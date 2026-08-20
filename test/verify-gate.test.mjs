import assert from 'node:assert/strict'
import test from 'node:test'

const plugin = await import('../preset/llm-as-a-verifier/verify-gate.mjs')

function badScoreResponse() {
  const tokens = ['<score_', 'A>', ' T', ' ', '</score_A>', '\n<score_', 'B>', ' A', ' </score_B>']
  const positions = tokens.map((token) => [{ token, logprob: -0.01 }])
  positions[2] = [{ token: ' T', logprob: -0.01 }]
  positions[7] = [{ token: ' A', logprob: -0.01 }]
  return {
    choices: [{ message: { content: '<score_A> T </score_A>\n<score_B> A </score_B>' }, logprobs: { content: tokens.map((token, index) => ({ token, top_logprobs: positions[index] })) } }],
    usage: { prompt_tokens: 10, completion_tokens: 4 },
  }
}

function gateSession() {
  return {
    id: 'gate-s1',
    header: { cwd: process.cwd(), delegationDepth: 0 },
    events: [
      { type: 'user/message', source: { kind: 'user' }, message: [{ type: 'text', text: 'Solve the task.' }] },
      { type: 'assistant/message', data: { turn: 1, step: 1, message: [{ type: 'text', text: 'The answer is likely wrong.' }] } },
    ],
  }
}

test('verify-gate steers once when the final answer scores below threshold', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    text: async () => JSON.stringify(badScoreResponse()),
  })
  try {
    let listener
    const ctx = { on: (_event, fn) => { listener = fn } }
    plugin.apply(ctx, {
      enabled: true,
      backend: 'deepseek',
      apiKey: 'test',
      model: 'deepseek-v4-flash',
      threshold: 0.6,
      evaluations: 1,
    })
    const steered = []
    const agent = {
      session: gateSession(),
      steer(message) { steered.push(message) },
    }
    await listener({ agent, turn: 1 })
    assert.equal(steered.length, 1)
    assert.equal(steered[0]?.source?.plugin, 'verify-gate')
    await listener({ agent, turn: 1 })
    assert.equal(steered.length, 1, 'second turn-stopping event must not steer again')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('verify-gate is inert when disabled', async () => {
  let listener
  const ctx = { on: (_event, fn) => { listener = fn } }
  plugin.apply(ctx, { enabled: false })
  const steered = []
  await listener({ agent: { session: gateSession(), steer(message) { steered.push(message) } }, turn: 1 })
  assert.equal(steered.length, 0)
})
