/**
 * Online incremental progress tracker.
 *
 * Mirrors the published ProgressTracker idea in a DeepSeek Harness tool
 * shape: the model starts a tracker for one task, feeds one step at a time,
 * and each update scores only the trajectory prefix seen so far. The state
 * is event-sourced from durable `tool/call` / `tool/result` records, so a
 * session restart can rebuild the same curve without re-running old steps.
 */

export interface TrackerState {
  problem: string
  steps: string[]
  scores: Array<number | null>
  evaluations: number
}

interface TrackerEvent {
  type?: string
  data?: Record<string, unknown>
  message?: unknown
}

export interface TrackerSession {
  id?: string
  sessionId?: string
  events?: unknown[]
}

function idOf(session: TrackerSession): string {
  return session.id ?? session.sessionId ?? 'session'
}

function eventData(event: TrackerEvent): Record<string, unknown> {
  const data = event.data
  return typeof data === 'object' && data !== null ? data : {}
}

function stringifyContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((block) => {
        if (typeof block === 'string') return block
        if (typeof block === 'object' && block !== null && 'text' in block) {
          return String((block as { text: unknown }).text)
        }
        return ''
      })
      .filter((part) => part.length > 0)
      .join('\n')
  }
  if (typeof value === 'object' && value !== null && 'text' in value) {
    return String((value as { text: unknown }).text)
  }
  return ''
}

function parseStart(args: string): { problem: string; evaluations: number } | undefined {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>
    const problem = typeof parsed.problem === 'string' ? parsed.problem : ''
    if (problem.length === 0) return undefined
    const evaluations = typeof parsed.evaluations === 'number' && Number.isInteger(parsed.evaluations) && parsed.evaluations >= 1
      ? parsed.evaluations
      : 1
    return { problem, evaluations }
  } catch {
    return undefined
  }
}

function parseUpdate(args: string): string | undefined {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>
    return typeof parsed.step === 'string' ? parsed.step : undefined
  } catch {
    return undefined
  }
}

/** The tracker emits a deterministic result line so cold rebuild can parse it. */
const SCORE_PATTERN = /Latest progress after step (\d+): ([0-9.]+)/
const RESULT_PREFIX = 'Tracker started.'

function applyStart(state: TrackerState, args: string): boolean {
  const parsed = parseStart(args)
  if (parsed === undefined) return false
  state.problem = parsed.problem
  state.steps = []
  state.scores = []
  state.evaluations = parsed.evaluations
  return true
}

function applyUpdate(state: TrackerState, args: string): boolean {
  const step = parseUpdate(args)
  if (step === undefined || state.problem.length === 0) return false
  state.steps.push(step)
  state.scores.push(null)
  return true
}

function applyResult(state: TrackerState, text: string): void {
  const match = SCORE_PATTERN.exec(text)
  if (match === null) return
  const step = Number(match[1])
  const score = Number(match[2])
  if (!Number.isInteger(step) || step < 1 || step > state.scores.length) return
  if (!Number.isFinite(score)) return
  state.scores[step - 1] = score
}

export class OnlineProgressTracker {
  private readonly sessions = new Map<string, TrackerState>()
  private readonly pending = new Map<string, Map<string, number>>()

  private ensure(session: TrackerSession): TrackerState {
    const id = idOf(session)
    const existing = this.sessions.get(id)
    if (existing !== undefined) return existing
    const state: TrackerState = { problem: '', steps: [], scores: [], evaluations: 1 }
    this.sessions.set(id, state)
    const pendingCalls = new Map<string, number>()
    this.pending.set(id, pendingCalls)
    for (const raw of session.events ?? []) {
      this.apply(raw as TrackerEvent, state, pendingCalls)
    }
    return state
  }

  private apply(event: TrackerEvent, state: TrackerState, pending: Map<string, number>): void {
    const type = event.type ?? ''
    const data = eventData(event)
    if (type === 'tool/call') {
      const name = typeof data.name === 'string' ? data.name : ''
      const args = typeof data.arguments === 'string' ? data.arguments : ''
      const callId = typeof data.callId === 'string' ? data.callId : ''
      if (name === 'verifier_tracker_start') {
        applyStart(state, args)
      } else if (name === 'verifier_tracker_update') {
        if (applyUpdate(state, args)) pending.set(callId, state.steps.length - 1)
      }
      return
    }
    if (type === 'tool/result') {
      const callId = typeof data.callId === 'string' ? data.callId : ''
      const index = pending.get(callId)
      if (index === undefined) return
      pending.delete(callId)
      const message = data.message ?? event.message
      applyResult(state, stringifyContent(message))
    }
  }

  observe(session: TrackerSession, event: TrackerEvent): void {
    const id = idOf(session)
    const state = this.ensure(session)
    const pending = this.pending.get(id) ?? new Map<string, number>()
    this.pending.set(id, pending)
    this.apply(event, state, pending)
  }

  start(session: TrackerSession, problem: string, evaluations = 1): TrackerState {
    const state = this.ensure(session)
    state.problem = problem
    state.steps = []
    state.scores = []
    state.evaluations = Math.max(1, Math.floor(evaluations))
    return state
  }

  pushStep(session: TrackerSession, step: string): TrackerState {
    const state = this.ensure(session)
    if (state.problem.length === 0) throw new Error('start the tracker first with verifier_tracker_start')
    state.steps.push(step)
    state.scores.push(null)
    return state
  }

  recordScore(session: TrackerSession, score: number): void {
    const state = this.ensure(session)
    state.scores[state.scores.length - 1] = score
  }

  snapshot(session: TrackerSession): TrackerState {
    const state = this.ensure(session)
    return {
      problem: state.problem,
      steps: [...state.steps],
      scores: [...state.scores],
      evaluations: state.evaluations,
    }
  }

  hasStarted(session: TrackerSession): boolean {
    return this.ensure(session).problem.length > 0
  }

  renderStart(state: TrackerState): string {
    return `${RESULT_PREFIX} Problem: ${state.problem}\nEvaluations: ${state.evaluations}`
  }

  renderUpdate(state: TrackerState): string {
    const index = state.steps.length
    const score = state.scores[index - 1] ?? null
    return `Latest progress after step ${index}: ${score === null ? 'unavailable' : score.toFixed(5)}`
  }

  renderResult(state: TrackerState): string {
    if (state.steps.length === 0) return 'No tracker updates yet.'
    const lines = ['Progress curve (step: score):']
    state.steps.forEach((_, index) => {
      const score = state.scores[index] ?? null
      lines.push(`  ${index + 1}: ${score === null ? 'unavailable' : score.toFixed(5)}`)
    })
    return lines.join('\n')
  }
}
