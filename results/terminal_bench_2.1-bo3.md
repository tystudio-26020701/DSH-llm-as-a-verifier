# terminal_bench_2.1 — bo3 reproduction

- Run at: 2026-08-21T02:19:09.803Z
- Preset: trials=3, pivots=1, evaluations=2, seed=0
- Data source: `/run/media/lcz/b9694bf8-68f6-456d-bb43-03f8d2d9eec2/Creation/llm-as-a-verifier-Plugin/references/llm-as-a-verifier/data/terminal_bench_2.1_trajs/mini-swe-agent_deepseek-v4-flash`

## Summary

| Metric | Value |
|---|---|
| Tasks | 89 |
| Pass@1 | 79.78% |
| Verifier selection | 84.27% |
| Oracle | 92.13% |
| Uplift over Pass@1 | 4.49% |
| Gap to oracle | 7.87% |
| Directed comparisons | 445 |
| Verifier calls | 1217 |
| Input tokens | 97785688 |
| Cached input tokens | 71659520 |
| Output tokens | 5834454 |

> Independent reproduction with DSH-llm-as-a-verifier. Upstream reported
> numbers live in the main README and are tracked separately.
