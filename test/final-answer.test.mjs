import assert from 'node:assert/strict'
import test from 'node:test'

import { findFinalAnswer, extractFirstUserMessage } from '../dist/lib/index.mjs'

const session = {
  events: [
    { type: 'user/message', source: { kind: 'user' }, message: [{ type: 'text', text: 'Fix the bug.' }] },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: [{ type: 'text', text: 'Planning...' }] } },
    { type: 'tool/call', data: { turn: 1, step: 1, name: 'bash', callId: 'x' } },
    { type: 'assistant/message', data: { turn: 1, step: 2, message: [{ type: 'text', text: 'Done. Final answer is 42.' }] } },
  ],
}

test('extractFirstUserMessage skips plugin messages', () => {
  assert.equal(extractFirstUserMessage(session), 'Fix the bug.')
})

test('findFinalAnswer returns the last tool-free assistant message', () => {
  const candidate = findFinalAnswer(session, 1)
  assert.equal(candidate?.text, 'Done. Final answer is 42.')
  assert.equal(candidate?.step, 2)
})

test('findFinalAnswer ignores a turn with no final text', () => {
  assert.equal(findFinalAnswer(session, 99), undefined)
})
