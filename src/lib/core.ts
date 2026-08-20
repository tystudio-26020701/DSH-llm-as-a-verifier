/**
 * dsh-verifier-core wasm loader.
 *
 * The Rust core is a self-contained `wasm32-unknown-unknown` module. This
 * file owns the ABI conversation only: it loads the module lazily, copies
 * JSON bytes through the wasm heap, and unwraps the `{ok, value|error}`
 * envelope every core operation returns.
 *
 * The loader probes two well-known locations so the same bundle works both
 * in a copied DeepSeek Harness preset and in the repository build output.
 */

import { readFile } from 'node:fs/promises'

export interface LogprobToken {
  token: string
  logprob: number
}

export type TokenPositions = LogprobToken[][]

export interface CoreEnvelope<T = unknown> {
  ok: boolean
  value?: T
  error?: string
}

export interface PairPromptInput {
  problem: string
  traceA: string
  traceB: string
  criterion: { name: string; description: string }
  groundTruthNote?: string
  nImages?: number
}

export interface ProgressPromptInput {
  problem: string
  steps: string[]
  checkpointSteps: number[]
  nImages?: number
}

export interface ScoreExtractionInput {
  text: string
  tokens?: string[] | null
  positions?: TokenPositions | null
  tag: string
}

export interface ProgressExtractionInput extends Omit<ScoreExtractionInput, 'tag'> {
  count: number
}

export interface ComparisonEntry {
  a: number
  b: number
  rewardA: number
  rewardB: number
}

export interface PptPlan {
  pivots: number[]
  pivotPairs: [number, number][]
}

export interface PptResult {
  bestIndex: number
  scores: number[]
  ranking: number[]
  nComparisons: number
}

interface WasmExports {
  lv_init(): void
  lv_alloc(len: number): number
  lv_free(ptr: number, len: number): void
  lv_dispatch(opPtr: number, opLen: number, inputPtr: number, inputLen: number): bigint
  memory: { buffer: ArrayBufferLike }
}

interface CoreInstance {
  exports: WasmExports
}

interface WebAssemblyApi {
  instantiate(bytes: Uint8Array, imports?: unknown): Promise<{ instance: { exports: WasmExports } }>
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const wasmApi = (globalThis as { WebAssembly?: unknown }).WebAssembly as unknown as WebAssemblyApi | undefined
let corePromise: Promise<CoreInstance> | undefined

async function probeCandidates(): Promise<string[]> {
  const candidates = [
    new URL('./verifier-core.wasm', import.meta.url),
    new URL('../verifier-core.wasm', import.meta.url),
    new URL('../../preset/llm-as-a-verifier/verifier-core.wasm', import.meta.url),
  ]
  return candidates.map((url) => url.pathname)
}

async function findWasmPath(): Promise<string> {
  for (const path of await probeCandidates()) {
    try {
      await readFile(path)
      return path
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(
    'dsh-verifier-core.wasm was not found next to the verifier preset bundle; run `npm run build:wasm` and reinstall the preset',
  )
}

async function instantiate(): Promise<CoreInstance> {
  if (wasmApi === undefined) throw new Error('WebAssembly is unavailable in this runtime')
  const path = await findWasmPath()
  const bytes = await readFile(path)
  const module = await wasmApi.instantiate(bytes, {})
  const instance = module.instance as unknown as CoreInstance
  instance.exports.lv_init()
  return instance
}

async function getCore(): Promise<CoreInstance> {
  corePromise ??= instantiate().catch((error: unknown) => {
    corePromise = undefined
    throw error
  })
  return corePromise
}

/**
 * Run one named core operation. Input is JSON-encoded on the JS side and the
 * response envelope is decoded back into plain objects. All values cross the
 * ABI as lossless JSON, so numbers keep their precision.
 */
export async function callCore<T = unknown>(op: string, input: unknown = {}): Promise<T> {
  const core = await getCore()
  const opBytes = encoder.encode(op)
  const inputBytes = encoder.encode(JSON.stringify(input))

  const opPtr = core.exports.lv_alloc(opBytes.length)
  const inputPtr = core.exports.lv_alloc(inputBytes.length)
  if (opPtr === 0 || inputPtr === 0) {
    if (opPtr !== 0) core.exports.lv_free(opPtr, opBytes.length)
    if (inputPtr !== 0) core.exports.lv_free(inputPtr, inputBytes.length)
    throw new Error('dsh-verifier-core wasm heap allocation failed')
  }

  try {
    new Uint8Array(core.exports.memory.buffer, opPtr, opBytes.length).set(opBytes)
    new Uint8Array(core.exports.memory.buffer, inputPtr, inputBytes.length).set(inputBytes)
    const packed = core.exports.lv_dispatch(opPtr, opBytes.length, inputPtr, inputBytes.length)
    const resultPtr = Number(packed >> 32n)
    const resultLen = Number(packed & 0xffff_ffffn)
    if (resultPtr === 0 || resultLen === 0) {
      throw new Error('dsh-verifier-core returned an empty result')
    }
    try {
      const resultBytes = new Uint8Array(core.exports.memory.buffer, resultPtr, resultLen).slice()
      const envelope = JSON.parse(decoder.decode(resultBytes)) as CoreEnvelope<T>
      if (!envelope.ok) {
        throw new Error(envelope.error ?? `dsh-verifier-core operation ${op} failed`)
      }
      return envelope.value as T
    } finally {
      core.exports.lv_free(resultPtr, resultLen)
    }
  } finally {
    core.exports.lv_free(opPtr, opBytes.length)
    core.exports.lv_free(inputPtr, inputBytes.length)
  }
}

export async function coreVersion(): Promise<string> {
  const version = await callCore<{ version: string }>('version')
  return version.version
}

export function buildPairPrompt(input: PairPromptInput): Promise<string> {
  return callCore<string>('pair_prompt', input)
}

export function buildProgressPrompt(input: ProgressPromptInput): Promise<string> {
  return callCore<string>('progress_prompt', input)
}

export function extractScore(input: ScoreExtractionInput): Promise<number> {
  return callCore<number>('extract_score', input)
}

export function extractProgress(input: ProgressExtractionInput): Promise<Array<number | null>> {
  return callCore<Array<number | null>>('extract_progress', input)
}

export async function pptRing(n: number, seed: number): Promise<[number, number][]> {
  const ring = await callCore<[number, number][]>('ppt_ring', { n, seed })
  return ring.map((pair) => [Number(pair[0]), Number(pair[1])])
}

export function pptPlan(input: {
  n: number
  pivots: number
  comparisons: ComparisonEntry[]
}): Promise<PptPlan> {
  return callCore<PptPlan>('ppt_plan', {
    n: input.n,
    pivots: input.pivots,
    comparisons: input.comparisons.map((entry) => [entry.a, entry.b, entry.rewardA, entry.rewardB]),
  })
}

export function pptResult(input: {
  n: number
  comparisons: ComparisonEntry[]
}): Promise<PptResult> {
  return callCore<PptResult>('ppt_result', {
    n: input.n,
    comparisons: input.comparisons.map((entry) => [entry.a, entry.b, entry.rewardA, entry.rewardB]),
  })
}
