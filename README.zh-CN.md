
![alt text](asstes/DSH-LLM-as-a-Verifier_02.svg)

# DSH-llm-as-a-verifier

**面向 DeepSeek Harness 的 LLM-as-a-Verifier**——把细粒度验证、Best-of-N
择优与进度追踪做成智能体原生工具。

由 **北京太殷造物科技有限公司（Beijing Taiyin Zhaowu Technology Co., Ltd.）**
维护 · [English README](./README.md)

该预设为 DeepSeek Harness 智能体提供一套自包含的“验证站”：智能体可以直接
比较候选轨迹、从 token 级 log-probabilities 读取 20 级细粒度奖励、通过概率
枢轴锦标赛挑选 N 个候选中的最优解、评估已完成轨迹的进度曲线，并对自己
**当前会话的持久化轨迹**打分——全程无需离开 Harness。

## 工具一览

| 工具 | 能力 |
|---|---|
| `verifier_compare` | 两条轨迹的期望奖励 `(R_A, R_B)`，取值 `[0, 1]` |
| `verifier_select` | Best-of-N 的胜者、逐候选分数与排序 |
| `verifier_track` | 已完成轨迹在指定检查点的进度曲线 |
| `verifier_session` | 当前会话持久化轨迹的进度曲线 |
| `verifier_tracker_start` / `_update` / `_result` | 在线增量进度曲线，只评分当前前缀 |
| `verifier_status` | 后端、Rust 核心版本、token 用量与工作目录 |
| `verify-gate`（可选插件行） | 回合结束前自动评分最终答复，低于阈值则引导模型返工 |

本仓库是对已发表方法论的独立原创实现：

- **TypeScript** 负责 DeepSeek Harness 集成：工具注册、会话事件、HTTP 后端、
  JSON 分数缓存与 token 记账。
- **Rust** 负责确定性数学：提示词构造、字母刻度解码、log-probability 期望、
  锦标赛聚合与进度解码，并编译为零依赖 WebAssembly 模块。
- **零 Python**：仓库、构建与测试只使用 TypeScript 与 Rust。

## 方法概览

每次成对比较要求验证模型输出两个分数标签（`<score_A>`、`<score_B>`），
评分使用 A–T 共 20 个字母等级。插件不读取单个采样字母，而是读取每个标签
位置上的 top-20 token 分布并计算期望值，得到连续的细粒度奖励。首先对随机
有向环上的相邻比较打分，将最强候选提升为枢轴，再完成其余枢轴轮次，最后用
Bradley-Terry 模型聚合。进度追踪复用同一机制，但刻度反转（A = 无进展，
T = 完成）。

## 方法论出处与上游结果

本预设是已发表的 [LLM-as-a-Verifier](https://github.com/llm-as-a-verifier/llm-as-a-verifier)
方法论的独立实现。上游 README 如此概括其核心思想（原文引用）：

> The key idea is simple: 1) use fine-grained scoring granularity, 2) take the
> expectation over the full logprob distribution of LLM score tokens, and 3)
> scale repeated evaluation and criteria decomposition.

以下数字为**上游报告的结果**，仅用于方法论出处与社区致敬，并非本仓库产出：

| Config | Pass@1 | LLM-as-a-Verifier | Oracle |
|---|---|---|---|
| Best-of-3 | 79.4% | **86.5% ± 1.1%** | 92.1% |
| Best-of-5 | 78.7% | **88.0% ± 0.6%** | 96.6% |

| Benchmark | Base Model | Harness | Pass@1 | LLM-as-a-Verifier | Oracle |
|---|---|---|---|---|---|
| Terminal-Bench V2 | GPT-5.5 (Best-of-5) | Capy | 83.1% | **86.5%** | 92.1% |
| SWE-Bench Verified | Opus 4.5 / Opus 4.6 / Gemini 3 Flash (Best-of-3) | mini-swe-agent | 76.1% | **78.2%** | 84.4% |
| MedAgentBench | Claude Opus 4.8 (Best-of-5) | AgentBench | 70.2% | **73.3%** | 75.0% |

来源：llm-as-a-verifier `README.md`，commit
`8db8a114355a9d7fdf9a8d1d5c87f6aeebd18770`（2026-08-20），MIT 许可。完整引用
跟踪与引用政策见 [docs/PROVENANCE.md](./docs/PROVENANCE.md) 与
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

本仓库自己的复现结果将单独发布在 `results/`，并附带完整复现卡片，绝不与
上表混用。目前已完成 89 任务 BO3 完整复现，见
[`results/terminal_bench_2.1-bo3.md`](./results/terminal_bench_2.1-bo3.md)；
三任务冒烟 pilot 见
[`results/terminal_bench_2.1-bo3-pilot-3tasks.md`](./results/terminal_bench_2.1-bo3-pilot-3tasks.md)。

## 安装

### 1. 配置验证后端

验证模型必须返回 token 级 logprobs，二选一：

- **DeepSeek 官方 API**——设置 `DEEPSEEK_API_KEY`；
- **任意 OpenAI 兼容服务**（vLLM、SGLang、OpenAI、Vertex 兼容端点）——
  设置 `VERIFIER_BASE_URL`（服务 `/v1` 根地址）以及 `OPENAI_API_KEY` 或
  `VERIFIER_API_KEY`。

全部环境变量见 [`.env.example`](./.env.example)。

### 2. 安装预设

```sh
dsh_home="${DSH_HOME:-$HOME/.dsh}"
mkdir -p "$dsh_home/.agent-presets"
rm -rf "$dsh_home/.agent-presets/llm-as-a-verifier"
cp -R preset/llm-as-a-verifier "$dsh_home/.agent-presets/llm-as-a-verifier"
```

重启 DeepSeek Harness，打开一个**全新的空白会话**并选择
**LLM-as-a-Verifier**。DeepSeek Harness 只会在会话仍为空白时应用预设切换；
已有历史记录的会话会继续使用其创建时的预设。该预设自带精简工作目录
（持久化 bash、str_replace_editor、read/write/edit、glob/grep、后台任务）
和五个验证工具。

### 3. 验证安装

让模型调用 `verifier_status`。健康安装会报告后端路由、默认模型
`deepseek-v4-flash`（或你的覆盖值）以及 Rust 核心版本。


## 在线进度追踪器

`verifier_tracker_*` 等价迁移了已发表的增量 `ProgressTracker`：每次 update
只追加一步、只对“迄今前缀”打分。状态从持久化工具事件重建，重启后可恢复。

```text
verifier_tracker_start(problem="任务", evaluations=2)
verifier_tracker_update(step="第 1 步动作 + 输出")  -> 0.03
verifier_tracker_update(step="第 2 步动作 + 输出")  -> 0.41
verifier_tracker_result()
```

适合在长 rollout 中做早停或重采样。

## 最终答复自动验证门

预设挂载了可选的 `verify-gate` 行。设置 `enabled: true` 后，每个回合即将
以纯文本最终答复结束时，插件会结合会话任务自动打分；低于 `threshold` 就
通过 `agent.steer` 把模型拉回去返工。验证调用失败时绝不阻塞回合关闭。

编辑 `preset/llm-as-a-verifier/agent.cordis.yml` 启用：

```yaml
- id: verify-gate
  name: ./verify-gate.mjs
  config:
    enabled: true
    threshold: 0.6
    maxGatesPerTurn: 1
    evaluations: 1
    criteria: general
    includeSubagents: false
```


## 使用方式

```text
verifier_compare(problem, traceA, traceB, criteria="general")

verifier_select(problem, candidates=[...], criteria="general",
                evaluations=4, pivots=2, seed=0)

verifier_track(problem, steps=[...], checkpointSteps=[2, 5, 8])

verifier_session(problem="当前会话要解决的任务")
```

`criteria` 支持：

- 内置名称：`general`、`terminal_bench`、`swe_bench`、`medagentbench`；
- criteria Markdown 文件路径；
- JSON 对象，例如 `{"Correctness": "输出是否符合任务要求？"}`；
- JSON 数组（字符串或 `{name, description}` 对象）。

### Criteria 文件格式

```md
# 你的任务

## Ground Truth Note

相信可观察的输出，不要相信智能体的叙述。

## Criteria

### Requirement Match

只评估产出的工件是否满足任务陈述的要求。

### Verification Evidence

只评估最后一次编辑之后是否成功运行过相关检查。
```

文件中的 HTML 注释会在交给验证模型前被移除。标准 id 由标题自动生成；需要
稳定缓存键时可用 `{#my_id}` 固定。

### 后端选择

优先级：工具参数 → `agent.cordis.yml` 配置 → `dsh-verifier` 用户设置命名空间
（宿主提供时）→ 环境变量。变量清单见 [`.env.example`](./.env.example)。

本地开放模型示例：

```sh
export VERIFIER_BASE_URL="http://localhost:8000/v1"
export VERIFIER_API_KEY="EMPTY"
export VERIFIER_MODEL="your-served-model"
```

如果服务自身不输出分数标签，预设会请求在每个标签位置做一次受约束的单 token
续写（`continue_final_message`），并直接读取重归一化后的 A–T 分布。

## 仓库结构

```text
src/                        TypeScript 源码
  lib/                      后端、缓存、criteria、benchmark、验证编排
  plugins/verifier-tools.ts Cordis 插件（工具 + 会话记录器）
crates/verifier-core/       Rust 核心（no_std wasm32 + 原生测试）
preset/llm-as-a-verifier/   可安装预设（bundle + criteria + wasm）
scripts/                    纯 Node 构建、benchmark 与卫生检查脚本
docs/                       出处与 benchmark 指南
test/                       Node 测试
```

## 开发

前置条件：Node.js >= 22、npm、Rust，并执行
`rustup target add wasm32-unknown-unknown`。

```sh
npm install
npm run build       # Rust -> wasm，再 TypeScript -> 预设 bundle
npm test            # Node 测试 + cargo test
npm run check       # 提交前完整检查
```

仓库提交了预构建的 `preset/llm-as-a-verifier/verifier-core.wasm`，预设开箱
即用；`npm run build:wasm` 可从源码重新生成。

## Benchmark 复现

仓库内置原创的 TypeScript/Node runner，用于对预生成的 Terminal-Bench 轨迹
数据做 Best-of-N 复现：

```sh
npm run bench:dry                                        # 打印 bo3 估算
node scripts/benchmark.mjs terminal_bench_2.1 --mode bo3 # 完整 bo3 复现
```

成本估算、本地/租用服务器步骤与复现卡片规范见
[docs/BENCHMARK.md](./docs/BENCHMARK.md)。原始轨迹数据只放在被 git 忽略的
`references/` 目录中，仓库只提交 `results/` 的结果摘要。

## 许可证

双许可：

- **公开代码与预设：** [PolyForm Noncommercial License 1.0.0](./LICENSE)。
  个人学习、研究、实验、爱好项目以及许可中列明的非商业组织可免费使用。
  请注意这是“源码可见的非商业许可”，并非 OSI 意义上的开源许可证。
- **商业使用：** 需要另行签署书面商业许可。详见
  [COMMERCIAL-LICENSE.md](./COMMERCIAL-LICENSE.md)，或联系
  **北京太殷造物科技有限公司（Beijing Taiyin Zhaowu Technology Co., Ltd.）**
  <tystudio-26020701@protonmail.com>。

本仓库为已发表方法论的原创实现，未复制
[ACKNOWLEDGEMENTS.md](./ACKNOWLEDGEMENTS.md) 中所致谢项目的任何源代码。

## 安全

请将漏洞私下报告至 <tystudio-26020701@protonmail.com>，详见
[SECURITY.md](./SECURITY.md)。请勿提交 `.env`；仅跟踪
[`.env.example`](./.env.example)。
