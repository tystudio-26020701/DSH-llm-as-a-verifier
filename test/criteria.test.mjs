import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { normalizeCriteria, parseCriteriaMarkdown, resolveCriteria } from '../dist/lib/index.mjs'

test('criteria markdown parser extracts note and criterion ids', () => {
  const document = parseCriteriaMarkdown(`# Title

## Ground Truth Note

Trust output only.

## Criteria

### Final Answer Correctness

Score the final answer.

### Empirical Verification {#verification}

Look at the commands.
`)
  assert.equal(document.groundTruthNote, 'Trust output only.')
  assert.deepEqual(
    document.criteria.map((criterion) => criterion.id),
    ['final_answer_correctness', 'verification'],
  )
})

test('inline criteria normalize dicts and arrays', () => {
  const fromObject = normalizeCriteria({ Correctness: 'Is it right?' })
  assert.equal(fromObject[0]?.name, 'Correctness')
  const fromArray = normalizeCriteria(['Solves the task', { name: 'Checks', description: 'Ran checks', id: 'checks' }])
  assert.equal(fromArray[1]?.id, 'checks')
})

test('invalid criteria documents fail loudly', () => {
  assert.throws(() => parseCriteriaMarkdown('# Only a title'), /no criteria/)
  assert.throws(() => normalizeCriteria([]), /must not be empty/)
})

test('resolveCriteria reads a workspace criteria file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-verifier-criteria-'))
  await writeFile(
    join(directory, 'task.md'),
    '## Ground Truth Note\n\nUse the output.\n\n## Criteria\n\n### Result\n\nCompare the result.\n',
  )
  const document = await resolveCriteria('task', directory)
  assert.equal(document.criteria[0]?.id, 'result')
})
