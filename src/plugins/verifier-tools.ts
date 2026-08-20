/**
 * verifier-tools — the DeepSeek Harness plugin surface of the preset.
 *
 * It registers five model-facing tools and one durable session listener:
 *  - verifier_compare : raw pairwise fine-grained rewards
 *  - verifier_select  : probabilistic pivot-tournament best-of-N selection
 *  - verifier_track   : offline checkpoint progress curve
 *  - verifier_session : score the live session transcript (harness-native)
 *  - verifier_status  : backend, core, cache and token-usage report
 *
 * The plugin has no npm runtime dependencies. Configuration resolves from the
 * `agent.cordis.yml` row, the `dsh-verifier` user-settings namespace when the
 * host exposes it, tool arguments, and the trusted environment.
 */

import {
  backendSummary,
  resolveBackend,
  VerifierBackend,
  type BackendSettings,
} from '../lib/backend.js'
import { coreVersion } from '../lib/core.js'
import type { CriteriaArgument } from '../lib/criteria.js'
import { OnlineProgressTracker } from '../lib/online-tracker.js'
import { TranscriptRecorder, type SessionLike, type TranscriptEvent } from '../lib/session-transcript.js'
import { tokenUsage } from '../lib/usage.js'
import {
  compareTrajectories,
  selectTrajectories,
  trackProgress,
  type VerifierOptions,
} from '../lib/verifier.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'verifier-tools'

/** The tools registry must exist before these tools can register. */
export const inject = ['tools']

interface ParameterSpec {
  type: string
  required?: boolean
  description?: string
  items?: ParameterSpec
}

interface ToolExec {
  agent?: {
    session?: {
      header?: { cwd?: string }
      events?: unknown[]
    } & SessionLike
  } & SessionLike
  signal?: AbortSignal
}

interface ToolResult {
  text: string
}

interface CordisContext {
  tools: {
    register(tool: Record<string, unknown>): void
  }
  on(event: string, listener: (session: SessionLike, event: TranscriptEvent) => void): unknown
  get?(name: string): unknown
}

function toParameterSchema(spec: Record<string, ParameterSpec>): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, meta] of Object.entries(spec)) {
    const property: Record<string, unknown> = { type: meta.type }
    if (meta.description !== undefined) property.description = meta.description
    if (meta.items !== undefined) property.items = meta.items
    properties[key] = property
    if (meta.required === true) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

function outputText(): Record<string, unknown> {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    render: (_args: unknown, value: ToolResult): Array<{ type: string; text: string }> => [
      { type: 'text', text: value.text },
    ],
  }
}

function stringArg(args: Record<string, unknown>, key: string, fallback = ''): string {
  const value = args[key]
  return typeof value === 'string' ? value : fallback
}

function numberArg(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function intArg(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = numberArg(args, key, fallback)
  return Math.max(1, Math.floor(value))
}

function stringArrayArg(args: Record<string, unknown>, key: string): string[] {
  const value = args[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

function numberArrayArg(args: Record<string, unknown>, key: string): number[] | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) return undefined
  const numbers = value.filter((item): item is number => typeof item === 'number' && Number.isInteger(item))
  return numbers.length === value.length ? numbers : undefined
}

function parseCriteria(raw: string): CriteriaArgument {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as unknown
    if (typeof parsed === 'string') return parsed
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as CriteriaArgument
    }
  }
  return trimmed
}

function usageLines(): string[] {
  const usage = tokenUsage.snapshot()
  const hitRate = usage.inputTokens > 0
    ? `${((100 * usage.cachedInputTokens) / usage.inputTokens).toFixed(1)}%`
    : '0.0%'
  return [
    `Token usage: ${usage.calls} verifier calls`,
    `  input ${usage.inputTokens} (cached ${usage.cachedInputTokens}, ${hitRate} hit rate)`,
    `  output ${usage.outputTokens} (reasoning ${usage.reasoningTokens})`,
  ]
}

function workspaceCwd(exec: ToolExec | undefined): string {
  return exec?.agent?.session?.header?.cwd ?? process.cwd()
}

function backendOverrides(args: Record<string, unknown>): Partial<BackendSettings> {
  const overrides: Partial<BackendSettings> = {}
  const model = stringArg(args, 'model')
  const backend = stringArg(args, 'backend')
  const onError = stringArg(args, 'onError')
  if (model.length > 0) overrides.model = model
  if (backend === 'deepseek' || backend === 'openai' || backend === 'auto') overrides.backend = backend
  if (onError === 'raise' || onError === 'tie') overrides.onError = onError
  return overrides
}

function optionsFor(
  ctx: CordisContext,
  config: BackendSettings,
  args: Record<string, unknown>,
  exec: ToolExec | undefined,
): VerifierOptions {
  return {
    ctx,
    settings: config,
    overrides: backendOverrides(args),
    cwd: workspaceCwd(exec),
    cache: config.cachePath,
  }
}

function formatUsageFooter(): string {
  return `\n${usageLines().join('\n')}`
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function apply(ctx: CordisContext, config: BackendSettings = {}): void {
  const recorder = new TranscriptRecorder()
  const tracker = new OnlineProgressTracker()

  ctx.on('session/event', (session, event) => {
    recorder.observe(session, event)
    tracker.observe(session, event)
  })

  ctx.tools.register({
    name: 'verifier_compare',
    description: [
      'Score TWO candidate trajectories against one task using the fine-grained LLM verifier.',
      '',
      'The verifier reads the probability distribution over a 20-level letter scale (A..T) from token-level logprobs and returns the expected rewards R_A and R_B, each in [0, 1]. This is the raw pairwise signal behind best-of-N selection; a single directed call does not cancel slot bias.',
      '',
      '`criteria` accepts a bundled name (general, terminal_bench, swe_bench, medagentbench), a path to a criteria .md file, a JSON object {"Name": "description"}, or a JSON array of strings/objects.',
    ].join('\n'),
    parameters: toParameterSchema({
      problem: { type: 'string', required: true, description: 'Task description shown to the verifier.' },
      traceA: { type: 'string', required: true, description: 'First candidate trajectory, with observable output.' },
      traceB: { type: 'string', required: true, description: 'Second candidate trajectory, with observable output.' },
      criteria: { type: 'string', required: true, description: 'Bundled criteria name, .md path, or JSON-encoded criteria object/array.' },
      evaluations: { type: 'number', required: false, description: 'Repeated verifications per criterion (default 1).' },
      groundTruthNote: { type: 'string', required: false, description: 'Optional evidence guidance shown to the verifier.' },
      model: { type: 'string', required: false, description: 'Optional verifier model override.' },
      backend: { type: 'string', required: false, description: 'Optional backend override: auto, deepseek, or openai.' },
      onError: { type: 'string', required: false, description: 'Optional error policy: tie or raise (default tie).' },
    }),
    output: outputText(),
    async execute(args: Record<string, unknown>, exec: ToolExec | undefined): Promise<ToolResult> {
      try {
        const result = await compareTrajectories(
          stringArg(args, 'problem'),
          stringArg(args, 'traceA'),
          stringArg(args, 'traceB'),
          parseCriteria(stringArg(args, 'criteria')),
          intArg(args, 'evaluations', 1),
          optionsFor(ctx, config, args, exec),
        )
        return {
          text: [
            `Reward A: ${result.rewardA.toFixed(5)}`,
            `Reward B: ${result.rewardB.toFixed(5)}`,
            `Criteria: ${result.criteria.join(', ')} (${result.evaluations} evaluation(s) each)`,
            formatUsageFooter(),
          ].join('\n'),
        }
      } catch (error) {
        return { text: `verifier_compare failed: ${describeError(error)}` }
      }
    },
  })

  ctx.tools.register({
    name: 'verifier_select',
    description: [
      'Select the best of N candidate trajectories for one task.',
      '',
      'The method scores a random ring of directed pairwise comparisons with the fine-grained logprob reward, promotes the strongest candidates as pivots, scores the remaining pivot rounds, and aggregates everything under the Bradley-Terry model. Cost is linear in N for a fixed pivot count instead of O(N^2).',
      '',
      'Returns the winner index, best trajectory, per-candidate scores, ranking, and the number of verifier comparisons.',
    ].join('\n'),
    parameters: toParameterSchema({
      problem: { type: 'string', required: true, description: 'Task description shown to the verifier.' },
      candidates: {
        type: 'array',
        required: true,
        description: 'Candidate trajectories to rank, each with observable output.',
        items: { type: 'string' },
      },
      criteria: { type: 'string', required: true, description: 'Bundled criteria name, .md path, or JSON-encoded criteria object/array.' },
      evaluations: { type: 'number', required: false, description: 'Repeated verifications per criterion (default 4).' },
      pivots: { type: 'number', required: false, description: 'Pivot count k (default 2).' },
      seed: { type: 'number', required: false, description: 'Random ring seed; same seed reproduces the tournament (default 0).' },
      model: { type: 'string', required: false, description: 'Optional verifier model override.' },
      backend: { type: 'string', required: false, description: 'Optional backend override: auto, deepseek, or openai.' },
      onError: { type: 'string', required: false, description: 'Optional error policy: tie or raise (default tie).' },
    }),
    output: outputText(),
    async execute(args: Record<string, unknown>, exec: ToolExec | undefined): Promise<ToolResult> {
      try {
        const candidates = stringArrayArg(args, 'candidates')
        if (candidates.length === 0) return { text: 'verifier_select needs at least one candidate.' }
        const result = await selectTrajectories(
          stringArg(args, 'problem'),
          candidates,
          parseCriteria(stringArg(args, 'criteria')),
          intArg(args, 'evaluations', 4),
          Math.max(1, Math.floor(numberArg(args, 'pivots', 2))),
          Math.floor(numberArg(args, 'seed', 0)),
          optionsFor(ctx, config, args, exec),
        )
        const lines = [
          `Winner: candidate #${result.index} (score ${result.scores[result.index]?.toFixed(5) ?? 'n/a'})`,
          `Ranking: ${result.ranking.join(' > ')}`,
          `Scores: ${result.scores.map((score) => score.toFixed(4)).join(', ')}`,
          `Comparisons: ${result.nComparisons}`,
          `Criteria: ${result.criteria.join(', ')} (${result.evaluations} evaluation(s) each)`,
          formatUsageFooter(),
        ]
        return { text: lines.join('\n') }
      } catch (error) {
        return { text: `verifier_select failed: ${describeError(error)}` }
      }
    },
  })

  ctx.tools.register({
    name: 'verifier_track',
    description: [
      'Score the progress of a FINISHED trajectory at chosen checkpoints.',
      '',
      'One verifier call sees the whole trajectory and scores each checkpoint independently: given everything through step k, would the hidden grader already accept the current state? Letters A..T map to a 0..1 progress curve. Use verifier_session to score the live session instead.',
    ].join('\n'),
    parameters: toParameterSchema({
      problem: { type: 'string', required: true, description: 'Task description shown to the verifier.' },
      steps: {
        type: 'array',
        required: true,
        description: 'Agent steps; each string is one action plus its observed output.',
        items: { type: 'string' },
      },
      checkpointSteps: {
        type: 'array',
        required: false,
        description: '1-indexed steps to score; defaults to a sensible even spread.',
        items: { type: 'number' },
      },
      evaluations: { type: 'number', required: false, description: 'Independent repeats to average (default 1).' },
      model: { type: 'string', required: false, description: 'Optional verifier model override.' },
      backend: { type: 'string', required: false, description: 'Optional backend override: auto, deepseek, or openai.' },
      onError: { type: 'string', required: false, description: 'Optional error policy: tie or raise (default tie).' },
    }),
    output: outputText(),
    async execute(args: Record<string, unknown>, exec: ToolExec | undefined): Promise<ToolResult> {
      try {
        const steps = stringArrayArg(args, 'steps')
        if (steps.length === 0) return { text: 'verifier_track needs at least one step.' }
        const result = await trackProgress(
          stringArg(args, 'problem'),
          steps,
          numberArrayArg(args, 'checkpointSteps'),
          intArg(args, 'evaluations', 1),
          optionsFor(ctx, config, args, exec),
        )
        const lines = [
          'Progress curve (step: score):',
          ...result.steps.map((step, index) => `  ${step}: ${result.scores[index]?.toFixed(5) ?? 'n/a'}`),
          `Final checkpoint: ${result.scores[result.scores.length - 1]?.toFixed(5) ?? 'n/a'}`,
          formatUsageFooter(),
        ]
        return { text: lines.join('\n') }
      } catch (error) {
        return { text: `verifier_track failed: ${describeError(error)}` }
      }
    },
  })

  ctx.tools.register({
    name: 'verifier_session',
    description: [
      'Score the CURRENT DeepSeek Harness session with the verifier progress model.',
      '',
      'The preset records the session trajectory from durable events (tool calls, tool results, assistant messages), rebuilds it after a restart, and scores selected checkpoints without the model assembling a transcript by hand. Use it to decide whether to continue, backtrack, or resample.',
      '',
      'Requires the task `problem`; checkpointSteps defaults to a spread across the recorded steps.',
    ].join('\n'),
    parameters: toParameterSchema({
      problem: { type: 'string', required: true, description: 'The task this session is trying to solve.' },
      checkpointSteps: {
        type: 'array',
        required: false,
        description: '1-indexed transcript steps to score; defaults to a sensible spread.',
        items: { type: 'number' },
      },
      evaluations: { type: 'number', required: false, description: 'Independent repeats to average (default 1).' },
      model: { type: 'string', required: false, description: 'Optional verifier model override.' },
      backend: { type: 'string', required: false, description: 'Optional backend override: auto, deepseek, or openai.' },
      onError: { type: 'string', required: false, description: 'Optional error policy: tie or raise (default tie).' },
    }),
    output: outputText(),
    async execute(args: Record<string, unknown>, exec: ToolExec | undefined): Promise<ToolResult> {
      try {
        const session = exec?.agent?.session
        if (session === undefined) return { text: 'verifier_session requires an agent session context.' }
        const steps = recorder.snapshot(session)
        if (steps.length === 0) return { text: 'verifier_session found no recorded trajectory steps in this session yet.' }
        const result = await trackProgress(
          stringArg(args, 'problem'),
          steps,
          numberArrayArg(args, 'checkpointSteps'),
          intArg(args, 'evaluations', 1),
          optionsFor(ctx, config, args, exec),
        )
        const lines = [
          `Session transcript: ${steps.length} step(s) recorded.`,
          'Progress curve (transcript step: score):',
          ...result.steps.map((step, index) => `  ${step}: ${result.scores[index]?.toFixed(5) ?? 'n/a'}`),
          `Latest checkpoint: ${result.scores[result.scores.length - 1]?.toFixed(5) ?? 'n/a'}`,
          formatUsageFooter(),
        ]
        return { text: lines.join('\n') }
      } catch (error) {
        return { text: `verifier_session failed: ${describeError(error)}` }
      }
    },
  })

  ctx.tools.register({
    name: 'verifier_tracker_start',
    description: [
      'Start an ONLINE progress tracker for one task.',
      '',
      'After starting, feed the session steps one at a time with verifier_tracker_update; each update scores only the prefix seen so far, so the verifier never sees the future. Use the returned score for early stopping or resampling, and verifier_tracker_result to print the curve.',
    ].join('\n'),
    parameters: toParameterSchema({
      problem: { type: 'string', required: true, description: 'The task this tracker will measure progress against.' },
      evaluations: { type: 'number', required: false, description: 'Independent verifier repeats per update (default 1).' },
    }),
    output: outputText(),
    async execute(args: Record<string, unknown>, exec: ToolExec | undefined): Promise<ToolResult> {
      const session = exec?.agent?.session
      if (session === undefined) return { text: 'verifier_tracker_start requires an agent session context.' }
      const problem = stringArg(args, 'problem')
      if (problem.length === 0) return { text: 'verifier_tracker_start requires a non-empty problem.' }
      const state = tracker.start(session, problem, intArg(args, 'evaluations', 1))
      return { text: tracker.renderStart(state) }
    },
  })

  ctx.tools.register({
    name: 'verifier_tracker_update',
    description: [
      'Append ONE new agent step to the online tracker and return its progress score.',
      '',
      'The verifier sees the task plus the trajectory prefix up to and including this step only. Call this after every meaningful action when early stopping or a live progress curve is wanted.',
    ].join('\n'),
    parameters: toParameterSchema({
      step: { type: 'string', required: true, description: 'The latest agent step: action plus observed output.' },
      model: { type: 'string', required: false, description: 'Optional verifier model override.' },
      backend: { type: 'string', required: false, description: 'Optional backend override: auto, deepseek, or openai.' },
      onError: { type: 'string', required: false, description: 'Optional error policy: tie or raise (default tie).' },
    }),
    output: outputText(),
    async execute(args: Record<string, unknown>, exec: ToolExec | undefined): Promise<ToolResult> {
      const session = exec?.agent?.session
      if (session === undefined) return { text: 'verifier_tracker_update requires an agent session context.' }
      if (!tracker.hasStarted(session)) return { text: 'Start the tracker first with verifier_tracker_start.' }
      const step = stringArg(args, 'step')
      if (step.length === 0) return { text: 'verifier_tracker_update requires a non-empty step.' }
      try {
        const state = tracker.pushStep(session, step)
        const result = await trackProgress(
          state.problem,
          state.steps,
          [state.steps.length],
          state.evaluations,
          optionsFor(ctx, config, args, exec),
        )
        const score = result.scores[0] ?? 0.5
        tracker.recordScore(session, score)
        return { text: tracker.renderUpdate(tracker.snapshot(session)) }
      } catch (error) {
        return { text: `verifier_tracker_update failed: ${describeError(error)}` }
      }
    },
  })

  ctx.tools.register({
    name: 'verifier_tracker_result',
    description: [
      'Return the online progress curve collected so far for the current session.',
      '',
      'The curve is stateful and resume-safe: tracker tool calls are durable session events, so a restart rebuilds the same steps and scores.',
    ].join('\n'),
    parameters: toParameterSchema({}),
    output: outputText(),
    async execute(_args: Record<string, unknown>, exec: ToolExec | undefined): Promise<ToolResult> {
      const session = exec?.agent?.session
      if (session === undefined) return { text: 'verifier_tracker_result requires an agent session context.' }
      if (!tracker.hasStarted(session)) return { text: 'Start the tracker first with verifier_tracker_start.' }
      return { text: tracker.renderResult(tracker.snapshot(session)) }
    },
  })


  ctx.tools.register({
    name: 'verifier_status',
    description: [
      'Report the verifier preset configuration, Rust core version, token usage, and cache status.',
      'No API traffic is sent by this tool; credentials are never printed.',
    ].join('\n'),
    parameters: toParameterSchema({}),
    output: outputText(),
    async execute(_args: Record<string, unknown>, exec: ToolExec | undefined): Promise<ToolResult> {
      const lines: string[] = []
      try {
        const backend = new VerifierBackend(await resolveBackend(ctx, config, backendOverrides({})))
        lines.push('Backend:', ...Object.entries(backendSummary(backend)).map(([key, value]) => `  ${key}: ${String(value)}`))
      } catch (error) {
        lines.push(`Backend: not fully configured — ${describeError(error)}`)
      }
      try {
        lines.push(`Rust core: v${await coreVersion()}`)
      } catch (error) {
        lines.push(`Rust core: unavailable — ${describeError(error)}`)
      }
      lines.push(...usageLines())
      lines.push(`Working directory: ${workspaceCwd(exec)}`)
      return { text: lines.join('\n') }
    },
  })
}
