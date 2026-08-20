# Changelog

## 0.1.0 — 2026-08-20

- Initial DeepSeek Harness preset with five verifier tools.
- Rust `no_std` wasm32 core: A–T scale, logprob expectation, pair and
  progress prompts, probabilistic pivot tournament, progress decoding.
- TypeScript integration layer: DeepSeek and OpenAI-compatible backends,
  constrained score-tag prefill, JSON score cache, token accounting.
- Session transcript recorder powering `verifier_session`.
- Bundled criteria for general, terminal, software-maintenance, and
  domain-question tasks.
- Dual licensing: PolyForm Noncommercial 1.0.0 plus commercial license.

## 0.2.0 (unreleased)

- Add online incremental progress tracker tools (`verifier_tracker_start`,
  `verifier_tracker_update`, `verifier_tracker_result`) with resume-safe
  event-sourced state.
- Add optional `verify-gate` plugin for automatic final-answer verification
  at turn boundaries (disabled by default).
- Add provenance and third-party notice documents.
- Add TypeScript Terminal-Bench benchmark runner and pilot result docs.
- Parallelize the verifier warm-up wave.
