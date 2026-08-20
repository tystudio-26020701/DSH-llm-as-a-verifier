# Security Policy

## Reporting a vulnerability

Please report suspected security issues **privately** to:

- **Email:** <tystudio-26020701@protonmail.com>

Please include:

1. the affected component (preset bundle, Rust core, backend transport, cache);
2. a minimal reproduction when possible;
3. whether the issue requires a configured API key or local file access.

Maintainers will acknowledge within 5 business days and aim to publish a fix
within 30 days after confirmation.

## Out of scope

- Missing `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` configuration errors;
- prompt-injection behavior of third-party verifier models;
- intentional local file access through the ordinary filesystem tools the
  preset mounts;
- issues in code you have modified outside this repository.

## Responsible disclosure

Please give maintainers a reasonable window before public disclosure. When
crediting researchers, we will acknowledge reporters unless they prefer to
remain anonymous.

Maintained by Beijing Taiyin Zhaowu Technology Co., Ltd.
(北京太殷造物科技有限公司).
