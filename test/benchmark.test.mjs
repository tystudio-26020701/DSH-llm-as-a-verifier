import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  BENCHMARK_PRESETS,
  comparisonsFor,
  estimateBenchmark,
  loadTerminalBenchmark,
  runTerminalBenchmark,
  VerifierBackend,
} from '../dist/lib/index.mjs'

function trajectory(taskName, trialName, reward) {
  return {
    trial_name: trialName,
    reward,
    trajectory: {
      steps: [
        { step_id: 1, source: 'user', message: `Solve the ${taskName} task.` },
        { step_id: 2, source: 'system', message: '$ env' },
        {
          step_id: 3,
          source: 'agent',
          message: `Working on ${taskName}. CAND-${taskName}-${trialName}`,
          tool_calls: [{ arguments: { keystrokes: `echo ${trialName}` } }],
          observation: { results: [{ content: `output-for-${trialName}` }] },
        },
      ],
    },
  }
}

async function seedBenchmark() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-bench-'))
  for (const [task, count] of [['task-a', 3], ['task-b', 2]]) {
    const taskDir = join(directory, task)
    await mkdir(taskDir, { recursive: true })
    for (let index = 1; index <= count; index += 1) {
      const reward = task === 'task-a' ? (index === 1 ? 1 : 0) : (index === 2 ? 1 : 0)
      await writeFile(
        join(taskDir, `${task}__trial${index}_trajectory.json`),
        JSON.stringify(trajectory(task, `trial${index}`, reward)),
      )
    }
  }
  return directory
}

test('terminal loader extracts problems and renders traces', async () => {
  const directory = await seedBenchmark()
  const tasks = await loadTerminalBenchmark(directory, 3)
  assert.equal(tasks.size, 2)
  const taskA = tasks.get('task-a') ?? []
  assert.equal(taskA.length, 3)
  assert.equal(taskA[0]?.problem, 'Solve the task-a task.')
  assert.equal(taskA[0]?.reward, 1)
  assert.match(taskA[0]?.trace ?? '', /--- Agent Step 3 ---/)
  assert.match(taskA[0]?.trace ?? '', /\[Command\] echo trial1/)
  assert.match(taskA[0]?.trace ?? '', /output-for-trial1/)
})

test('comparison and call estimates match the tournament formula', () => {
  assert.equal(comparisonsFor(3, 1), 5)
  assert.equal(comparisonsFor(5, 2), 12)
  const tasks = new Map([
    ['a', [1, 2, 3]],
    ['b', [1, 2]],
  ])
  const estimate = estimateBenchmark(tasks, BENCHMARK_PRESETS.bo3, 3)
  assert.equal(estimate.tasks, 2)
  assert.equal(estimate.comparisons, 8)
  assert.equal(estimate.verifierCalls, 8 * 2 * 3)
})

test('benchmark runner selects the successful candidate per task', async () => {
  const directory = await seedBenchmark()
  const backend = new VerifierBackend({
    kind: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'test',
    model: 'deepseek-v4-flash',
    maxTokens: 512,
    effort: 'off',
    maxConcurrency: 1,
    timeoutMs: 1000,
    onError: 'tie',
    cachePath: undefined,
  })
  const originalComplete = backend.complete
  backend.complete = async (prompt) => {
    const markerA = /Candidate A:\n[\s\S]*?CAND-([\w-]+-trial\d)/.exec(prompt)?.[1] ?? 'none'
    const markerB = /Candidate B:\n[\s\S]*?CAND-([\w-]+-trial\d)/.exec(prompt)?.[1] ?? 'none'
    const successful = new Set(['task-a-trial1', 'task-b-trial2'])
    const letter = (marker) => (successful.has(marker) ? 'A' : 'T')
    return {
      text: `<score_A> ${letter(markerA)} </score_A>\n<score_B> ${letter(markerB)} </score_B>`,
      tokens: null,
      positions: null,
      usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10, reasoningTokens: 0 },
    }
  }
  try {
    const run = await runTerminalBenchmark({
      agentDir: directory,
      preset: { ...BENCHMARK_PRESETS.bo3, evaluations: 1 },
      criteria: { Quality: 'Prefer the successful candidate.' },
      seed: 0,
      cache: false,
      backendInstance: backend,
      cwd: directory,
    })
    assert.equal(run.summary.tasks, 2)
    assert.equal(run.summary.passAt1, 0.5)
    assert.equal(run.summary.verifierAccuracy, 1)
    assert.equal(run.summary.oracleRate, 1)
    assert.equal(run.summary.nComparisons, 8)
    assert.deepEqual(run.tasks.map((task) => task.selectedIndex), [0, 1])
  } finally {
    backend.complete = originalComplete
  }
})
