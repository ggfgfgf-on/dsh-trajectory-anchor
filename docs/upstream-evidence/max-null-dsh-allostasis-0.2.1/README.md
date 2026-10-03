# @max-null/dsh-allostasis

本插件属于 **`@max-null/*` 插件系列**——这一系列共同构成 **[SSID（思灵 · Seek Soul in Darkness）](https://github.com/Max-Null/seek-soul-in-darkness)** 桌面体验。SSID 是整合它们的盒：`dsh-allostasis` · `dsh-capture` · `dsh-chat-rail` · `dsh-chinese-thinking` · `dsh-draft-polish` · `dsh-guardian` · `dsh-habit` · `dsh-memory` · `dsh-node-appearance` · `dsh-plugin-center` · `dsh-quick-toolbar` · `dsh-skill-mcp-center` · `dsh-ssid-panels` · `dsh-ssid-zh-ui` · `dsh-achievements`。

This plugin belongs to the **`@max-null/*` family** — a set of plugins that together form the **[SSID (思灵 · Seek Soul in Darkness)](https://github.com/Max-Null/seek-soul-in-darkness)** desktop experience.

Allostasis for the DeepSeek Harness — session self-regulation rather than monitoring.
Before each step it reads the most recent reasoning block and appends one near-end message
when that thinking has drifted into English (**Chinese anchoring**) or collapsed into
repetition (**degeneration reminder**). When a turn ends with no visible output at all
(**silent turn**), it records the verdict in the session log and the browser half shows a
notice beneath that turn.

## 它做什么

**应变**（allostasis）取「**通过改变自己来维持自己**」之义——它不只是一个监测器，它会改变行为。

| 能力 | 状态 | 触发条件 |
|---|---|---|
| **中文锚定** | **已实现** | 上一步思考的英文功能词密度越线 |
| **推理退化提醒** | **已实现** | 上一步思考的重复率越线，且连续 N 步成立 |
| **空回合提示** | **已实现** | 回合收尾时末条助手消息没有非空文本（只在 `completed` 回合上判） |
| 上下文占用感知 | 计划中 | 需先定「什么情况下才出现」（持续在场会退化成背景音） |
| 压缩预约落盘 | 计划中 | 待通路验证：退化样本散布在整段退化区间，「只压一小段」能否打断循环尚无证据（二期方案 §八.1） |

前两类提醒以 `notice` 形式注入——在**轨迹页**是折叠态就显示一行摘要的注入行，不弹窗、不打断；
**对话页不显示**（2026-09-29 在 SSiD dev / DSH 0.2.0-rc.1 上实测，口径见二期方案 §九）。

**空回合提示是三者里唯一有界面的一个**，就挂在那一段空白下面（见「截图」段）。它不发消息、不改模型输入——
浏览器半边从 `turn/start` / `assistant/message` / `turn/end` 自己折叠出判定，投影成 Turn 尾部的一行提示。

**判定结果不写会话日志。** 内核的事件词汇表在构建期生成，下游插件的自定义类型不在其中，而 `Session.append()` 没有 `ignorable` 标记通道；无标记的自定义事件会让**整份**日志在下次加载时被拒读。判定输入本来就可重放，留痕由 `console.debug` 诊断行与界面上那行提示承担。理由与取证见 `docs/设计/2026-09-30-空回合检测与可见化.md` §十一。

**除空回合外全程静默，所以「确认它在工作」只能靠日志。** 前两类命中时只在轨迹页留一行；不命中时一个字都不说——「装了没有」「阈值生效没有」「这一步为什么没提醒」三个问题原本都无从回答，只能靠改配置去试。因此它在 `src/index.ts` 的 `apply` 里留两行痕：

```
[dsh-allostasis] loaded · driftThreshold=0.15 repetitionThreshold=0.5 consecutiveSteps=2
[dsh-allostasis] turn 8 step 11 · drift=chinese funcDensity=0.6% chars=1764
                 · repetition=normal units=29 ratio=0%
```

第一行 `info`、每个进程一次，报的是**生效阈值**（`Config` 的解析结果，不是代码里的缺省常量）。第二行 `debug`、**每一步判定一行**：两类判据的三态结论加度量。默认静默，排查时打开即可——不必为了看一眼判定结果去动阈值。其中 `units` 是切分后的单元数，**低于 12 判 `insufficient`**（样本不足不下结论），此时 `ratio` 仍会给出，只是不参与判定。

判据来源、实测数据与完整设计见 `docs/设计/2026-09-20-应变-设计方案.md`、
`docs/设计/2026-09-28-应变二期-退化检测与自动干预.md`。

## 为什么需要它

`dsh-chinese-thinking` 把「始终使用中文进行思考」挂在 system prompt 的**固定前缀**上——那是对的定位：基线、常驻、cache-safe。但固定前缀离每一次输出最远，而语言模式受**近因**支配；长会话里基线会变弱。

本插件补的是**纠偏信号**——「你正在漂移」。它是叠加而非替代：基线层永远在场，增强层只在检测到漂移时出现。**平时不出现**正是它作为信号的前提；一段一直存在的提醒会退化成背景音，重演它要修的那个问题。

## 判据

两类提醒各有一个纯函数判据，都在 `src/` 下，都附实测依据。

### 语言漂移

**英文功能词密度** =（`the` / `is` / `are` / `and` / `of` / `to` / `that` 这类功能词数）/ 英文词数，**且英文词数 ≥ 50 才判定**。

实测数据（一份 10 turn / 157 step 的真实会话）：中文期中位 **0.012**、英文期中位 **0.273–0.389**，阈值 **0.15** 使两群完全分离。词数门槛不可省——中文期唯一的越线点只有 26 个英文词，小样本会让密度失真。

另外两个看起来更直观的指标被否掉：**中文字符占比**（中文思考本来就大量夹英文标识符，实测中文期只有 0.19–0.37，区分度不足）；**最长连续英文游程**（中文思考引用一段代码就会把它顶高，它测的是「引用了多长的代码」而非「用什么语言思考」）。

阈值由 `tools/analyze-thinking-lang.mjs` 在一份真实会话上标定，该工具随包发布。

### 推理退化

**重复率** = 单条推理按换行与中英句读切分后，**出现 ≥3 次的单元占全部单元的比例**；**单元数 ≥ 12 才判定**，**连续 N 步（默认 2）越线才触发**。

实测数据（一份 19 轮 / 416 条助手消息的真实会话）：正常期 **0%–35%**、退化期 **48%–92%**，阈值 **0.5** 落在隔离带中段。连续步数不可省——正常期也有单次抖动（实测峰值 35%）；代价是延迟，按同一份数据回放会晚约 3 步触发。

**退化与上下文占用脱钩**：同一会话里 26.1% 占用时重复率 84%、67.9% 时 83–92%，压缩到 26.1% 并不降低重复率。所以「调低阈值」治不了它；压缩能否治它取决于力度。完整数据见 `docs/排查/2026-09-28-推理退化与上下文占用脱钩.md`。

退化触发的留痕是 `console.debug` 诊断行（`repetition=` 那一段给出 `units` 与 `ratio`）加上轨迹页那行提醒。**判定结果不落会话日志**——理由与空回合那条同源，见前文。

## 截图

空回合提示：浏览器半边从会话事件流自行折叠出「这一轮没有产出内容」，对话页在该回合尾部显示一行说明。它贴着那一段空白，回看历史时也还在原处。

| 空回合提示 |
|---|
| ![空回合提示](docs/shots/silent-turn-1.png) |

其余两个能力（中文锚定、推理退化提醒）是**提示注入类**：不新增按钮、面板或设置项，每个 step 前读取最近一条思考，判定越线时向请求末尾追加一条提醒，效果体现在模型行为上——那两项按《SSiD 开发手册》§9 走无 UI 插件豁免，只有空回合提示有界面元素。

## Compose

```yaml
# cordis.yml (or via the bundle patch):
- id: allostasis
  name: '@max-null/dsh-allostasis'
```

Requires `agents` and `system-prompt` in the host composition (dsh-base ships both).
Installs as a bundle: `dsh plugin --profile <name> add @max-null/dsh-allostasis`.

## Config

三个判定阈值加一个空回合档位可在 `config` 段覆盖；省略即用括号内的默认值。

| 字段 | 默认 | 含义 |
|---|---|---|
| `driftThreshold` | `0.15` | 英文功能词密度达到此值即判为漂移 |
| `repetitionThreshold` | `0.5` | 推理重复率阈值，取值 0–1 |
| `consecutiveSteps` | `2` | 连续多少步越线才触发退化提醒 |
| `silentTurn` | `observe` | 空回合档位：`off` 宿主不判定也不干预、`observe` 判定并打一行诊断、`steer` 额外补一次生成 |

**档位管不到对话页那行提示**：提示由浏览器半边折叠会话事件流得出，与宿主判据同源但独立于档位——浏览器半边的 `apply` 拿不到插件配置（2026-10-01 实测：在 `cordis.patch.yml` 里配 `silentTurn: off`，宿主读到 `off`，浏览器半边收到空对象）。要完全静默请禁用插件。

```yaml
- id: allostasis
  name: '@max-null/dsh-allostasis'
  config:
    repetitionThreshold: 0.6
```

判据里的**小样本门槛**（`MIN_WORDS` / `MIN_UNITS` / `REPEAT_MIN_COUNT`）不是配置项——它们不是偏好，改了就是把密度与比例算飞。值域外的取值会让插件**报错中止**而不是静默回退：静默回退会让「我明明改了配置」与「插件按默认值跑」同时成立而无从察觉。

这几个阈值都是**起点值而非标定结果**——单会话样本给出的隔离带中段，标定留给数据积累（设计方案 §5.1 的三条路：显性配置项、数据积累、LLM 自调）。

## Develop

```sh
npm install --legacy-peer-deps   # DSH peer types resolve via tsconfig paths
npm test                         # vitest
npm run typecheck                # tsc against the adjacent deepseek-harness lib/types
npm run build                    # emit dist/
```

**注意 tsconfig 的 `paths` 用 `../../deepseek-harness/...`**（本仓库位于 `max-null-plugins/` 下，`deepseek-harness/` 在再上一级）。写成 `../deepseek-harness/...` 时 TypeScript 会**静默回落**到 `node_modules` 里 npm 装的旧版 DSH 类型——症状是「某些显然存在的成员报 not exported」，而不是找不到模块。
