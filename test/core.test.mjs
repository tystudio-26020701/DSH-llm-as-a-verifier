import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildPairPrompt,
  buildProgressPrompt,
  coreVersion,
  extractProgress,
  extractScore,
  pptPlan,
  pptResult,
  pptRing,
} from '../dist/lib/index.mjs'

test('core version reports the Rust module version', async () => {
  assert.match(await coreVersion(), /^\d+\.\d+\.\d+$/)
})

test('pair prompt puts criterion after the heavy content and tags last', async () => {
  const prompt = await buildPairPrompt({
    problem: 'Task body',
    traceA: 'Candidate A body',
    traceB: 'Candidate B body',
    criterion: { name: 'Correctness', description: 'Score only correctness.' },
    groundTruthNote: 'Trust output.',
    nImages: 0,
  })
  assert.match(prompt, /Candidate A:/)
  assert.match(prompt, /Candidate B:/)
  assert.ok(prompt.lastIndexOf('Correctness') < prompt.lastIndexOf('<score_A>'))
  assert.ok(prompt.endsWith('<score_B> LETTER_A_TO_T </score_B>\n'))
})

test('progress prompt numbers steps and checkpoints', async () => {
  const prompt = await buildProgressPrompt({
    problem: 'Task',
    steps: ['step one', 'step two', 'step three'],
    checkpointSteps: [1, 3],
    nImages: 0,
  })
  assert.match(prompt, /=== Agent step 1 ===/)
  assert.match(prompt, /=== Agent step 3 ===/)
  assert.match(prompt, /<c1>LETTER<\/c1>/)
  assert.match(prompt, /<c2>LETTER<\/c2>/)
})

test('score extraction falls back to the last tagged letter in text', async () => {
  const score = await extractScore({
    text: 'analysis <score_A> C </score_A>',
    tokens: [],
    positions: [],
    tag: 'score_A',
  })
  assert.ok(Math.abs(score - 17 / 19) < 1e-9)
})

test('score extraction prefers logprob expectation when positions exist', async () => {
  const tokens = ['<score_', 'A>', ' A', ' ', '</score_A>']
  const positions = [
    [{ token: '<score_', logprob: -0.01 }],
    [{ token: 'A>', logprob: -0.01 }],
    [
      { token: ' A', logprob: -0.05 },
      { token: ' C', logprob: -3.0 },
    ],
    [{ token: ' ', logprob: 0.0 }],
    [{ token: '</score_A>', logprob: 0.0 }],
  ]
  const score = await extractScore({ text: '', tokens, positions, tag: 'score_A' })
  assert.ok(score > 0.9, `A should dominate, got ${score}`)
})

test('progress extraction decodes A/T endpoints', async () => {
  const scores = await extractProgress({
    text: '<c1>A</c1>\n<c2>T</c2>',
    tokens: [],
    positions: [],
    count: 2,
  })
  assert.ok(Math.abs((scores[0] ?? -1) - 0) < 1e-9)
  assert.ok(Math.abs((scores[1] ?? -1) - 1) < 1e-9)
})

test('ring cycle is deterministic and covers every candidate', async () => {
  const ring = await pptRing(8, 42)
  assert.equal(ring.length, 8)
  assert.deepEqual(ring, await pptRing(8, 42))
  const seen = new Set(ring.flat())
  assert.equal(seen.size, 8)
})

test('tournament plan and result prefer the strong candidate', async () => {
  const comparisons = [
    { a: 0, b: 1, rewardA: 0.9, rewardB: 0.2 },
    { a: 1, b: 2, rewardA: 0.1, rewardB: 0.1 },
    { a: 2, b: 0, rewardA: 0.3, rewardB: 0.8 },
  ]
  const plan = await pptPlan({ n: 3, pivots: 2, comparisons })
  assert.ok(plan.pivots.includes(0))
  const result = await pptResult({ n: 3, comparisons })
  assert.equal(result.bestIndex, 0)
  assert.deepEqual(result.ranking, [0, 2, 1])
})
