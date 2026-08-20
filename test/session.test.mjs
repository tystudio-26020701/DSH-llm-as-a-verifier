import assert from 'node:assert/strict'
import test from 'node:test'

import { TranscriptRecorder } from '../dist/lib/index.mjs'

test('transcript recorder derives steps from durable session events', () => {
  const recorder = new TranscriptRecorder()
  const session = {
    id: 's1',
    events: [
      { type: 'assistant/message', data: { message: 'Planning the change' } },
      { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"echo hi"}' } },
      { type: 'tool/result', data: { message: [{ type: 'text', text: 'hi' }] } },
    ],
  }
  const steps = recorder.snapshot(session)
  assert.equal(steps.length, 2)
  assert.match(steps[0] ?? '', /Planning/)
  assert.match(steps[1] ?? '', /Action: bash/)
  assert.match(steps[1] ?? '', /Output:\nhi/)
})

test('live observation updates an existing transcript', () => {
  const recorder = new TranscriptRecorder()
  const session = { id: 's2', events: [] }
  recorder.observe(session, { type: 'tool/call', data: { name: 'bash', arguments: '{}' } })
  recorder.observe(session, { type: 'tool/result', data: { message: 'done' } })
  assert.deepEqual(recorder.snapshot(session), ['Action: bash\nArguments: {}\nOutput:\ndone'])
})

test('cold snapshots rebuild from the durable log', () => {
  const recorder = new TranscriptRecorder()
  const session = {
    id: 's3',
    events: [{ type: 'assistant/message', data: { message: 'finished' } }],
  }
  assert.deepEqual(recorder.snapshot(session), ['Agent message:\nfinished'])
})
