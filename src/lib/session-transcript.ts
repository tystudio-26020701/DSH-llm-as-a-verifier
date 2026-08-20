/**
 * Durable session-trajectory recorder.
 *
 * The harness keeps every session fact in an append-only event log. This
 * recorder derives a bounded, human-readable trajectory from that log:
 * assistant messages become narrative steps, tool calls become action steps,
 * and the matching tool result is appended to the same action step. It is
 * what powers `verifier_session` — the model can ask the verifier to score
 * the work the current session has actually performed.
 */

export interface SessionLike {
  id?: string
  sessionId?: string
  events?: unknown[]
}

export interface TranscriptEvent {
  type?: string
  data?: Record<string, unknown>
  message?: unknown
}

const MAX_STEPS = 400
const MAX_STEP_CHARS = 8000
const MAX_TOTAL_CHARS = 160_000

interface TranscriptState {
  steps: string[]
}

function idOf(session: SessionLike): string {
  return session.id ?? session.sessionId ?? 'session'
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

function eventType(event: TranscriptEvent): string {
  return event?.type ?? ''
}

function eventData(event: TranscriptEvent): Record<string, unknown> {
  const data = event?.data
  return typeof data === 'object' && data !== null ? data : {}
}

function appendBounded(state: TranscriptState, text: string): void {
  const trimmed = text.trim()
  if (trimmed.length === 0) return
  state.steps.push(trimmed.slice(0, MAX_STEP_CHARS))
  while (state.steps.length > MAX_STEPS) state.steps.shift()
  let total = state.steps.reduce((sum, step) => sum + step.length, 0)
  while (total > MAX_TOTAL_CHARS && state.steps.length > 1) {
    total -= state.steps[0]?.length ?? 0
    state.steps.shift()
  }
}

function appendToLast(state: TranscriptState, suffix: string): void {
  const last = state.steps[state.steps.length - 1]
  if (last === undefined) {
    appendBounded(state, suffix)
    return
  }
  state.steps[state.steps.length - 1] = `${last}\n${suffix.trim()}`.slice(0, MAX_STEP_CHARS)
}

function applyEvent(state: TranscriptState, event: TranscriptEvent): void {
  const type = eventType(event)
  if (type === 'tool/call') {
    const data = eventData(event)
    const name = typeof data.name === 'string' ? data.name : 'tool'
    const args = typeof data.arguments === 'string' ? data.arguments : ''
    appendBounded(state, `Action: ${name}${args.length > 0 ? `\nArguments: ${args}` : ''}`)
    return
  }
  if (type === 'tool/result') {
    const data = eventData(event)
    const message = data.message ?? event.message
    const text = stringifyContent(message)
    if (text.length > 0) appendToLast(state, `Output:\n${text}`)
    return
  }
  if (type === 'assistant/message') {
    const data = eventData(event)
    const message = data.message ?? event.message
    const text = stringifyContent(message)
    if (text.length > 0) appendBounded(state, `Agent message:\n${text}`)
  }
}

export class TranscriptRecorder {
  private readonly sessions = new Map<string, TranscriptState>()

  private scan(session: SessionLike): TranscriptState {
    const state: TranscriptState = { steps: [] }
    for (const event of session.events ?? []) {
      applyEvent(state, event as TranscriptEvent)
    }
    this.sessions.set(idOf(session), state)
    return state
  }

  ensure(session: SessionLike): TranscriptState {
    const id = idOf(session)
    const existing = this.sessions.get(id)
    if (existing !== undefined) return existing
    return this.scan(session)
  }

  observe(session: SessionLike, event: TranscriptEvent): void {
    applyEvent(this.ensure(session), event)
  }

  snapshot(session: SessionLike): string[] {
    const state = this.sessions.get(idOf(session))
    if (state !== undefined) return [...state.steps]
    return this.scan(session).steps
  }
}
