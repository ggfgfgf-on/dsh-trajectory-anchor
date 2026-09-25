# dsh-trajectory-anchor

自包含 DeepSeek Harness bundle：首轮轨迹锚定、EWMA 轨迹评分、自适应回卷、anchorGate 晋升门控、
bootstrap 上下文抑制、轨迹日志导出与过程奖励标注。**零社区插件依赖**，一行挂载。

> 本 bundle 的每个机制都在本 harness 家族上以动态插件原型实测通过（迭代 1–3，8 个测试子代理，
> 全程轨迹审计留存）。运行时事实与社区参考（dsh-anchored-standard / context-gate /
> @argszero/cordis-plugin-preset-tool-filter / @a9i5k4/dsh-anchored-monitor /
> @max-null/dsh-allostasis / we-need-ds）对照见下。

## 安装

```powershell
# profile 的 package.json dependencies 加入:
#   "@dsh-ext/trajectory-anchor": "file:D:/DSHwork/trajectory-anchor-bundle"
pnpm install

# profile 的 cordis.patch.yml 追加一行（或由 bundle patch 自动合并）:
#   - insert:
#       - id: trajectory-anchor
#         name: '@dsh-ext/trajectory-anchor'
```

重启 DSH。插件挂载于宿主平面：启动时收养全部活代理（仅审计），此后每个新代理经历
**锚定 → 门控晋升 → 持续评分** 生命周期。

## 生命周期

```
agent/created
   │  restrict({ allow: 可见 bootstrap 工具 })     # 按代理作用域探测
   │  complete persona("You are a helpful …")      # 同名遮蔽 preset persona
   │  suppressRuntimeContext()                     # 清空动态 runtime-context
   ▼
请求 #1: bootstrap 工具 + 1024 maxTokens + Minimal persona
   │  首个 tool/call → gate-armed
   ▼
门控等待: 最新窗口推理块 minimal-like（含 we、无 let me）
   │  兜底: maxBootstrapSteps=5 / promoteAfterFirstResponse
   ▼
晋升: 解除限制 + 恢复上下文 + 显式剥除 maxTokens 封顶（seed 会继承上一 header）
   ▼
持续: EWMA 轨迹评分 + 滞后状态机 +（可选）drift 回卷 + 反事实候选挖掘
   ▼
agent/disposed: RewardAnnotator 过程奖励 + 轨迹 JSONL 终态归档
```

## 关键配置（cordis.patch.yml）

| 键 | 默认 | 说明 |
|---|---|---|
| `bootstrapTools` | `[bash, str_replace_editor, pwsh]` | 按代理可见面探测后取交集；Windows 上 bash 行常被禁用 |
| `bootstrapMaxTokens` | **`null`（不封顶）** | opt-in：首轮输出封顶低于实际输出会截断开场规划、杀死回合（社区 issue #85，本机复现）；启用后晋升时显式剥除（seed 继承陷阱） |
| `gateEnabled` | `true` | anchorGate 晋升门控 |
| `maxBootstrapSteps` | `5` | 门控兜底 |
| `suppressContextOnBootstrap` | `true` | bootstrap 期 agent 作用域上下文抑制 |
| `lexicon` / `ratioWeights` | monitor 标定值 | 词典加权评分（we/let's/we'll/"we need"/our vs "let me"；中性 i will/i'll/i need/check/verify） |
| `specMax` / `reactMin` | `0.2` / `0.5` | persona_ratio 三波段边界（spec/mixed/react） |
| `baselineMinSamples` / `rollbackPercentile` | `10` / `25` | **基线相对漂移**：react 带 + 当前 ratio 在会话自身历史中的分位 < 25 才触发回卷 |
| `rollbackEnabled` | `true` | 校准后的回卷开关（基线相对语义下可安全开启） |
| `leanDenyPatterns` | 61 项 | drift 回卷 deny 集（前缀 `*` 通配） |
| `rewardAnnotator` | `default` | Layer 4 过程奖励；可插拔扩展点 |

## 校准结论（实测，重要）

1. **锚定效应在本部署模型（deepseek-v4-flash）上成立**：仅 pwsh + Minimal persona（不封顶）
   下，实测子代理首推理块为纯 "we"（词典 ratio 282–290，spec 带），无需 1024 封顶——
   与社区 "Minimal schema at 256000 锚定 5/5" 一致。
2. **1024 首轮封顶是风险项而非锚定必需品**：截断开场规划会让子代理零工具调用即死
   （本机复现 issue #85），故默认关闭。
3. **绝对波段不判别漂移**：deepseek-v4 的基线风格就是 let-me（react 带），旧二元评分
   恒判 drift；升级为词典 + 波段 + **会话自身基线分位数**后，"漂移"= 相对自身历史的
   退化（晋升后 ratio 290→1 的回落正是该信号），回卷不再无条件触发。
4. 运行时 Agent 标识字段是 `id`（不是 `sessionId`）；轨迹文件必须落在进程级
   workspaceRoot（沙箱策略允许区）。
5. 感知通道：`internal/dispatch`（无 filter、每次派发前触发）+ 直接 waterfall
   （`agent/request`/`agent/pre-step` 以 `prepend:true` 注册）。宿主平面行可达，已实测。

## 社区参考对照

| 机制 | 参考来源 |
|---|---|
| 晋升后 maxTokens 显式剥除、prepend 注册纪律 | dsh-anchored-standard `shared/tool-bootstrap.mjs` |
| pre-step 过滤 await-next + claimed 基线 + 失败降级 | dsh-anchored-standard `shared/context-gate.mjs` |
| restrict 可见面预筛 + run_code 排除 | `@argszero/cordis-plugin-preset-tool-filter` |
| 词典/波段/分位数评分、L1 暗示措辞、L2 重锚定载荷 | `@a9i5k4/dsh-anchored-monitor` |
| 近因位置纠偏追加 + 每轮节流 | `@max-null/dsh-allostasis` |
| 判定轮/执行轮解耦 | `we-need-ds` |

## Layer-4 训练数据导出

轨迹 JSONL（事件流 + 过程奖励）与 DSH 会话日志（文本）由 `tools/export-layer4.mjs`
批量 join 成 step 级训练样本（零依赖，Node ≥ 22 用 node:zlib 解 zstd）：

```powershell
node tools\export-layer4.mjs `
  --logs-dir <workspaceRoot>\.dsh-trajectory-logs `
  --sessions-dir $env:USERPROFILE\.dsh\sessions `
  --out D:\datasets\layer4-1
```

- **聚合**：assistant-message/tool-call 按 `(turn,step)` 对齐会话日志文本；score 词典分就近贴附
- **清洗**：只收 closed 代理；排除主会话（`anchor-session-*` / `summary.self`）；剔除生命周期 marker 行
- **schema**：`{sessionId, model, turn, step, kind, messages, response, toolName, toolResult,
  reward{lexicon, sessionScore, scoreNorm, planner}, trajectory_features{…}, textComplete}` ——
  兼容 PRM（逐 step 过程奖励）与 DPO/RLVR（按 sessionId 成对取样）
- **归一化**：会话奖励 min-max 归一（`scoreNorm`）、词典正/负样本统计、band/liftReason/machineState 分桶
- 产出：`dataset.jsonl` + `stats.json`（含纳入/排除清单、文本覆盖率、模型分布）+ `manifest.json`

## 验证

- 每个代理的轨迹审计：`<workspaceRoot>/.dsh-trajectory-logs/anchor-<agentId>.jsonl`
- 实时状态：`anchor_status` 工具（全局注册，只读）
- 事件序列断言：`adopted → anchored → context-suppressed → maxTokens-rewrite →
  gate-armed → lift(anchor-gate:minimal-like | max-steps) → context-restored →
  maxTokens-strip → score… → closed + record(含 reward)`

## 许可

MIT。
