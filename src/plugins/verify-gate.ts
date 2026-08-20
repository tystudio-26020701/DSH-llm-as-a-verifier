/**
 * verify-gate — optional final-answer auto-verification gate.
 *
 * The gate listens on the serial `agent/turn-stopping` checkpoint. When a
 * turn is about to close with a text-only final answer, it scores that answer
 * against the session's task prompt with the same fine-grained verifier. If
 * the reward is below the configured threshold, it steers the model once to
 * re-open the task and retry instead of closing the turn.
 *
 * Safety:
 *  - disabled by default (`enabled: false`);
 *  - a failed verifier call always lets the turn close untouched;
 *  - at most `maxGatesPerTurn` steer events per turn (resume-safe: previously
 *    steered turns are rebuilt from durable `steering/message` events);
 *  - subagents are skipped unless `includeSubagents: true`.
 */

import type { BackendSettings } from '../lib/backend.js'
import type { CriteriaArgument } from '../lib/criteria.js'
import { extractFirstUserMessage, findFinalAnswer, type GateSession } from '../lib/final-answer.js'
import { compareTrajectories, type VerifierOptions } from '../lib/verifier.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'verify-gate'

/** No services are required before the listener can register. */
export const inject = []

interface GateConfig extends BackendSettings {
  enabled?: boolean
  threshold?: number
  maxGatesPerTurn?: number
  evaluations?: number
  criteria?: string
  problem?: string
  steerText?: string
  includeSubagents?: boolean
}

interface GateAgent {
  session?: GateSession & {
    id?: string
    header?: { cwd?: string; delegationDepth?: number }
  }
  steer?: (message: Record<string, unknown>) => void
}

const DEFAULT_THRESHOLD = 0.6
const DEFAULT_MAX_GATES = 1
const DEFAULT_STEER_TEXT = 'Verification gate: the final answer scored below the configured threshold. Re-open the task, fix the remaining issues, and submit a new final answer.'
const STEERING_EVENT = 'steering/message'

function parseCriteria(raw: string): CriteriaArgument {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as unknown
    if (typeof parsed === 'object' && parsed !== null) return parsed as CriteriaArgument
  }
  return trimmed
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

function thresholdOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : DEFAULT_THRESHOLD
}

function steeredTurnOf(event: unknown): number | undefined {
  if (typeof event !== 'object' || event === null) return undefined
  const record = event as { turn?: unknown; data?: { turn?: unknown } }
  const turn = record.turn ?? record.data?.turn
  return typeof turn === 'number' ? turn : undefined
}

function isSubagent(session: GateAgent['session']): boolean {
  return (session?.header?.delegationDepth ?? 0) > 0
}

export function apply(ctx: unknown, config: GateConfig = {}): void {
  const enabled = config.enabled === true
  const threshold = thresholdOf(config.threshold)
  const maxGatesPerTurn = positiveInt(config.maxGatesPerTurn, DEFAULT_MAX_GATES)
  const evaluations = positiveInt(config.evaluations, 1)
  const criteria = parseCriteria(config.criteria ?? 'general')
  const steerText = typeof config.steerText === 'string' && config.steerText.length > 0
    ? config.steerText
    : DEFAULT_STEER_TEXT
  const includeSubagents = config.includeSubagents === true

  const steeredTurns = new Map<string, Set<number>>()
  let warned = false

  const warn = (message: string): void => {
    if (warned) return
    warned = true
    console.error(`[${name}] ${message}`)
  }

  const turnsSteeredFor = (session: GateAgent['session']): Set<number> => {
    const sessionId = session?.id ?? 'session'
    const existing = steeredTurns.get(sessionId)
    if (existing !== undefined) return existing
    const rebuilt = new Set<number>()
    for (const event of session?.events ?? []) {
      if (event.type !== STEERING_EVENT) continue
      if (event.source !== null && typeof event.source === 'object' && (event.source as { plugin?: unknown }).plugin === name) {
        const turn = steeredTurnOf(event)
        if (turn !== undefined) rebuilt.add(turn)
      }
    }
    steeredTurns.set(sessionId, rebuilt)
    return rebuilt
  }

  const context = ctx as {
    on?: (event: string, listener: (payload: { agent?: GateAgent; turn?: number }) => void | Promise<void>) => unknown
  }
  if (typeof context.on !== 'function') return

  context.on('agent/turn-stopping', async ({ agent, turn }) => {
    if (!enabled || agent === undefined || turn === undefined) return
    const session = agent.session
    if (session === undefined) return
    if (!includeSubagents && isSubagent(session)) return

    const steered = turnsSteeredFor(session)
    if (steered.has(turn) || steered.size >= maxGatesPerTurn * 4) return

    const candidate = findFinalAnswer(session, turn)
    if (candidate === undefined || candidate.text.length === 0) return

    const problem = (typeof config.problem === 'string' && config.problem.trim().length > 0)
      ? config.problem.trim()
      : extractFirstUserMessage(session)
    if (problem.length === 0) return

    const options: VerifierOptions = {
      ctx,
      settings: config,
      cwd: session.header?.cwd,
      cache: false,
    }

    try {
      const result = await compareTrajectories(
        problem,
        candidate.text,
        '(no answer produced)',
        criteria,
        evaluations,
        options,
      )
      if (result.rewardA >= threshold) return
      if (steered.has(turn) || steered.size >= maxGatesPerTurn) return
      steered.add(turn)
      agent.steer?.({
        id: crypto.randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: steerText }],
        source: {
          kind: 'plugin',
          plugin: name,
          form: 'notice',
          summary: 'final answer failed auto-verification',
        },
      })
    } catch (error) {
      warn(`verification failed, letting the turn close: ${String((error && (error as Error).message) || error)}`)
    }
  })
}
