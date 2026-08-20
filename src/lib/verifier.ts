/**
 * High-level verification orchestration.
 *
 * This module composes the Rust core with the HTTP backends:
 *  - `compareTrajectories` — fine-grained pairwise reward.
 *  - `selectTrajectories` — probabilistic pivot tournament best-of-N.
 *  - `trackProgress` — checkpoint progress curve.
 *
 * Pairwise prompts put the criterion at the tail so a prefix-caching provider
 * reuses the expensive task+trajectory prefix. One request per distinct
 * prompt prefix runs first, then the rest fan out against the warm cache.
 */

import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'

import { VerifierBackend, mapWithConcurrency, resolveBackend, type BackendSettings, type CompletedVerification } from './backend.js'
import { ScoreCache } from './cache.js'
import {
  buildPairPrompt,
  buildProgressPrompt,
  extractProgress,
  extractScore,
  pptPlan,
  pptResult,
  pptRing,
  type ComparisonEntry,
} from './core.js'
import { resolveCriteria, type CriteriaArgument, type Criterion } from './criteria.js'
import { tokenUsage, type TokenUsageSnapshot } from './usage.js'

export interface CompareResult {
  rewardA: number
  rewardB: number
  criteria: string[]
  evaluations: number
  usage: TokenUsageSnapshot
}

export interface SelectResult {
  index: number
  best: string
  scores: number[]
  ranking: number[]
  nComparisons: number
  criteria: string[]
  evaluations: number
  usage: TokenUsageSnapshot
}

export interface ProgressResult {
  steps: number[]
  scores: number[]
  perEvaluation: Array<Array<number | null>>
  usage: TokenUsageSnapshot
}

interface DirectedReward {
  rewardA: number
  rewardB: number
}

interface ScoreJob {
  cacheKey: string
  criterion: Criterion
  repeat: number
  swap: boolean
  prompt: string
  prefix: string
  a: number
  b: number
}

interface ScoreContext {
  backend: VerifierBackend
  cache?: ScoreCache
  groundTruthNote: string
  criteria: Criterion[]
  evaluations: number
}

function hashText(text: string, length = 16): string {
  return createHash('sha256').update(text).digest('hex').slice(0, length)
}

function tieOrThrow(error: unknown, backend: VerifierBackend): DirectedReward {
  if (backend.onError === 'raise') throw error
  return { rewardA: 0.5, rewardB: 0.5 }
}

async function scoreOne(
  backend: VerifierBackend,
  prompt: string,
): Promise<{ rewardA: number; rewardB: number; verification: CompletedVerification }> {
  const verification = await backend.complete(prompt, ['<score_A>', '<score_B>'])
  const rewardA = await extractScore({
    text: verification.text,
    tokens: verification.tokens,
    positions: verification.positions,
    tag: 'score_A',
  })
  const rewardB = await extractScore({
    text: verification.text,
    tokens: verification.tokens,
    positions: verification.positions,
    tag: 'score_B',
  })
  return { rewardA, rewardB, verification }
}

/**
 * Score one directed comparison (candidate `a` in logical slot A, `b` in
 * logical slot B). Odd repeats swap the prompt slots and swap the rewards
 * back, which cancels verifier slot bias inside a single comparison.
 */
async function scoreDirected(
  context: ScoreContext,
  taskKey: string,
  problem: string,
  traces: string[],
  a: number,
  b: number,
): Promise<DirectedReward> {
  if (a === b) return { rewardA: 0.5, rewardB: 0.5 }
  let totalA = 0
  let totalB = 0
  let count = 0

  for (const criterion of context.criteria) {
    for (let repeat = 0; repeat < context.evaluations; repeat += 1) {
      const swap = repeat % 2 === 1
      const cacheKey = context.cache?.key([
        'pair',
        context.backend.model,
        context.backend.baseUrl,
        taskKey,
        criterion.id,
        a,
        b,
        repeat,
      ])
      const cached = cacheKey === undefined ? undefined : await context.cache?.get(cacheKey)
      let rewardA: number
      let rewardB: number
      if (cached !== undefined) {
        rewardA = cached.scoreA
        rewardB = cached.scoreB
      } else {
        const traceA = traces[swap ? b : a] ?? ''
        const traceB = traces[swap ? a : b] ?? ''
        const prompt = await buildPairPrompt({
          problem,
          traceA,
          traceB,
          criterion,
          groundTruthNote: context.groundTruthNote,
          nImages: 0,
        })
        try {
          const scored = await scoreOne(context.backend, prompt)
          rewardA = swap ? scored.rewardB : scored.rewardA
          rewardB = swap ? scored.rewardA : scored.rewardB
          if (cacheKey !== undefined) {
            await context.cache?.set(cacheKey, { scoreA: rewardA, scoreB: rewardB })
          }
        } catch (error) {
          const tied = tieOrThrow(error, context.backend)
          rewardA = tied.rewardA
          rewardB = tied.rewardB
        }
      }
      totalA += rewardA
      totalB += rewardB
      count += 1
    }
  }
  return {
    rewardA: count > 0 ? totalA / count : 0.5,
    rewardB: count > 0 ? totalB / count : 0.5,
  }
}

function prefixFor(taskKey: string, a: number, b: number, swap: boolean): string {
  const left = swap ? b : a
  const right = swap ? a : b
  return `${taskKey}:${left}:${right}`
}

/**
 * Build one scoring job per (criterion, repeat) for a directed pair. The
 * returned jobs are grouped so a warm-up pass can populate prompt-prefix
 * caches with one request per distinct prefix.
 */
async function buildJobs(
  context: ScoreContext,
  taskKey: string,
  problem: string,
  traces: string[],
  pairs: Array<[number, number]>,
): Promise<ScoreJob[]> {
  const jobs: ScoreJob[] = []
  for (const [a, b] of pairs) {
    if (a === b) continue
    for (const criterion of context.criteria) {
      for (let repeat = 0; repeat < context.evaluations; repeat += 1) {
        const swap = repeat % 2 === 1
        const traceA = traces[swap ? b : a] ?? ''
        const traceB = traces[swap ? a : b] ?? ''
        const prompt = await buildPairPrompt({
          problem,
          traceA,
          traceB,
          criterion,
          groundTruthNote: context.groundTruthNote,
          nImages: 0,
        })
        jobs.push({
          cacheKey: context.cache?.key([
            'pair',
            context.backend.model,
            context.backend.baseUrl,
            taskKey,
            criterion.id,
            a,
            b,
            repeat,
          ]) ?? '',
          criterion,
          repeat,
          swap,
          prompt,
          prefix: prefixFor(taskKey, a, b, swap),
          a,
          b,
        })
      }
    }
  }
  return jobs
}

interface PairAggregate extends DirectedReward {
  count: number
}

async function runScoreJobs(
  context: ScoreContext,
  jobs: ScoreJob[],
): Promise<Map<string, DirectedReward>> {
  const byPair = new Map<string, PairAggregate>()
  const fold = (job: ScoreJob, rewardA: number, rewardB: number): void => {
    const pairKey = `${job.a}:${job.b}`
    const aggregate = byPair.get(pairKey) ?? { rewardA: 0, rewardB: 0, count: 0 }
    aggregate.rewardA += rewardA
    aggregate.rewardB += rewardB
    aggregate.count += 1
    byPair.set(pairKey, aggregate)
  }

  const execute = async (job: ScoreJob): Promise<void> => {
    try {
      const scored = await scoreOne(context.backend, job.prompt)
      const rewardA = job.swap ? scored.rewardB : scored.rewardA
      const rewardB = job.swap ? scored.rewardA : scored.rewardB
      if (job.cacheKey.length > 0) {
        await context.cache?.set(job.cacheKey, { scoreA: rewardA, scoreB: rewardB })
      }
      fold(job, rewardA, rewardB)
    } catch (error) {
      const tied = tieOrThrow(error, context.backend)
      fold(job, tied.rewardA, tied.rewardB)
    }
  }

  const cold: ScoreJob[] = []
  for (const job of jobs) {
    const cached = job.cacheKey.length > 0 ? await context.cache?.get(job.cacheKey) : undefined
    if (cached === undefined) {
      cold.push(job)
    } else {
      fold(job, cached.scoreA, cached.scoreB)
    }
  }

  // Warm-up wave: one request per distinct prompt prefix populates the
  // provider's prefix cache, then the remaining jobs fan out concurrently.
  const byPrefix = new Map<string, ScoreJob[]>()
  for (const job of cold) {
    const group = byPrefix.get(job.prefix) ?? []
    group.push(job)
    byPrefix.set(job.prefix, group)
  }
  const warm: ScoreJob[] = []
  const rest: ScoreJob[] = []
  for (const group of byPrefix.values()) {
    const first = group.shift()
    if (first !== undefined) warm.push(first)
    rest.push(...group)
  }
  for (const job of warm) await execute(job)
  await mapWithConcurrency(rest, context.backend.maxConcurrency, execute)

  const normalized = new Map<string, DirectedReward>()
  for (const [key, aggregate] of byPair) {
    normalized.set(key, {
      rewardA: aggregate.rewardA / aggregate.count,
      rewardB: aggregate.rewardB / aggregate.count,
    })
  }
  return normalized
}

export interface VerifierOptions {
  ctx?: unknown
  settings?: BackendSettings
  overrides?: Partial<BackendSettings>
  cwd?: string
  cache?: boolean | string
  /** Pre-built backend instance; used by tests and library embedders. */
  backendInstance?: VerifierBackend
}

interface PreparedOptions {
  backend: VerifierBackend
  cache?: ScoreCache
}

function cacheFilePath(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolve(cwd, value)
}

async function prepare(options: VerifierOptions): Promise<PreparedOptions> {
  const backend = options.backendInstance ?? new VerifierBackend(await resolveBackend(options.ctx, options.settings, options.overrides))
  const cwd = options.cwd ?? process.cwd()
  let cache: ScoreCache | undefined
  if (options.cache === false || backend.baseUrl === '') {
    cache = undefined
  } else if (typeof options.cache === 'string') {
    cache = new ScoreCache(cacheFilePath(options.cache, cwd))
  } else if (options.settings?.cachePath !== undefined) {
    cache = new ScoreCache(cacheFilePath(options.settings.cachePath, cwd))
  }
  return { backend, cache }
}

/** Raw pairwise fine-grained rewards for two candidate trajectories. */
export async function compareTrajectories(
  problem: string,
  traceA: string,
  traceB: string,
  criteria: CriteriaArgument,
  evaluations = 1,
  options: VerifierOptions = {},
): Promise<CompareResult> {
  const prepared = await prepare(options)
  const document = await resolveCriteria(criteria, options.cwd ?? process.cwd())
  const groundTruthNote = document.groundTruthNote
  const context: ScoreContext = {
    backend: prepared.backend,
    cache: prepared.cache,
    groundTruthNote,
    criteria: document.criteria,
    evaluations: Math.max(1, evaluations),
  }
  const rewards = await scoreDirected(
    context,
    hashText(JSON.stringify([problem, traceA, traceB])),
    problem,
    [traceA, traceB],
    0,
    1,
  )
  await prepared.cache?.save()
  return {
    rewardA: rewards.rewardA,
    rewardB: rewards.rewardB,
    criteria: document.criteria.map((criterion) => criterion.id),
    evaluations: context.evaluations,
    usage: tokenUsage.snapshot(),
  }
}

/** Best-of-N selection through the probabilistic pivot tournament. */
export async function selectTrajectories(
  problem: string,
  candidates: string[],
  criteria: CriteriaArgument,
  evaluations = 4,
  pivots = 2,
  seed = 0,
  options: VerifierOptions = {},
): Promise<SelectResult> {
  if (candidates.length === 0) throw new Error('candidate list must not be empty')
  if (candidates.length === 1) {
    const document = await resolveCriteria(criteria, options.cwd ?? process.cwd())
    return {
      index: 0,
      best: candidates[0] ?? '',
      scores: [1],
      ranking: [0],
      nComparisons: 0,
      criteria: document.criteria.map((criterion) => criterion.id),
      evaluations: Math.max(1, evaluations),
      usage: tokenUsage.snapshot(),
    }
  }

  const prepared = await prepare(options)
  const document = await resolveCriteria(criteria, options.cwd ?? process.cwd())
  const context: ScoreContext = {
    backend: prepared.backend,
    cache: prepared.cache,
    groundTruthNote: document.groundTruthNote,
    criteria: document.criteria,
    evaluations: Math.max(1, evaluations),
  }
  const taskKey = `task-${hashText(JSON.stringify([problem, ...candidates]))}`

  const ring = await pptRing(candidates.length, seed)
  const ringJobs = await buildJobs(context, taskKey, problem, candidates, ring)
  const ringScores = await runScoreJobs(context, ringJobs)
  const ringComparisons: ComparisonEntry[] = ring
    .map(([a, b]) => {
      const reward = ringScores.get(`${a}:${b}`)
      return reward === undefined ? undefined : { a, b, rewardA: reward.rewardA, rewardB: reward.rewardB }
    })
    .filter((entry): entry is ComparisonEntry => entry !== undefined)

  const plan = await pptPlan({
    n: candidates.length,
    pivots,
    comparisons: ringComparisons,
  })
  const pivotJobs = await buildJobs(context, taskKey, problem, candidates, plan.pivotPairs as Array<[number, number]>)
  const pivotScores = await runScoreJobs(context, pivotJobs)
  const pivotComparisons: ComparisonEntry[] = (plan.pivotPairs as Array<[number, number]>)
    .map(([a, b]) => {
      const reward = pivotScores.get(`${a}:${b}`)
      return reward === undefined ? undefined : { a, b, rewardA: reward.rewardA, rewardB: reward.rewardB }
    })
    .filter((entry): entry is ComparisonEntry => entry !== undefined)

  const result = await pptResult({
    n: candidates.length,
    comparisons: [...ringComparisons, ...pivotComparisons],
  })
  await prepared.cache?.save()

  return {
    index: result.bestIndex,
    best: candidates[result.bestIndex] ?? '',
    scores: result.scores,
    ranking: result.ranking,
    nComparisons: result.nComparisons,
    criteria: document.criteria.map((criterion) => criterion.id),
    evaluations: context.evaluations,
    usage: tokenUsage.snapshot(),
  }
}

function chooseCheckpoints(total: number, requested: number[] | undefined): number[] {
  if (requested !== undefined && requested.length > 0) {
    for (const checkpoint of requested) {
      if (!Number.isInteger(checkpoint) || checkpoint < 1 || checkpoint > total) {
        throw new Error(`checkpoint ${checkpoint} is outside the valid range 1..${total}`)
      }
    }
    return [...new Set(requested)].sort((a, b) => a - b)
  }
  if (total <= 12) return Array.from({ length: total }, (_, index) => index + 1)
  const count = 10
  const steps: number[] = []
  for (let index = 0; index < count; index += 1) {
    steps.push(Math.round(1 + (index * (total - 1)) / (count - 1)))
  }
  return [...new Set(steps)]
}

/** Offline checkpoint progress curve for a finished trajectory. */
export async function trackProgress(
  problem: string,
  steps: string[],
  checkpointSteps: number[] | undefined,
  evaluations = 1,
  options: VerifierOptions = {},
): Promise<ProgressResult> {
  if (steps.length === 0) throw new Error('step list must not be empty')
  const prepared = await prepare(options)
  const backend = prepared.backend
  const checkpoints = chooseCheckpoints(steps.length, checkpointSteps)
  const repeats = Math.max(1, evaluations)
  const prompt = await buildProgressPrompt({
    problem,
    steps,
    checkpointSteps: checkpoints,
    nImages: 0,
  })

  const run = async (): Promise<Array<number | null>> => {
    try {
      const verification = await backend.complete(prompt, [])
      return await extractProgress({
        text: verification.text,
        tokens: verification.tokens,
        positions: verification.positions,
        count: checkpoints.length,
      })
    } catch (error) {
      if (backend.onError === 'raise') throw error
      return Array.from({ length: checkpoints.length }, () => 0.5)
    }
  }

  const perEvaluation = repeats === 1 ? [await run()] : await mapWithConcurrency(
    Array.from({ length: repeats }, (_, index) => index),
    backend.maxConcurrency,
    run,
  )

  const scores = checkpoints.map((_, checkpointIndex) => {
    const values = perEvaluation
      .map((row) => row[checkpointIndex])
      .filter((value): value is number => value !== null && value !== undefined)
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0.5
  })

  return { steps: checkpoints, scores, perEvaluation, usage: tokenUsage.snapshot() }
}
