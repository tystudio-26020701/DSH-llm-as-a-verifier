/**
 * Terminal-Bench trajectory loader.
 *
 * The runner reads the same public trajectory JSON shape used by the
 * LLM-as-a-Verifier reproduction data. This implementation is original:
 * it walks the directory itself, extracts the task prompt from the first
 * non-shell user step, and renders a compact action/output transcript from
 * the recorded steps.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface TerminalTrial {
  taskName: string
  trialName: string
  reward: number
  problem: string
  trace: string
}

interface TerminalStep {
  step_id?: unknown
  source?: unknown
  message?: unknown
  tool_calls?: Array<{
    arguments?: { keystrokes?: unknown }
  }>
  observation?: {
    results?: Array<{ content?: unknown }>
  }
}

interface TerminalTrajectoryFile {
  trial_name?: unknown
  reward?: unknown
  trajectory?: {
    steps?: TerminalStep[]
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function looksLikeShellPrompt(message: string): boolean {
  const trimmed = message.trim()
  return trimmed.startsWith('$') && trimmed.length < 5
}

/** Extract the task instruction from the first real user message. */
function extractProblem(steps: TerminalStep[], taskName: string): string {
  for (const step of steps) {
    if (step.source !== 'user') continue
    const message = asString(step.message).trim()
    if (message.length === 0 || looksLikeShellPrompt(message)) continue
    return message
  }
  const fallback: string[] = []
  for (const step of steps) {
    if (step.source !== 'agent') continue
    const message = asString(step.message).trim()
    if (message.length === 0) continue
    fallback.push(message)
    if (fallback.length >= 2) break
  }
  if (fallback.length > 0) {
    return `(Task: ${taskName})\nThe original task instruction was not captured. The agent's opening analysis follows:\n\n${fallback.join('\n\n')}`
  }
  return `(Task: ${taskName})`
}

/** Render one recorded step into the transcript the verifier will read. */
function renderStep(step: TerminalStep, index: number): string[] {
  const parts: string[] = []
  const message = asString(step.message).trim()
  if (step.source !== 'agent') return parts
  parts.push(`--- Agent Step ${String(step.step_id ?? index)} ---`)
  if (message.length > 0) parts.push(message)
  for (const call of step.tool_calls ?? []) {
    const keystrokes = asString(call.arguments?.keystrokes).trim()
    if (keystrokes.length > 0) parts.push(`[Command] ${keystrokes}`)
  }
  for (const result of step.observation?.results ?? []) {
    const content = asString(result.content).trim()
    if (content.length > 0) parts.push(`[Output]\n${content}`)
  }
  if (parts.length === 1) return []
  parts.push('')
  return parts
}

/** Render the whole trajectory as a verifier-readable transcript. */
export function formatTerminalTrace(steps: TerminalStep[]): string {
  if (steps.length === 0) return '(no trajectory data)'
  const parts: string[] = []
  for (const [index, step] of steps.entries()) {
    parts.push(...renderStep(step, index + 1))
  }
  return parts.join('\n')
}

async function walkDirectories(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name)).sort()
}

async function walkFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  return entries.filter((entry) => entry.isFile()).map((entry) => join(root, entry.name)).sort()
}

/** Load all tasks under an `agent_dir` whose children are task directories. */
export async function loadTerminalBenchmark(
  agentDir: string,
  maxTrials = Number.POSITIVE_INFINITY,
): Promise<Map<string, TerminalTrial[]>> {
  const tasks = new Map<string, TerminalTrial[]>()
  for (const taskDir of await walkDirectories(agentDir)) {
    const taskName = taskDir.split('/').pop() ?? taskDir
    const trials: TerminalTrial[] = []
    for (const file of await walkFiles(taskDir)) {
      if (!file.endsWith('_trajectory.json')) continue
      if (trials.length >= maxTrials) break
      const parsed = JSON.parse(await readFile(file, 'utf8')) as TerminalTrajectoryFile
      const steps = parsed.trajectory?.steps ?? []
      if (steps.length === 0) continue
      trials.push({
        taskName,
        trialName: asString(parsed.trial_name) || file.split('/').pop() || 'trial',
        reward: typeof parsed.reward === 'number' ? parsed.reward : 0,
        problem: extractProblem(steps, taskName),
        trace: formatTerminalTrace(steps),
      })
    }
    if (trials.length > 0) tasks.set(taskName, trials)
  }
  return tasks
}
