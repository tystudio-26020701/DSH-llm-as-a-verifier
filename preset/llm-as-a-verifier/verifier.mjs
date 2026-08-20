// (c) 2026 Beijing Taiyin Zhaowu Technology Co., Ltd. — original implementation; PolyForm Noncommercial 1.0.0

// src/lib/usage.ts
var TokenUsage = class {
  calls = 0;
  inputTokens = 0;
  cachedInputTokens = 0;
  outputTokens = 0;
  reasoningTokens = 0;
  reset() {
    this.calls = 0;
    this.inputTokens = 0;
    this.cachedInputTokens = 0;
    this.outputTokens = 0;
    this.reasoningTokens = 0;
  }
  add(record, calls = 1) {
    this.calls += calls;
    this.inputTokens += record.inputTokens ?? 0;
    this.cachedInputTokens += record.cachedInputTokens ?? 0;
    this.outputTokens += record.outputTokens ?? 0;
    this.reasoningTokens += record.reasoningTokens ?? 0;
  }
  snapshot() {
    return {
      calls: this.calls,
      inputTokens: this.inputTokens,
      cachedInputTokens: this.cachedInputTokens,
      outputTokens: this.outputTokens,
      reasoningTokens: this.reasoningTokens
    };
  }
};
var tokenUsage = new TokenUsage();

// src/lib/backend.ts
var LETTERS = "ABCDEFGHIJKLMNOPQRST";
var SCORE_TAGS = ["<score_A>", "<score_B>"];
var DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
var DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
var DEFAULT_DEEPSEEK_MAX_TOKENS = 32768;
var DEFAULT_OPENAI_MAX_TOKENS = 4096;
var DEFAULT_TIMEOUT_MS = 12e4;
function nonEmpty(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function positiveInt(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : void 0;
}
function readSettingsSection(ctx) {
  try {
    const settings = ctx?.get?.("settings");
    const describe = settings?.describe?.();
    const described = Array.isArray(describe) ? describe : void 0;
    const section = described?.find((entry) => {
      const record = entry;
      return record?.ns === "dsh-verifier";
    });
    const value = section?.value;
    return typeof value === "object" && value !== null ? value : void 0;
  } catch {
    return void 0;
  }
}
async function resolveCredential(ctx, envName) {
  try {
    const credentials = ctx?.get?.("credentials");
    const resolver = credentials?.resolve;
    if (typeof resolver === "function") {
      const resolved = await resolver(envName);
      const value = typeof resolved === "string" ? resolved : typeof resolved === "object" && resolved !== null && "value" in resolved ? String(resolved.value) : void 0;
      return nonEmpty(value);
    }
  } catch {
  }
  return nonEmpty(process.env[envName]);
}
function normalizeEffort(value) {
  if (value === "off" || value === "disabled" || value === "none") return "off";
  if (value === "low" || value === "high" || value === "max") return value;
  return "high";
}
function envNumber(name2) {
  const value = process.env[name2];
  if (value === void 0) return void 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : void 0;
}
async function resolveBackend(ctx, settings, overrides = {}) {
  const section = readSettingsSection(ctx);
  const merged = {
    ...settings,
    ...section,
    ...overrides
  };
  const envBaseUrl = nonEmpty(process.env.VERIFIER_BASE_URL) ?? nonEmpty(process.env.DEEPSEEK_BASE_URL) ?? nonEmpty(process.env.OPENAI_BASE_URL);
  const baseUrlInput = nonEmpty(merged.baseUrl) ?? envBaseUrl;
  const hasDeepSeekKey = nonEmpty(process.env.DEEPSEEK_API_KEY) !== void 0;
  let kind;
  let baseUrl;
  if (merged.backend === "deepseek") {
    kind = "deepseek";
    baseUrl = baseUrlInput ?? DEFAULT_DEEPSEEK_BASE_URL;
  } else if (merged.backend === "openai") {
    kind = "openai";
    baseUrl = baseUrlInput ?? DEFAULT_DEEPSEEK_BASE_URL;
  } else if (baseUrlInput?.includes("api.deepseek.com") || baseUrlInput === void 0 && hasDeepSeekKey) {
    kind = "deepseek";
    baseUrl = baseUrlInput ?? DEFAULT_DEEPSEEK_BASE_URL;
  } else if (baseUrlInput !== void 0) {
    kind = "openai";
    baseUrl = baseUrlInput;
  } else {
    kind = "deepseek";
    baseUrl = DEFAULT_DEEPSEEK_BASE_URL;
  }
  const apiKeyEnv = merged.apiKeyEnv ?? (kind === "deepseek" ? "DEEPSEEK_API_KEY" : "OPENAI_API_KEY");
  const apiKey = merged.apiKey ?? await resolveCredential(ctx, apiKeyEnv);
  if (apiKey === void 0 || apiKey.length === 0) {
    const hint = kind === "deepseek" ? "set DEEPSEEK_API_KEY (or VERIFIER_API_KEY) in the environment or DSH credentials" : "set OPENAI_API_KEY (or VERIFIER_API_KEY) for the endpoint in the environment or DSH credentials";
    const error = new Error(`verifier backend is not configured: ${hint}`);
    error.code = "MISSING_CREDENTIAL";
    throw error;
  }
  const model = nonEmpty(merged.model) ?? nonEmpty(process.env.VERIFIER_MODEL) ?? (kind === "deepseek" ? DEFAULT_DEEPSEEK_MODEL : void 0);
  if (model === void 0) {
    throw new Error("verifier model is required for an OpenAI-compatible backend; set VERIFIER_MODEL or pass `model`");
  }
  return {
    kind,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    model,
    maxTokens: positiveInt(merged.maxTokens) ?? envNumber("VERIFIER_MAX_TOKENS") ?? envNumber("DEEPSEEK_MAX_TOKENS") ?? (kind === "deepseek" ? DEFAULT_DEEPSEEK_MAX_TOKENS : DEFAULT_OPENAI_MAX_TOKENS),
    effort: normalizeEffort(merged.effort ?? process.env.VERIFIER_EFFORT ?? process.env.DEEPSEEK_EFFORT),
    maxConcurrency: positiveInt(merged.maxConcurrency) ?? envNumber("VERIFIER_MAX_CONCURRENCY") ?? (kind === "deepseek" ? 8 : 4),
    timeoutMs: positiveInt(merged.timeoutMs) ?? envNumber("VERIFIER_TIMEOUT_MS") ?? DEFAULT_TIMEOUT_MS,
    onError: merged.onError === "raise" ? "raise" : "tie",
    cachePath: nonEmpty(merged.cachePath)
  };
}
function extractUsage(payload) {
  const usage = payload.usage;
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0
  };
}
function extractVerification(payload, usage, kind) {
  const choice = payload.choices?.[0];
  const message = choice?.message;
  const text = message?.content ?? message?.reasoning_content ?? message?.reasoning ?? "";
  const content = choice?.logprobs?.content ?? null;
  const tokens = content === null ? null : content.map((entry) => entry.token ?? "");
  const positions = content === null ? null : content.map((entry) => {
    const alternatives = entry.top_logprobs && entry.top_logprobs.length > 0 ? entry.top_logprobs.map((alternative) => ({ token: alternative.token ?? "", logprob: alternative.logprob ?? 0 })) : [{ token: entry.token ?? "", logprob: entry.logprob ?? 0 }];
    return alternatives;
  });
  if (kind === "deepseek" && positions === null) {
    const error = new Error(
      `DeepSeek returned no answer logprobs (finish_reason=${choice?.finish_reason ?? "unknown"}); raise the max tokens or lower the reasoning effort`
    );
    error.code = "MISSING_LOGPROBS";
    throw error;
  }
  return { text, tokens, positions, usage };
}
var VerifierBackend = class {
  constructor(resolved) {
    this.resolved = resolved;
  }
  get kind() {
    return this.resolved.kind;
  }
  get model() {
    return this.resolved.model;
  }
  get maxConcurrency() {
    return this.resolved.maxConcurrency;
  }
  get onError() {
    return this.resolved.onError;
  }
  get baseUrl() {
    return this.resolved.baseUrl;
  }
  baseBody(prompt) {
    const body = {
      model: this.resolved.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: this.resolved.maxTokens,
      temperature: 1,
      logprobs: true,
      top_logprobs: 20
    };
    if (this.resolved.kind === "deepseek") {
      if (this.resolved.effort === "off") {
        body.thinking = { type: "disabled" };
      } else {
        body.thinking = { type: "enabled" };
        body.reasoning_effort = this.resolved.effort;
      }
    }
    return body;
  }
  async post(body) {
    const response = await fetch(`${this.resolved.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.resolved.apiKey}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.resolved.timeoutMs)
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`verifier backend ${response.status}: ${text.slice(0, 400)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("verifier backend returned non-JSON content");
    }
  }
  async callOnce(body) {
    const payload = await this.post(body);
    const usage = extractUsage(payload);
    tokenUsage.add(usage);
    return extractVerification(payload, usage, this.resolved.kind);
  }
  analysisPrefix(text) {
    const indexes = SCORE_TAGS.map((tag) => text.indexOf(tag)).filter((index) => index >= 0);
    const first = indexes.length > 0 ? Math.min(...indexes) : text.length;
    return text.slice(0, first).trimEnd();
  }
  /**
   * Constrained continuation at one score tag. Only used for OpenAI-compatible
   * servers that do not emit the tags themselves.
   */
  async prefillScoreTag(body, prefix, tag) {
    const choices = [...LETTERS, ...LETTERS.split("").map((letter2) => ` ${letter2}`)];
    const prefillBody = {
      ...body,
      messages: [...body.messages, { role: "assistant", content: prefix }],
      max_tokens: 1,
      add_generation_prompt: false,
      continue_final_message: true,
      structured_outputs: { choice: choices }
    };
    const payload = await this.post(prefillBody);
    const usage = extractUsage(payload);
    tokenUsage.add(usage);
    const choice = payload.choices?.[0];
    const content = choice?.logprobs?.content;
    if (content === null || content === void 0 || content.length === 0) {
      throw new Error(`verifier backend does not support constrained continuation for ${tag}`);
    }
    const first = content[0];
    const alternatives = first?.top_logprobs && first.top_logprobs.length > 0 ? first.top_logprobs.map((item) => ({ token: item.token ?? "", logprob: item.logprob ?? 0 })) : [{ token: first?.token ?? "", logprob: first?.logprob ?? 0 }];
    const sampled = messageText(choice) || first?.token || alternatives[0]?.token || "";
    const letter = [...sampled.trim()].find((character) => LETTERS.includes(character.toUpperCase()));
    if (letter === void 0) {
      throw new Error(`verifier backend sampled an invalid score token for ${tag}: ${JSON.stringify(sampled)}`);
    }
    const closing = `</${tag.slice(1)}`;
    return { text: `${prefix}
${tag}${letter}${closing}`, letter, closing, positions: alternatives };
  }
  async complete(prompt, scoreTags = SCORE_TAGS) {
    const body = this.baseBody(prompt);
    let result;
    if (this.resolved.kind === "openai") {
      try {
        result = await this.callOnce({ ...body, chat_template_kwargs: { enable_thinking: false } });
      } catch {
        result = await this.callOnce(body);
      }
      const missingTags = scoreTags.filter((tag) => !result.text.includes(tag));
      if (missingTags.length > 0) {
        const analysis = this.analysisPrefix(result.text);
        let combined = analysis;
        const tokens = [analysis];
        const positions = [[]];
        for (const tag of scoreTags) {
          const filled = await this.prefillScoreTag(body, combined, tag);
          combined = filled.text;
          tokens.push(`
${tag}`, filled.letter, filled.closing);
          positions.push([], filled.positions, []);
        }
        positions.push([]);
        return {
          text: combined,
          tokens,
          positions,
          usage: result.usage
        };
      }
      return result;
    }
    result = await this.callOnce(body);
    return result;
  }
};
function messageText(choice) {
  return choice?.message?.content ?? choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? "";
}
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item !== void 0) results[index] = await worker(item, index);
    }
  });
  await Promise.all(runners);
  return results;
}
function backendSummary(backend) {
  return {
    kind: backend.kind,
    baseUrl: backend.baseUrl,
    model: backend.model,
    maxConcurrency: backend.maxConcurrency,
    onError: backend.onError
  };
}

// src/lib/core.ts
import { readFile } from "node:fs/promises";
var encoder = new TextEncoder();
var decoder = new TextDecoder();
var wasmApi = globalThis.WebAssembly;
var corePromise;
async function probeCandidates() {
  const candidates = [
    new URL("./verifier-core.wasm", import.meta.url),
    new URL("../verifier-core.wasm", import.meta.url),
    new URL("../../preset/llm-as-a-verifier/verifier-core.wasm", import.meta.url)
  ];
  return candidates.map((url) => url.pathname);
}
async function findWasmPath() {
  for (const path of await probeCandidates()) {
    try {
      await readFile(path);
      return path;
    } catch {
    }
  }
  throw new Error(
    "dsh-verifier-core.wasm was not found next to the verifier preset bundle; run `npm run build:wasm` and reinstall the preset"
  );
}
async function instantiate() {
  if (wasmApi === void 0) throw new Error("WebAssembly is unavailable in this runtime");
  const path = await findWasmPath();
  const bytes = await readFile(path);
  const module = await wasmApi.instantiate(bytes, {});
  const instance = module.instance;
  instance.exports.lv_init();
  return instance;
}
async function getCore() {
  corePromise ??= instantiate().catch((error) => {
    corePromise = void 0;
    throw error;
  });
  return corePromise;
}
async function callCore(op, input = {}) {
  const core = await getCore();
  const opBytes = encoder.encode(op);
  const inputBytes = encoder.encode(JSON.stringify(input));
  const opPtr = core.exports.lv_alloc(opBytes.length);
  const inputPtr = core.exports.lv_alloc(inputBytes.length);
  if (opPtr === 0 || inputPtr === 0) {
    if (opPtr !== 0) core.exports.lv_free(opPtr, opBytes.length);
    if (inputPtr !== 0) core.exports.lv_free(inputPtr, inputBytes.length);
    throw new Error("dsh-verifier-core wasm heap allocation failed");
  }
  try {
    new Uint8Array(core.exports.memory.buffer, opPtr, opBytes.length).set(opBytes);
    new Uint8Array(core.exports.memory.buffer, inputPtr, inputBytes.length).set(inputBytes);
    const packed = core.exports.lv_dispatch(opPtr, opBytes.length, inputPtr, inputBytes.length);
    const resultPtr = Number(packed >> 32n);
    const resultLen = Number(packed & 0xffffffffn);
    if (resultPtr === 0 || resultLen === 0) {
      throw new Error("dsh-verifier-core returned an empty result");
    }
    try {
      const resultBytes = new Uint8Array(core.exports.memory.buffer, resultPtr, resultLen).slice();
      const envelope = JSON.parse(decoder.decode(resultBytes));
      if (!envelope.ok) {
        throw new Error(envelope.error ?? `dsh-verifier-core operation ${op} failed`);
      }
      return envelope.value;
    } finally {
      core.exports.lv_free(resultPtr, resultLen);
    }
  } finally {
    core.exports.lv_free(opPtr, opBytes.length);
    core.exports.lv_free(inputPtr, inputBytes.length);
  }
}
async function coreVersion() {
  const version = await callCore("version");
  return version.version;
}
function buildPairPrompt(input) {
  return callCore("pair_prompt", input);
}
function buildProgressPrompt(input) {
  return callCore("progress_prompt", input);
}
function extractScore(input) {
  return callCore("extract_score", input);
}
function extractProgress(input) {
  return callCore("extract_progress", input);
}
async function pptRing(n, seed) {
  const ring = await callCore("ppt_ring", { n, seed });
  return ring.map((pair) => [Number(pair[0]), Number(pair[1])]);
}
function pptPlan(input) {
  return callCore("ppt_plan", {
    n: input.n,
    pivots: input.pivots,
    comparisons: input.comparisons.map((entry) => [entry.a, entry.b, entry.rewardA, entry.rewardB])
  });
}
function pptResult(input) {
  return callCore("ppt_result", {
    n: input.n,
    comparisons: input.comparisons.map((entry) => [entry.a, entry.b, entry.rewardA, entry.rewardB])
  });
}

// src/lib/session-transcript.ts
var MAX_STEPS = 400;
var MAX_STEP_CHARS = 8e3;
var MAX_TOTAL_CHARS = 16e4;
function idOf(session) {
  return session.id ?? session.sessionId ?? "session";
}
function stringifyContent(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((block) => {
      if (typeof block === "string") return block;
      if (typeof block === "object" && block !== null && "text" in block) {
        return String(block.text);
      }
      return "";
    }).filter((part) => part.length > 0).join("\n");
  }
  if (typeof value === "object" && value !== null && "text" in value) {
    return String(value.text);
  }
  return "";
}
function eventType(event) {
  return event?.type ?? "";
}
function eventData(event) {
  const data = event?.data;
  return typeof data === "object" && data !== null ? data : {};
}
function appendBounded(state, text) {
  const trimmed = text.trim();
  if (trimmed.length === 0) return;
  state.steps.push(trimmed.slice(0, MAX_STEP_CHARS));
  while (state.steps.length > MAX_STEPS) state.steps.shift();
  let total = state.steps.reduce((sum, step) => sum + step.length, 0);
  while (total > MAX_TOTAL_CHARS && state.steps.length > 1) {
    total -= state.steps[0]?.length ?? 0;
    state.steps.shift();
  }
}
function appendToLast(state, suffix) {
  const last = state.steps[state.steps.length - 1];
  if (last === void 0) {
    appendBounded(state, suffix);
    return;
  }
  state.steps[state.steps.length - 1] = `${last}
${suffix.trim()}`.slice(0, MAX_STEP_CHARS);
}
function applyEvent(state, event) {
  const type = eventType(event);
  if (type === "tool/call") {
    const data = eventData(event);
    const name2 = typeof data.name === "string" ? data.name : "tool";
    const args = typeof data.arguments === "string" ? data.arguments : "";
    appendBounded(state, `Action: ${name2}${args.length > 0 ? `
Arguments: ${args}` : ""}`);
    return;
  }
  if (type === "tool/result") {
    const data = eventData(event);
    const message = data.message ?? event.message;
    const text = stringifyContent(message);
    if (text.length > 0) appendToLast(state, `Output:
${text}`);
    return;
  }
  if (type === "assistant/message") {
    const data = eventData(event);
    const message = data.message ?? event.message;
    const text = stringifyContent(message);
    if (text.length > 0) appendBounded(state, `Agent message:
${text}`);
  }
}
var TranscriptRecorder = class {
  sessions = /* @__PURE__ */ new Map();
  scan(session) {
    const state = { steps: [] };
    for (const event of session.events ?? []) {
      applyEvent(state, event);
    }
    this.sessions.set(idOf(session), state);
    return state;
  }
  ensure(session) {
    const id = idOf(session);
    const existing = this.sessions.get(id);
    if (existing !== void 0) return existing;
    return this.scan(session);
  }
  observe(session, event) {
    applyEvent(this.ensure(session), event);
  }
  snapshot(session) {
    const state = this.sessions.get(idOf(session));
    if (state !== void 0) return [...state.steps];
    return this.scan(session).steps;
  }
};

// src/lib/verifier.ts
import { createHash as createHash2 } from "node:crypto";
import { isAbsolute as isAbsolute2, resolve as resolve2 } from "node:path";

// src/lib/cache.ts
import { createHash } from "node:crypto";
import { mkdir, readFile as readFile2, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
var ScoreCache = class {
  constructor(filePath) {
    this.filePath = filePath;
  }
  data = {};
  hits = 0;
  loaded = false;
  key(parts) {
    const hash = createHash("sha256");
    hash.update(JSON.stringify(parts));
    return hash.digest("hex").slice(0, 32);
  }
  async ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile2(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) this.data = parsed;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
  async get(key) {
    await this.ensureLoaded();
    const entry = this.data[key];
    if (entry !== void 0) this.hits += 1;
    return entry;
  }
  async set(key, entry) {
    await this.ensureLoaded();
    this.data[key] = entry;
  }
  async save() {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = join(
      dirname(this.filePath),
      `.${this.filePath.split("/").pop() ?? "cache"}.${process.pid}.${Date.now()}.tmp`
    );
    await writeFile(temporary, JSON.stringify(this.data), "utf8");
    await rename(temporary, this.filePath);
  }
  stats() {
    return {
      path: this.filePath,
      entries: Object.keys(this.data).length,
      hits: this.hits
    };
  }
  get enabled() {
    return this.filePath.length > 0;
  }
};

// src/lib/criteria.ts
import { readFile as readFile3 } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
var HTML_COMMENT = /<!--[\s\S]*?-->/g;
function slug(text) {
  const value = text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40).replace(/_+$/g, "");
  return value || "criterion";
}
function dedupeId(wanted, used) {
  let candidate = wanted;
  let counter = 2;
  while (used.has(candidate)) {
    candidate = `${wanted}_${counter}`;
    counter += 1;
  }
  used.add(candidate);
  return candidate;
}
function parseCriteriaMarkdown(text) {
  const cleaned = text.replace(HTML_COMMENT, "");
  const lines = cleaned.split(/\r?\n/);
  let groundTruthNote = "";
  let section = "other";
  const criteria = [];
  const usedIds = /* @__PURE__ */ new Set();
  let current = null;
  let buffer = [];
  const flush = () => {
    const body = buffer.join("\n").trim();
    if (section === "ground-truth" && groundTruthNote.length === 0) {
      groundTruthNote = body;
    } else if (current !== null) {
      current.description = body;
      if (body.length > 0) criteria.push(current);
      current = null;
    }
    buffer = [];
  };
  for (const line of lines) {
    if (line.startsWith("### ") && section === "criteria") {
      flush();
      const heading = line.slice(4).trim();
      const pinned = heading.match(/^(.*?)\s*\{#([a-zA-Z0-9_-]+)\}\s*$/);
      const name2 = (pinned?.[1] ?? heading).trim();
      const id = dedupeId(pinned?.[2] ?? slug(name2), usedIds);
      current = { id, name: name2, description: "" };
    } else if (line.startsWith("## ") && !line.startsWith("### ")) {
      flush();
      const heading = line.slice(3).trim().toLowerCase();
      section = heading.includes("ground truth") ? "ground-truth" : heading.includes("criteri") ? "criteria" : "other";
    } else if (line.startsWith("# ")) {
      continue;
    } else {
      buffer.push(line);
    }
  }
  flush();
  if (criteria.length === 0) {
    throw new Error("no criteria found; the file needs a `## Criteria` section with `### Name` blocks");
  }
  const empty = criteria.filter((criterion) => criterion.description.length === 0);
  if (empty.length > 0) {
    throw new Error(`criteria without instructions: ${empty.map((criterion) => criterion.id).join(", ")}`);
  }
  return { groundTruthNote, criteria };
}
function isInlineObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizeCriteria(argument) {
  let rows = [];
  if (isInlineObject(argument)) {
    rows = Object.entries(argument).map(([name2, description]) => ({ name: name2, description }));
  } else {
    rows = argument;
  }
  if (rows.length === 0) {
    throw new Error("criteria must not be empty");
  }
  const used = /* @__PURE__ */ new Set();
  return rows.map((row, index) => {
    const name2 = typeof row === "string" ? row : String(row.name ?? "");
    const description = typeof row === "string" ? row : String(row.description ?? "");
    if (description.length === 0) {
      throw new Error(`criteria[${index}] is missing a description`);
    }
    const fallbackName = name2.length > 0 ? name2 : slug(description);
    const id = typeof row === "object" && typeof row.id === "string" && row.id.length > 0 ? dedupeId(row.id, used) : dedupeId(slug(fallbackName), used);
    return { id, name: fallbackName, description };
  });
}
var BUNDLED_CRITERIA_ROOT = new URL("../../preset/llm-as-a-verifier/criteria/", import.meta.url);
async function readCriteriaFile(pathOrName, cwd) {
  const candidates = [];
  if (isAbsolute(pathOrName)) {
    candidates.push(pathOrName);
  } else {
    const withExtension = pathOrName.endsWith(".md") ? pathOrName : `${pathOrName}.md`;
    candidates.push(resolve(cwd, pathOrName), resolve(cwd, withExtension));
    if (pathOrName === withExtension) {
      candidates.push(resolve(cwd, "criteria", withExtension));
    } else {
      candidates.push(resolve(cwd, "criteria", withExtension));
    }
    candidates.push(new URL(withExtension, BUNDLED_CRITERIA_ROOT).pathname);
  }
  let lastError;
  for (const candidate of candidates) {
    try {
      return parseCriteriaMarkdown(await readFile3(candidate, "utf8"));
    } catch (error) {
      lastError = error;
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
  throw new Error(`criteria file not found: ${pathOrName} (looked in the workspace and the preset criteria folder)`, {
    cause: lastError
  });
}
async function resolveCriteria(argument, cwd) {
  if (typeof argument === "string") {
    return readCriteriaFile(argument, cwd);
  }
  return { groundTruthNote: "", criteria: normalizeCriteria(argument) };
}

// src/lib/verifier.ts
function hashText(text, length = 16) {
  return createHash2("sha256").update(text).digest("hex").slice(0, length);
}
function tieOrThrow(error, backend) {
  if (backend.onError === "raise") throw error;
  return { rewardA: 0.5, rewardB: 0.5 };
}
async function scoreOne(backend, prompt) {
  const verification = await backend.complete(prompt, ["<score_A>", "<score_B>"]);
  const rewardA = await extractScore({
    text: verification.text,
    tokens: verification.tokens,
    positions: verification.positions,
    tag: "score_A"
  });
  const rewardB = await extractScore({
    text: verification.text,
    tokens: verification.tokens,
    positions: verification.positions,
    tag: "score_B"
  });
  return { rewardA, rewardB, verification };
}
async function scoreDirected(context, taskKey, problem, traces, a, b) {
  if (a === b) return { rewardA: 0.5, rewardB: 0.5 };
  let totalA = 0;
  let totalB = 0;
  let count = 0;
  for (const criterion of context.criteria) {
    for (let repeat = 0; repeat < context.evaluations; repeat += 1) {
      const swap = repeat % 2 === 1;
      const cacheKey = context.cache?.key([
        "pair",
        context.backend.model,
        context.backend.baseUrl,
        taskKey,
        criterion.id,
        a,
        b,
        repeat
      ]);
      const cached = cacheKey === void 0 ? void 0 : await context.cache?.get(cacheKey);
      let rewardA;
      let rewardB;
      if (cached !== void 0) {
        rewardA = cached.scoreA;
        rewardB = cached.scoreB;
      } else {
        const traceA = traces[swap ? b : a] ?? "";
        const traceB = traces[swap ? a : b] ?? "";
        const prompt = await buildPairPrompt({
          problem,
          traceA,
          traceB,
          criterion,
          groundTruthNote: context.groundTruthNote,
          nImages: 0
        });
        try {
          const scored = await scoreOne(context.backend, prompt);
          rewardA = swap ? scored.rewardB : scored.rewardA;
          rewardB = swap ? scored.rewardA : scored.rewardB;
          if (cacheKey !== void 0) {
            await context.cache?.set(cacheKey, { scoreA: rewardA, scoreB: rewardB });
          }
        } catch (error) {
          const tied = tieOrThrow(error, context.backend);
          rewardA = tied.rewardA;
          rewardB = tied.rewardB;
        }
      }
      totalA += rewardA;
      totalB += rewardB;
      count += 1;
    }
  }
  return {
    rewardA: count > 0 ? totalA / count : 0.5,
    rewardB: count > 0 ? totalB / count : 0.5
  };
}
function prefixFor(taskKey, a, b, swap) {
  const left = swap ? b : a;
  const right = swap ? a : b;
  return `${taskKey}:${left}:${right}`;
}
async function buildJobs(context, taskKey, problem, traces, pairs) {
  const jobs = [];
  for (const [a, b] of pairs) {
    if (a === b) continue;
    for (const criterion of context.criteria) {
      for (let repeat = 0; repeat < context.evaluations; repeat += 1) {
        const swap = repeat % 2 === 1;
        const traceA = traces[swap ? b : a] ?? "";
        const traceB = traces[swap ? a : b] ?? "";
        const prompt = await buildPairPrompt({
          problem,
          traceA,
          traceB,
          criterion,
          groundTruthNote: context.groundTruthNote,
          nImages: 0
        });
        jobs.push({
          cacheKey: context.cache?.key([
            "pair",
            context.backend.model,
            context.backend.baseUrl,
            taskKey,
            criterion.id,
            a,
            b,
            repeat
          ]) ?? "",
          criterion,
          repeat,
          swap,
          prompt,
          prefix: prefixFor(taskKey, a, b, swap),
          a,
          b
        });
      }
    }
  }
  return jobs;
}
async function runScoreJobs(context, jobs) {
  const byPair = /* @__PURE__ */ new Map();
  const fold = (job, rewardA, rewardB) => {
    const pairKey = `${job.a}:${job.b}`;
    const aggregate = byPair.get(pairKey) ?? { rewardA: 0, rewardB: 0, count: 0 };
    aggregate.rewardA += rewardA;
    aggregate.rewardB += rewardB;
    aggregate.count += 1;
    byPair.set(pairKey, aggregate);
  };
  const execute = async (job) => {
    try {
      const scored = await scoreOne(context.backend, job.prompt);
      const rewardA = job.swap ? scored.rewardB : scored.rewardA;
      const rewardB = job.swap ? scored.rewardA : scored.rewardB;
      if (job.cacheKey.length > 0) {
        await context.cache?.set(job.cacheKey, { scoreA: rewardA, scoreB: rewardB });
      }
      fold(job, rewardA, rewardB);
    } catch (error) {
      const tied = tieOrThrow(error, context.backend);
      fold(job, tied.rewardA, tied.rewardB);
    }
  };
  const cold = [];
  for (const job of jobs) {
    const cached = job.cacheKey.length > 0 ? await context.cache?.get(job.cacheKey) : void 0;
    if (cached === void 0) {
      cold.push(job);
    } else {
      fold(job, cached.scoreA, cached.scoreB);
    }
  }
  const byPrefix = /* @__PURE__ */ new Map();
  for (const job of cold) {
    const group = byPrefix.get(job.prefix) ?? [];
    group.push(job);
    byPrefix.set(job.prefix, group);
  }
  const warm = [];
  const rest = [];
  for (const group of byPrefix.values()) {
    const first = group.shift();
    if (first !== void 0) warm.push(first);
    rest.push(...group);
  }
  for (const job of warm) await execute(job);
  await mapWithConcurrency(rest, context.backend.maxConcurrency, execute);
  const normalized = /* @__PURE__ */ new Map();
  for (const [key, aggregate] of byPair) {
    normalized.set(key, {
      rewardA: aggregate.rewardA / aggregate.count,
      rewardB: aggregate.rewardB / aggregate.count
    });
  }
  return normalized;
}
function cacheFilePath(value, cwd) {
  return isAbsolute2(value) ? value : resolve2(cwd, value);
}
async function prepare(options) {
  const backend = options.backendInstance ?? new VerifierBackend(await resolveBackend(options.ctx, options.settings, options.overrides));
  const cwd = options.cwd ?? process.cwd();
  let cache;
  if (options.cache === false || backend.baseUrl === "") {
    cache = void 0;
  } else if (typeof options.cache === "string") {
    cache = new ScoreCache(cacheFilePath(options.cache, cwd));
  } else if (options.settings?.cachePath !== void 0) {
    cache = new ScoreCache(cacheFilePath(options.settings.cachePath, cwd));
  }
  return { backend, cache };
}
async function compareTrajectories(problem, traceA, traceB, criteria, evaluations = 1, options = {}) {
  const prepared = await prepare(options);
  const document = await resolveCriteria(criteria, options.cwd ?? process.cwd());
  const groundTruthNote = document.groundTruthNote;
  const context = {
    backend: prepared.backend,
    cache: prepared.cache,
    groundTruthNote,
    criteria: document.criteria,
    evaluations: Math.max(1, evaluations)
  };
  const rewards = await scoreDirected(
    context,
    hashText(problem),
    problem,
    [traceA, traceB],
    0,
    1
  );
  await prepared.cache?.save();
  return {
    rewardA: rewards.rewardA,
    rewardB: rewards.rewardB,
    criteria: document.criteria.map((criterion) => criterion.id),
    evaluations: context.evaluations,
    usage: tokenUsage.snapshot()
  };
}
async function selectTrajectories(problem, candidates, criteria, evaluations = 4, pivots = 2, seed = 0, options = {}) {
  if (candidates.length === 0) throw new Error("candidate list must not be empty");
  if (candidates.length === 1) {
    const document2 = await resolveCriteria(criteria, options.cwd ?? process.cwd());
    return {
      index: 0,
      best: candidates[0] ?? "",
      scores: [1],
      ranking: [0],
      nComparisons: 0,
      criteria: document2.criteria.map((criterion) => criterion.id),
      evaluations: Math.max(1, evaluations),
      usage: tokenUsage.snapshot()
    };
  }
  const prepared = await prepare(options);
  const document = await resolveCriteria(criteria, options.cwd ?? process.cwd());
  const context = {
    backend: prepared.backend,
    cache: prepared.cache,
    groundTruthNote: document.groundTruthNote,
    criteria: document.criteria,
    evaluations: Math.max(1, evaluations)
  };
  const taskKey = `task-${hashText(problem)}`;
  const ring = await pptRing(candidates.length, seed);
  const ringJobs = await buildJobs(context, taskKey, problem, candidates, ring);
  const ringScores = await runScoreJobs(context, ringJobs);
  const ringComparisons = ring.map(([a, b]) => {
    const reward = ringScores.get(`${a}:${b}`);
    return reward === void 0 ? void 0 : { a, b, rewardA: reward.rewardA, rewardB: reward.rewardB };
  }).filter((entry) => entry !== void 0);
  const plan = await pptPlan({
    n: candidates.length,
    pivots,
    comparisons: ringComparisons
  });
  const pivotJobs = await buildJobs(context, taskKey, problem, candidates, plan.pivotPairs);
  const pivotScores = await runScoreJobs(context, pivotJobs);
  const pivotComparisons = plan.pivotPairs.map(([a, b]) => {
    const reward = pivotScores.get(`${a}:${b}`);
    return reward === void 0 ? void 0 : { a, b, rewardA: reward.rewardA, rewardB: reward.rewardB };
  }).filter((entry) => entry !== void 0);
  const result = await pptResult({
    n: candidates.length,
    comparisons: [...ringComparisons, ...pivotComparisons]
  });
  await prepared.cache?.save();
  return {
    index: result.bestIndex,
    best: candidates[result.bestIndex] ?? "",
    scores: result.scores,
    ranking: result.ranking,
    nComparisons: result.nComparisons,
    criteria: document.criteria.map((criterion) => criterion.id),
    evaluations: context.evaluations,
    usage: tokenUsage.snapshot()
  };
}
function chooseCheckpoints(total, requested) {
  if (requested !== void 0 && requested.length > 0) {
    for (const checkpoint of requested) {
      if (!Number.isInteger(checkpoint) || checkpoint < 1 || checkpoint > total) {
        throw new Error(`checkpoint ${checkpoint} is outside the valid range 1..${total}`);
      }
    }
    return [...new Set(requested)].sort((a, b) => a - b);
  }
  if (total <= 12) return Array.from({ length: total }, (_, index) => index + 1);
  const count = 10;
  const steps = [];
  for (let index = 0; index < count; index += 1) {
    steps.push(Math.round(1 + index * (total - 1) / (count - 1)));
  }
  return [...new Set(steps)];
}
async function trackProgress(problem, steps, checkpointSteps, evaluations = 1, options = {}) {
  if (steps.length === 0) throw new Error("step list must not be empty");
  const prepared = await prepare(options);
  const backend = prepared.backend;
  const checkpoints = chooseCheckpoints(steps.length, checkpointSteps);
  const repeats = Math.max(1, evaluations);
  const prompt = await buildProgressPrompt({
    problem,
    steps,
    checkpointSteps: checkpoints,
    nImages: 0
  });
  const run = async () => {
    try {
      const verification = await backend.complete(prompt, []);
      return await extractProgress({
        text: verification.text,
        tokens: verification.tokens,
        positions: verification.positions,
        count: checkpoints.length
      });
    } catch (error) {
      if (backend.onError === "raise") throw error;
      return Array.from({ length: checkpoints.length }, () => 0.5);
    }
  };
  const perEvaluation = repeats === 1 ? [await run()] : await mapWithConcurrency(
    Array.from({ length: repeats }, (_, index) => index),
    backend.maxConcurrency,
    run
  );
  const scores = checkpoints.map((_, checkpointIndex) => {
    const values = perEvaluation.map((row) => row[checkpointIndex]).filter((value) => value !== null && value !== void 0);
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0.5;
  });
  return { steps: checkpoints, scores, perEvaluation, usage: tokenUsage.snapshot() };
}

// src/plugins/verifier-tools.ts
var name = "verifier-tools";
var inject = ["tools"];
function toParameterSchema(spec) {
  const properties = {};
  const required = [];
  for (const [key, meta] of Object.entries(spec)) {
    const property = { type: meta.type };
    if (meta.description !== void 0) property.description = meta.description;
    if (meta.items !== void 0) property.items = meta.items;
    properties[key] = property;
    if (meta.required === true) required.push(key);
  }
  return { type: "object", properties, required, additionalProperties: false };
}
function outputText() {
  return {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { text: { type: "string" } },
      required: ["text"]
    },
    render: (_args, value) => [
      { type: "text", text: value.text }
    ]
  };
}
function stringArg(args, key, fallback = "") {
  const value = args[key];
  return typeof value === "string" ? value : fallback;
}
function numberArg(args, key, fallback) {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function intArg(args, key, fallback) {
  const value = numberArg(args, key, fallback);
  return Math.max(1, Math.floor(value));
}
function stringArrayArg(args, key) {
  const value = args[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item.length > 0);
}
function numberArrayArg(args, key) {
  const value = args[key];
  if (value === void 0 || value === null) return void 0;
  if (!Array.isArray(value)) return void 0;
  const numbers = value.filter((item) => typeof item === "number" && Number.isInteger(item));
  return numbers.length === value.length ? numbers : void 0;
}
function parseCriteria(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "string") return parsed;
    if (typeof parsed === "object" && parsed !== null) {
      return parsed;
    }
  }
  return trimmed;
}
function usageLines() {
  const usage = tokenUsage.snapshot();
  const hitRate = usage.inputTokens > 0 ? `${(100 * usage.cachedInputTokens / usage.inputTokens).toFixed(1)}%` : "0.0%";
  return [
    `Token usage: ${usage.calls} verifier calls`,
    `  input ${usage.inputTokens} (cached ${usage.cachedInputTokens}, ${hitRate} hit rate)`,
    `  output ${usage.outputTokens} (reasoning ${usage.reasoningTokens})`
  ];
}
function workspaceCwd(exec) {
  return exec?.agent?.session?.header?.cwd ?? process.cwd();
}
function backendOverrides(args) {
  const overrides = {};
  const model = stringArg(args, "model");
  const backend = stringArg(args, "backend");
  const onError = stringArg(args, "onError");
  if (model.length > 0) overrides.model = model;
  if (backend === "deepseek" || backend === "openai" || backend === "auto") overrides.backend = backend;
  if (onError === "raise" || onError === "tie") overrides.onError = onError;
  return overrides;
}
function optionsFor(ctx, config, args, exec) {
  return {
    ctx,
    settings: config,
    overrides: backendOverrides(args),
    cwd: workspaceCwd(exec),
    cache: config.cachePath
  };
}
function formatUsageFooter() {
  return `
${usageLines().join("\n")}`;
}
function describeError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
function apply(ctx, config = {}) {
  const recorder = new TranscriptRecorder();
  ctx.on("session/event", (session, event) => {
    recorder.observe(session, event);
  });
  ctx.tools.register({
    name: "verifier_compare",
    description: [
      "Score TWO candidate trajectories against one task using the fine-grained LLM verifier.",
      "",
      "The verifier reads the probability distribution over a 20-level letter scale (A..T) from token-level logprobs and returns the expected rewards R_A and R_B, each in [0, 1]. This is the raw pairwise signal behind best-of-N selection; a single directed call does not cancel slot bias.",
      "",
      '`criteria` accepts a bundled name (general, terminal_bench, swe_bench, medagentbench), a path to a criteria .md file, a JSON object {"Name": "description"}, or a JSON array of strings/objects.'
    ].join("\n"),
    parameters: toParameterSchema({
      problem: { type: "string", required: true, description: "Task description shown to the verifier." },
      traceA: { type: "string", required: true, description: "First candidate trajectory, with observable output." },
      traceB: { type: "string", required: true, description: "Second candidate trajectory, with observable output." },
      criteria: { type: "string", required: true, description: "Bundled criteria name, .md path, or JSON-encoded criteria object/array." },
      evaluations: { type: "number", required: false, description: "Repeated verifications per criterion (default 1)." },
      groundTruthNote: { type: "string", required: false, description: "Optional evidence guidance shown to the verifier." },
      model: { type: "string", required: false, description: "Optional verifier model override." },
      backend: { type: "string", required: false, description: "Optional backend override: auto, deepseek, or openai." },
      onError: { type: "string", required: false, description: "Optional error policy: tie or raise (default tie)." }
    }),
    output: outputText(),
    async execute(args, exec) {
      try {
        const result = await compareTrajectories(
          stringArg(args, "problem"),
          stringArg(args, "traceA"),
          stringArg(args, "traceB"),
          parseCriteria(stringArg(args, "criteria")),
          intArg(args, "evaluations", 1),
          optionsFor(ctx, config, args, exec)
        );
        return {
          text: [
            `Reward A: ${result.rewardA.toFixed(5)}`,
            `Reward B: ${result.rewardB.toFixed(5)}`,
            `Criteria: ${result.criteria.join(", ")} (${result.evaluations} evaluation(s) each)`,
            formatUsageFooter()
          ].join("\n")
        };
      } catch (error) {
        return { text: `verifier_compare failed: ${describeError(error)}` };
      }
    }
  });
  ctx.tools.register({
    name: "verifier_select",
    description: [
      "Select the best of N candidate trajectories for one task.",
      "",
      "The method scores a random ring of directed pairwise comparisons with the fine-grained logprob reward, promotes the strongest candidates as pivots, scores the remaining pivot rounds, and aggregates everything under the Bradley-Terry model. Cost is linear in N for a fixed pivot count instead of O(N^2).",
      "",
      "Returns the winner index, best trajectory, per-candidate scores, ranking, and the number of verifier comparisons."
    ].join("\n"),
    parameters: toParameterSchema({
      problem: { type: "string", required: true, description: "Task description shown to the verifier." },
      candidates: {
        type: "array",
        required: true,
        description: "Candidate trajectories to rank, each with observable output.",
        items: { type: "string" }
      },
      criteria: { type: "string", required: true, description: "Bundled criteria name, .md path, or JSON-encoded criteria object/array." },
      evaluations: { type: "number", required: false, description: "Repeated verifications per criterion (default 4)." },
      pivots: { type: "number", required: false, description: "Pivot count k (default 2)." },
      seed: { type: "number", required: false, description: "Random ring seed; same seed reproduces the tournament (default 0)." },
      model: { type: "string", required: false, description: "Optional verifier model override." },
      backend: { type: "string", required: false, description: "Optional backend override: auto, deepseek, or openai." },
      onError: { type: "string", required: false, description: "Optional error policy: tie or raise (default tie)." }
    }),
    output: outputText(),
    async execute(args, exec) {
      try {
        const candidates = stringArrayArg(args, "candidates");
        if (candidates.length === 0) return { text: "verifier_select needs at least one candidate." };
        const result = await selectTrajectories(
          stringArg(args, "problem"),
          candidates,
          parseCriteria(stringArg(args, "criteria")),
          intArg(args, "evaluations", 4),
          Math.max(1, Math.floor(numberArg(args, "pivots", 2))),
          Math.floor(numberArg(args, "seed", 0)),
          optionsFor(ctx, config, args, exec)
        );
        const lines = [
          `Winner: candidate #${result.index} (score ${result.scores[result.index]?.toFixed(5) ?? "n/a"})`,
          `Ranking: ${result.ranking.join(" > ")}`,
          `Scores: ${result.scores.map((score) => score.toFixed(4)).join(", ")}`,
          `Comparisons: ${result.nComparisons}`,
          `Criteria: ${result.criteria.join(", ")} (${result.evaluations} evaluation(s) each)`,
          formatUsageFooter()
        ];
        return { text: lines.join("\n") };
      } catch (error) {
        return { text: `verifier_select failed: ${describeError(error)}` };
      }
    }
  });
  ctx.tools.register({
    name: "verifier_track",
    description: [
      "Score the progress of a FINISHED trajectory at chosen checkpoints.",
      "",
      "One verifier call sees the whole trajectory and scores each checkpoint independently: given everything through step k, would the hidden grader already accept the current state? Letters A..T map to a 0..1 progress curve. Use verifier_session to score the live session instead."
    ].join("\n"),
    parameters: toParameterSchema({
      problem: { type: "string", required: true, description: "Task description shown to the verifier." },
      steps: {
        type: "array",
        required: true,
        description: "Agent steps; each string is one action plus its observed output.",
        items: { type: "string" }
      },
      checkpointSteps: {
        type: "array",
        required: false,
        description: "1-indexed steps to score; defaults to a sensible even spread.",
        items: { type: "number" }
      },
      evaluations: { type: "number", required: false, description: "Independent repeats to average (default 1)." },
      model: { type: "string", required: false, description: "Optional verifier model override." },
      backend: { type: "string", required: false, description: "Optional backend override: auto, deepseek, or openai." },
      onError: { type: "string", required: false, description: "Optional error policy: tie or raise (default tie)." }
    }),
    output: outputText(),
    async execute(args, exec) {
      try {
        const steps = stringArrayArg(args, "steps");
        if (steps.length === 0) return { text: "verifier_track needs at least one step." };
        const result = await trackProgress(
          stringArg(args, "problem"),
          steps,
          numberArrayArg(args, "checkpointSteps"),
          intArg(args, "evaluations", 1),
          optionsFor(ctx, config, args, exec)
        );
        const lines = [
          "Progress curve (step: score):",
          ...result.steps.map((step, index) => `  ${step}: ${result.scores[index]?.toFixed(5) ?? "n/a"}`),
          `Final checkpoint: ${result.scores[result.scores.length - 1]?.toFixed(5) ?? "n/a"}`,
          formatUsageFooter()
        ];
        return { text: lines.join("\n") };
      } catch (error) {
        return { text: `verifier_track failed: ${describeError(error)}` };
      }
    }
  });
  ctx.tools.register({
    name: "verifier_session",
    description: [
      "Score the CURRENT DeepSeek Harness session with the verifier progress model.",
      "",
      "The preset records the session trajectory from durable events (tool calls, tool results, assistant messages), rebuilds it after a restart, and scores selected checkpoints without the model assembling a transcript by hand. Use it to decide whether to continue, backtrack, or resample.",
      "",
      "Requires the task `problem`; checkpointSteps defaults to a spread across the recorded steps."
    ].join("\n"),
    parameters: toParameterSchema({
      problem: { type: "string", required: true, description: "The task this session is trying to solve." },
      checkpointSteps: {
        type: "array",
        required: false,
        description: "1-indexed transcript steps to score; defaults to a sensible spread.",
        items: { type: "number" }
      },
      evaluations: { type: "number", required: false, description: "Independent repeats to average (default 1)." },
      model: { type: "string", required: false, description: "Optional verifier model override." },
      backend: { type: "string", required: false, description: "Optional backend override: auto, deepseek, or openai." },
      onError: { type: "string", required: false, description: "Optional error policy: tie or raise (default tie)." }
    }),
    output: outputText(),
    async execute(args, exec) {
      try {
        const session = exec?.agent?.session;
        if (session === void 0) return { text: "verifier_session requires an agent session context." };
        const steps = recorder.snapshot(session);
        if (steps.length === 0) return { text: "verifier_session found no recorded trajectory steps in this session yet." };
        const result = await trackProgress(
          stringArg(args, "problem"),
          steps,
          numberArrayArg(args, "checkpointSteps"),
          intArg(args, "evaluations", 1),
          optionsFor(ctx, config, args, exec)
        );
        const lines = [
          `Session transcript: ${steps.length} step(s) recorded.`,
          "Progress curve (transcript step: score):",
          ...result.steps.map((step, index) => `  ${step}: ${result.scores[index]?.toFixed(5) ?? "n/a"}`),
          `Latest checkpoint: ${result.scores[result.scores.length - 1]?.toFixed(5) ?? "n/a"}`,
          formatUsageFooter()
        ];
        return { text: lines.join("\n") };
      } catch (error) {
        return { text: `verifier_session failed: ${describeError(error)}` };
      }
    }
  });
  ctx.tools.register({
    name: "verifier_status",
    description: [
      "Report the verifier preset configuration, Rust core version, token usage, and cache status.",
      "No API traffic is sent by this tool; credentials are never printed."
    ].join("\n"),
    parameters: toParameterSchema({}),
    output: outputText(),
    async execute(_args, exec) {
      const lines = [];
      try {
        const backend = new VerifierBackend(await resolveBackend(ctx, config, backendOverrides({})));
        lines.push("Backend:", ...Object.entries(backendSummary(backend)).map(([key, value]) => `  ${key}: ${String(value)}`));
      } catch (error) {
        lines.push(`Backend: not fully configured \u2014 ${describeError(error)}`);
      }
      try {
        lines.push(`Rust core: v${await coreVersion()}`);
      } catch (error) {
        lines.push(`Rust core: unavailable \u2014 ${describeError(error)}`);
      }
      lines.push(...usageLines());
      lines.push(`Working directory: ${workspaceCwd(exec)}`);
      return { text: lines.join("\n") };
    }
  });
}
export {
  apply,
  inject,
  name
};
