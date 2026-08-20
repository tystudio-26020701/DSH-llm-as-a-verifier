# DSH-llm-as-a-verifier

**LLM-as-a-Verifier for DeepSeek Harness** — fine-grained verification,
best-of-N selection, and progress tracking as native agent tools.

Maintained by **Beijing Taiyin Zhaowu Technology Co., Ltd.
(北京太殷造物科技有限公司)** · [简体中文说明](./README.zh-CN.md)

This preset gives a DeepSeek Harness agent a self-contained verification
station. The agent can compare candidate trajectories with a fine-grained
20-level reward read from token log-probabilities, select the best of N
through a probabilistic pivot tournament, track checkpoint progress of a
finished trajectory, and score its **own live session transcript** — all
without leaving the harness.

## Why this exists

Agents are good at producing candidates and bad at knowing which candidate
actually solved the task. This plugin turns an LLM verifier into ordinary
session tools:

| Tool | What it computes |
|---|---|
| `verifier_compare` | Expected rewards `(R_A, R_B)` in `[0, 1]` for two trajectories |
| `verifier_select` | Best-of-N winner, per-candidate scores, ranking |
| `verifier_track` | Progress curve at chosen checkpoints of a finished trajectory |
| `verifier_session` | Progress curve over the current session's durable transcript |
| `verifier_status` | Backend, Rust core version, token usage, working directory |

The methodology is implemented as an independent original codebase:

- **TypeScript** owns DeepSeek Harness integration: tool registration, session
  events, HTTP backends, JSON score cache, and token accounting.
- **Rust** owns the deterministic mathematics: prompt construction, scale
  decoding, log-probability expectation, tournament aggregation, and progress
  decoding. It compiles to a zero-dependency WebAssembly module.
- **No Python.** The repository, build, and test pipeline are TypeScript and
  Rust only.

## Method in one paragraph

Each pairwise comparison asks the verifier for two score tags
(`<score_A>`, `<score_B>`) on an A–T letter scale. Instead of reading one
sampled letter, the plugin reads the provider's top-20 token distribution at
each tag and takes the expected value over the scale — a continuous,
fine-grained reward. A directed ring of comparisons is scored first, the
strongest candidates become pivots, the remaining pivot rounds are scored,
and the results are aggregated under a Bradley-Terry model. Progress tracking
uses the same machinery with the scale inverted (A = no progress, T = done).

## Installation

### 1. Configure a verifier backend

The verifier needs one provider that returns token-level logprobs:

- **DeepSeek official API** — set `DEEPSEEK_API_KEY`.
- **Any OpenAI-compatible server** (vLLM, SGLang, OpenAI, Vertex-compatible) —
  set `VERIFIER_BASE_URL` to the server's `/v1` root and `OPENAI_API_KEY`
  or `VERIFIER_API_KEY`.

See [`.env.example`](./.env.example) for every supported variable.

### 2. Install the preset

```sh
dsh_home="${DSH_HOME:-$HOME/.dsh}"
mkdir -p "$dsh_home/.agent-presets"
rm -rf "$dsh_home/.agent-presets/llm-as-a-verifier"
cp -R preset/llm-as-a-verifier "$dsh_home/.agent-presets/llm-as-a-verifier"
```

Restart DeepSeek Harness, create a new session, and select
**LLM-as-a-Verifier**. The preset ships a lean working catalog (persistent
bash, str_replace_editor, read/write/edit, glob/grep, background jobs) plus
the five verifier tools.

### 3. Verify the installation

Ask the model to call `verifier_status`. A healthy install reports the backend
route, the `deepseek-v4-flash` model (or your override), and the Rust core
version.

## Usage

The model can call the tools directly. Typical patterns:

```text
verifier_compare(problem, traceA, traceB, criteria="general")

verifier_select(problem, candidates=[...], criteria="general",
                evaluations=4, pivots=2, seed=0)

verifier_track(problem, steps=[...], checkpointSteps=[2, 5, 8])

verifier_session(problem="the task this session is solving")
```

`criteria` accepts:

- a bundled name: `general`, `terminal_bench`, `swe_bench`, `medagentbench`;
- a path to a criteria Markdown file;
- a JSON object like `{"Correctness": "Does the output match the task?"}`;
- a JSON array of strings or `{name, description}` objects.

### Criteria files

```md
# Your Task

## Ground Truth Note

Trust observed output, not the agent's narration.

## Criteria

### Requirement Match

Score only whether the produced artifact satisfies the stated requirements.

### Verification Evidence

Score whether a relevant check ran successfully after the last edit.
```

HTML comments are stripped before the verifier sees the file. Criterion ids
are slugged from the heading; pin one with `{#my_id}` when cache stability
matters.

### Backend selection

Resolution order: tool arguments → `agent.cordis.yml` config → user settings
namespace `dsh-verifier` (when the host exposes it) → environment. The
environment variables are documented in [`.env.example`](./.env.example).

For local open models, start the server with token logprobs enabled and point
the preset at it:

```sh
export VERIFIER_BASE_URL="http://localhost:8000/v1"
export VERIFIER_API_KEY="EMPTY"
export VERIFIER_MODEL="your-served-model"
```

When the server does not emit score tags itself, the preset asks it for a
constrained one-token continuation at each tag (`continue_final_message`) and
reads the renormalized A–T distribution directly.

## Repository layout

```text
src/                        TypeScript sources
  lib/                      backend, cache, criteria, core loader, verifier
  plugins/verifier-tools.ts the Cordis plugin (tools + session recorder)
crates/verifier-core/       Rust core (no_std wasm32 + native tests)
preset/llm-as-a-verifier/   installable preset (bundles + criteria + wasm)
scripts/                    Node-only build and hygiene scripts
test/                       Node test runner suite
```

## Development

Prerequisites: Node.js >= 22, npm, Rust with
`rustup target add wasm32-unknown-unknown`.

```sh
npm install
npm run build       # Rust -> wasm, then TypeScript -> preset bundles
npm test            # Node tests + cargo test
npm run check       # full pre-commit gate
```

The prebuilt `preset/llm-as-a-verifier/verifier-core.wasm` is committed so the
preset is copy-and-go; `npm run build:wasm` regenerates it from source.

## License

Dual-licensed:

- **Public code and preset:** [PolyForm Noncommercial License 1.0.0](./LICENSE).
  Free for personal study, research, experimentation, hobby projects, and the
  non-commercial organizations listed in the license. Note that this is a
  source-available non-commercial license, not an OSI open-source license.
- **Commercial use:** a separate written license is required. See
  [COMMERCIAL-LICENSE.md](./COMMERCIAL-LICENSE.md) or contact
  **Beijing Taiyin Zhaowu Technology Co., Ltd. (北京太殷造物科技有限公司)**
  at <tystudio-26020701@protonmail.com>.

This is an original implementation of a published methodology; no source code
was copied from the projects credited in
[ACKNOWLEDGEMENTS.md](./ACKNOWLEDGEMENTS.md).

## Security

Report vulnerabilities privately to <tystudio-26020701@protonmail.com>.
See [SECURITY.md](./SECURITY.md). Never commit `.env`; only
[`.env.example`](./.env.example) is tracked.
