/**
 * Type-check and bundle the TypeScript sources.
 *
 * Outputs:
 *  - preset/llm-as-a-verifier/verifier.mjs — the self-contained Cordis plugin
 *  - dist/lib/index.mjs                    — the library build used by tests
 */

import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { copyFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const typecheck = spawnSync('npx', ['tsc', '-p', 'tsconfig.json', '--noEmit'], {
  stdio: 'inherit',
  cwd: root,
})
if (typecheck.status !== 0) process.exit(typecheck.status ?? 1)

const legal = '// (c) 2026 Beijing Taiyin Zhaowu Technology Co., Ltd. — original implementation; PolyForm Noncommercial 1.0.0'

await build({
  entryPoints: [resolve(root, 'src/plugins/verifier-tools.ts')],
  outfile: resolve(root, 'preset/llm-as-a-verifier/verifier.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  legalComments: 'inline',
  banner: { js: legal },
  logLevel: 'info',
})

await build({
  entryPoints: [resolve(root, 'src/lib/index.ts')],
  outfile: resolve(root, 'dist/lib/index.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  legalComments: 'inline',
  banner: { js: legal },
  logLevel: 'info',
})

// Keep the copied preset self-contained for license-notice purposes.
for (const file of ['LICENSE', 'COMMERCIAL-LICENSE.md', 'ACKNOWLEDGEMENTS.md', 'THIRD_PARTY_NOTICES.md']) {
  await copyFile(resolve(root, file), resolve(root, 'preset/llm-as-a-verifier', file))
}
