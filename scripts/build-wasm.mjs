/**
 * Build the Rust methodology core for wasm32-unknown-unknown and copy the
 * resulting module into the preset and the JS test build.
 *
 * Standard setup: `rustup target add wasm32-unknown-unknown`, then run this
 * script. For unusual toolchains the script honors:
 *   VERIFIER_CARGO          cargo executable to use
 *   VERIFIER_RUSTC          rustc executable cargo should invoke
 *   VERIFIER_WASM_RUSTFLAGS extra RUSTFLAGS for the wasm build
 */

import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = resolve(root, 'crates/verifier-core/Cargo.toml')
const sourceWasm = resolve(root, 'crates/verifier-core/target/wasm32-unknown-unknown/release/dsh_verifier_core.wasm')
const destinations = [
  resolve(root, 'preset/llm-as-a-verifier/verifier-core.wasm'),
  resolve(root, 'dist/lib/verifier-core.wasm'),
]

function run(command, args, env = process.env) {
  return spawnSync(command, args, { stdio: 'inherit', env, cwd: root })
}

function buildWith(cargo, env) {
  return run(cargo, [
    'build',
    '--manifest-path', manifest,
    '--release',
    '--target', 'wasm32-unknown-unknown',
  ], env)
}

const cargo = process.env.VERIFIER_CARGO ?? 'cargo'
const env = { ...process.env }
if (process.env.VERIFIER_RUSTC !== undefined) env.RUSTC = process.env.VERIFIER_RUSTC
if (process.env.VERIFIER_WASM_RUSTFLAGS !== undefined) env.RUSTFLAGS = process.env.VERIFIER_WASM_RUSTFLAGS

let result = buildWith(cargo, env)
if (result.status !== 0) {
  const rustup = process.env.VERIFIER_RUSTUP ?? 'rustup'
  const probe = run(rustup, ['target', 'list', '--installed'], env)
  if (probe.status === 0 && !probe.stdout?.toString().includes('wasm32-unknown-unknown')) {
    console.error('The wasm32-unknown-unknown target is missing; installing it with rustup...')
    const add = run(rustup, ['target', 'add', 'wasm32-unknown-unknown'], env)
    if (add.status === 0) result = buildWith(cargo, env)
  }
}

if (result.status !== 0) {
  console.error('Rust wasm build failed. Install the target with:')
  console.error('  rustup target add wasm32-unknown-unknown')
  process.exit(result.status ?? 1)
}

for (const destination of destinations) {
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(sourceWasm, destination)
}
console.error(`Wasm core ready: ${destinations.join(', ')}`)
