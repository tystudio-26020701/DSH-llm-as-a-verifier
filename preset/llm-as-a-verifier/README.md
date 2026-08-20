# LLM-as-a-Verifier preset

DeepSeek Harness preset id: `llm-as-a-verifier`.

Maintained by Beijing Taiyin Zhaowu Technology Co., Ltd.
(北京太殷造物科技有限公司) — full documentation in the repository:
<https://github.com/tystudio-26020701/DSH-llm-as-a-verifier>

## Tools

- `verifier_compare` — pairwise fine-grained rewards from token logprobs.
- `verifier_select` — best-of-N probabilistic pivot tournament.
- `verifier_track` — checkpoint progress curve for a finished trajectory.
- `verifier_session` — progress curve over this session's durable transcript.
- `verifier_status` — backend, core version, and token usage report.

## Backend

Set `DEEPSEEK_API_KEY` for the official DeepSeek API, or
`VERIFIER_BASE_URL` + `OPENAI_API_KEY`/`VERIFIER_API_KEY` for any
OpenAI-compatible server that returns token-level logprobs.

## License

PolyForm Noncommercial License 1.0.0. Commercial use requires a written
license from Beijing Taiyin Zhaowu Technology Co., Ltd.
