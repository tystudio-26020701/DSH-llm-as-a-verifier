/**
 * Final-answer detection for the optional auto-verification gate.
 *
 * A turn's candidate final answer is the last assistant message whose step
 * requested no tool calls. The task description is taken from the first
 * user-sourced message in the durable session log, or from gate config.
 */

export interface GateSession {
  events?: GateEvent[]
}

export interface GateEvent {
  type?: string
  data?: Record<string, unknown>
  message?: unknown
  source?: Record<string, unknown>
}

function eventData(event: GateEvent): Record<string, unknown> {
  const data = event.data
  return typeof data === 'object' && data !== null ? data : {}
}

export function eventContent(value: unknown): string {
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

/** First real user message text, used as the task description when the gate
 * config does not pin one. */
export function extractFirstUserMessage(session: GateSession): string {
  for (const event of session.events ?? []) {
    if (event.type !== 'user/message') continue
    const source = event.source ?? eventData(event).source
    const kind = typeof source === 'object' && source !== null && 'kind' in source
      ? String((source as { kind: unknown }).kind)
      : ''
    if (kind === 'plugin' || kind === 'skill-invocation') continue
    const content = eventContent(event.message ?? eventData(event).message ?? event)
    if (content.trim().length > 0) return content.trim()
  }
  return ''
}

export interface AssistantCandidate {
  text: string
  turn: number
  step: number
}

/** The last assistant message in `turn` whose step has no tool call. */
export function findFinalAnswer(session: GateSession, turn: number): AssistantCandidate | undefined {
  const assistantMessages: AssistantCandidate[] = []
  const toolSteps = new Set<string>()
  for (const event of session.events ?? []) {
    if (event.type === 'tool/call') {
      const data = eventData(event)
      if (data.turn === turn && typeof data.step === 'number') {
        toolSteps.add(`${String(data.turn)}:${String(data.step)}`)
      }
    }
  }
  for (const event of session.events ?? []) {
    if (event.type !== 'assistant/message') continue
    const data = eventData(event)
    if (data.turn !== turn || typeof data.step !== 'number') continue
    const text = eventContent(data.message ?? event.message).trim()
    if (text.length === 0) continue
    if (toolSteps.has(`${String(data.turn)}:${String(data.step)}`)) continue
    assistantMessages.push({ text, turn, step: data.step })
  }
  return assistantMessages.at(-1)
}
