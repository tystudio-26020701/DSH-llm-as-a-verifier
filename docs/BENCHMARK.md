# Benchmark guide — Terminal-Bench best-of-N reproduction

This guide covers the **Self-Verification (Terminal-Bench 2.1)** and
**Test-Time Scaling (Terminal-Bench V2)** reproductions using
DSH-llm-as-a-verifier. The runner is TypeScript/Node only; no Python is used.

## 1. What you need

- Node.js >= 22 (same requirement as the preset).
- A verifier backend:
  - **DeepSeek official API** (`DEEPSEEK_API_KEY`) for numbers comparable to
    the upstream self-verification study, or
  - any OpenAI-compatible server that returns token-level logprobs
    (`VERIFIER_BASE_URL` + `VERIFIER_API_KEY` / `OPENAI_API_KEY`).
- The pre-generated trajectory data. Keep it in the git-ignored
  `references/llm-as-a-verifier/data/` directory. The repository does not
  commit trajectory data.
- A recent build: `npm run build` (builds the Rust wasm core and the
  TypeScript library).

## 2. Cost model

The tournament scores a directed ring plus pivot rounds. For `n` candidates
and `k` pivots the number of directed comparisons is:

```text
n + k * (n - k) + k * (k - 1) / 2
```

Every directed comparison is repeated per criterion and per evaluation.

| Preset | Candidates | Pivots | Evaluations | Comparisons/task | Criteria | Verifier calls/task |
|---|---|---|---|---|---|---|
| `bo3` | 3 | 1 | 2 | 5 | 3 | 30 |
| `bo5` | 5 | 2 | 2 | 12 | 3 | 72 |
| `terminal_v2` | 5 | 2 | 4 | 12 | 3 | 144 |

Terminal-Bench 2.1 and 2.0 each contain 89 tasks locally, so full-run
estimates are:

| Preset | Verifier calls | Rough scale |
|---|---|---|
| `bo3` | ~2,670 | smallest recommended first run |
| `bo5` | ~6,408 | medium |
| `terminal_v2` | ~12,816 | large; budget API spend first |

Use `--dry-run` to print the exact estimate for your data directory before
spending any API quota.

### Cost notes

- Trajectory data is pre-generated; the machine only issues HTTP calls. A
  1–2 vCPU VPS with stable networking is sufficient.
- The dominant cost is verifier output tokens (DeepSeek reasoning is enabled
  by default and shares the output budget). Set
  `VERIFIER_MAX_TOKENS=32768` / `VERIFIER_EFFORT=high` (defaults) for a
  comparable setup, or lower them for a cheaper pilot.
- Concurrency: DeepSeek tolerates high concurrency, but a rented server may
  rate-limit outbound connections. Start with `VERIFIER_MAX_CONCURRENCY=4`
  for a pilot, then raise it.

## 3. Local machine

```sh
# one-time setup
npm install
npm run build
export DEEPSEEK_API_KEY="..."          # never write the key into a tracked file

# estimate first
node scripts/benchmark.mjs terminal_bench_2.1 --mode bo3 --dry-run

# pilot: first 3 tasks
node scripts/benchmark.mjs terminal_bench_2.1 --mode bo3 --limit 3

# full reproduction
node scripts/benchmark.mjs terminal_bench_2.1 --mode bo3
node scripts/benchmark.mjs terminal_bench_2.1 --mode bo5
node scripts/benchmark.mjs terminal_bench_2.0 --mode terminal_v2 --limit 3
```

Results are written to:

```text
results/<benchmark>-<mode>.json
results/<benchmark>-<mode>.md
results/cache-<benchmark>-<mode>.json   # reusable score cache
```

## 4. Temporary rented server

1. Provision a small Linux VPS (1–2 vCPU, 2 GB RAM is enough).
2. Install Node.js >= 22 and clone this repository.
3. Copy the trajectory data into `references/llm-as-a-verifier/data/` on the
   server (or generate it elsewhere and rsync it over).
4. Set the API key in the shell environment or the DSH credentials store;
   never put it in a file that git tracks.
5. Run `npm ci && npm run build`, then the dry-run and a `--limit 3` pilot.
6. Use `tmux`/`screen`/`nohup` for long runs, capture stdout to a log, and
   pull `results/*.json` + `results/*.md` back to your local repository for
   review before committing.
7. Record server OS, Node/Rust versions, date, and any non-default
   environment variables in the reproducibility card below.

## 5. Reproducibility card (fill in for every committed result set)

```md
- Runner: scripts/benchmark.mjs
- Repository commit: <git rev-parse HEAD>
- Data source: references/llm-as-a-verifier (upstream commit 8db8a11)
- Data directory checksum: sha256sum of the JSON files (optional)
- Verifier backend: <DeepSeek official API | OpenAI-compatible URL>
- Verifier model: <model id>
- Criteria: terminal_bench (bundled)
- Preset: trials / pivots / evaluations
- Seeds: <list>
- Concurrency: <maxConcurrency>
- Environment: VERIFIER_EFFORT / VERIFIER_MAX_TOKENS
- Run date (UTC): <iso date>
- Cost / token usage: <input, cached input, output, reasoning>
```

## 6. Reporting policy

- Upstream-reported numbers stay in the README "Methodology & evidence"
  section's labeled `Up.` columns; our results stay in labeled `Ours`
  columns or in `results/` tables. The two are never presented as one
  unlabeled dataset.
- Commit only runner scripts and result summaries. Trajectory data stays
  untracked.
- Report mean and, when multiple seeds are run, standard deviation. Label
  every table "Independent reproduction with DSH-llm-as-a-verifier".
- If a number differs from upstream, publish it anyway with the full config;
  a clean negative result is useful.

## Recorded results

Full BO3 reproduction, `2026-08-21`, 89 tasks, seed 0:

| Tasks | Pass@1 | Verifier | Oracle | Calls | Input tokens | Cached input | Output tokens |
|---|---|---|---|---|---|---|---|
| 89 | 79.78% | 84.27% | 92.13% | 1,217 | 97,785,688 | 71,659,520 | 5,834,454 |

Result files:
[`results/terminal_bench_2.1-bo3.md`](../results/terminal_bench_2.1-bo3.md)
and the matching JSON. This is an independent reproduction with
DSH-llm-as-a-verifier; upstream numbers stay in the README provenance
section. Only one seed has been run so far — run more seeds before quoting a
confidence interval.

Three-task smoke pilot, `2026-08-20`, seed 0:

| Tasks | Pass@1 | Verifier | Oracle | Calls | Input tokens | Output tokens |
|---|---|---|---|---|---|---|
| 3 | 100.00% | 100.00% | 100.00% | 72 | 4,118,922 | 376,814 |

Pilot files:
[`results/terminal_bench_2.1-bo3-pilot-3tasks.md`](../results/terminal_bench_2.1-bo3-pilot-3tasks.md)
and the matching JSON.
