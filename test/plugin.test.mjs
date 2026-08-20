import assert from 'node:assert/strict'
import test from 'node:test'

const plugin = await import('../preset/llm-as-a-verifier/verifier.mjs')

function fakeDeepSeekResponse(body) {
  const tokens = [
    '<score_', 'A>', ' A', ' ', '</score_A>',
    '\n<score_', 'B>', ' T', ' </score_B>',
  ]
  const positions = tokens.map((token) => [{ token, logprob: -0.01 }])
  positions[2] = [
    { token: ' A', logprob: -0.02 },
    { token: ' C', logprob: -3.0 },
  ]
  positions[7] = [
    { token: ' T', logprob: -0.02 },
    { token: ' S', logprob: -3.0 },
  ]
  assert.ok(body.model.includes('deepseek'))
  return {
    choices: [
      {
        message: { content: '<score_A> A </score_A>\n<score_B> T </score_B>' },
        logprobs: { content: tokens.map((token, index) => ({ token, top_logprobs: positions[index] })) },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 12,
      prompt_tokens_details: { cached_tokens: 40 },
      completion_tokens_details: { reasoning_tokens: 4 },
    },
  }
}

test('plugin registers five verifier tools and a session listener', () => {
  const tools = []
  const events = []
  const ctx = {
    tools: { register(tool) { tools.push(tool) } },
    on(event, listener) { events.push({ event, listener }) },
  }
  plugin.apply(ctx, {})
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ['verifier_compare', 'verifier_select', 'verifier_session', 'verifier_status', 'verifier_track', 'verifier_tracker_result', 'verifier_tracker_start', 'verifier_tracker_update'],
  )
  assert.equal(events[0]?.event, 'session/event')
})

test('verifier_compare executes against a mocked DeepSeek backend', async () => {
  const originalFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url, body: JSON.parse(String(init.body)) })
    return {
      ok: true,
      text: async () => JSON.stringify(fakeDeepSeekResponse(JSON.parse(String(init.body)))),
    }
  }
  try {
    const tools = []
    const ctx = {
      tools: { register(tool) { tools.push(tool) } },
      on() {},
    }
    plugin.apply(ctx, {
      backend: 'deepseek',
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
      maxConcurrency: 1,
      maxTokens: 1024,
      effort: 'off',
    })
    const compare = tools.find((tool) => tool.name === 'verifier_compare')
    assert.ok(compare)
    const result = await compare.execute(
      {
        problem: 'Reverse a string.',
        traceA: 'Candidate A',
        traceB: 'Candidate B',
        criteria: JSON.stringify({ Correctness: 'Does it reverse?' }),
        evaluations: 1,
      },
      { agent: { session: { header: { cwd: process.cwd() } } } },
    )
    assert.match(result.text, /Reward A: 0\.9/)
    assert.match(result.text, /Reward B: 0\.0/)
    assert.equal(seen.length, 1)
    assert.equal(seen[0]?.url, 'https://api.deepseek.com/chat/completions')
    assert.equal(seen[0]?.body.thinking.type, 'disabled')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('verifier_status never prints credentials', async () => {
  const tools = []
  const ctx = { tools: { register(tool) { tools.push(tool) } }, on() {} }
  plugin.apply(ctx, { backend: 'deepseek', apiKey: 'super-secret', model: 'deepseek-v4-flash' })
  const status = tools.find((tool) => tool.name === 'verifier_status')
  assert.ok(status)
  const result = await status.execute({}, { agent: { session: { header: { cwd: process.cwd() } } } })
  assert.match(result.text, /deepseek-v4-flash/)
  assert.doesNotMatch(result.text, /super-secret/)
  assert.match(result.text, /Rust core: v/)
})
