/**
 * Pre-commit sanity gate for repository hygiene.
 *
 * Verifies that local-only materials never became trackable and that no
 * Python source was introduced by this project.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ignoredRoots = new Set(['.git', 'node_modules', 'references', '.cargo-home', '.npm-cache', '.wasm-sysroot'])

function run(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8' }).trim()
}

function walk(directory) {
  const files = []
  for (const entry of readdirSync(directory)) {
    if (ignoredRoots.has(entry)) continue
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) files.push(...walk(path))
    else if (entry !== 'package-lock.json') files.push(path)
  }
  return files
}

const trackedReferences = run('git', ['ls-files', 'references'])
if (trackedReferences.length > 0) {
  console.error('references/ must never be tracked:', trackedReferences)
  process.exit(1)
}

for (const local of ['AGENTS.md', 'LOCAL-NOTES.md']) {
  const check = spawnSync('git', ['check-ignore', '-q', local], { cwd: root })
  if (check.status !== 0) {
    console.error(`${local} must stay git-ignored`)
    process.exit(1)
  }
}

for (const file of walk(root)) {
  if (file.includes(`${join(root, 'crates')}`) && file.includes(`${join(root, 'target')}`)) continue
  if (extname(file).toLowerCase() === '.py') {
    console.error('Python source found in project content:', file)
    process.exit(1)
  }
}

console.log('Repository hygiene checks passed.')
