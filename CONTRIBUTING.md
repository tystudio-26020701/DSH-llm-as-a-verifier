# Contributing

Thanks for your interest in DSH-llm-as-a-verifier. This project is maintained
by Beijing Taiyin Zhaowu Technology Co., Ltd. (北京太殷造物科技有限公司) and
is licensed under the PolyForm Noncommercial License 1.0.0; by submitting a
contribution you agree that your contribution will be distributed under that
license unless a different written agreement says otherwise.

## Ground rules

- The repository is TypeScript and Rust only. Do not add Python.
- Preset bundles under `preset/` are generated; edit the sources under `src/`
  and run `npm run build`.
- The Rust core targets `wasm32-unknown-unknown` with `no_std`. Keep the ABI
  JSON-in / JSON-envelope-out and extend `src/lib/core.ts` in the same step.
- Keep runtime dependencies at zero for the preset bundle; development
  dependencies only.
- Tests: add coverage for new behavior in `test/` (Node) and/or
  `crates/verifier-core/src/lib.rs` (cargo test).

## Local workflow

```sh
npm install
npm run build
npm test
npm run check
```

## Pull requests

1. Open an issue first for large changes so the design can be discussed.
2. One focused change per pull request.
3. Update README and CHANGELOG when behavior changes.
4. Keep commit subjects short and descriptive.
5. Run `npm run check` before pushing.
