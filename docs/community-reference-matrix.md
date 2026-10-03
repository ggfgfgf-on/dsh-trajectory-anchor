# 社区实现对照矩阵（dsh-trajectory-anchor）

**用途**：把"我们的机制"逐条对着社区实现核对，标明差异性质与采纳决定。
**证据原则**：每行的"上游做法"都指向 `docs/upstream-evidence/` 里的源码快照（可复现），
不是二手描述。快照抓取命令与版本见该目录 README。

生成时间：2026-10-01（本轮 P0–P7 改造期间）。核对方：本仓库维护者。

---

## 一、总判定

| 维度 | 判定 | 依据 |
|---|---|---|
| 调用纪律（怎么调 `tools.restrict`） | ✅ 符合 | 与 `@argszero` 一致：必须 `agent.ctx`、先解析可见面、未知名字不硬抛 |
| 架构取向（限制是**派生**还是**突变**） | ❌→✅ 已改正 | 社区每次组装按状态派生工具面；我们原先改注册层一次性突变。**P1 已改为组装期派生** |
| 失败姿态（出错往哪边倒） | ❌→✅ 已改正 | 社区 fail-open（"a gate bug must never eat the user's context"）；我们原先静默 fail-closed。**P2 已改为暴露全量 + 响亮告警** |
| 边界（冷却/上限/终态/手动解除） | ❌→✅ 已改正 | 社区有三级阶梯 + 冷却 + 重试上限 + 终态 + 手动 reset；我们原先只有最重一级且无上限。**P3/P6 已改为有界片段（`maxDriftSteps`）+ 能力预算耗尽语义** |
| 告知 | ❌→✅ 已改正 | 社区把"发生了什么"写成模型可见的消息；我们原先静默。**P4 已注入 notice section** |
| 驱动信号 | ⚠️ 仍不足 | 社区用"轮类型/状态"驱动，可判；我们用词表命中数，实测无判别力（见第四节）。**能力层已按标定结论默认关闭** |

## 二、逐条对照

| # | 参考机制 | 上游做法（证据） | 我们的实现 | 判定与处置 |
|---|---|---|---|---|
| 1 | `dsh-anchored-standard/shared/tool-bootstrap.mjs`（工具面两阶段） | 组装路径上 filter `assembled.tools`（L228-267）；晋级状态 `promotion.status(agent).promoted` **每次组装重新求值**；`promoteOn:'either'` 默认，注释明说旧模式 "can trap a session in bootstrap forever … the 'either' default **removes that trap**"；过滤失败 → `warnOnce('… bootstrap filter failed, **exposing the full catalog**')`；配置缺工具 → `'bootstrap disabled, full catalog exposed'`；非法配置在**挂载期**抛错 | `surfaceForPhase()`（纯函数）+ `system-prompt/assemble` 处理器；异常返回原 assembly | ✅ **采纳**（P1/P2）。这正是本轮的核心改造：把"突变+归还"换成"派生" |
| 2 | `shared/context-gate.mjs`（pre-step 抑制） | 组装时 blank `contexts` + pre-step 保留 **claimed batch + kind allowlist**；晋级后自动放行；原文 "**both filters degrade to 'keep everything' on their own failures**"；非法配置挂载期报错 | 我们用 `scopedPrompt.section()` + `suppressRuntimeContext()`，晋级时显式 restore | ⚠️ 部分采纳：我们已有显式恢复；fail-open 原则已在 P2 用于 bootstrap 与工具面。**context 抑制路径本身未改**（不在本轮范围） |
| 3 | `@argszero/cordis-plugin-preset-tool-filter@0.2.0` | `tools.restrict()` 只用于 **`agent/created` 的创建期静态断言**（per-preset allowlist / per-deployment group opt-out）；先解析可见面再命名；非法配置 warn+drop；文档明确"a restricted name **survives `restrict()`, leaves `schemas()`/`get()`, and dispatches as `UNKNOWN_TOOL`**" | 我们**保留了**同一条纪律（含 cull retry）用于 bootstrap allow 面；**移除**了会话中途的 deny 用法（P1） | ✅ 手法符合；**时点已改正**：deny 用法被删除，`check-invariants.mjs` C3 断言常驻（上限 0 处） |
| 4 | `@a9i5k4/dsh-anchored-monitor@0.3.1`（分级干预） | L1 建议式提示注入 `agent/pre-step`（明确"命令式会把 we 轨迹打回 let me"）；L2 `agent.cancel` 停当前回合（保留 inbox）+ pendingReset 在 `system-prompt/assemble` 消费 + `submitContinuation` **显式双语告知模型**；**L2 冷却 120s、重试上限 2**，超限升 L3，L3 后 `phase='restart'` **停止对该会话干预**；`POST /api/sessions/:id/reset` 手动重置；面板可视化 + 离线回放 | 行动分档（`policyDecision` 的 level/action）+ `maxDriftSteps` 有界 + 能力预算耗尽后片段内不再收窄 + notice + `policy-notice` 审计 | ✅ 采纳精神（有界、分级、可观测）；❌ 未采纳：冷却计时器（实测 p50=4.4s / max=58h 的双峰节奏下无正确值）、强制停回合、persona 回切。手动解除仍为待办（`anchor_status` 的 release 动作） |
| 5 | `@max-null/dsh-allostasis@0.2.1` | 漂移/退化干预是**消息**，`admitPerTurn` 按 turn 节流（同 turn 至多一次），状态用 WeakMap 挂会话 | 我们原先用**能力摘除**；现在默认双关（只观察），通知层也是按步审计而非刷屏 | ✅ 方向一致（干预尽量轻）；我们的 notify 目前只写审计、不注入上下文（避免在无判别力信号上污染上下文） |
| 6 | `YixuAn-13/we-need-ds` | **按轮类型**切工具面（决策轮 Minimal 对 / 执行轮全量 MCP + DSH persona）→ 周期性、**天然可逆** | 我们按**信号**切；现在切法是派生的（可逆），但触发条件仍受信号质量限制 | ⚠️ 结构性可逆已达成；触发条件待"行为轴"信号（表二 B1/B6） |

## 三、本轮从对照中直接得到的三条设计修正

1. **"派生"优于"租约"**：本方案早期版本打算给 `restrict()` 加 TTL 租约 + 看门狗；
   社区证据显示更干净的做法是**根本不突变**——每次组装由状态派生。已采纳（P1）。
2. **fail-open 是明文原则，不是口味**：`tool-bootstrap`/`context-gate` 都写明"自己的 bug
   绝不能吃掉能力/上下文"。已采纳（P2，`C5` 断言守护）。
3. **"存在一个必然不可达的退出条件"是社区已经踩过的坑**：`promoteOn:'tool-call'` 的注释
   就是记录。我们的 rollback 是同一坑的翻版（`band==='spec'` 在 `personaRatio≡1` 时不可达），
   现已改为"步数硬上限 + 证据回到参考内"两条必然可达的退出（P3/P6，回放验收 0 越界）。

## 四、未解决项（诚实记录）

| 项 | 现状 | 影响 |
|---|---|---|
| 词表信号的判别力 | 标定实测：会话级误触发率 15.9%（α=0.001）/ 43.2%（α=0.01），预算 5% | **能力层与通知层默认双关**；必须换行为轴信号或重新标定词典 |
| 手动解除入口 | 未实现（`policy-notice` 只写审计） | 运维只能靠关开关或等片段自然结束 |
| context 抑制路径的 fail-open | 未按社区原则核查 | 低（该路径本轮未改，失败会写 `context-restore-error`） |
| `allostasis` / `we-need-ds` 的证据深度 | 到源码结构与 README 级，未逐行核对 | 中（若采纳其机制需升级证据） |

## 五、证据清单

`docs/upstream-evidence/` 内含本轮抓取的原始文件（npm 包解包 + GitHub raw）：

- `argszero-cordis-plugin-preset-tool-filter-0.2.0/lib/index.js`（9.0 KB）
- `a9i5k4-dsh-anchored-monitor-0.3.1/`（dist + config + README，选中文件）
- `max-null-dsh-allostasis-0.2.1/`（dist + README，选中文件）
- `xiaobright-dsh-anchored-standard/shared_tool-bootstrap.mjs`（14.9 KB）
- `xiaobright-dsh-anchored-standard/shared_context-gate.mjs`（9.7 KB）
- 其余：`test_tool-bootstrap.test.mjs`、`shared_zero-tool-bootstrap.mjs`、`shared_anchor-turn.mjs`
