# Provenance — methodology, quoted evidence, and reproduction policy

This document records where the ideas and the quoted evidence in this
repository come from, what was quoted, and how our own results must be kept
separate from upstream results.

## 1. Methodology lineage

DSH-llm-as-a-verifier is an independent implementation of the published
**LLM-as-a-Verifier** methodology:

- Project: <https://github.com/llm-as-a-verifier/llm-as-a-verifier>
- Website: <https://llm-as-a-verifier.com>
- Paper: [arXiv:2607.05391](https://arxiv.org/abs/2607.05391)
- Upstream license: MIT

The three ideas this project implements are, in our own words:

1. score a candidate with a fine-grained ordered letter scale instead of one
   binary label;
2. read the verifier's token-level log-probability distribution at each score
   tag and take its expectation, producing a continuous reward;
3. use repeated evaluations and criterion decomposition to make the reward
   stable, then aggregate directed pairwise rewards for best-of-N selection.

## 2. Source snapshot used for quotes

All quoted material in this repository was read from the upstream repository
at:

- commit `8db8a114355a9d7fdf9a8d1d5c87f6aeebd18770`
- commit date `2026-08-20`
- file `README.md`
- file `LICENSE` (MIT)

Any future update to the quotes must update this snapshot record and
`THIRD_PARTY_NOTICES.md`.

## 3. What is quoted and where

| Quoted material | Used in |
|---|---|
| One-sentence summary of the three key ideas (`README.md`, section "About") | `README.md`, section "Methodology & evidence" |
| Self-Verification (Terminal-Bench 2.1) table | `README.md`, section "Methodology & evidence" |
| Test-Time Scaling table | `README.md`, section "Methodology & evidence" |

The quotes are marked as upstream-reported results and are never presented as
results produced by this repository.

## 4. Recorded reproductions

Results produced by this repository are kept separate from the upstream
quotes above:

- Full Terminal-Bench 2.1 BO3 reproduction (89 tasks, seed 0):
  [`results/terminal_bench_2.1-bo3.md`](../results/terminal_bench_2.1-bo3.md)
  and matching JSON.
- Three-task BO3 smoke pilot:
  [`results/terminal_bench_2.1-bo3-pilot-3tasks.md`](../results/terminal_bench_2.1-bo3-pilot-3tasks.md)
  and matching JSON.

## 5. Rules for future benchmark content

- Upstream numbers and our numbers live in separate tables.
- Every reproduction table must carry its own reproducibility card:
  data source and checksum/commit, runner version, verifier model and backend,
  criteria file, pivots, evaluations, seeds, concurrency, date, token usage,
  and cost.
- Raw trajectory data stays outside this repository (the local `references/`
  folder is git-ignored). Only runner scripts and result summaries are
  committed.
- We do not claim SOTA or imply endorsement by the upstream team.

## 6. Non-endorsement statement

This project is not affiliated with, endorsed by, or certified by the
LLM-as-a-Verifier team. "LLM-as-a-Verifier" is used to credit the methodology;
all code, prompt wording, and documentation here are original.
