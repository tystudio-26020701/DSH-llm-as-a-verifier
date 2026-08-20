import assert from 'node:assert/strict'
import test from 'node:test'

import { VerifierBackend, extractScore, mapWithConcurrency } from '../dist/lib/index.mjs'

const resolved = {
  kind: 'openai',
  baseUrl: 'https://localhost.test/v1',
  apiKey: 'test',
  model: 'test-model',
  maxTokens: 512,
  effort: 'high',
  maxConcurrency: 2,
  timeoutMs: 1000,
  onError: 'tie',
  cachePath: undefined,
}

test('OpenAI-compatible prefill turns top-logprobs into score tags', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (_url, init) => {
    calls += 1
    const body = JSON.parse(String(init.body))
    if (body.continue_final_message !== true) {
      return {
        ok: true,
        text: async () => JSON.stringify({
          choices: [{
            message: { content: 'The candidates differ in correctness.' },
            logprobs: { content: [{ token: 'The', logprob: 0, top_logprobs: [{ token: 'The', logprob: 0 }] }] },
          }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }),
      }
    }
    const letter = calls === 2 ? 'A' : 'T'
    return {
      ok: true,
      text: async () => JSON.stringify({
        choices: [{
          message: { reasoning_content: letter },
          logprobs: {
            content: [{
              token: letter,
              logprob: -0.01,
              top_logprobs: [{ token: letter, logprob: -0.01 }],
            }],
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 1 },
      }),
    }
  }
  try {
    const backend = new VerifierBackend(resolved)
    const verification = await backend.complete('Prompt ending with score instructions')
    assert.equal(calls, 3)
    assert.match(verification.text, /<score_A>A<\/score_A>/)
    assert.match(verification.text, /<score_B>T<\/score_B>/)
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
    assert.ok(rewardA > 0.9)
    assert.ok(rewardB < 0.1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('mapWithConcurrency preserves order and caps concurrency', async () => {
  let active = 0
  let peak = 0
  const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active -= 1
    return value * 10
  })
  assert.deepEqual(results, [10, 20, 30, 40, 50])
  assert.ok(peak <= 2)
})
