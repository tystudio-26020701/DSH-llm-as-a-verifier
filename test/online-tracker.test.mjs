import assert from 'node:assert/strict'
import test from 'node:test'

import { OnlineProgressTracker } from '../dist/lib/index.mjs'

test('online tracker records steps and renders a curve', () => {
  const tracker = new OnlineProgressTracker()
  const session = { id: 's1', events: [] }
  tracker.start(session, 'Solve the task.', 2)
  tracker.pushStep(session, 'Step one')
  tracker.recordScore(session, 0.25)
  tracker.pushStep(session, 'Step two')
  tracker.recordScore(session, 0.75)
  const snapshot = tracker.snapshot(session)
  assert.equal(snapshot.problem, 'Solve the task.')
  assert.deepEqual(snapshot.steps, ['Step one', 'Step two'])
  assert.deepEqual(snapshot.scores, [0.25, 0.75])
  assert.match(tracker.renderResult(snapshot), /1: 0\.25000/)
  assert.match(tracker.renderResult(snapshot), /2: 0\.75000/)
})

test('online tracker rebuilds state from durable tool events', () => {
  const session = {
    id: 's2',
    events: [
      { type: 'tool/call', data: { callId: 'c1', name: 'verifier_tracker_start', arguments: '{"problem":"Build a demo.","evaluations":2}' } },
      { type: 'tool/call', data: { callId: 'c2', name: 'verifier_tracker_update', arguments: '{"step":"First action"}' } },
      { type: 'tool/result', data: { callId: 'c2', message: 'Latest progress after step 1: 0.50000' } },
      { type: 'tool/call', data: { callId: 'c3', name: 'verifier_tracker_update', arguments: '{"step":"Second action"}' } },
      { type: 'tool/result', data: { callId: 'c3', message: 'Latest progress after step 2: 0.90000' } },
    ],
  }
  const tracker = new OnlineProgressTracker()
  const snapshot = tracker.snapshot(session)
  assert.equal(snapshot.problem, 'Build a demo.')
  assert.deepEqual(snapshot.steps, ['First action', 'Second action'])
  assert.deepEqual(snapshot.scores, [0.5, 0.9])
})

test('online tracker observes live events after a cold snapshot', () => {
  const tracker = new OnlineProgressTracker()
  const session = { id: 's3', events: [] }
  tracker.observe(session, { type: 'tool/call', data: { callId: 'c1', name: 'verifier_tracker_start', arguments: '{"problem":"Task"}' } })
  tracker.observe(session, { type: 'tool/call', data: { callId: 'c2', name: 'verifier_tracker_update', arguments: '{"step":"Only step"}' } })
  tracker.observe(session, { type: 'tool/result', data: { callId: 'c2', message: 'Latest progress after step 1: 0.42000' } })
  assert.deepEqual(tracker.snapshot(session).scores, [0.42])
})
