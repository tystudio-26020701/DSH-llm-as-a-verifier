// (c) 2026 Beijing Taiyin Zhaowu Technology Co., Ltd. — original implementation; PolyForm Noncommercial 1.0.0

// src/lib/final-answer.ts
function eventData(event) {
  const data = event.data;
  return typeof data === "object" && data !== null ? data : {};
}
function eventContent(value) {
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
function extractFirstUserMessage(session) {
  for (const event of session.events ?? []) {
    if (event.type !== "user/message") continue;
    const source = event.source ?? eventData(event).source;
    const kind = typeof source === "object" && source !== null && "kind" in source ? String(source.kind) : "";
    if (kind === "plugin" || kind === "skill-invocation") continue;
    const content = eventContent(event.message ?? eventData(event).message ?? event);
    if (content.trim().length > 0) return content.trim();
  }
  return "";
}
function findFinalAnswer(session, turn) {
  const assistantMessages = [];
  const toolSteps = /* @__PURE__ */ new Set();
  for (const event of session.events ?? []) {
    if (event.type === "tool/call") {
      const data = eventData(event);
      if (data.turn === turn && typeof data.step === "number") {
        toolSteps.add(`${String(data.turn)}:${String(data.step)}`);
      }
    }
  }
  for (const event of session.events ?? []) {
    if (event.type !== "assistant/message") continue;
    const data = eventData(event);
    if (data.turn !== turn || typeof data.step !== "number") continue;
    const text = eventContent(data.message ?? event.message).trim();
    if (text.length === 0) continue;
    if (toolSteps.has(`${String(data.turn)}:${String(data.step)}`)) continue;
    assistantMessages.push({ text, turn, step: data.step });
  }
  return assistantMessages.at(-1);
}

// src/lib/verifier.ts
import { createHash as createHash2 } from "node:crypto";
import { isAbsolute as isAbsolute2, resolve as resolve2 } from "node:path";

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
    if (baseUrlInput === void 0) {
      throw new Error("OpenAI-compatible backend needs VERIFIER_BASE_URL or OPENAI_BASE_URL (or set backend to deepseek)");
    }
    baseUrl = baseUrlInput;
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
  const apiKey = merged.apiKey ?? await resolveCredential(ctx, "VERIFIER_API_KEY") ?? await resolveCredential(ctx, apiKeyEnv);
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

// src/lib/cache.ts
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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
      const raw = await readFile(this.filePath, "utf8");
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
      `.${basename(this.filePath)}.${process.pid}.${Date.now()}.tmp`
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

// src/lib/core.ts
import { readFile as readFile2 } from "node:fs/promises";
import { fileURLToPath } from "node:url";
var encoder = new TextEncoder();
var decoder = new TextDecoder();
var wasmApi = globalThis.WebAssembly;
var corePromise;
function probeCandidates() {
  return [
    fileURLToPath(new URL("./verifier-core.wasm", import.meta.url)),
    fileURLToPath(new URL("../verifier-core.wasm", import.meta.url)),
    fileURLToPath(new URL("../../preset/llm-as-a-verifier/verifier-core.wasm", import.meta.url))
  ];
}
async function findWasmPath() {
  for (const path of probeCandidates()) {
    try {
      await readFile2(path);
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
  const bytes = await readFile2(path);
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
function buildPairPrompt(input) {
  return callCore("pair_prompt", input);
}
function extractScore(input) {
  return callCore("extract_score", input);
}

// src/lib/criteria.ts
import { readFile as readFile3 } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
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
var BUNDLED_CRITERIA_DIR = fileURLToPath2(
  new URL("../../preset/llm-as-a-verifier/criteria/", import.meta.url)
);
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
    candidates.push(resolve(BUNDLED_CRITERIA_DIR, withExtension));
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
    hashText(JSON.stringify([problem, traceA, traceB])),
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

// src/plugins/verify-gate.ts
var name = "verify-gate";
var inject = [];
var DEFAULT_THRESHOLD = 0.6;
var DEFAULT_MAX_GATES = 1;
var DEFAULT_STEER_TEXT = "Verification gate: the final answer scored below the configured threshold. Re-open the task, fix the remaining issues, and submit a new final answer.";
var STEERING_EVENT = "steering/message";
function parseCriteria(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) return parsed;
  }
  return trimmed;
}
function positiveInt2(value, fallback) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}
function thresholdOf(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : DEFAULT_THRESHOLD;
}
function steeredTurnOf(event) {
  if (typeof event !== "object" || event === null) return void 0;
  const record = event;
  const turn = record.turn ?? record.data?.turn;
  return typeof turn === "number" ? turn : void 0;
}
function isSubagent(session) {
  return (session?.header?.delegationDepth ?? 0) > 0;
}
function apply(ctx, config = {}) {
  const enabled = config.enabled === true;
  const threshold = thresholdOf(config.threshold);
  const maxGatesPerTurn = positiveInt2(config.maxGatesPerTurn, DEFAULT_MAX_GATES);
  const evaluations = positiveInt2(config.evaluations, 1);
  const criteria = parseCriteria(config.criteria ?? "general");
  const steerText = typeof config.steerText === "string" && config.steerText.length > 0 ? config.steerText : DEFAULT_STEER_TEXT;
  const includeSubagents = config.includeSubagents === true;
  const steeredTurns = /* @__PURE__ */ new Map();
  let warned = false;
  const warn = (message) => {
    if (warned) return;
    warned = true;
    console.error(`[${name}] ${message}`);
  };
  const turnsSteeredFor = (session) => {
    const sessionId = session?.id ?? "session";
    const existing = steeredTurns.get(sessionId);
    if (existing !== void 0) return existing;
    const rebuilt = /* @__PURE__ */ new Set();
    for (const event of session?.events ?? []) {
      if (event.type !== STEERING_EVENT) continue;
      if (event.source !== null && typeof event.source === "object" && event.source.plugin === name) {
        const turn = steeredTurnOf(event);
        if (turn !== void 0) rebuilt.add(turn);
      }
    }
    steeredTurns.set(sessionId, rebuilt);
    return rebuilt;
  };
  const context = ctx;
  if (typeof context.on !== "function") return;
  context.on("agent/turn-stopping", async ({ agent, turn }) => {
    if (!enabled || agent === void 0 || turn === void 0) return;
    const session = agent.session;
    if (session === void 0) return;
    if (!includeSubagents && isSubagent(session)) return;
    const steered = turnsSteeredFor(session);
    if (steered.has(turn) || steered.size >= maxGatesPerTurn * 4) return;
    const candidate = findFinalAnswer(session, turn);
    if (candidate === void 0 || candidate.text.length === 0) return;
    const problem = typeof config.problem === "string" && config.problem.trim().length > 0 ? config.problem.trim() : extractFirstUserMessage(session);
    if (problem.length === 0) return;
    const options = {
      ctx,
      settings: config,
      cwd: session.header?.cwd,
      cache: false
    };
    try {
      const result = await compareTrajectories(
        problem,
        candidate.text,
        "(no answer produced)",
        criteria,
        evaluations,
        options
      );
      if (result.rewardA >= threshold) return;
      if (steered.has(turn) || steered.size >= maxGatesPerTurn) return;
      steered.add(turn);
      agent.steer?.({
        id: crypto.randomUUID(),
        role: "user",
        content: [{ type: "text", text: steerText }],
        source: {
          kind: "plugin",
          plugin: name,
          form: "notice",
          summary: "final answer failed auto-verification"
        }
      });
    } catch (error) {
      warn(`verification failed, letting the turn close: ${String(error && error.message || error)}`);
    }
  });
}
export {
  apply,
  inject,
  name
};
