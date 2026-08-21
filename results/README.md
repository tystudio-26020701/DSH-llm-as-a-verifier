# Results

Benchmark result summaries live here. Raw trajectory data never enters the
repository; only runner scripts and result summaries are committed.

## Naming

```text
<benchmark>-<mode>[-pilot-<n>tasks].json
<benchmark>-<mode>[-pilot-<n>tasks].md
cache-<benchmark>-<mode>.json   # reusable score cache, git-ignored
```

## Schema

Each result JSON contains:

- `createdAt`, `agentDir`, `limit` (when a subset was run);
- `preset` (`trials`, `pivots`, `evaluations`), `seed`;
- `summary` (`passAt1`, `verifierAccuracy`, `oracleRate`, uplift/gap,
  comparison and call counts, token usage);
- `tasks` (per-task rewards, selected index, scores, ranking).

## Recorded

- `terminal_bench_2.1-bo3.{json,md}` — full 89-task BO3 reproduction,
  seed 0, 2026-08-21.
- `terminal_bench_2.1-bo3-pilot-3tasks.{json,md}` — three-task smoke pilot,
  seed 0, 2026-08-20.

## Policy

- Upstream-reported numbers stay in the main README and are never mixed with
  the tables here.
- A pilot result must be named `pilot-<n>tasks` and is not a full
  reproduction.
- Every full reproduction is accompanied by the reproducibility details in
  [docs/BENCHMARK.md](../docs/BENCHMARK.md).

`usageSource` records when usage was observed on the initial uncached run and
the JSON was later replayed from the score cache.
