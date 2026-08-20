# Acknowledgements

This project implements and packages the published **LLM-as-a-Verifier**
methodology — fine-grained letter-scale scoring, expectation over token-level
log-probabilities, and probabilistic pivot-tournament best-of-N selection —
as a DeepSeek Harness preset.

We thank the researchers and maintainers of the following projects for
publishing the ideas and the integration model that made this implementation
possible:

- [llm-as-a-verifier](https://github.com/llm-as-a-verifier/llm-as-a-verifier) —
  methodology reference: fine-grained reward, pivot tournament, and progress
  tracking.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —
  the target platform, its Cordis plugin model, and the agent preset format.
- [PolyForm Project](https://polyformproject.org/) — the license used for this
  repository.

**Originality statement.** This repository contains an independent
implementation written for this project. No source file was copied from the
projects above; they were used as published methodology and platform
documentation. Any similarity in concepts (scale levels, pairwise evaluation,
tournament structure) is inherent to the methodology being implemented, while
all code, prompt wording, and documentation here are original.

DeepSeek and DeepSeek Harness are names of their respective owner. This
community project is not affiliated with or endorsed by DeepSeek.

Maintained by Beijing Taiyin Zhaowu Technology Co., Ltd.
(北京太殷造物科技有限公司).
