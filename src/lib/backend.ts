/**
 * Verifier model backends.
 *
 * The preset talks to any provider that speaks the OpenAI chat-completions
 * protocol and returns token-level logprobs:
 *  - the DeepSeek official API (thinking + reasoning effort enabled), and
 *  - any OpenAI-compatible server such as vLLM/SGLang/OpenAI/Vertex.
 *
 * For open-model servers that do not emit `<score_A>` / `<score_B>` tags by
 * themselves, the backend performs a constrained one-token continuation at
 * each score position (`continue_final_message`) so the returned top-logprobs
 * become the model's distribution over the 20-level letter scale.
 *
 * Everything here uses the built-in `fetch`; the preset has zero npm runtime
 * dependencies.
 */

import { tokenUsage } from './usage.js'

export type BackendKind = 'deepseek' | 'openai'
export type Effort = 'off' | 'low' | 'high' | 'max'
export type OnError = 'tie' | 'raise'

export interface BackendSettings {
  backend?: 'auto' | BackendKind
  baseUrl?: string
  apiKey?: string
  apiKeyEnv?: string
  model?: string
  maxTokens?: number
  effort?: Effort
  maxConcurrency?: number
  timeoutMs?: number
  onError?: OnError
  cachePath?: string
}

export interface VerifierUsage {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningTokens: number
}

export interface CompletedVerification {
  text: string
  tokens: string[] | null
  positions: Array<Array<{ token: string; logprob: number }>> | null
  usage: VerifierUsage
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRST'
const SCORE_TAGS = ['<score_A>', '<score_B>']
const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash'
const DEFAULT_DEEPSEEK_MAX_TOKENS = 32768
const DEFAULT_OPENAI_MAX_TOKENS = 4096
const DEFAULT_TIMEOUT_MS = 120_000

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function readSettingsSection(ctx: unknown): Record<string, unknown> | undefined {
  try {
    const settings = (ctx as { get?: (name: string) => unknown } | undefined)?.get?.('settings')
    const describe = (settings as { describe?: () => unknown } | undefined)?.describe?.()
    const described = Array.isArray(describe) ? describe : undefined
    const section = described?.find((entry: unknown) => {
      const record = entry as { ns?: unknown }
      return record?.ns === 'dsh-verifier'
    })
    const value = (section as { value?: unknown } | undefined)?.value
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

async function resolveCredential(ctx: unknown, envName: string): Promise<string | undefined> {
  try {
    const credentials = (ctx as { get?: (name: string) => unknown } | undefined)?.get?.('credentials')
    const resolver = (credentials as { resolve?: (ref: string) => Promise<unknown> } | undefined)?.resolve
    if (typeof resolver === 'function') {
      const resolved = await resolver(envName)
      const value = typeof resolved === 'string'
        ? resolved
        : typeof resolved === 'object' && resolved !== null && 'value' in resolved
          ? String((resolved as { value: unknown }).value)
          : undefined
      return nonEmpty(value)
    }
  } catch {
    // Fall through to the process environment.
  }
  return nonEmpty(process.env[envName])
}

export interface ResolvedBackend {
  kind: BackendKind
  baseUrl: string
  apiKey: string
  model: string
  maxTokens: number
  effort: Effort
  maxConcurrency: number
  timeoutMs: number
  onError: OnError
  cachePath: string | undefined
}

function normalizeEffort(value: unknown): Effort {
  if (value === 'off' || value === 'disabled' || value === 'none') return 'off'
  if (value === 'low' || value === 'high' || value === 'max') return value
  return 'high'
}

function envNumber(name: string): number | undefined {
  const value = process.env[name]
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined
}

/**
 * Merge row config, user settings, explicit call options and environment.
 * Explicit `overrides` (tool arguments) win over the preset configuration.
 */
export async function resolveBackend(
  ctx: unknown,
  settings: BackendSettings | undefined,
  overrides: Partial<BackendSettings> = {},
): Promise<ResolvedBackend> {
  const section = readSettingsSection(ctx)
  const merged: BackendSettings = {
    ...settings,
    ...section,
    ...overrides,
  }

  const envBaseUrl = nonEmpty(process.env.VERIFIER_BASE_URL)
    ?? nonEmpty(process.env.DEEPSEEK_BASE_URL)
    ?? nonEmpty(process.env.OPENAI_BASE_URL)
  const baseUrlInput = nonEmpty(merged.baseUrl) ?? envBaseUrl
  const hasDeepSeekKey = nonEmpty(process.env.DEEPSEEK_API_KEY) !== undefined

  let kind: BackendKind
  let baseUrl: string
  if (merged.backend === 'deepseek') {
    kind = 'deepseek'
    baseUrl = baseUrlInput ?? DEFAULT_DEEPSEEK_BASE_URL
  } else if (merged.backend === 'openai') {
    kind = 'openai'
    if (baseUrlInput === undefined) {
      throw new Error('OpenAI-compatible backend needs VERIFIER_BASE_URL or OPENAI_BASE_URL (or set backend to deepseek)')
    }
    baseUrl = baseUrlInput
  } else if (baseUrlInput?.includes('api.deepseek.com') || (baseUrlInput === undefined && hasDeepSeekKey)) {
    kind = 'deepseek'
    baseUrl = baseUrlInput ?? DEFAULT_DEEPSEEK_BASE_URL
  } else if (baseUrlInput !== undefined) {
    kind = 'openai'
    baseUrl = baseUrlInput
  } else {
    kind = 'deepseek'
    baseUrl = DEFAULT_DEEPSEEK_BASE_URL
  }

  const apiKeyEnv = merged.apiKeyEnv ?? (kind === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'OPENAI_API_KEY')
  const apiKey = merged.apiKey
    ?? await resolveCredential(ctx, 'VERIFIER_API_KEY')
    ?? await resolveCredential(ctx, apiKeyEnv)
  if (apiKey === undefined || apiKey.length === 0) {
    const hint = kind === 'deepseek'
      ? 'set DEEPSEEK_API_KEY (or VERIFIER_API_KEY) in the environment or DSH credentials'
      : 'set OPENAI_API_KEY (or VERIFIER_API_KEY) for the endpoint in the environment or DSH credentials'
    const error = new Error(`verifier backend is not configured: ${hint}`) as Error & { code?: string }
    error.code = 'MISSING_CREDENTIAL'
    throw error
  }

  const model = nonEmpty(merged.model)
    ?? nonEmpty(process.env.VERIFIER_MODEL)
    ?? (kind === 'deepseek' ? DEFAULT_DEEPSEEK_MODEL : undefined)
  if (model === undefined) {
    throw new Error('verifier model is required for an OpenAI-compatible backend; set VERIFIER_MODEL or pass `model`')
  }

  return {
    kind,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    model,
    maxTokens: positiveInt(merged.maxTokens)
      ?? envNumber('VERIFIER_MAX_TOKENS')
      ?? envNumber('DEEPSEEK_MAX_TOKENS')
      ?? (kind === 'deepseek' ? DEFAULT_DEEPSEEK_MAX_TOKENS : DEFAULT_OPENAI_MAX_TOKENS),
    effort: normalizeEffort(merged.effort ?? process.env.VERIFIER_EFFORT ?? process.env.DEEPSEEK_EFFORT),
    maxConcurrency: positiveInt(merged.maxConcurrency)
      ?? envNumber('VERIFIER_MAX_CONCURRENCY')
      ?? (kind === 'deepseek' ? 8 : 4),
    timeoutMs: positiveInt(merged.timeoutMs) ?? envNumber('VERIFIER_TIMEOUT_MS') ?? DEFAULT_TIMEOUT_MS,
    onError: merged.onError === 'raise' ? 'raise' : 'tie',
    cachePath: nonEmpty(merged.cachePath),
  }
}

interface ChatCompletionLogprob {
  token?: string
  logprob?: number
  top_logprobs?: Array<{ token?: string; logprob?: number }> | null
}

interface ChatCompletionChoice {
  message?: {
    content?: string | null
    reasoning_content?: string | null
    reasoning?: string | null
  }
  logprobs?: {
    content?: ChatCompletionLogprob[] | null
  } | null
  finish_reason?: string | null
}

interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
    completion_tokens_details?: { reasoning_tokens?: number }
    prompt_cache_hit_tokens?: number
  }
}

interface ChatRequestBody {
  model: string
  messages: Array<{ role: string; content: string }>
  max_tokens: number
  temperature: number
  logprobs: boolean
  top_logprobs: number
  thinking?: { type: 'enabled' | 'disabled' }
  reasoning_effort?: Effort
  chat_template_kwargs?: { enable_thinking: boolean }
  add_generation_prompt?: boolean
  continue_final_message?: boolean
  structured_outputs?: { choice: string[] }
}

function extractUsage(payload: ChatCompletionResponse): VerifierUsage {
  const usage = payload.usage
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
  }
}

function extractVerification(payload: ChatCompletionResponse, usage: VerifierUsage, kind: BackendKind): CompletedVerification {
  const choice = payload.choices?.[0]
  const message = choice?.message
  const text = message?.content ?? message?.reasoning_content ?? message?.reasoning ?? ''
  const content = choice?.logprobs?.content ?? null
  const tokens: string[] | null = content === null ? null : content.map((entry) => entry.token ?? '')
  const positions = content === null
    ? null
    : content.map((entry) => {
        const alternatives = entry.top_logprobs && entry.top_logprobs.length > 0
          ? entry.top_logprobs.map((alternative) => ({ token: alternative.token ?? '', logprob: alternative.logprob ?? 0 }))
          : [{ token: entry.token ?? '', logprob: entry.logprob ?? 0 }]
        return alternatives
      })
  if (kind === 'deepseek' && positions === null) {
    const error = new Error(
      `DeepSeek returned no answer logprobs (finish_reason=${choice?.finish_reason ?? 'unknown'}); raise the max tokens or lower the reasoning effort`,
    ) as Error & { code?: string }
    error.code = 'MISSING_LOGPROBS'
    throw error
  }
  return { text, tokens, positions, usage }
}

export class VerifierBackend {
  constructor(private readonly resolved: ResolvedBackend) {}

  get kind(): BackendKind {
    return this.resolved.kind
  }

  get model(): string {
    return this.resolved.model
  }

  get maxConcurrency(): number {
    return this.resolved.maxConcurrency
  }

  get onError(): OnError {
    return this.resolved.onError
  }

  get baseUrl(): string {
    return this.resolved.baseUrl
  }

  private baseBody(prompt: string): ChatRequestBody {
    const body: ChatRequestBody = {
      model: this.resolved.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: this.resolved.maxTokens,
      temperature: 1,
      logprobs: true,
      top_logprobs: 20,
    }
    if (this.resolved.kind === 'deepseek') {
      if (this.resolved.effort === 'off') {
        body.thinking = { type: 'disabled' }
      } else {
        body.thinking = { type: 'enabled' }
        body.reasoning_effort = this.resolved.effort
      }
    }
    return body
  }

  private async post(body: ChatRequestBody): Promise<ChatCompletionResponse> {
    const response = await fetch(`${this.resolved.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.resolved.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.resolved.timeoutMs),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`verifier backend ${response.status}: ${text.slice(0, 400)}`)
    }
    try {
      return JSON.parse(text) as ChatCompletionResponse
    } catch {
      throw new Error('verifier backend returned non-JSON content')
    }
  }

  private async callOnce(body: ChatRequestBody): Promise<CompletedVerification> {
    const payload = await this.post(body)
    const usage = extractUsage(payload)
    tokenUsage.add(usage)
    return extractVerification(payload, usage, this.resolved.kind)
  }

  private analysisPrefix(text: string): string {
    const indexes = SCORE_TAGS.map((tag) => text.indexOf(tag)).filter((index) => index >= 0)
    const first = indexes.length > 0 ? Math.min(...indexes) : text.length
    return text.slice(0, first).trimEnd()
  }

  /**
   * Constrained continuation at one score tag. Only used for OpenAI-compatible
   * servers that do not emit the tags themselves.
   */
  private async prefillScoreTag(body: ChatRequestBody, prefix: string, tag: string): Promise<{ text: string; letter: string; closing: string; positions: Array<{ token: string; logprob: number }> }> {
    const choices = [...LETTERS, ...LETTERS.split('').map((letter) => ` ${letter}`)]
    const prefillBody: ChatRequestBody = {
      ...body,
      messages: [...body.messages, { role: 'assistant', content: prefix }],
      max_tokens: 1,
      add_generation_prompt: false,
      continue_final_message: true,
      structured_outputs: { choice: choices },
    }
    const payload = await this.post(prefillBody)
    const usage = extractUsage(payload)
    tokenUsage.add(usage)
    const choice = payload.choices?.[0]
    const content = choice?.logprobs?.content
    if (content === null || content === undefined || content.length === 0) {
      throw new Error(`verifier backend does not support constrained continuation for ${tag}`)
    }
    const first = content[0]
    const alternatives = first?.top_logprobs && first.top_logprobs.length > 0
      ? first.top_logprobs.map((item) => ({ token: item.token ?? '', logprob: item.logprob ?? 0 }))
      : [{ token: first?.token ?? '', logprob: first?.logprob ?? 0 }]
    const sampled = messageText(choice) || first?.token || alternatives[0]?.token || ''
    const letter = [...sampled.trim()].find((character) => LETTERS.includes(character.toUpperCase()))
    if (letter === undefined) {
      throw new Error(`verifier backend sampled an invalid score token for ${tag}: ${JSON.stringify(sampled)}`)
    }
    const closing = `</${tag.slice(1)}`
    return { text: `${prefix}\n${tag}${letter}${closing}`, letter, closing, positions: alternatives }
  }

  async complete(prompt: string, scoreTags = SCORE_TAGS): Promise<CompletedVerification> {
    const body = this.baseBody(prompt)
    let result: CompletedVerification
    if (this.resolved.kind === 'openai') {
      try {
        result = await this.callOnce({ ...body, chat_template_kwargs: { enable_thinking: false } })
      } catch {
        result = await this.callOnce(body)
      }
      const missingTags = scoreTags.filter((tag) => !result.text.includes(tag))
      if (missingTags.length > 0) {
        const analysis = this.analysisPrefix(result.text)
        let combined = analysis
        const tokens: string[] = [analysis]
        const positions: Array<Array<{ token: string; logprob: number }>> = [[]]
        for (const tag of scoreTags) {
          const filled = await this.prefillScoreTag(body, combined, tag)
          combined = filled.text
          tokens.push(`\n${tag}`, filled.letter, filled.closing)
          positions.push([], filled.positions, [])
        }
        positions.push([])
        return {
          text: combined,
          tokens,
          positions,
          usage: result.usage,
        }
      }
      return result
    }
    result = await this.callOnce(body)
    return result
  }
}

function messageText(choice: ChatCompletionChoice | undefined): string {
  return choice?.message?.content ?? choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? ''
}

/** Bounded fan-out for verifier calls, honoring the backend concurrency cap. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      const item = items[index]
      if (item !== undefined) results[index] = await worker(item, index)
    }
  })
  await Promise.all(runners)
  return results
}

export function backendSummary(backend: VerifierBackend): Record<string, unknown> {
  return {
    kind: backend.kind,
    baseUrl: backend.baseUrl,
    model: backend.model,
    maxConcurrency: backend.maxConcurrency,
    onError: backend.onError,
  }
}
