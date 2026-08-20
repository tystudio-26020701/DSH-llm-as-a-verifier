import assert from 'node:assert/strict'
import test from 'node:test'

import { VerifierBackend, selectTrajectories } from '../dist/lib/index.mjs'

const backend = new VerifierBackend({
  kind: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  apiKey: 'test',
  model: 'deepseek-v4-flash',
  maxTokens: 512,
  effort: 'off',
  maxConcurrency: 2,
  timeoutMs: 1000,
  onError: 'tie',
  cachePath: undefined,
})

const quality = new Map([
  ['candidate-zero', 'A'],
  ['candidate-one', 'C'],
  ['candidate-two', 'T'],
])

function letterFor(prompt, slot) {
  const marker = slot === 'A' ? 'Candidate A:\n' : 'Candidate B:\n'
  const start = prompt.indexOf(marker) + marker.length
  const word = prompt.slice(start).match(/candidate-\w+/)?.[0] ?? 'candidate-two'
  return quality.get(word) ?? 'T'
}

function fakeVerification(prompt) {
  const letterA = letterFor(prompt, 'A')
  const letterB = letterFor(prompt, 'B')
  const tokens = [
    '<score_', 'A>', ' A', ' ', '</score_A>',
    '\n<score_', 'B>', ' B', ' </score_B>',
  ]
  const positions = tokens.map((token) => [{ token, logprob: -0.01 }])
  positions[2] = [{ token: ` ${letterA}`, logprob: -0.01 }]
  positions[7] = [{ token: ` ${letterB}`, logprob: -0.01 }]
  return {
    text: `<score_A> ${letterA} </score_A>\n<score_B> ${letterB} </score_B>`,
    tokens,
    positions,
    usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10, reasoningTokens: 0 },
  }
}

test('selectTrajectories ranks three candidates with the pivot tournament', async () => {
  const originalComplete = backend.complete
  let calls = 0
  backend.complete = async (prompt) => {
    calls += 1
    return fakeVerification(prompt)
  }
  try {
    const result = await selectTrajectories(
      'Pick the strongest candidate.',
      ['candidate-zero', 'candidate-one', 'candidate-two'],
      { Quality: 'Prefer the candidate with the highest letter grade.' },
      1,
      2,
      0,
      { backendInstance: backend, cache: false },
    )
    assert.equal(result.index, 0)
    assert.deepEqual(result.ranking, [0, 1, 2])
    assert.ok(result.scores[0] > result.scores[1])
    assert.ok(result.scores[1] > result.scores[2])
    assert.equal(result.nComparisons, 6)
    assert.equal(calls, 6)
  } finally {
    backend.complete = originalComplete
  }
})

test('score cache does not reuse entries across different candidate sets', async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const directory = await mkdtemp(join(tmpdir(), 'dsh-verifier-cache-'))
  const cachePath = join(directory, 'cache.json')

  const originalComplete = backend.complete
  let calls = 0
  backend.complete = async (prompt) => {
    calls += 1
    const letterA = quality.get(letterFor(prompt, 'A')) ?? 'T'
    const letterB = quality.get(letterFor(prompt, 'B')) ?? 'T'
    return {
      text: `<score_A> ${letterA} </score_A>\n<score_B> ${letterB} </score_B>`,
      tokens: null,
      positions: null,
      usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10, reasoningTokens: 0 },
    }
  }
  try {
    const first = ['candidate-zero', 'candidate-one', 'candidate-two']
    const options = { backendInstance: backend, cache: cachePath }
    await selectTrajectories('Pick the strongest.', first, { Quality: 'Prefer A.' }, 1, 2, 0, options)
    const firstRunCalls = calls
    assert.ok(firstRunCalls > 0)
    await selectTrajectories('Pick the strongest.', first, { Quality: 'Prefer A.' }, 1, 2, 0, options)
    assert.equal(calls, firstRunCalls, 'identical rerun should be fully cached')

    quality.set('candidate-alpha', 'A')
    quality.set('candidate-beta', 'C')
    quality.set('candidate-gamma', 'T')
    await selectTrajectories('Pick the strongest.', ['candidate-alpha', 'candidate-beta', 'candidate-gamma'], { Quality: 'Prefer A.' }, 1, 2, 0, options)
    assert.ok(calls > firstRunCalls, 'changed candidates must not reuse the old cache')
  } finally {
    backend.complete = originalComplete
  }
})
