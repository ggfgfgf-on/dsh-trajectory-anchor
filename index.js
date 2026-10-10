/**
 * dsh-trajectory-anchor — self-contained bundle plugin.
 *
 * All mechanisms live-validated on this harness family via dynamic-plugin
 * iterations 1-3 (9 test subagents, full trajectory audits):
 *  - perception: `internal/dispatch` observer (unfiltered, fires before every
 *    dispatch) + direct `agent/request` / `agent/pre-step` waterfalls
 *    (reachable from a host-plane row in this cordis fork).
 *  - anchoring: `agent/created`-driven adoption; per-agent probe via
 *    `agent.ctx.tools.schemas(agent)`; bootstrap `restrict({ allow })` with
 *    throw-driven culling; first-round maxTokens cap is OPT-IN (default off —
 *    anchored-standard issue #85: a cap below the real first-round output
 *    truncates the model's opening plan and kills the turn).
 *  - anchorGate: first durable tool/call arms the gate; promotion requires
 *    the newest window message to be minimal-like (has "we", no "let me")
 *    with maxBootstrapSteps / promoteAfterFirstResponse fallbacks. Bootstrap
 *    context suppression on the AGENT'S OWN scope: a `complete: true`
 *    section named `persona` (shadows the preset persona) plus
 *    `suppressRuntimeContext()`; both released on lift.
 *  - scoring v2 (monitor-calibrated): weighted lexicon (we/let's/we'll/
 *    "we need"/our vs "let me"; neutral i will/i'll/i need/check/verify) →
 *    weighted ratio + persona-ratio bands (spec <0.2 / mixed / react ≥0.5) +
 *    BASELINE-RELATIVE drift: react band alone is not drift on models whose
 *    baseline IS let-me-heavy; drift requires the current ratio to rank
 *    below rollbackPercentile against the session's own history. Spec band
 *    recovers. This is what makes rollback meaningful on deepseek-v4.
 *  - Layer 4: per-agent JSONL trajectory logs (under the process
 *    workspaceRoot), pluggable RewardAnnotator (default rule-based process
 *    scoring), counterfactual anchor candidates.
 *
 * Runtime facts (live-verified): Agents expose `id` (not `sessionId`);
 * `agent.ctx.get('tools')` / `agent.ctx.get('systemPrompt')` resolve the
 * per-scope instances; trajectory files must live under the sandbox-policy
 * workspaceRoot (process.cwd()).
 * Lexicon is replaceable at startup: config `lexiconPath` (JSON file) or env
 * TRAJECTORY_ANCHOR_LEXICON_PATH; CJK-safe term matching (no ASCII \b).
 */

import { readFileSync, mkdirSync, appendFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath, dirname as dirname2 } from 'node:path'
// L1：任务锚定信号的**单一实现**（tools/task-anchor-core.mjs 是纯模块，不反向 import 本文件，
// 因此没有循环依赖）。为什么不在这里再写一份：本项目已经两次栽在"两套规则各说各话"
// （台账定稿 51 倍偏差、两级连续计数混层），所以本轮一律共用一份实现。
import {
  parseTaskAnchors, inScope, isIgnorablePath, changeInvalidatesVerification, pathsFromCallStrict, isWriteTool, isReadTool,
  verifyCommandKind, claimsFromFinalMessage, commandPaths, verifyStaleness,
} from './tools/task-anchor-core.mjs'
// 纠偏线索**共用离线标注那一份**（`drift-label-core` 零依赖、只读）：避免"标注用的判据"
// 与"运行时触发的判据"各写一份、然后悄悄漂移（本项目在台账与形态识别上各栽过一次）。
import { CORRECTION_CUES } from './tools/drift-label-core.mjs'

const DEFAULTS = {
  anchorEnabled: true,
  // 契约重锚定（只读版，信息型）：代理**宣告完成**时，把首轮任务陈述摘要重新注入近因位置，
  // 供它在交付前自检"有没有偏离原契约"。由来：dil2 台实测"后续指令与首轮契约冲突"时，
  // 代理行为完全由"哪条指令最新"驱动，而插件全程沉默（ablation-log 第二十三条）。
  // 默认关（与其他执行器同一纪律：先有验收证据再默认开）。
  contractReanchor: false,
  // 交付缺口回放（只读版，信息型）：代理宣告完成时，把它**自己最后一次验证输出里的失败**
  // 回放到它眼前（"你宣布完成，但你自己刚跑的结果还有 N 个失败：…"）。由来：ark×Project2
  // 五跑实测的失败形态是"早停 + 声明与证据脱节"（ablation-log §26/§28），L1 响"改完没验证"
  // （它一直在验证，几乎不响）、L2' 回放 persona（对"还剩 21 个失败"零信息量）——都不对症。
  doneGapMirror: false,
  // 越界回放（只读版，信息型）：写操作落在首条指令声明的范围之外时，把"越界路径清单 +
  // 原始范围条款"回放到它眼前（F3 事实，证据=它自己的工具调用轨迹）。默认关（同一纪律：
  // 先有验收证据再默认开）。
  scopeBreachMirror: false,
  // 验证过期回放（只读版，信息型）：宣告完成时，若它最后一次验证**之后**又改过验证覆盖的
  // 同一文件，把"验证命令 + 事后编辑"回放出来（F5 事实，"你的验证早于这次改动"）。默认关（同上）。
  verifyStalenessMirror: false,
  bootstrapTools: ['bash', 'str_replace_editor', 'pwsh'],
  bootstrapMaxTokens: null,
  bootstrapPersona: 'You are a helpful software engineer assistant.',
  trajectoryWindowSize: 3,
  ewmaAlpha: 0.4,
  maxBootstrapSteps: 5,
  promoteAfterFirstResponse: true,
  gateEnabled: true,
  suppressContextOnBootstrap: true,
  suppressSkillCatalog: true,
  suppressedSources: ['skill-catalog'],
  // 能力层与通知层的总开关。默认**都关**（只观察、只审计）——这是按标定结论定下的
  // 安全默认：tools/calibrate-response-policy.mjs 在 44 个历史会话上测得当前词表
  // 信号的会话级误触发率 15.9%（α=0.001）/ 43.2%（α=0.01），远高于 5% 预算，
  // 即"信号不足以支撑能力层干预"。开之前必须先让标定通过（或换 P5 行为轴信号）。
  rollbackEnabled: false,
  notifyEnabled: false,
  lexicon: {
    positive: { we: 2, "let's": 1.5, "we'll": 1.2, 'we need': 1.2, our: 0.8 },
    negative: { 'let me': 3 },
    neutral: { 'i will': 1, "i'll": 1, 'i need': 0.8, check: 0.4, verify: 0.4 },
  },
  ratioWeights: { alpha: 2, beta: 0.5, gamma: 1.5, epsilon: 1 },
  lexiconPath: null,
  specMax: 0.2,
  reactMin: 0.5,
  // ── P3 响应策略：会话内自参考偏离检验（取代旧的"单步 percentile<25"）──────
  // 为什么换掉旧的：percentile 是**定义性秩**——取最低四分位就恒有 ~25% 的步落在
  // 里面，它的边际率由阈值本身决定，不是模型行为；实测该信号在 25 个会话上的
  // 会话间空转率是 4.3%–92.1%（差 21 倍），自相关 0.65、平均游程 4.27 步，
  // 因此"根据全局语料解一对 (K,k)"在该信号上无解（K 拉到 32 仍有 8% 误进）。
  // 新做法：拿**本会话自己的历史**当零假设，检验当前窗是否异常偏低（分布无关的
  // 秩检验），预算直接落在会话内；离线语料只用来回答"该信号有没有判别力"。
  refMinSteps: 12,      // 参考段最少步数（全局默认；每通道可在 responseChannels 覆盖）
  testWindow: 4,        // 检验窗长度（全局默认；每通道可覆盖）
  notifyAlpha: 0.05,    // 通知预算（全局默认；每通道可覆盖）
  actAlpha: 0.01,       // 能力层预算（全局默认；每通道可覆盖）
  // ── B3 运行时门禁 ────────────────────────────────────────────────────────
  // 标定件路径（responsePolicy.json）。给了就按它决定"哪些通道有资格动能力面"；
  // 没给 / 过期 / 不匹配 / verdict≠PASS → **一律只观察**（fail-safe，绝不默认放开）。
  // 环境变量 TRAJECTORY_ANCHOR_POLICY_PATH 可作为等价来源（与词典的 env 一致）。
  responsePolicyPath: null,
  // 评测保护：true ⇒ 强制只观察（能力层与通知层都关），用于"分数归因不被插件污染"。
  // 可由标定件的 measurementSafe 或配置直接置位。
  // 人工试运行放行（默认 null = 这条路径根本不存在）：
  //   { channels: ['inaction'], alpha: 0.01, until: '2026-10-16T00:00:00Z', note: '为什么放行' }
  // 它是**唯一**能绕过"标定件不合格"的动作路径，所以三重约束缺一不可：
  //   · 必须显式列出通道（不许"放行全部"）；
  //   · 必须显式给 α（试运行的工作点，不许默默沿用一个说不清的默认）；
  //   · 必须给到期时间（**没有期限的执行器就是事故**——本插件最重那次事故的形态）。
  // measurementSafe 与 autoDemote 仍然优先：试运行绕不过它们（见 effectiveRollback）。
  trialRelease: null,
  measurementSafe: false,
  // 在线自动降档：最近 autoDemoteWindow 个已结束会话里，出现过收窄的比例超过
  // autoDemoteBudget ⇒ 自动降为只观察并留审计（防止"离线合格、线上超标"）。
  autoDemoteWindow: 20,
  autoDemoteBudget: 0.05,
  // ── 行为通道（B1）────────────────────────────────────────────────────────
  // 为什么加：词表信号实测无判别力（会话级误触发 15.9%–43.2%，预算 5%）；行为通道
  //   的空转侧在**全语料**（77 会话 / 41584 步）上实测如下（tools/calibrate-channels.mjs）：
  //     α=0.01, k=1 → A′ 14.3%、C 31.2%、B 41.6%（远超 5% 预算）
  //     按预算反解 → A′ k=1, α=0.001 → 2.6%；C k=1, α=1e-5 → 0.0%；B 只允许通知
  //   根因：α 是**单次检验**的误报率，而预算是**每会话**的（会话几百步，族错误率
  //   1−(1−α)^N 会放大几十倍）。
  //   ⚠ 这组数在 2026-10 被**重算过**：此前离线核心自带一套台账定稿规则，与运行时不一致
  //     （把"回合末步=合法收尾"也记成 A′ 命中），128 会话里 123 个序列不同、A′ 命中率
  //     0.16% 对 8.10%（差 51 倍），因此那时的 α 是给一条**运行时不存在**的通道算的。
  //     现在台账只有一份实现（本文件导出的 buildLedgerFromEvents），由
  //     tools/test-ledger-parity.mjs（逐步对拍）+ tools/test-ledger-semantics.mjs（手算真值）守着。
  // 这里的 actAlpha=1e-5 是**比标定值更严的默认**：通道默认无资格（capabilityEligible=false），
  //   资格只能由标定件授予，而标定件会带来它自己反解出来的 α/k（装载器会覆盖这两个键）。
  //   若有人手写 capabilityEligible: true 又不给标定件，得到的是一套保守参数——这是有意的方向。
  // A′ 的定义**必须**带"回合未结束"硬条件：实测 67 个"无工具调用"步 100% 是回合末步
  //   （代理干完活回答了），不分回合末步就是 100% 误判（G3 反向对照门常驻验证）。
  // capabilityEligible 默认全 false：由标定件按预算翻转。
  responseChannels: {
    inaction: { enabled: true, refMinSteps: 20, testWindow: 3, actAlpha: 1e-5, notifyAlpha: 1e-4, consecutive: 1, capabilityEligible: false },
    repetition: { enabled: true, refMinSteps: 20, testWindow: 3, window: 5, minRepeats: 2, actAlpha: 1e-5, notifyAlpha: 1e-4, consecutive: 1, capabilityEligible: false },
    failure: { enabled: true, refMinSteps: 20, testWindow: 3, actAlpha: 1e-5, notifyAlpha: 1e-4, consecutive: 1, capabilityEligible: false },
    // 词表通道：α **必须各自标定**——行为通道反解出的 1e-5 不能套到它头上（两者标度不同）。
    // 它的会话级空转率实测 15.9%（α=1e-3）～43.2%（α=0.01），按 5% 预算同样需要 ~1e-5；
    // 但它的能力层资格本就是 false（标定 FAIL），所以这里保留历史值 0.01/0.05，
    // 万一被显式打开，装载器仍会按各自的反解值覆盖。
    // ⚠ 词典/风格通道**默认关闭**（2026-10-09，实测否定后移除判据面）：
    // 它作为**漂移判据**已被实测否定——在真实语料上 α=0.05 时召回 4.3%、精确率 6.2%
    // （低于 20% 的随机基线）；对强锚点的精度倍数也不到 1；60 会话判别力实测
    // 召回 24.2% 对**同预算随机** 36.8%（0.64×），部署口径（节流后）1.06× ≈ 随机。
    // 留着它只会扩大噪音面（多一条可能误触发的通道、多一列要解释的状态）。
    // **关闭是结构性关闭**：channelTests 在 enabled===false 时**根本不构造这一行**
    // （index.js 的 `if (lexCfg.enabled !== false)`），所以它既不会被标定件授权、
    // 也不会被试运行放行重新拉回判断面——这条由 C28 不变量 + 反向对照守着。
    // **但它作为"锚定机制的判据"仍在用**：首轮 persona/工具面/上下文抑制三件套与晋升门
    // （`anchor-gate:minimal-like` = 最近推理窗有 we、无 let me）依赖的是 `CONFIG.lexicon`
    // 与逐分块的 `updateWindow`，**不是这条通道**——所以关掉它不影响锚定本身。
    // 离线测量件（evaluate-signals / test-ledger-parity 等）要复现历史口径时显式传
    // `responseChannels: { lexicon: { enabled: true } }` 即可。
    lexicon: { enabled: false, refMinSteps: 12, testWindow: 4, actAlpha: 0.01, notifyAlpha: 0.05, consecutive: 1, capabilityEligible: false },
  },
  // ── L1 任务锚定拉回（信息型，默认关）──────────────────────────────────────────
  // 它是**第一个把话直接说给模型听**的动作。机制已验证（注入漂移必须触发、措辞/节流/豁免合规），
  // 但**效果**只能靠在线对照或真实长会话积累——离线语料里"可客观标注的漂移"实测为 0
  // （tools/measure-task-signal.mjs：42 个可解析会话里越界写 0、未验证声明 0；
  //   曾经报出的 8 条经人工审计全为假阳）。所以先关、先审计。
  pullbackEnabled: false,
  // 每会话最多说几次（节流见 allostasis 的 admitPerTurn：同一 turn 至多一次）。
  pullbackMaxPerSession: 3,
  // **对照组比例**（L4 在线对照）：触发时以该概率"故意不说"，从而拿到"说了 vs 没说"的配对。
  // 默认 0 = 不抑制（不在未授权时改变行为）；做效果测量时才调大（如 0.3）。
  // 为什么必须有对照组：没有它就只剩"说过之后的行为"这一侧观测，无法区分"起了作用"与"本来就会这样"。
  pullbackControlRate: 0,
  // ── L2 重锚定（最强干预：把首轮 Minimal 载荷重新灌回近因位置）────────────────
  // 默认关，且**不与 L1 共用同一道门**：它额外要求一份**在线证据件**（reanchorEvidencePath），
  // 该证据件由真实会话累积的结果生成（见 recordPullbackOutcome），且必须 verdict=PASS-online、未过期。
  // 依据：本项目最重的一次事故就是"未经验证的信号 → 不可逆执行器"（23 个会话进收窄、0 个恢复），
  // 所以凡是要动**上下文内容**的动作，一律先要在线证据。
  reanchorEnabled: false,
  reanchorEvidencePath: null,
  // L2'（**确认即恢复**）：不要求"拉回有效"的在线效果件，只在**当场确认出问题**时重锚定一次。
  // 为什么它可以在没有效果证据时存在：载荷是**信息型**的——把首轮 Minimal 载荷放回近因位置，
  // 不改工具面、不改系统基线、不删任何信息 —— 与 L1 同一风险类别；而它的前提不是"预测未来"，
  // 是**当场确认**（用户纠正 / 工具不存在 / 验证未通过）。仍然：measurementSafe 与 autoDemote
  // 优先、每会话一次、全程留痕；并用同一套随机化对照（reanchorConfirmControlRate）
  // ⇒ 它的**效果**照样能被估出来（落盘行 action='reanchor'），而不是靠相信它有用。
  reanchorOnConfirm: false,
  reanchorConfirmControlRate: 0,
  // 拉回效果采集：会话结束时把"说过之后行为有没有变"写成一行 JSONL（默认在 baseDir 下）。
  pullbackOutcomePath: null,
  // ── 累积状态（记忆）的持久化 ─────────────────────────────────────────────────
  // 与"派生状态每次重算"互补：降档窗口 / 通道回灌计数 / 倍率 是**学到的**，重启不该清零，
  // 否则"最近 N 个会话"永远攒不满、跨天自适应永远从零开始（这是本轮修正的设计缺口）。
  // 只有"与自适应有关的会话"（动过手或有通道触发）才落盘 ⇒ 默认全关时不产生任何文件。
  adaptiveStateEnabled: true,
  adaptiveStatePath: null,          // 默认 <baseDir>/.dsh-trajectory-logs/adaptive-state.jsonl
  adaptiveStateWindow: 200,         // 装载上限（有界，文件再长也不拖慢挂载）
  // ── L3 第二层：provider/model 族先验的收缩 ──────────────────────────────────
  // `familyPriorPath` 指向 tools/family-priors.mjs 的产物（各族各通道的**每步基频**）。
  // 给了就按族做收缩（同一步偏离在不同基频的族里得到不同 p）；没给/坏了/族未知 ⇒ 退回
  // 固定的 Jeffreys 伪计数（即今天的行为）——fail-safe 而不是 fail-open。
  familyPriorPath: null,
  // 先验的等效样本量（步）：S 越小越"信会话自己"，越大越"信族"。20 步 ≈ 默认 refMinSteps，
  // 于是"参考段刚够长时先验与数据各占一半"。
  priorStrength: 20,
  // ── L3 第三层：结局回灌（按通道把"动了之后的结果"回灌到门限上）────────────────
  // 默认关：它是**门限执行器**，按项目纪律这类东西必须先在真实会话里攒够样本。
  // 打开后是**非对称**的：不产出就收紧（安全方向）、放宽需要更多样本且更高产出率、
  // 产出极差则撤销**该通道**的资格（比全局 autoDemote 精确得多）。
  outcomeFeedbackEnabled: false,
  feedbackMinSessions: 5,
  feedbackMinProductiveRate: 0.6,
  feedbackRevokeEligibilityRate: 0.2,
  feedbackAlphaFloorDivisor: 64,
  // 探索步：长期无变化就周期性回升一档（防"收紧到不再触发 ⇒ 证据断流 ⇒ 永久锁死"的单向棘轮）。
  feedbackExploreAfterSessions: 30,
  // P6 不变量：收窄态的步数硬上限（退出条件必然可达）。0 = 关闭该上限（不推荐）。
  // 到顶后本漂移片段内禁止再次收窄，直到检验不再触发（片段结束）才复位。
  // 取值来源（不是拍脑袋）：45 个历史会话 / 3299 步关上限回放得到的自然片段长度
  //   p50=5  p75=9  p90=12  p95=19  p99=22  max=22
  // → 12 = 自然长度的 p90，即"给证据与它在 90% 情形下自然需要的时间一样长"，
  //   只截断尾部 5/53 个片段（见 D:\DSHwork\scratch\derive-max-drift-steps.mjs）。
  // 角色分工：本上限是**安全界**（必须存在、必须可达）；真正的预算杠杆是**误触发率**
  //   （由 tools/calibrate-response-policy.mjs 的 G1 门禁管）。标定件
  //   （responsePolicy.json）可按同一分位法重算该值并覆盖此默认。
  maxDriftSteps: 12,
  historyCap: 200,
  leanDenyPatterns: [
    'vision_*', 'browser_*', 'sandbox_*', 'desktop_*',
    'web_search', 'workflow', 'ralph',
    'session_log_scan', 'session_log_repair',
    'model_knobs', 'model_balance',
    'subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents',
    'todo_write', 'plot_function', 'lean_check',
    'cordis_define', 'cordis_run', 'cordis_update_tool', 'cordis_inspect_query',
    'cordis_inspect_list', 'cordis_inspect_self', 'cordis_stop', 'cordis_undefine',
    'anchor_status',
  ],
  mineCounterfactualCandidates: true,
  exportTrajectoryLogs: true,
  logDir: '.dsh-trajectory-logs',
  // 分块落盘：达到条数阈值或字节预算即把当前缓冲写成不可变块文件
  // anchor-<id>.jsonl.<n>。没有任何事件被裁剪——400 是缓冲阈值而非数据丢失上限。
  auditChunkEvents: 400,
  auditChunkBytes: 262144,
  rewardAnnotator: 'default',
}

const CONFIG_KEYS = new Set(Object.keys(DEFAULTS))

export const name = 'dsh-trajectory-anchor'

/** `tools` is declared so the row waits for the registry before registering
 * the anchor_status audit tool (a no-inject row applied before the tools row
 * would silently skip the registration). Everything else is resolved at
 * event time. */
export const inject = ['tools']

const INTERESTING = new Set([
  'agent/created', 'agent/disposed', 'agent/request', 'agent/pre-step',
  'agent/session-start', 'agent/status', 'session/event', 'session/created',
  'session/disposed', 'tools/change', 'llm/stream', 'system-prompt/assemble',
  'subagent/start', 'subagent/end', 'workflow/agent-start', 'workflow/agent-end',
])

const recs = new Map()
const finished = []
let CONFIG = { ...DEFAULTS }
/** 插件版本（写进累积状态记录，便于回溯"这条记忆是哪个版本学的"）；挂载时从 package.json 读。 */
let PLUGIN_VERSION = 'unknown'
let agentsSvc = null
let fsSvc = null
let spSvc = null
let baseDir = null
let sessionCwd = null
let auditToolDispose = null
const disposers = []
const dispatchStats = { total: 0, names: {} }
const channelStats = {}
let waterfallAgentRequest = 0
let waterfallPreStep = 0
let listAtApply = { length: -1, error: null }
let initiatorSessionId = null
const lateLookupDenied = new Set()

function msg(error) {
  try {
    if (error instanceof Error) return error.message
    if (error && typeof error === 'object' && typeof error.message === 'string') return error.message
    return String(error)
  } catch (e) {
    return '<unprintable error>'
  }
}

// ---------- 失败姿态：fail-open + 可见 ----------
// 原则（对照社区 dsh-anchored-standard/shared/{tool-bootstrap,context-gate}.mjs）：
// 本插件自己的 bug 绝不能吃掉用户的能力或上下文——任何降级都必须朝"暴露全量"倒，
// 并且必须响亮、可查（社区原文 "a gate bug must never eat the user's context"）。
const warned = new Set()
/** 一次性响亮告警：同一 reason 只打一次，避免每请求刷屏。 */
function warnOnce(message) {
  if (warned.has(message)) return
  warned.add(message)
  try { console.warn(`[${name}] ${message}`) } catch (e) { /* 无 console 环境忽略 */ }
}
const configWarnings = []
function noteConfigWarning(message) {
  if (!configWarnings.includes(message)) configWarnings.push(message)
  warnOnce(message)
}

// ---------- B3：运行时门禁状态（标定件 / 自动降档 / 评测保护）----------
/** 已装载的标定件摘要（null = 未提供）。 */
let policyArtifact = null
/** 在线自动降档状态（一旦置位即保持，直到进程重启或人工清空）。 */
let autoDemote = null
/** 最近已结束会话的"是否收窄过"记录（在线超预算自动降档用）。 */
const sessionOutcomes = []
/** L2：已装载的在线证据件摘要（null = 未提供）。 */
let reanchorEvidence = null
/** L3：已装载的族先验（null = 未提供/不可用 ⇒ 退回固定 Jeffreys）。 */
let familyPriors = null

/**
 * 取本次会话所属族的先验（L3 第二层）。
 * 族键 = `${provider}/${model}`，可选再带 scope（任务族）。族不存在或未装载 ⇒ null（不收缩）。
 * @returns {{rate:number, strength:number, key:string, matched:string}|null}
 */
function priorForFamily(rec, channelName) {
  if (!familyPriors || !familyPriors.byKey) return null
  const key = familyKeyOf(rec)
  if (!key) return null
  for (const candidate of [key.full, key.modelOnly]) {
    const fam = familyPriors.byKey[candidate]
    if (fam && fam.baseRates && Number.isFinite(fam.baseRates[channelName])) {
      return { rate: fam.baseRates[channelName], strength: CONFIG.priorStrength, key: key.full, matched: candidate }
    }
  }
  return null
}

/** 会话的族键：模型来自 request/header 事件，任务范围来自首条人类消息。 */
function familyKeyOf(rec) {
  const provider = rec.family && rec.family.provider ? rec.family.provider : 'unknown'
  const model = rec.family && rec.family.model ? rec.family.model : 'unknown'
  const preset = rec.family && rec.family.preset ? rec.family.preset : 'no-preset'
  const anchors = rec.taskAnchors
  let scope = 'none'
  if (anchors && anchors.parsed) {
    scope = (anchors.scopeNames && anchors.scopeNames[0])
      || ((anchors.scopeDirs && anchors.scopeDirs[0]) ? String(anchors.scopeDirs[0]).split('/').filter(Boolean).pop() : null)
      || 'scope'
  }
  const modelOnly = `${provider}/${model}`
  return { full: `${modelOnly} @ ${preset} @ ${scope}`, modelOnly }
}

/**
 * 能力层**有效**开关（决策路径必须用这个，而不是直接读 CONFIG.rollbackEnabled）：
 * 配置开关 ∧ 标定件允许 ∧ 未被自动降档 ∧ 不在评测保护下。
 * 任何一项不满足 → 只观察。这是"默认安全"的最后一道闸门。
 */
/**
 * 人工试运行放行是否**生效**（默认 null ⇒ 这条路径永不存在）。
 * 归一路径（任何一项不合规 ⇒ null，回到只观察，并且从不静默）：
 *   · 形状不对 / 通道表为空 / α 不在 (0,1) / **没有到期时间** / **已过期**。
 * 它**不**绕过 measurementSafe 与 autoDemote —— 那是两道独立的更硬的闸门（见 effectiveRollback）。
 * 为什么不给"放行全部"：一次只准放行你点名的通道，这样爆炸半径是写得出来的。
 */
function trialReleaseActive() {
  const t = CONFIG.trialRelease
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null
  const channels = Array.isArray(t.channels) ? t.channels.filter((c) => typeof c === 'string' && c.length > 0) : []
  if (channels.length === 0) return null
  const alpha = Number(t.alpha)
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) return null
  const until = typeof t.until === 'string' ? t.until : null
  if (!until) return null
  const untilMs = Date.parse(until)
  if (!Number.isFinite(untilMs)) return null
  // 人工试运行的**治理到期时间**：操作者设的硬期限，到点自动回到只观察。
  // 这不是漂移判定（C10 禁的是"用墙钟判漂移"），而是"不许有无期限的执行器"这条纪律的实现：
  // 期限的意义正是**逼一次重新决策**，所以它该与人的日历对齐，而不是与观测单元对齐。
  if (untilMs <= Date.now()) return null    // time-ok: 治理期限（操作者设置，非漂移判定）
  return { channels, alpha, until, untilMs, note: typeof t.note === 'string' ? t.note : null }
}

/** 通道是否在人工试运行放行名单里（拿不到生效的放行 ⇒ null）。 */
function trialGrant(name) {
  const t = trialReleaseActive()
  if (!t) return null
  return t.channels.includes(name) ? t : null
}

function effectiveRollback() {
  if (CONFIG.measurementSafe === true) return false
  if (autoDemote) return false
  const trial = trialReleaseActive()
  if (policyArtifact && policyArtifact.verdict !== 'PASS' && policyArtifact.verdict !== 'PARTIAL-PASS') {
    // 标定件不合格（或没有标定件）⇒ 正常路径关闭；**人工试运行是唯一例外**
    return trial !== null
  }
  return CONFIG.rollbackEnabled === true || trial !== null
}
/** 通知层的有效开关：同样受评测保护与自动降档约束（降档后连通知也停，只留审计）。 */
function effectiveNotify() {
  if (CONFIG.measurementSafe === true) return false
  if (autoDemote) return false
  return CONFIG.notifyEnabled === true
}
/** 卡口为何关闭（可观测：让人一眼知道"为什么没动手"）。 */
function capabilityGateReason() {
  if (CONFIG.measurementSafe === true) return 'measurement-safe'
  if (autoDemote) return `auto-demoted:${autoDemote.reason}`
  const trial = trialReleaseActive()
  // 试运行只在**它真的在为开门负责**时才被报出来（标定件已通过、或开关已开时，
  // 说"是试运行开的门"就是误导）——但一旦它负责，就必须一眼看出来"这不是标定授权"。
  const normalClosedByPolicy = Boolean(policyArtifact && policyArtifact.verdict !== 'PASS' && policyArtifact.verdict !== 'PARTIAL-PASS')
  if (normalClosedByPolicy) return trial ? `trial-release:${trial.channels.join('+')}` : `policy-${policyArtifact.verdict}`
  if (CONFIG.rollbackEnabled !== true) return trial ? `trial-release:${trial.channels.join('+')}` : 'switch-off'
  return null
}

/**
 * L2 重锚定的**有效**开关：配置开关 ∧ 在线证据件通过 ∧ 未被自动降档 ∧ 不在评测保护下。
 * 与能力层分开判（各自的证据门槛不同：能力层要"空转+召回"两关，重锚定要"在线效果"证据）。
 */
function effectiveReanchor() {
  if (CONFIG.measurementSafe === true) return false
  if (autoDemote) return false
  if (!reanchorEvidence || reanchorEvidence.verdict !== 'PASS-online') return false
  return CONFIG.reanchorEnabled === true
}
/** 重锚定为何关闭（同 capabilityGateReason 的可观测原则）。 */
function reanchorGateReason() {
  if (CONFIG.measurementSafe === true) return 'measurement-safe'
  if (autoDemote) return 'auto-demoted'
  if (!reanchorEvidence) return CONFIG.reanchorEnabled === true ? 'no-online-evidence' : 'switch-off'
  if (reanchorEvidence.verdict !== 'PASS-online') return `evidence-${reanchorEvidence.verdict}`
  if (CONFIG.reanchorEnabled !== true) return 'switch-off'
  return null
}

function round2(n) {
  return Math.round(n * 100) / 100
}

/**
 * 概率的显示精度：α 现在是 1e-5 量级，round2 会把 3e-3 与 9e-6 一并印成 0，
 * 于是"为什么动手 / 为什么没动手"在审计与 anchor_status 里根本无法回答
 * （实测：p=0.003 的行动级判定与 p=1e-9 的判定在报告里长得一模一样）。
 * 小值保留 2 位有效数字（0.003、1.2e-7），大值仍按两位小数。
 */
function roundP(p) {
  if (!Number.isFinite(p)) return null
  if (p === 0) return 0
  if (p < 0.001) return Number(p.toPrecision(2))
  return round2(p)
}

function bump(channel) {
  channelStats[channel] = (channelStats[channel] || 0) + 1
}

function logAudit(rec, kind, fields) {
  try {
    const entry = { t: Date.now(), kind }
    if (fields !== undefined && fields !== null) {
      for (const k in fields) entry[k] = fields[k]
    }
    rec.events.push(entry)
    rec.auditBytes = (rec.auditBytes || 0) + estimateEntryBytes(entry)
    // 缓冲达到阈值 → 整块落盘（块文件只写一次，永不裁剪；生命周期事件随块
    // 按时间序保留，不再需要单独的防裁剪数组）
    if (rec.events.length >= CONFIG.auditChunkEvents || rec.auditBytes >= CONFIG.auditChunkBytes) {
      drainAuditChunk(rec)
    }
    flushRec(rec)
  } catch (e) {
    // audit must never break a hot path
  }
}

/** 事件字节估算：JSON 序列化长度的廉价近似（关键字段长度求和 + 结构开销）。 */
function estimateEntryBytes(entry) {
  let n = 48
  for (const k in entry) {
    const v = entry[k]
    if (typeof v === 'string') n += v.length
    else if (typeof v === 'number') n += 16
  }
  return n
}

/** 把当前缓冲写成不可变块文件 anchor-<id>.jsonl.<idx>，然后清空缓冲。
 *  块文件按序号单调追加，永不重写——长任务的事件流因此零丢失。
 *  ⚠ 序号必须**先从磁盘续起**（ensureAuditFiles）：rec.chunkIdx 是随挂载新建的，
 *  从 1 重新数就等于每次重启都把上一轮的 chunk 1..N 覆写一遍。而且这个续号必须发生
 *  在**第一次落盘之前**——阈值小的配置下 drainAuditChunk 会先于 flushRec 被调用，
 *  晚一步就已经把 .1 覆写了（本修复的第一次实现就踩了这个）。 */
function drainAuditChunk(rec) {
  if (rec.events.length === 0) return
  if (!CONFIG.exportTrajectoryLogs || !fsSvc) { rec.events = []; rec.auditBytes = 0; return }
  ensureAuditFiles(rec)
  let dir = CONFIG.logDir
  if (typeof baseDir === 'string' && baseDir.length > 0) dir = baseDir + '/' + CONFIG.logDir
  const idx = rec.chunkIdx = (rec.chunkIdx || 0) + 1
  const file = dir + '/anchor-' + rec.sessionId + '.jsonl.' + idx
  const text = rec.events.map(e => JSON.stringify(e)).join('\n') + '\n'
  rec.events = []
  rec.auditBytes = 0
  const write = () => Promise.resolve()
    .then(() => fsSvc.resolve(file, typeof baseDir === 'string' ? { cwd: baseDir } : undefined))
    .then(target => fsSvc.writeText(target, text))
    .catch(error => { rec.fileError = msg(error) })
  rec.flushChain = (rec.flushChain || Promise.resolve()).then(write, write)
}

function ensureAuditFiles(rec) {
  if (rec.auditInit === true) return
  rec.auditInit = true
  adoptAuditFiles(rec)
}

/**
 * 挂载时接手审计文件（每次挂载只做一次）：
 *   ① 把上一轮挂载留在**主文件**里的尾部缓冲（主文件每次 flush 是重写，不是追加）
 *      转成一个块文件，序号接在磁盘最大值之后；
 *   ② 把块序号续到磁盘最大值——否则新挂载的 chunk 1 会覆写上一轮的 chunk 1。
 * 为什么转成块而不是"当作主文件前缀接着写"：读侧（export-layer4）的顺序是
 * **块按序号、主文件最后**。若把上一轮尾部留在主文件里，它会被读到所有新块之后，
 * 时间序就错位了；转成"续号的块"则整条序列仍然单调。
 */
function adoptAuditFiles(rec) {
  try {
    let dir = CONFIG.logDir
    if (typeof baseDir === 'string' && baseDir.length > 0) dir = baseDir + '/' + CONFIG.logDir
    const main = dir + '/anchor-' + rec.sessionId + '.jsonl'
    const prefix = 'anchor-' + rec.sessionId + '.jsonl.'
    let maxIdx = 0
    let names = []
    try { names = readdirSync(dir) } catch { names = [] }
    for (const n of names) {
      if (!n.startsWith(prefix)) continue
      const v = Number(n.slice(prefix.length))
      if (Number.isFinite(v) && v > maxIdx) maxIdx = v
    }
    let carried = 0
    if (existsSync(main)) {
      let text = ''
      try { text = readFileSync(main, 'utf8') } catch { text = '' }
      const lines = text.split('\n').filter((l) => l.trim())
      if (lines.length > 0) {
        const idx = maxIdx + 1
        writeFileSync(dir + '/anchor-' + rec.sessionId + '.jsonl.' + idx, lines.join('\n') + '\n', 'utf8')
        maxIdx = idx
        carried = lines.length
        warnOnce('audit: 上一轮挂载留在主文件里的尾部缓冲已转成块文件（主文件是重写的，不转就会丢）')
      }
      // 主文件随新挂载从空开始（内容要么已转块、要么本来就是空的）
      try { writeFileSync(main, '', 'utf8') } catch { /* 下一轮 flush 会重写它 */ }
    }
    rec.chunkIdx = maxIdx
    if (carried > 0) {
      logAudit(rec, 'audit-adopted', { lines: carried, chunk: maxIdx, note: '挂载接手：上一轮尾部已转块，块序号已续接' })
    }
  } catch (e) {
    rec.fileError = msg(e)
  }
}

function flushRec(rec) {
  if (!CONFIG.exportTrajectoryLogs || !fsSvc) return Promise.resolve()
  // 挂载接手必须在**第一次落盘之前**完成：主文件每次 flush 是重写（不是追加），
  // 上一轮压在里面未满块的尾部缓冲会被直接抹掉（2026-10-08 实测：12:54–14:08
  // 一整段审计消失，连两次 pullback-outcome 的 closed 事件都没有；只有 appendFileSync
  // 写的 pullback-outcomes.jsonl 活了下来）。
  ensureAuditFiles(rec)
  const events = rec.events.slice()
  if (rec.lifted || rec.closed) events.push({ t: Date.now(), kind: 'record', summary: summaryOf(rec) })
  let dir = CONFIG.logDir
  if (typeof baseDir === 'string' && baseDir.length > 0) dir = baseDir + '/' + CONFIG.logDir
  const file = dir + '/anchor-' + rec.sessionId + '.jsonl'
  // Serialize flushes per rec: fire-and-forget async writes race and the
  // shorter (earlier) write can land LAST, truncating the final closed/record
  // lines (observed on three B2 runs).
  const write = () => Promise.resolve()
    .then(() => fsSvc.resolve(file, typeof baseDir === 'string' ? { cwd: baseDir } : undefined))
    .then(target => fsSvc.writeText(target, events.map(e => JSON.stringify(e)).join('\n') + '\n'))
    .then(() => { rec.fileError = null })
    .catch(error => { rec.fileError = msg(error) })
  rec.flushChain = (rec.flushChain || Promise.resolve()).then(write, write)
  return rec.flushChain
}

// ---------- scoring v2: lexicon / bands / baseline percentile ----------

function reasoningBlocks(event) {
  try {
    const content = event && event.data && event.data.message && event.data.message.content
    if (!Array.isArray(content)) return []
    const out = []
    for (const block of content) {
      if (block && block.type === 'reasoning' && typeof block.text === 'string' && block.text.length > 0) out.push(block.text)
    }
    return out
  } catch (e) {
    return []
  }
}

/** 词条 → 匹配正则（与 tools/lexicon-core.mjs 的 termRegex 同语义）：
 *  纯 CJK 词条按字面子串匹配（提取器提取的就是子串，匹配必须同语义）；
 *  拉丁/西里尔词条用「非词内字母」前后环视当边界——\b 是 ASCII 词边界，
 *  对带重音字母（é/ñ 等非 \w）失效；字母环视与提取器的词切分
 *  （[A-Za-z\u00c0-\u024f\u0400-\u04ff] 起头）一致，并正确处理 we1 这类数字相邻情形。 */
export function termRegex(term, flags) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')
  const hasLatin = /[A-Za-z\u00c0-\u024f\u0400-\u04ff]/.test(term)
  if (!hasLatin) return new RegExp(escaped, flags)
  const L = '[A-Za-z\u00c0-\u024f\u0400-\u04ff]'
  return new RegExp('(?<!' + L + ')' + escaped + '(?!' + L + ')', flags)
}

/** 解析词典 JSON（启动加载）：接受 {positive,negative,neutral} 直体，或
 *  校准工具输出 {lexicon:{...}, ratioWeights:{...}}；权重必须是有限数。 */
export function parseLexiconJson(text) {
  const raw = JSON.parse(text)
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) &&
    raw.lexicon && typeof raw.lexicon === 'object' ? raw : { lexicon: raw }
  const lex = body.lexicon
  if (!lex || typeof lex !== 'object' || Array.isArray(lex)) throw new Error('lexicon JSON must contain a lexicon object')
  const out = {}
  for (const b of ['positive', 'negative', 'neutral']) {
    const map = lex[b]
    if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error(`lexicon bucket "${b}" must be an object`)
    out[b] = {}
    for (const t of Object.keys(map)) {
      if (typeof map[t] !== 'number' || !Number.isFinite(map[t])) throw new Error(`lexicon weight for "${t}" must be a finite number`)
      out[b][t] = map[t]
    }
  }
  const w = body.ratioWeights
  if (w && typeof w === 'object' &&
    typeof w.alpha === 'number' && typeof w.beta === 'number' &&
    typeof w.gamma === 'number' && typeof w.epsilon === 'number') {
    out.ratioWeights = { alpha: w.alpha, beta: w.beta, gamma: w.gamma, epsilon: w.epsilon }
  }
  return out
}

function measureText(text) {
  const normalized = text.replace(/[\u2018\u2019]/g, "'")
  const lower = normalized.toLowerCase()
  let positive = 0
  let negative = 0
  let neutral = 0
  let positiveWords = 0
  let negativeWords = 0
  for (const term of Object.keys(CONFIG.lexicon.positive)) {
    const m = lower.match(termRegex(term, 'g'))
    const n = m ? m.length : 0
    if (n > 0) {
      positive += n * CONFIG.lexicon.positive[term]
      positiveWords += n
    }
  }
  for (const term of Object.keys(CONFIG.lexicon.negative)) {
    const m = lower.match(termRegex(term, 'g'))
    const n = m ? m.length : 0
    if (n > 0) {
      negative += n * CONFIG.lexicon.negative[term]
      negativeWords += n
    }
  }
  for (const term of Object.keys(CONFIG.lexicon.neutral)) {
    const m = lower.match(termRegex(term, 'g'))
    const n = m ? m.length : 0
    if (n > 0) neutral += n * CONFIG.lexicon.neutral[term]
  }
  // 极性语义与具体词无关：正/负命中由当前词典的标记词决定，
  // 换一套词典（如 let-me 为正向的词典）这些计数自动跟着翻转。
  return {
    positive,
    negative,
    neutral,
    positiveWords,
    negativeWords,
    hasPositive: positiveWords > 0,
    hasNegative: negativeWords > 0,
  }
}

function flagsOf(texts) {
  const flags = []
  for (const text of texts) flags.push(measureText(text))
  return flags
}

function weightedRatio(agg) {
  const w = CONFIG.ratioWeights
  return (w.alpha * agg.positive + w.beta * agg.neutral) / (w.gamma * agg.negative + w.epsilon)
}

function personaRatio(agg) {
  const denom = agg.positiveWords + agg.negativeWords
  return denom === 0 ? 0 : agg.negativeWords / denom
}

function bandOf(ratio) {
  if (ratio < CONFIG.specMax) return 'spec'
  if (ratio < CONFIG.reactMin) return 'mixed'
  return 'react'
}

function percentileRank(value, history) {
  if (history.length === 0) return null
  let below = 0
  for (const x of history) {
    if (x < value) below += 1
  }
  return (below / history.length) * 100
}

function recompute(rec, agent) {
  const agg = { positive: 0, negative: 0, neutral: 0, positiveWords: 0, negativeWords: 0 }
  for (const m of rec.lastMessages) {
    for (const f of m.flags) {
      agg.positive += f.positive
      agg.negative += f.negative
      agg.neutral += f.neutral
      agg.positiveWords += f.positiveWords
      agg.negativeWords += f.negativeWords
    }
  }
  if (rec.lastMessages.length === 0) return
  const ratio = weightedRatio(agg)
  const pr = personaRatio(agg)
  const band = bandOf(pr)
  rec.ratioHistory.push(ratio)
  if (rec.ratioHistory.length > CONFIG.historyCap) rec.ratioHistory.shift()
  // band / personaRatio / percentile：**仅供审计与离线标定**——标定工具
  // （calibrate-lexicon-v2、calibrate-response-policy）都从轨迹日志读这些字段。
  // 决策路径一律不得读它们（断言 C11 守护）；漂移判定已改为会话内自参考检验。
  rec.bandHistory.push(band)
  if (rec.bandHistory.length > CONFIG.historyCap) rec.bandHistory.shift()
  const percentile = percentileRank(ratio, rec.ratioHistory)
  rec.weightedRatio = ratio
  rec.personaRatio = pr
  rec.band = band
  rec.percentile = percentile === null ? null : Math.round(percentile * 10) / 10
  // P5 词典非退化闸门所需：本会话累计的"桶是否命中过"证据。
  rec.stepsScored += 1
  if (agg.positiveWords > 0) rec.positiveHitSteps += 1
  if (agg.negativeWords > 0) rec.negativeHitSteps += 1
  const degen = lexiconDegenerate(rec.positiveHitSteps, rec.stepsScored, CONFIG.refMinSteps)
  if (degen && rec.lexiconDegenerate !== degen) {
    rec.lexiconDegenerate = degen
    logAudit(rec, 'lexicon-degenerate', {
      reason: degen,
      stepsScored: rec.stepsScored,
      positiveHitSteps: rec.positiveHitSteps,
      negativeHitSteps: rec.negativeHitSteps,
      effect: 'capability actions forbidden; notify-only',
    })
    warnOnce(`lexicon degenerate for ${rec.sessionId}: positive bucket never hit in ${rec.stepsScored} steps — capability actions disabled (notify-only)`)
  }
  if (rec.ewmaCount === 0) rec.ewma = ratio
  else rec.ewma = CONFIG.ewmaAlpha * ratio + (1 - CONFIG.ewmaAlpha) * rec.ewma
  rec.ewmaCount += 1
  rec.lastState = band
  logAudit(rec, 'score', {
    ratio: round2(ratio),
    personaRatio: round2(pr),
    band,
    percentile: rec.percentile,
    ewma: round2(rec.ewma),
    pos: round2(agg.positive),
    neg: round2(agg.negative),
    neu: round2(agg.neutral),
  })
  if (agent !== undefined) stateMachine(rec, agent)
}

function updateWindow(rec, texts, agent) {
  if (texts.length > 0) {
    rec.lastMessages.push({ flags: flagsOf(texts) })
    while (rec.lastMessages.length > CONFIG.trajectoryWindowSize) rec.lastMessages.shift()
  }
  recompute(rec, agent)
}

function backfill(rec, agent) {
  try {
    const events = agent && agent.session ? agent.session.events : undefined
    if (!events) return
    const list = Array.isArray(events) ? events : Array.from(events)
    let assistantCount = 0
    for (const ev of list) {
      if (ev && ev.type === 'assistant/message') {
        assistantCount += 1
        const texts = reasoningBlocks(ev)
        if (texts.length > 0) {
          rec.lastMessages.push({ flags: flagsOf(texts) })
          while (rec.lastMessages.length > CONFIG.trajectoryWindowSize) rec.lastMessages.shift()
        }
      }
    }
    if (rec.lastMessages.length > 0) recompute(rec, undefined)
    logAudit(rec, 'backfill', { events: list.length, assistantMessages: assistantCount, window: rec.lastMessages.length })
  } catch (e) {
    logAudit(rec, 'backfill-error', { error: msg(e) })
  }
}

// ---------- state machine v2 (bands + baseline-relative drift) ----------

function matchPatterns(name, patterns) {
  for (const p of patterns) {
    if (typeof p !== 'string' || p.length === 0) continue
    if (p.endsWith('*')) {
      if (name.startsWith(p.slice(0, -1))) return true
    } else if (name === p) {
      return true
    }
  }
  return false
}

function restrictWithCull(scopedTools, filter) {
  const mode = filter.allow !== undefined ? 'allow' : 'deny'
  let names = (mode === 'allow' ? filter.allow : filter.deny).slice()
  let lastError = null
  while (names.length > 0) {
    try {
      const lift = scopedTools.restrict(mode === 'allow' ? { allow: names.slice() } : { deny: names.slice() })
      return { lift, applied: names.slice() }
    } catch (e) {
      lastError = msg(e)
      const m = lastError.match(/known global tools: ([^\n]*)$/)
      if (!m) return { error: lastError }
      const known = m[1].split(',').map(s => s.trim().replace(/\.$/, '')).filter(s => s.length > 0 && s !== '(none)')
      const next = names.filter(n => known.includes(n))
      if (next.length === names.length) return { error: lastError }
      names = next
    }
  }
  return { error: lastError || 'empty restriction' }
}

/**
 * 阶段 → 模型可见工具面（纯函数，可单测；绝不修改入参、绝不触碰注册层）。
 *
 * 为什么是"派生"而不是 tools.restrict 的 deny 模式：注册层突变是不可逆的资源占用，
 * 归还必须靠一个显式调用——本插件为此栽过跟头（实测 23 个会话触发、0 个归还，
 * 恢复条件 band==='spec' 在 personaRatio≡1 时不可达；18 个会话工具面永久停在 23）。
 * 组装期派生则天然可逆：阶段一变，下一次组装就是新面，"归还"这个词消失。
 * 参照社区 dsh-anchored-standard/shared/tool-bootstrap.mjs（每次 assemble 由
 * promotion 状态重新派生 filter）。
 *
 * @param phase - 'narrowed' 时收窄；其余阶段（stable/watch）原样返回。
 * @param tools - 组装期交给模型的工具 schema 数组（PromptAssembly.tools）。
 * @param patterns - 收窄用的 deny 模式（`*` 后缀通配）。
 */
export function surfaceForPhase(phase, tools, patterns) {
  if (!Array.isArray(tools)) return tools
  if (phase !== 'narrowed') return tools
  const pats = Array.isArray(patterns) ? patterns : []
  if (pats.length === 0) return tools
  return tools.filter(t => !matchPatterns((t && t.name) || '', pats))
}

/**
 * 单侧 Mann-Whitney 检验（纯函数，可单测）：P(检验窗取值随机地不高于参考窗) 的
 * 正态近似 p 值（含并列修正与连续性修正）。用于"当前窗是否异常偏低"的**预算判定**
 * ——不是发表级统计；参考段长度由 refMinSteps 兜底，近似在该量级足够决策用。
 * 返回 [0,1]；样本不足返回 1（= 无证据，不动手）。
 */
export function mannWhitneyLowerP(test, reference) {
  const t = Array.isArray(test) ? test.filter(v => Number.isFinite(v)) : []
  const r = Array.isArray(reference) ? reference.filter(v => Number.isFinite(v)) : []
  const n = t.length
  const m = r.length
  if (n === 0 || m === 0) return 1
  const all = [...t, ...r]
  // 平均秩（并列取平均）
  const idx = all.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0])
  const ranks = new Array(all.length)
  let tieSum = 0
  for (let i = 0; i < idx.length;) {
    let j = i
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j += 1
    const avg = (i + j) / 2 + 1
    const tieCount = j - i + 1
    if (tieCount > 1) tieSum += tieCount ** 3 - tieCount
    for (let k = i; k <= j; k++) ranks[idx[k][1]] = avg
    i = j + 1
  }
  const rankSumTest = ranks.slice(0, n).reduce((a, b) => a + b, 0)
  const u = rankSumTest - (n * (n + 1)) / 2            // 越小 = 检验窗越低
  const mu = (n * m) / 2
  const N = n + m
  const sigma = Math.sqrt(((n * m) / 12) * ((N + 1) - tieSum / (N * (N - 1))))
  if (!(sigma > 0)) return 1
  const z = (u + 0.5 - mu) / sigma                     // 连续性修正（向 0 收）
  // 正态 CDF
  const cdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2))
  return Math.min(1, Math.max(0, cdf(z)))
}

/** erf 近似（Abramowitz & Stegun 7.1.26），绝对误差 < 1.5e-7。 */
function erf(x) {
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * ax)
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax)
  return sign * y
}

/** 二项分布对数概率 ln C(n,k) + k·ln p + (n−k)·ln(1−p)，避免下溢。 */
function binomLogPmf(k, n, p) {
  if (k < 0 || k > n) return -Infinity
  if (p <= 0) return k === 0 ? 0 : -Infinity
  if (p >= 1) return k === n ? 0 : -Infinity
  let logC = 0
  for (let i = 1; i <= k; i++) logC += Math.log(n - k + i) - Math.log(i)
  return logC + k * Math.log(p) + (n - k) * Math.log1p(-p)
}

/**
 * 二值通道的单侧精确二项检验（会话内自参考；纯函数，可单测）。
 *
 * 与词表通道的曼-惠特尼检验是同一件事的两种测量标度：都拿**本会话自己的历史**
 * 当零假设，检验"当前窗是否异常"；区别只是标度是连续值 vs 二值命中。
 *
 * pHat 的估计有两种来源（L3 第二层）：
 *   · `pseudo`（数值，默认 0.5 = Jeffreys 伪计数）：否则"历史 0 命中 → p̂=0 → 任何一次命中
 *     都无限显著"。数值示例（参考 20 步全干净、窗 3、命中 2）：p̂=0.0238 → p≈0.0016。
 *   · `prior`（{rate, strength}，来自 provider/model 族先验）：等价于"先验 S 步里命中 rate·S 次"
 *     与本次会话的参考段一起估计：
 *         pHat = (refHits + rate·S) / (refLen + S)
 *     于是**同一段偏离在基频不同的族里得到不同的 p**（这才是"适配不同模型"的机制）；
 *     且随着 refLen 增长，会话自己的数据逐步主导（收缩的正确行为：早借先验、晚信自己）。
 *     方向不是想当然的：先验均值高 ⇒ 同样的命中数更不意外（p 更大）；但 S 同时决定
 *     "数据能推翻先验的速度"——实测（见 tools/family-priors.mjs --eval）两者的净效应是
 *     高基频族的 p 更大、低基频族更小，差距随 refLen 收敛。
 *
 * @returns 上侧尾概率 P(Binom(m, p̂) ≥ observed)，[0,1]；样本不足返回 1（无证据）。
 */
export function binomialLowerP(observed, m, refHits, refLen, pseudo = 0.5) {
  if (!Number.isFinite(observed) || !Number.isFinite(m) || m <= 0) return 1
  if (!Number.isFinite(refHits) || !Number.isFinite(refLen) || refLen <= 0) return 1
  let pHat
  if (pseudo && typeof pseudo === 'object' && Number.isFinite(pseudo.rate) && Number.isFinite(pseudo.strength) && pseudo.strength > 0) {
    const r = Math.min(0.999, Math.max(0.001, pseudo.rate))
    pHat = (refHits + r * pseudo.strength) / (refLen + pseudo.strength)
  } else {
    const ps = Number.isFinite(pseudo) ? pseudo : 0.5
    pHat = (refHits + ps) / (refLen + 2 * ps)
  }
  const k0 = Math.max(0, Math.min(m, Math.round(observed)))
  let logTail = -Infinity
  for (let k = k0; k <= m; k++) {
    const lp = binomLogPmf(k, m, pHat)
    if (lp === -Infinity) continue
    logTail = logTail === -Infinity ? lp : logAdd(logTail, lp)
  }
  if (logTail === -Infinity) return 1
  return Math.min(1, Math.max(0, Math.exp(logTail)))
}

/** log(exp(a)+exp(b))，数值稳定。 */
function logAdd(a, b) {
  const hi = a > b ? a : b
  const lo = a > b ? b : a
  return hi + Math.log1p(Math.exp(lo - hi))
}

/**
 * 多通道聚合（纯函数，可单测）——**唯一的决策入口**。
 *
 * 每个通道各自过会话内自参考检验，得到 p 值与自己的参考长度；聚合规则：
 *   ① 所有通道都不可用（连检验窗/参考段都不够）→ stable + 两档"证据不足"原因（留痕）；
 *   ② 有通道 p ≤ actAlpha（强偏离）→ 状态语义 narrowed；**动作**还要过闸门：
 *        能力开关关 / 通道无资格（capabilityEligible=false，如退化词典或未过标定）
 *        / 能力预算耗尽 → 只通知（或只审计）；全部通过才 narrow；
 *   ③ 只有 p ≤ notifyAlpha（弱偏离）→ watch + 通知/审计。
 * 入口用 **OR**（任一通道成立即可），不做跨通道"与"——"与"会继承每个通道的盲区。
 */
export function evaluateChannels(input) {
  const chans = Array.isArray(input.perChannel) ? input.perChannel : []
  const usable = []
  let maxRefLen = 0
  let anyWindow = false
  for (const c of chans) {
    if (typeof c.refLen === 'number') maxRefLen = Math.max(maxRefLen, c.refLen)
    if (typeof c.refLen === 'number' && c.refLen >= 1) anyWindow = true
    if (Number.isFinite(c.p) && typeof c.refLen === 'number' && c.refLen >= (c.refMinSteps ?? input.refMinSteps)) {
      usable.push(c)
    }
  }
  const none = { channel: null, p: null, perChannel: chans.map((c) => ({ name: c.name, p: roundP(c.p) })) }
  if (usable.length === 0) {
    return {
      ...none,
      level: 'stable',
      action: 'none',
      reason: anyWindow ? 'insufficient-reference' : 'no-observation',
    }
  }
  const byP = usable.slice().sort((a, b) => a.p - b.p)
  const actA = (c) => (Number.isFinite(c.actAlpha) ? c.actAlpha : input.actAlpha)
  const notifyA = (c) => (Number.isFinite(c.notifyAlpha) ? c.notifyAlpha : input.notifyAlpha)
  // 连续确认 k：与离线核心同语义——连续 k 次检验都命中才算一次触发（观测单位迟滞）。
  // fireRun / fireRunNotify 由运行时逐通道维护（各自的门限见 stateMachine）；
  // 直接调用本函数的场景（兼容 façade、回归用例）未跟踪连续计数时按 1 处理
  // = "单次检验即触发"（B3 之前的行为，向后兼容）。
  const runOf = (c, tier) => {
    const v = tier === 'act' ? c.fireRun : c.fireRunNotify
    return Number.isFinite(v) ? v : 1
  }
  const confirmed = (c, tier) => runOf(c, tier) >= Math.max(1, c.consecutive ?? 1)
  const strong = byP.filter((c) => c.p <= actA(c) && confirmed(c, 'act'))
  const weak = byP.filter((c) => c.p <= notifyA(c) && confirmed(c, 'notify'))
  const notice = input.notifyEnabled === true ? 'notice' : 'none'
  if (strong.length > 0) {
    // OR 入口的正确语义：**任一"有资格"的通道够强即可收窄**。
    // 不能只看 p 最小的那条——否则一条无资格通道（p 更小）会挡住另一条有资格通道
    // 本该成立的收窄（这条语义错误是被回归用例 H/I/J 里的 "OR 入口" 用例抓出来的）。
    const strongEligible = strong.filter((c) => c.capabilityEligible === true)
    const pick = strongEligible.length > 0 ? strongEligible[0] : strong[0]
    if (input.rollbackEnabled !== true) {
      return { ...none, level: 'narrowed', action: notice, reason: input.notifyEnabled === true ? 'capability-disabled' : 'observe-only', channel: pick.name, p: roundP(pick.p) }
    }
    if (strongEligible.length === 0) {
      return { ...none, level: 'narrowed', action: notice, reason: pick.blockedBy || 'channel-not-eligible', channel: pick.name, p: roundP(pick.p) }
    }
    if (input.budgetExhausted === true) {
      return { ...none, level: 'narrowed', action: notice, reason: 'capability-budget-exhausted', channel: pick.name, p: roundP(pick.p) }
    }
    return { ...none, level: 'narrowed', action: 'narrow', reason: 'deviation', channel: pick.name, p: roundP(pick.p) }
  }
  if (weak.length > 0) {
    const pick = weak[0]
    return { ...none, level: 'watch', action: notice, reason: input.notifyEnabled === true ? 'deviation-weak' : 'observe-only', channel: pick.name, p: roundP(pick.p) }
  }
  return { ...none, level: 'stable', action: 'none', reason: 'within-reference' }
}

/** 兼容 façade：单通道（词表）调用 evaluateChannels。保留给既有调用方与回归用例。 */
export function policyDecision(input) {
  const r = evaluateChannels({
    perChannel: [{
      name: 'lexicon',
      p: input.p,
      refLen: input.refLen,
      refMinSteps: input.refMinSteps,
      capabilityEligible: input.degenerate !== true,
      blockedBy: input.degenerate === true ? 'lexicon-degenerate' : undefined,
    }],
    refMinSteps: input.refMinSteps,
    actAlpha: input.actAlpha,
    notifyAlpha: input.notifyAlpha,
    rollbackEnabled: input.rollbackEnabled,
    notifyEnabled: input.notifyEnabled,
    budgetExhausted: input.budgetExhausted,
  })
  return { level: r.level, action: r.action, reason: r.reason }
}

/** 词典退化判定（纯函数）：本会话已有足够观测，但正桶一次都没命中。 */
export function lexiconDegenerate(positiveHitSteps, stepsScored, minSteps) {
  if (stepsScored < minSteps) return false
  return positiveHitSteps === 0 ? 'positive-bucket-never-hit' : false
}

function applyRollback(rec, via, p) {
  if (!effectiveRollback()) return
  if (!rec.anchored || !rec.lifted) return
  if (rec.surfacePhase === 'narrowed') return
  if (CONFIG.leanDenyPatterns.length === 0) {
    logAudit(rec, 'rollback-skipped', { reason: 'no deny patterns configured', via })
    return
  }
  // P1：只改阶段，可见面在下次组装时派生；不再调用 tools.restrict 的 deny 模式。
  rec.surfacePhase = 'narrowed'
  rec.surfaceNarrowedAt = Date.now()
  rec.narrowedSteps = 0
  rec.rollbackDeny = CONFIG.leanDenyPatterns.slice()
  if (CONFIG.mineCounterfactualCandidates) {
    rec.counterfactual = {
      startedAt: Date.now(),
      decisionPoint: 'deviation-test',
      injected: CONFIG.leanDenyPatterns.slice(),
      requests: rec.requests,
      turn: rec.lastTurn,
      step: rec.lastStep,
      restored: null,
    }
  }
  logAudit(rec, 'surface', { phase: 'narrowed', denied: CONFIG.leanDenyPatterns.slice(), via, p: round2(p), ratio: round2(rec.weightedRatio), trialRelease: (trialReleaseActive() || {}).channels || null })
}

function enterDrift(rec, via, p) {
  rec.machineState = 'drift'
  rec.driftSteps = 0
  rec.driftEnteredAt = Date.now()
  logAudit(rec, 'state', { state: 'drift', via, p: round2(p), band: rec.band })
  applyRollback(rec, via, p)
}

function recoverRollback(rec, reason) {
  rec.machineState = 'stable'
  rec.driftSteps = 0
  rec.narrowedSteps = 0
  // 注意：capabilityBudgetExhausted 属于**漂移片段**的状态，只在片段真正结束
  // （决策回到 stable）时复位。若在这里复位，会形成"耗尽→恢复→立刻再收窄"的
  // 无限循环——那正是我们要消灭的那类不可达/不可终止的形态。
  if (rec.surfacePhase === 'narrowed') {
    // 派生面：只需把阶段改回去——下一次组装自然恢复全量，没有任何"归还"调用。
    rec.surfacePhase = 'stable'
    rec.surfaceRestoredAt = Date.now()
    logAudit(rec, 'surface', { phase: 'stable', via: reason, denied: [] })
  }
  if (CONFIG.mineCounterfactualCandidates && rec.counterfactual) {
    rec.counterfactual.restored = {
      at: Date.now(),
      reason,
      requests: rec.requests,
      ratio: round2(rec.weightedRatio),
    }
    logAudit(rec, 'counterfactual', {
      startedAt: rec.counterfactual.startedAt,
      injected: rec.counterfactual.injected,
      restored: rec.counterfactual.restored,
    })
    rec.counterfactual = null
  }
  logAudit(rec, 'state', { state: 'stable', via: reason, band: rec.band })
}

function notePolicySkipped(rec, reason) {
  if (rec.lastPolicySkip === reason) return
  rec.lastPolicySkip = reason
  logAudit(rec, 'policy-skipped', { reason, history: rec.ratioHistory.length, refMinSteps: CONFIG.refMinSteps })
}

/**
 * 状态机（P3）：判定 = 会话内自参考偏离检验，而非"单步落在最低四分位"。
 * 进入收窄的每一次都带 (p, refLen)；退出有两条**必然可达**的路：
 *   ① 检验不再触发（片段结束）；
 *   ② 收窄满 maxDriftSteps → 能力预算耗尽（本片段内不再收窄，只通知）。
 */
function stateMachine(rec, agent) {
  // 多通道：词表（曼-惠特尼，会话内自参考）+ 行为（中途停手 / 重复 / 失败，二值精确二项）。
  // 入口是 OR——任一通道成立即可；不做跨通道"与"（"与"会继承每个通道的盲区）。
  const perChannel = channelTests(rec)
  // 连续确认计数（每通道独立）：p 命中则该通道 run+1，否则清零。
  // 与离线核心 behaviour-channel-core.mjs 的 walkChannel 同语义，否则"离线标定"
  // 与"在线判定"会对不上。
  if (!rec.fireRuns || typeof rec.fireRuns !== 'object') rec.fireRuns = {}
  for (const c of perChannel) {
    // 连续确认计数**按层级各自维护**，且必须与门限同层：
    //   行动级连续计数用 actAlpha，通知级用 notifyAlpha。
    // 为什么不能让"通知级命中"去凑行动级的 k：离线标定（calibrate-channels.mjs →
    // behaviour-channel-core.mjs 的 walkChannel(alpha)）是在**单一 α** 上数连续的，
    // 标定件反解出的 (α=1e-5, k) 语义就是"连续 k 次 p≤1e-5"。若在线改用 1e-4 计数，
    // 在线判定会比标定**更松**（1e-4 档的命中被算进连续），结果就是"离线合格、线上
    // 超标"——正是 B3 门禁要防的静默失效。（这条差异由门禁用例 ⑩ 守住。）
    // L3 第三层：行动级门限按**结局回灌**调整（默认关 ⇒ 与标定值逐位相同）。
    // 放在这里而不是改 CONFIG：回灌只影响"这一通道的有效门限"，不改配置本体（可审计、可解释）。
    const baseAct = Number.isFinite(c.actAlpha) ? c.actAlpha : CONFIG.actAlpha
    const effAct = effectiveActAlpha(c.name, baseAct)
    const actA = Number.isFinite(effAct) ? effAct : -Infinity      // revoked ⇒ -Infinity ⇒ 永不命中
    const notA = Number.isFinite(c.notifyAlpha) ? c.notifyAlpha : CONFIG.notifyAlpha
    const hitAct = Number.isFinite(c.p) && c.p <= actA
    const hitNot = Number.isFinite(c.p) && c.p <= notA
    if (hitAct) rec.channelActFires[c.name] = (rec.channelActFires[c.name] || 0) + 1
    c.actAlphaEffective = Number.isFinite(effAct) ? effAct : null
    const prev = rec.fireRuns[c.name]
    const slot = prev && typeof prev === 'object'
      ? prev
      : { act: Number.isFinite(prev) ? prev : 0, notify: Number.isFinite(prev) ? prev : 0 }
    slot.act = hitAct ? slot.act + 1 : 0
    slot.notify = hitNot ? slot.notify + 1 : 0
    rec.fireRuns[c.name] = slot
    c.fireRun = slot.act
    c.fireRunNotify = slot.notify
  }
  const decision = evaluateChannels({
    perChannel,
    refMinSteps: CONFIG.refMinSteps,
    notifyAlpha: CONFIG.notifyAlpha,
    actAlpha: CONFIG.actAlpha,
    budgetExhausted: Boolean(rec.capabilityBudgetExhausted),
    // 决策路径一律用**有效开关**（含标定件门禁 / 自动降档 / 评测保护）
    rollbackEnabled: effectiveRollback(),
    notifyEnabled: effectiveNotify(),
  })
  rec.channels = perChannel.map((c) => ({
    name: c.name,
    p: roundP(c.p),
    // 注意：短参考/被关闭的通道没有 observed/window/refHits —— 必须落成 null，
    // 不能留 undefined。DSH 的工具输出校验要求无损 JSON，undefined 会让
    // anchor_status 直接报 "value is not lossless JSON"（本轮踩过）。
    observed: c.observed ?? null,
    window: c.window ?? null,
    refLen: c.refLen ?? null,
    refHits: c.refHits ?? null,
    eligible: c.capabilityEligible === true,
    blockedBy: c.blockedBy ?? null,
    // 生效门限（含标定件反解值）必须可见：否则"为什么没动手"无法从审计里回答——
    // 同一形状的偏离在 α=0.01 下动手、在 α=1e-5 下不动手，差别只能从这里看出来。
    actAlpha: Number.isFinite(c.actAlpha) ? c.actAlpha : null,
    notifyAlpha: Number.isFinite(c.notifyAlpha) ? c.notifyAlpha : null,
    consecutive: c.consecutive ?? 1,
    fireRun: c.fireRun ?? 0,
    notifyRun: c.fireRunNotify ?? 0,
    // L3 第二层：该通道本次判定所用的族先验（null = 未收缩，退回固定 Jeffreys）
    prior: c.prior ? { rate: c.prior.rate, strength: c.prior.strength, matched: c.prior.matched } : null,
    // L3 第三层：实际生效的行动级门限（回灌后；null = 资格被撤销或不可用）
    actAlphaEffective: Number.isFinite(c.actAlphaEffective) ? c.actAlphaEffective : null,
    // 该通道的资格是不是**人工试运行**给的（不是标定件给的）——两者必须能分辨
    trialRelease: c.trialRelease === true,
  }))
  rec.lastPolicy = decision.level
  rec.lastPolicyAction = decision.action
  rec.lastPolicyP = decision.p === null || decision.p === undefined ? null : roundP(decision.p)
  rec.lastPolicyReason = decision.reason
  rec.lastPolicyChannel = decision.channel || null
  // 两个"证据不足"档都留痕（A 方案）：
  //   no-observation         —— 连检验窗都没有（会话最开始的 testWindow 步）
  //   insufficient-reference —— 检验窗有了，但参考段还不够长
  // 两档的 level/action 相同（stable/none，不动能力面），差别只在**分档语义**；
  // 但都必须能被日志看见，否则"判定为何没启动"在轨迹里无法回溯。
  if (decision.reason === 'insufficient-reference' || decision.reason === 'no-observation') {
    notePolicySkipped(rec, decision.reason)
  } else {
    rec.lastPolicySkip = null
  }
  if (decision.level === 'stable') {
    // 片段结束 = 证据回到参考内。这才是能力预算的复位点（见 recoverRollback 说明）。
    if (rec.capabilityBudgetExhausted) {
      rec.capabilityBudgetExhausted = false
      logAudit(rec, 'capability-budget-reset', { via: 'episode-ended' })
    }
    if (rec.machineState !== 'stable') {
      rec.episodesEndedNaturally += 1
      recoverRollback(rec, decision.reason)
    }
    return
  }
  if (decision.action === 'narrow') {
    if (rec.machineState !== 'drift') enterDrift(rec, `${decision.reason}:${decision.channel}`, decision.p)
  } else {
    // 偏离存在但不动能力面（弱偏离 / 闸门拦截）：保留状态语义，只写审计
    if (rec.machineState === 'stable') {
      rec.machineState = 'watch'
      logAudit(rec, 'state', { state: 'watch', via: decision.reason, p: rec.lastPolicyP })
    }
    if (decision.action === 'notice' && rec.lastNoticeReason !== decision.reason) {
      rec.lastNoticeReason = decision.reason
      logAudit(rec, 'policy-notice', { reason: decision.reason, p: rec.lastPolicyP, effect: 'no capability change' })
    }
  }
  // P6 不变量：收窄态必须有界——按"**面处于收窄态的步数**"计时，与本步动作无关
  // （否则被闸门降级成 notice 的步数会漏计，实测就出现过 15 步 > maxDriftSteps=12）。
  if (rec.surfacePhase === 'narrowed') {
    rec.narrowedSteps += 1
    rec.driftSteps = rec.narrowedSteps
    // **单调**的"本会话动过手"标记：与 narrowedSteps 分开记，后者会在片段结束时被清零。
    // 实测教训：recordSessionOutcome 原先用 `narrowedSteps > 0` 判断"动过手"，而
    // recoverRollback 会把 narrowedSteps 归零 ⇒ **收窄后又恢复的会话全不被计入**，
    // "最近 N 个会话里动过手的比例"被系统性低估 ⇒ 自动降档更难触发（方向不安全，
    // 而且注释里写的"只记录真的动过的会话"与实现不一致）。
    rec.didNarrow = true
    if (CONFIG.maxDriftSteps > 0 && rec.narrowedSteps >= CONFIG.maxDriftSteps) {
      rec.capabilityBudgetExhausted = true
      logAudit(rec, 'capability-budget-exhausted', {
        steps: rec.narrowedSteps,
        maxDriftSteps: CONFIG.maxDriftSteps,
        note: '本漂移片段内不再收窄；片段结束（回到参考内）后复位',
      })
      recoverRollback(rec, 'capability-budget-exhausted')
    }
  }
}

// ---------- 行为通道台账（B1）----------
// 每步一格，记录该步是否"有工具调用 / 有失败 / 有重复调用"，并在**证据确定后**才定稿：
//   · 出现同回合更大的 step  ⇒ 上一格定稿为"中途停手 = 无工具调用"
//   · turn/end 先到         ⇒ 上一格定稿为"合法收尾"（永不判为停手）
// 历史教训：不分"回合末步"就是 100% 误判——67 个"无工具调用"步实测 100% 是回合收尾。

/** 失败标记表（与 tools/calibrate-lexicon-v2.mjs 的 classifyResult 必须一致，断言 C8 守护）。 */
const FAILURE_MARKERS = [
  /\[exit code:\s*[1-9]\d*\]/,
  /\[sandbox: file access denied/,
  /Traceback \(most recent call last\)/,
  /AssertionError/,
  /\bFAILED\b/,
  /Command failed/,
  // 小写/计数形态（实测必需）：Project2 判定器输出 `[hidden] failed=21 errors=0`，
  // unittest 风格输出 `FAIL: test_xxx`——旧表只认大写的 `FAILED`，对这两类**全是瞎的**。
  /\bfailed\s*[:=]\s*[1-9]\d*/,
  /\berrors?\s*[:=]\s*[1-9]\d*/,
  /^FAIL:/m,
]

/** 工具结果文本（DSH 会话日志形态：data.message.content[] → tool-result 文本块）。 */
function toolResultText(event) {
  try {
    const blocks = event && event.data && event.data.message && event.data.message.content
    if (!Array.isArray(blocks)) return ''
    const parts = []
    for (const b of blocks) {
      if (b && b.type === 'tool-result' && Array.isArray(b.content)) {
        for (const c of b.content) if (c && c.type === 'text' && typeof c.text === 'string') parts.push(c.text)
      }
    }
    return parts.join('\n')
  } catch (e) {
    return ''
  }
}

/** 参数归一化：空白折叠 + 路径分隔符统一（宁可漏检，不做语义等价）。 */
function normalizeArgs(args) {
  const s = typeof args === 'string' ? args : JSON.stringify(args ?? '')
  return s.replace(/\s+/g, ' ').replace(/\\/g, '/').trim().slice(0, 300)
}

function ledgerCell(rec, turn, step) {
  if (typeof turn !== 'number' || typeof step !== 'number') return null
  let cell = rec.ledger.find((c) => c.turn === turn && c.step === step)
  if (!cell) {
    cell = { turn, step, tools: 0, failures: 0, repeated: false, finalized: false, midTurnInaction: null }
    rec.ledger.push(cell)
    if (rec.ledger.length > CONFIG.historyCap) rec.ledger.shift()
  }
  return cell
}

function ledgerNoteToolCall(rec, turn, step, name, args) {
  const cell = ledgerCell(rec, turn, step)
  if (!cell) return
  cell.tools += 1
  if (typeof name !== 'string' || name.length === 0) return
  const sig = `${name}\u0000${normalizeArgs(args)}`
  rec.recentCalls.push({ sig, turn, step })
  if (rec.recentCalls.length > 40) rec.recentCalls.shift()
  const window = (CONFIG.responseChannels.repetition && CONFIG.responseChannels.repetition.window) || 5
  const minRepeats = (CONFIG.responseChannels.repetition && CONFIG.responseChannels.repetition.minRepeats) || 2
  const distinct = []
  let hits = 0
  for (let i = rec.recentCalls.length - 1; i >= 0; i--) {
    const c = rec.recentCalls[i]
    if (c.turn === turn && c.step === step && c.sig === sig && distinct.length > 0) { hits += 1; continue }
    const key = `${c.turn}#${c.step}`
    if (!distinct.includes(key)) {
      if (distinct.length >= window) break
      distinct.push(key)
    }
    if (c.sig === sig) hits += 1
  }
  if (hits >= minRepeats) cell.repeated = true
}

function ledgerNoteToolResult(rec, turn, step, text) {
  const cell = ledgerCell(rec, turn, step)
  if (!cell || typeof text !== 'string' || text.length === 0) return
  if (FAILURE_MARKERS.some((re) => re.test(text))) cell.failures += 1
}

function ledgerFinalize(rec, cell, midTurnInaction) {
  if (!cell || cell.finalized) return
  cell.finalized = true
  cell.midTurnInaction = midTurnInaction
}

/** 新步到来：把同回合、更早且未定稿的格定稿（它们后面还有步 ⇒ 不是回合末步）。 */
function ledgerAdvanceStep(rec, turn, step) {
  if (typeof turn !== 'number' || typeof step !== 'number') return
  for (const c of rec.ledger) {
    if (c.finalized) continue
    if (c.turn === turn && c.step < step) ledgerFinalize(rec, c, c.tools === 0)
    else if (c.turn < turn) ledgerFinalize(rec, c, false)   // 跨回合的旧格：按合法收尾处理
  }
}

/** 回合结束：该回合最后一格定稿为"合法收尾"（永不判为中途停手）。 */
function ledgerCloseTurn(rec, turn) {
  if (typeof turn !== 'number') return
  for (const c of rec.ledger) {
    if (!c.finalized && c.turn === turn) ledgerFinalize(rec, c, false)
  }
}

/**
 * 批量重建台账与通道序列（**导出**，供 tools/ 的离线标定共用；纯函数，无副作用）。
 *
 * 为什么必须共用而不是各写一份（实测教训，2026-10 修）：
 *   tools/behaviour-channel-core.mjs 曾自己写了一套 `done` 规则
 *       done = step < maxStepOfTurn(turn) || turnsWithEnd.has(turn)
 *   它与运行时的定稿规则**不一致**：所在回合有 turn/end 时，它把**末步**也收进序列，
 *   而"末步无工具调用"正是**合法收尾**（运行时定稿为 false）。后果：同一批 128 个会话
 *   里 123 个序列不同，A′ 命中率 0.16%（运行时）对 8.10%（离线）——**差 51 倍**；
 *   于是 B2 反解出来的 α 是给一条**运行时不存在**的通道算的，
 *   而 G3"反向对照"（26.0%）与"真通道"（27.3%）几乎相同，本该早就暴露这一点。
 * 现在：运行时的实时路径与这里的批量路径用同一套规则，并由 tools/test-ledger-parity.mjs
 * 拿真实会话逐步入对拍（把解码后的真实事件喂进 apply()，逐步比对通道快照）。
 *
 * @param {Array<object>} events 会话事件（session.jsonl 解码后的对象数组）
 * @param {{repetitionWindow?:number, minRepeats?:number, trace?:boolean, testWindow?:number}} [opts]
 *   `trace: true` 时额外返回每一步事件的通道快照（O(n)，供逐步对拍与离线标注使用）：
 *   `trace[i] = { len, refLen, window, win:{inaction,repetition,failure}, ref:{...} }`
 * @returns {{cells:Array, allCells:Array, series:object, trace?:Array}}
 */
export function buildLedgerFromEvents(events, opts = {}) {
  const repetitionWindow = opts.repetitionWindow ?? 5
  const minRepeats = opts.minRepeats ?? 2
  const traceOn = opts.trace === true
  const traceWindow = opts.testWindow ?? 3
  const cells = new Map()
  const recentCalls = []
  const turnsWithEnd = new Set()
  const order = []
  const list = Array.isArray(events) ? events : Array.from(events || [])

  // ── 逐步轨迹（可选）：定稿顺序上的序列 + 前缀和。
  // 为什么需要：对拍若对每个事件前缀重算整段台账就是 O(n²)（实测在长会话上直接超时）。
  // 这里在**同一个实现内部**维护 O(1) 可读的快照，语义与最终 series 完全相同。
  const seriesNames = traceOn ? ['inaction', 'repetition', 'failure'] : []
  const vals = traceOn ? { inaction: [], repetition: [], failure: [] } : null
  const totals = traceOn ? { inaction: 0, repetition: 0, failure: 0 } : null
  const trace = traceOn ? [] : null
  const valueOf = (c, name) => (name === 'inaction' ? (c.midTurnInaction === true ? 1 : 0)
    : name === 'repetition' ? (c.repeated ? 1 : 0) : (c.failures > 0 ? 1 : 0))
  const snapshot = () => {
    const len = vals.inaction.length
    const refLen = len - traceWindow
    const win = {}
    const ref = {}
    for (const nm of seriesNames) {
      let w = 0
      for (let i = Math.max(0, len - traceWindow); i < len; i++) w += vals[nm][i]
      win[nm] = w
      ref[nm] = totals[nm] - w
    }
    return { len, refLen, window: traceWindow, win, ref }
  }
  /** 已定稿格的序列值变化时同步前缀和（乱序事件可能晚到）。 */
  const refresh = (c) => {
    if (!traceOn || c.seriesIdx === undefined) return
    for (const nm of seriesNames) {
      const v = valueOf(c, nm)
      const old = vals[nm][c.seriesIdx]
      if (old !== v) {
        vals[nm][c.seriesIdx] = v
        totals[nm] += v - old
      }
    }
  }
  const cellFor = (turn, step) => {
    if (typeof turn !== 'number' || typeof step !== 'number') return null
    const key = `${turn}#${step}`
    let c = cells.get(key)
    if (!c) {
      c = { turn, step, tools: 0, failures: 0, repeated: false, finalized: false, midTurnInaction: null }
      cells.set(key, c)
      order.push(key)
    }
    return c
  }
  const finalize = (c, midTurnInaction) => {
    if (!c || c.finalized) return
    c.finalized = true
    c.midTurnInaction = midTurnInaction
    if (traceOn) {
      c.seriesIdx = vals.inaction.length
      for (const nm of seriesNames) {
        const v = valueOf(c, nm)
        vals[nm].push(v)
        totals[nm] += v
      }
    }
  }
  const advanceStep = (turn, step) => {
    for (const c of cells.values()) {
      if (c.finalized) continue
      if (c.turn === turn && c.step < step) finalize(c, c.tools === 0)
      else if (c.turn < turn) finalize(c, false)
    }
  }
  const closeTurn = (turn) => {
    for (const c of cells.values()) if (!c.finalized && c.turn === turn) finalize(c, false)
  }
  const processEvent = (ev) => {
    if (!ev || typeof ev.type !== 'string') return
    const d = ev.data || {}
    const turn = typeof d.turn === 'number' ? d.turn : null
    const step = typeof d.step === 'number' ? d.step : null
    if (ev.type === 'turn/end') {
      if (turn !== null) { turnsWithEnd.add(turn); closeTurn(turn) }
      return
    }
    if (ev.type === 'tool/call') {
      if (turn === null || step === null) return
      // 注意：与运行时**逐字一致**——tool/call 只记账，**不推进步**。
      // （运行时只在 assistant/message 分支调用 ledgerAdvanceStep；这里若多推一次，
      //   定稿时机会提前，序列就会与在线判定不同——这正是本函数要消灭的那类漂移。）
      const c = cellFor(turn, step)
      if (!c) return
      c.tools += 1
      const nm = typeof d.name === 'string' ? d.name : ''
      if (!nm) { refresh(c); return }
      const sig = `${nm}\u0000${normalizeArgs(d.arguments)}`
      recentCalls.push({ sig, turn, step })
      if (recentCalls.length > 40) recentCalls.shift()
      const distinct = []
      let hits = 0
      for (let i = recentCalls.length - 1; i >= 0; i--) {
        const rc = recentCalls[i]
        if (rc.turn === turn && rc.step === step && rc.sig === sig && distinct.length > 0) { hits += 1; continue }
        const k = `${rc.turn}#${rc.step}`
        if (!distinct.includes(k)) { if (distinct.length >= repetitionWindow) break; distinct.push(k) }
        if (rc.sig === sig) hits += 1
      }
      if (hits >= minRepeats) c.repeated = true
      refresh(c)
      return
    }
    if (ev.type === 'assistant/message') {
      if (turn === null || step === null) return
      // 与运行时同序：先为本步建格，再推进（新步出现 ⇒ 上一步"无工具调用"是中途停手）。
      cellFor(turn, step)
      advanceStep(turn, step)
      return
    }
    if (ev.type === 'tool/result') {
      if (turn === null || step === null) return
      const c = cellFor(turn, step)
      if (!c) return
      const text = toolResultText(ev)
      if (text && FAILURE_MARKERS.some((re) => re.test(text))) c.failures += 1
      refresh(c)
    }
  }
  // trace[i] = 处理完 list[i] 之后的通道快照 ⇒ 下标与输入事件一一对应，
  // 对拍时可直接用同一个事件下标比对（运行时只在 assistant/message 时重算，
  // 因此只在这些下标上比对，但 trace 每步都记，避免两套下标换算再引入漂移）。
  for (let i = 0; i < list.length; i++) {
    processEvent(list[i])
    if (traceOn) trace.push(snapshot())
  }
  const done = order.map((k) => cells.get(k)).filter((c) => c.finalized)
  return {
    cells: done,
    // 全部格（含未定稿）：供对拍用——运行时的 rec.ledger 同时含未定稿格，
    // 只比"已定稿"会漏掉"该定稿却没定稿"的差异。
    allCells: order.map((k) => cells.get(k)),
    series: {
      inaction: done.map((c) => (c.midTurnInaction === true ? 1 : 0)),
      repetition: done.map((c) => (c.repeated ? 1 : 0)),
      failure: done.map((c) => (c.failures > 0 ? 1 : 0)),
      steps: done.map((c) => ({ turn: c.turn, step: c.step, tools: c.tools, failures: c.failures, repeated: c.repeated, midTurnInaction: c.midTurnInaction === true })),
    },
    ...(traceOn ? { trace } : {}),
  }
}

/** 通道序列：只取已定稿的格（未定稿的步不参与判定）。 */
function channelSeries(rec) {
  const done = rec.ledger.filter((c) => c.finalized)
  return {
    inaction: done.map((c) => (c.midTurnInaction === true ? 1 : 0)),
    repetition: done.map((c) => (c.repeated ? 1 : 0)),
    failure: done.map((c) => (c.failures > 0 ? 1 : 0)),
  }
}

/** 单通道的二值检验输入。`prior`（可选）是 L3 的族先验，用不上就退回 Jeffreys。 */
function channelTest(name, series, prior = null) {
  const cfg = (CONFIG.responseChannels && CONFIG.responseChannels[name]) || {}
  const base = {
    name,
    refMinSteps: cfg.refMinSteps || CONFIG.refMinSteps,
    actAlpha: Number.isFinite(cfg.actAlpha) ? cfg.actAlpha : CONFIG.actAlpha,
    notifyAlpha: Number.isFinite(cfg.notifyAlpha) ? cfg.notifyAlpha : CONFIG.notifyAlpha,
    consecutive: Math.max(1, cfg.consecutive ?? 1),
    prior: prior ? { rate: prior.rate, strength: prior.strength, matched: prior.matched } : null,
  }
  if (cfg.enabled === false) return { ...base, p: null, refLen: 0, capabilityEligible: false, blockedBy: 'channel-disabled' }
  const m = cfg.testWindow || CONFIG.testWindow
  const refLen = series.length - m
  if (refLen < 1) {
    return { ...base, p: null, refLen, capabilityEligible: cfg.capabilityEligible === true }
  }
  const test = series.slice(series.length - m)
  const reference = series.slice(0, series.length - m)
  const observed = test.reduce((a, b) => a + b, 0)
  const refHits = reference.reduce((a, b) => a + b, 0)
  const p = binomialLowerP(observed, m, refHits, reference.length, prior ? { rate: prior.rate, strength: prior.strength } : 0.5)
  return {
    ...base,
    p,
    refLen: reference.length,
    capabilityEligible: cfg.capabilityEligible === true,
    observed,
    window: m,
    refHits,
  }
}

/** 全部通道的检验输入（词表通道沿用曼-惠特尼，行为通道用二项）。 */
function channelTests(rec) {
  const out = []
  const lexCfg = (CONFIG.responseChannels && CONFIG.responseChannels.lexicon) || {}
  if (lexCfg.enabled !== false) {
    const hist = rec.ratioHistory
    const m = lexCfg.testWindow || CONFIG.testWindow
    const refLen = hist.length - m
    let p = null
    if (refLen >= 1) p = mannWhitneyLowerP(hist.slice(hist.length - m), hist.slice(0, hist.length - m))
    out.push({
      name: 'lexicon',
      p,
      refLen,
      refMinSteps: lexCfg.refMinSteps || CONFIG.refMinSteps,
      actAlpha: Number.isFinite(lexCfg.actAlpha) ? lexCfg.actAlpha : CONFIG.actAlpha,
      notifyAlpha: Number.isFinite(lexCfg.notifyAlpha) ? lexCfg.notifyAlpha : CONFIG.notifyAlpha,
      consecutive: Math.max(1, lexCfg.consecutive ?? 1),
      // 词典退化 → 该通道失去能力层资格（不是全局闸门：行为通道不受影响）
      capabilityEligible: lexCfg.capabilityEligible === true && !rec.lexiconDegenerate,
      blockedBy: rec.lexiconDegenerate ? 'lexicon-degenerate' : undefined,
    })
  }
  const series = channelSeries(rec)
  for (const name of ['inaction', 'repetition', 'failure']) out.push(channelTest(name, series[name] || [], priorForFamily(rec, name)))
  // 人工试运行放行（**唯一**入口，且默认不存在）：把名单里的通道的资格与工作点显式抬起来。
  // 三条纪律：
  //   · 试运行**只**绕"标定件给不给资格"，不绕数据质量（lexicon-degenerate 依然挡住该通道）；
  //   · 动手**不是静默的**——这里留一次 trial-release-armed 审计，status 里也能看到 α 与到期时间；
  //   · 放行了却没生效也**不是静默的**（trial-release-unavailable，见下）。
  const trial = trialReleaseActive()
  if (trial) {
    const granted = []
    for (const c of out) {
      if (!trial.channels.includes(c.name)) continue
      if (c.blockedBy === 'lexicon-degenerate') continue
      c.capabilityEligible = true
      c.actAlpha = trial.alpha          // 试运行的工作点（显式给的，不沿用任何默认）
      c.trialRelease = true
      granted.push(c.name)
    }
    if (granted.length > 0 && rec.trialReleaseArmed !== granted.join('+')) {
      rec.trialReleaseArmed = granted.join('+')
      logAudit(rec, 'trial-release-armed', {
        channels: granted, alpha: trial.alpha, until: trial.until, note: trial.note,
        why: '标定件未授权，按人工放行进入试运行（会写 didNarrow，供 L3.3 结局回灌积累样本）',
      })
    }
    // 第三条纪律：**放行了却没生效必须可见**。
    // 试运行是 L3.3 攒样本的唯一入口，而它只作用于"已经产出的通道行"——名单里写了一条
    // 出厂关闭的通道（如 lexicon）、写错名字、或该通道正被 lexicon-degenerate 挡着时，
    // 放行会**静静地什么都不做**：操作者以为试运行在跑，实际样本永远是 0。
    // 这正是"失败不得静默"这一条在治理配置上的落点（此前只能靠人对着 status 猜）。
    const notGranted = trial.channels
      .filter((n) => !granted.includes(n))
      .map((n) => {
        if (!CONFIG.responseChannels || !CONFIG.responseChannels[n]) return `${n}:unknown-channel`
        const row = out.find((c) => c.name === n)
        return row ? `${n}:${row.blockedBy || 'not-granted'}` : `${n}:channel-disabled`
      })
    if (notGranted.length > 0) {
      const sig = notGranted.join('+')
      if (rec.trialReleaseUnavailable !== sig) {
        rec.trialReleaseUnavailable = sig
        logAudit(rec, 'trial-release-unavailable', {
          channels: notGranted, configured: trial.channels.slice(), available: out.map((c) => c.name),
          why: '试运行名单里这些通道没有生效：既不会动手，也不会为 L3.3 积累任何样本',
        })
        noteConfigWarning(`trialRelease 放行的通道没有生效（不会积累样本）：${sig}`)
      }
    }
  }
  return out
}


// ---------- anchoring / lifting / gate / suppression ----------

function probeFor(agent) {
  try {
    const agentCtx = agent && agent.ctx
    const scopedTools = agentCtx && agentCtx.tools
    if (!scopedTools || typeof scopedTools.schemas !== 'function') return { error: 'agent.ctx.tools unavailable' }
    const names = []
    const schemas = scopedTools.schemas(agent)
    for (const s of schemas) {
      if (s && typeof s.name === 'string') names.push(s.name)
    }
    return { visible: names }
  } catch (e) {
    return { error: msg(e) }
  }
}

function suppressBootstrapContext(rec, agent) {
  if (!CONFIG.suppressContextOnBootstrap) return
  try {
    const agentCtx = agent && agent.ctx
    const scopedPrompt = agentCtx && typeof agentCtx.get === 'function' ? agentCtx.get('systemPrompt') : undefined
    if (!scopedPrompt || typeof scopedPrompt.section !== 'function' || typeof scopedPrompt.suppressRuntimeContext !== 'function') {
      rec.contextSuppressError = 'agent.ctx.get(systemPrompt) unavailable'
      logAudit(rec, 'context-suppress-failed', { error: rec.contextSuppressError })
      return
    }
    rec.personaDispose = scopedPrompt.section({
      name: 'persona',
      order: 0,
      text: CONFIG.bootstrapPersona,
      complete: true,
    })
    rec.runtimeContextDispose = scopedPrompt.suppressRuntimeContext()
    rec.contextSuppressed = true
    rec.contextSuppressedAt = Date.now()
    logAudit(rec, 'context-suppressed', { persona: CONFIG.bootstrapPersona })
  } catch (e) {
    rec.contextSuppressError = msg(e)
    logAudit(rec, 'context-suppress-failed', { error: rec.contextSuppressError })
  }
}

function restoreBootstrapContext(rec) {
  if (!rec.contextSuppressed) return
  let ok = true
  if (typeof rec.personaDispose === 'function') {
    try {
      rec.personaDispose()
      rec.personaDispose = null
    } catch (e) {
      ok = false
      logAudit(rec, 'context-restore-error', { error: msg(e) })
    }
  }
  if (typeof rec.runtimeContextDispose === 'function') {
    try {
      rec.runtimeContextDispose()
      rec.runtimeContextDispose = null
    } catch (e) {
      ok = false
      logAudit(rec, 'context-restore-error', { error: msg(e) })
    }
  }
  // ⚠ 只有**真的都还原成功**才把状态写成"未抑制"。旧写法无论成败都置 false ⇒
  // disposer 抛错时状态会**说谎**（对外显示"未抑制"，实际 persona 仍被替换、runtime
  // context 仍被摘掉），而下一行的早退 `if (!rec.contextSuppressed) return` 又让重试
  // 直接失效 ⇒ 永久卡在"看不到的降级"里（正是本项目最重那次事故的形态）。
  // 现在：失败则保持 true（状态说实话）、错误暴露到状态里、并保留重试机会。
  if (ok) {
    rec.contextSuppressed = false
    rec.contextRestoreError = null
  } else {
    rec.contextRestoreError = rec.contextRestoreError || 'restore-failed'
  }
  logAudit(rec, 'context-restored', { ok, stillSuppressed: rec.contextSuppressed === true })
}

function anchorAgent(agent, rec, channel) {
  // 四条降级路径全部朝"暴露全量"倒：不施加任何限制，模型看到完整工具面。
  // 每次降级都写 anchor-degraded 审计 + 一次性响亮告警，避免"以为锚定生效了"。
  const degrade = (reason) => {
    rec.anchorDegraded = true
    rec.anchorError = reason
    logAudit(rec, 'anchor-degraded', { reason, fullCatalogExposed: true, channel })
    warnOnce(`bootstrap disabled, full catalog exposed: ${reason}`)
  }
  const probe = probeFor(agent)
  if (probe.error) {
    degrade(probe.error)
    return
  }
  const candidates = CONFIG.bootstrapTools.filter(n => probe.visible.includes(n))
  if (candidates.length === 0) {
    degrade(`no bootstrap tool visible to agent (visible ${probe.visible.length})`)
    return
  }
  const scopedTools = agent.ctx && agent.ctx.tools
  if (!scopedTools || typeof scopedTools.restrict !== 'function') {
    degrade('agent.ctx.tools.restrict unavailable')
    return
  }
  const outcome = restrictWithCull(scopedTools, { allow: candidates })
  if (outcome.error) {
    degrade(outcome.error)
    return
  }
  rec.restrictLift = outcome.lift
  rec.anchored = true
  rec.anchorChannel = channel
  rec.anchorAllow = outcome.applied.slice()
  const capNote = CONFIG.bootstrapMaxTokens === null || CONFIG.bootstrapMaxTokens === undefined
    ? 'no cap (opt-in per issue #85)'
    : CONFIG.bootstrapMaxTokens
  logAudit(rec, 'anchored', { allow: outcome.applied.slice(), maxTokens: capNote, channel })
  suppressBootstrapContext(rec, agent)
}

function lift(rec, reason) {
  if (rec.lifted || rec.closed) return
  rec.lifted = true
  rec.liftReason = reason
  rec.liftedAt = Date.now()
  if (typeof rec.restrictLift === 'function') {
    try {
      rec.restrictLift()
      rec.restrictLift = null
    } catch (e) {
      rec.liftError = msg(e)
      logAudit(rec, 'lift-error', { error: rec.liftError })
    }
  }
  restoreBootstrapContext(rec)
  logAudit(rec, 'lift', { reason, requests: rec.requests, toolCalls: rec.toolCalls, band: rec.band })
}

// ---------- Layer 4: reward annotation ----------

const REWARD_ANNOTATORS = {}

function defaultRewardAnnotator(rec) {
  let planning = 0
  let shallow = 0
  for (const entry of rec.events) {
    if (entry.kind === 'assistant-message') {
      if ((entry.blocks || 0) > 0) planning += 1
      else shallow += 1
    }
  }
  const score = planning * 1 + shallow * -1 + rec.toolCalls * 0.5
  return {
    planner: 'default-rules',
    planningMessages: planning,
    shallowMessages: shallow,
    toolCalls: rec.toolCalls,
    score: round2(score),
  }
}
REWARD_ANNOTATORS.default = defaultRewardAnnotator

function annotateReward(rec) {
  const annotator = REWARD_ANNOTATORS[CONFIG.rewardAnnotator] || REWARD_ANNOTATORS.default
  try {
    rec.reward = annotator(rec)
    logAudit(rec, 'reward', rec.reward)
  } catch (e) {
    rec.reward = { planner: CONFIG.rewardAnnotator, error: msg(e) }
    logAudit(rec, 'reward-error', { error: msg(e) })
  }
}

/**
 * 在线自动降档（B3）：会话结束时记录"本会话是否收窄过"，并在最近
 * autoDemoteWindow 个会话里计算实际比例；超过 autoDemoteBudget 即降档。
 *
 * 为什么需要：离线标定合格 ≠ 线上合格（语料会漂、模型会换、任务族会变）。
 * 这条让插件**自己发现自己超标**，而不是等人去看日志。
 * 只记录"真的动过"的会话（单调标记 rec.didNarrow），不收窄的会话算分母。
 *
 * ⚠ 状态分两类（这一条是本轮修正的设计缺口）：
 *   · **派生状态**（CONFIG / policyArtifact / familyPriors / reanchorEvidence）——每次挂载重算，
 *     必须清空（否则出现"标定件状态跨挂载粘住"，那是修过的事故）；
 *   · **累积状态**（sessionOutcomes / channelFeedback / autoDemote / feedbackEpoch）——这是**记忆**，
 *     清掉就等于"跨天自适应永远从零开始"：每次重启都把"最近 N 个会话"抹平，回灌与降档永远攒不满。
 *   所以累积状态要**按会话落盘、挂载时装载**（见 adaptiveStateFor / loadAdaptiveState）。
 */
function recordSessionOutcome(rec) {
  try {
    if (!(CONFIG.autoDemoteWindow > 0)) return
    sessionOutcomes.push({ narrowed: rec.didNarrow === true })
    while (sessionOutcomes.length > CONFIG.autoDemoteWindow) sessionOutcomes.shift()
    evaluateAutoDemote(rec)
  } catch (e) {
    // 观测侧永不抛
  }
}

/** 按当前窗口重算是否需要降档（挂载时装载历史后也会调它一次）。 */
function evaluateAutoDemote(rec) {
  if (autoDemote) return
  if (sessionOutcomes.length < CONFIG.autoDemoteWindow) return
  const rate = sessionOutcomes.filter((o) => o.narrowed).length / sessionOutcomes.length
  if (rate > CONFIG.autoDemoteBudget) {
    autoDemote = { reason: 'session-rate-over-budget', rate: round2(rate), budget: CONFIG.autoDemoteBudget, window: sessionOutcomes.length, at: Date.now(), restored: rec ? false : true }
    warnOnce(`auto-demoted to observe-only: ${(rate * 100).toFixed(1)}% of the last ${sessionOutcomes.length} sessions narrowed (budget ${(CONFIG.autoDemoteBudget * 100).toFixed(1)}%)`)
    if (rec) logAudit(rec, 'auto-demote', { ...autoDemote, note: '能力层与通知层即刻关闭，只保留审计' })
  }
}

/** 每通道的结局回灌状态（L3 第三层）：只有真的触发过才记账。 */
const channelFeedback = {}
/** 回灌纪元：每结束一个会话 +1（用于"多久没有变化 ⇒ 该探索一次"）。 */
let feedbackEpoch = 0
/** 累积状态的装载摘要（供 anchor_status 说明"这些记忆从哪来"）。 */
let adaptiveState = null

/**
 * 本会话要落盘的那条"记忆"（**单一来源**：降档用它、回灌用它、持久化也用它，
 * 避免三处各算一遍导致口径漂移）。
 * 只记**与自适应有关**的会话（动过手 或 有通道触发过）；默认全关时不会写任何东西。
 */
function sessionOutcomeRecord(rec) {
  const fires = {}
  let totalFires = 0
  for (const [name, n] of Object.entries(rec.channelActFires || {})) {
    if (n > 0) { fires[name] = n; totalFires += n }
  }
  const didNarrow = rec.didNarrow === true
  if (!didNarrow && totalFires === 0) return null
  const endedNarrowed = rec.surfacePhase === 'narrowed' || rec.machineState === 'drift'
  const productive = !endedNarrowed && rec.sawUnknownTool !== true && rec.episodesEndedNaturally > 0
  // 每通道的**当前基准 α**：装载时用它判断"这份倍率是在哪个工作点上学的"，
  // 工作点变了就作废倍率（只保留计数）——否则换标定件后旧倍率会静默生效。
  const baseAlpha = {}
  for (const name of Object.keys(fires)) {
    const cfg = (CONFIG.responseChannels && CONFIG.responseChannels[name]) || {}
    baseAlpha[name] = Number.isFinite(cfg.actAlpha) ? cfg.actAlpha : CONFIG.actAlpha
  }
  return {
    storeVersion: 1,
    at: Date.now(),
    sessionId: rec.sessionId,
    didNarrow,
    fires,
    productive,
    // 学到的倍率/撤销/探索次数（按**本会话触发过的通道**记）：装载时只在与基准 α 匹配时恢复。
    multiplier: Number.isFinite(fbMultiplierOf(fires)) ? fbMultiplierOf(fires) : 1,
    revoked: Object.keys(fires).some((n) => channelFeedback[n] && channelFeedback[n].revoked === true),
    explores: Object.keys(fires).reduce((a, n) => a + ((channelFeedback[n] && channelFeedback[n].explores) || 0), 0),
    family: rec.family ? familyKeyOf(rec).full : null,
    baseAlpha,
    pluginVersion: PLUGIN_VERSION,
  }
}

/** 本会话触发过的通道里，"学到的倍率"取最小值（保守：宁可记更严的那个）。 */
function fbMultiplierOf(fires) {
  const names = Object.keys(fires || {})
  if (names.length === 0) return 1
  return names.reduce((a, n) => Math.min(a, (channelFeedback[n] && channelFeedback[n].multiplier) || 1), 1)
}

/** 累积状态文件路径（默认放在审计目录旁；可用 adaptiveStatePath 显式指定）。 */
function adaptiveStateFile() {
  if (typeof CONFIG.adaptiveStatePath === 'string' && CONFIG.adaptiveStatePath) {
    return isAbsolute(CONFIG.adaptiveStatePath) ? CONFIG.adaptiveStatePath : resolvePath(baseDir || process.cwd(), CONFIG.adaptiveStatePath)
  }
  return resolvePath(baseDir || process.cwd(), '.dsh-trajectory-logs', 'adaptive-state.jsonl')
}

/** 追加一条记忆（fail-safe：写失败只告警，绝不影响会话）。 */
function persistAdaptiveState(record) {
  try {
    if (CONFIG.adaptiveStateEnabled !== true) return
    if (!record) return
    const file = adaptiveStateFile()
    mkdirSync(dirname2(file), { recursive: true })
    appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
  } catch (e) {
    warnOnce(`adaptive state persist failed (ignored): ${msg(e)}`)
  }
}

/**
 * 挂载时装载累积状态（**记忆**；与"派生状态每次重算"互补）。
 *
 * 装载纪律（每条都对应一个真实风险）：
 *   · 失败/坏行/缺文件 ⇒ 空状态 + 响亮告警（fail-safe，绝不阻断挂载）；
 *   · 只取最后 adaptiveStateWindow 条（**有界**，文件再长也不会拖慢挂载）；
 *   · **倍率与撤销只在"基准 α 未变"时恢复**：工作点变了 ⇒ 丢弃倍率（保留计数），
 *     否则换了标定件后上一份倍率会静默生效——那正是"跨挂载粘住"的翻版；
 *   · 装载后**重算一次自动降档**：窗口内若已超标，挂载即降档（而不是等下一个会话）。
 */
function loadAdaptiveState() {
  // **自清空**：装载前先归零，消除对调用顺序的依赖。
  // 实测教训：原先靠调用方清空，结果挂载路径解析前后各装一次 ⇒ 计数翻倍（sessions 10 变 20）。
  // 装载必须是幂等的，这样"多装一次"最多是白做 I/O，不会悄悄把样本数算两遍。
  for (const k of Object.keys(channelFeedback)) delete channelFeedback[k]
  sessionOutcomes.length = 0
  autoDemote = null
  feedbackEpoch = 0
  adaptiveState = { source: null, records: 0, channels: 0, multipliersKept: 0, multipliersDropped: 0, autoDemoteRecomputed: false, error: null }
  if (CONFIG.adaptiveStateEnabled !== true) { adaptiveState.disabled = true; return }
  const file = adaptiveStateFile()
  adaptiveState.source = file
  let text
  try {
    if (!existsSync(file)) return
    text = readFileSync(file, 'utf8')
  } catch (e) {
    adaptiveState.error = msg(e)
    warnOnce(`adaptive state unreadable (${msg(e)}); starting from empty memory`)
    return
  }
  const lines = text.split('\n').filter((l) => l.trim())
  const window = Math.max(1, CONFIG.adaptiveStateWindow)
  const tail = lines.slice(-window)
  const records = []
  let badLines = 0
  for (const line of tail) {
    try {
      const o = JSON.parse(line)
      if (o && typeof o === 'object' && typeof o.didNarrow === 'boolean') records.push(o)
      else badLines += 1
    } catch (e) { badLines += 1 }
  }
  if (badLines > 0) warnOnce(`adaptive state had ${badLines} unreadable line(s) in the last ${tail.length}; ignored`)
  adaptiveState.records = records.length
  adaptiveState.badLines = badLines
  if (records.length === 0) return

  // ① 降档窗口：最近 autoDemoteWindow 个会话的"动过手"
  // ① 降档窗口：最近 autoDemoteWindow 个会话的"动过手"。
  //    关闭降档（window=0）时**不填**——与 recordSessionOutcome 的早退一致，
  //    否则会出现"降档关了却仍有一个 1 条的窗口"这种自相矛盾的状态（实测踩到）。
  if (CONFIG.autoDemoteWindow > 0) {
    for (const r of records.slice(-CONFIG.autoDemoteWindow)) sessionOutcomes.push({ narrowed: r.didNarrow === true })
  }
  // ② 逐通道回灌计数：**只计入"真的干预过"的会话**（与 recordChannelFeedback 同口径）。
  //    载荷侧若把"没干预"的会话算进来，恢复出来的 productive 率必然偏低 ⇒ 一挂载就越收越紧。
  for (const r of records) {
    if (r.didNarrow !== true) continue
    for (const [name, n] of Object.entries(r.fires || {})) {
      const fb = feedbackFor(name)
      fb.sessions += 1
      fb.fires += Number.isFinite(n) ? n : 0
      if (r.productive === true) fb.productive += 1
      fb.lastAt = typeof r.at === 'number' ? r.at : fb.lastAt
      fb.lastRate = round2(fb.productive / fb.sessions)
    }
  }
  adaptiveState.channels = Object.keys(channelFeedback).length
  // ③ 倍率/撤销：只认"基准 α 未变"的那份（取最新一条该通道的记录）
  for (const name of Object.keys(channelFeedback)) {
    let keep = null
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i]
      if (r.fires && r.fires[name] > 0) { keep = r; break }
    }
    const cfg = (CONFIG.responseChannels && CONFIG.responseChannels[name]) || {}
    const currentBase = Number.isFinite(cfg.actAlpha) ? cfg.actAlpha : CONFIG.actAlpha
    const recordedBase = keep && keep.baseAlpha && Number.isFinite(keep.baseAlpha[name]) ? keep.baseAlpha[name] : null
    if (keep && ((keep.multiplier != null && Number.isFinite(keep.multiplier)) || keep.revoked === true)) {
      if (recordedBase !== null && recordedBase === currentBase) {
        const fb = channelFeedback[name]
        if (Number.isFinite(keep.multiplier)) fb.multiplier = keep.multiplier
        if (keep.revoked === true) fb.revoked = true
        if (Number.isFinite(keep.explores)) fb.explores = keep.explores
        adaptiveState.multipliersKept += 1
      } else {
        adaptiveState.multipliersDropped += 1
      }
    }
  }
  if (adaptiveState.multipliersDropped > 0) {
    warnOnce(`adaptive state: dropped ${adaptiveState.multipliersDropped} learned multiplier(s) because the operating point changed (base alpha differs); counts kept`)
  }
  // ④ 纪元 + 装载后立即重算降档
  feedbackEpoch = records.length
  const before = autoDemote
  evaluateAutoDemote(null)
  adaptiveState.autoDemoteRecomputed = Boolean(autoDemote && autoDemote !== before)
  console.log(`[${name}] adaptive state loaded: ${records.length} session records, ${adaptiveState.channels} channel(s), multipliers kept ${adaptiveState.multipliersKept} / dropped ${adaptiveState.multipliersDropped}`)
}
function feedbackFor(name) {
  if (!channelFeedback[name]) {
    channelFeedback[name] = {
      sessions: 0, fires: 0, productive: 0, multiplier: 1, revoked: false,
      lastAt: null, lastRate: null, lastChangeEpoch: 0, explores: 0,
    }
  }
  return channelFeedback[name]
}

/**
 * L3 第三层：**结局回灌**——把"动了之后有没有好结果"回灌到该通道的门限上。
 *
 * 为什么需要（比现在的二值 autoDemote 强在哪）：现在的 autoDemote 是**全局**一刀切
 * （超过预算就把能力层与通知层一起关掉），既粗糙又不可逆——而"哪一条通道在惹事"其实是可以分开算的。
 *
 * 结局代理（可观测、不需要人工标签）：
 *   productive = 会话结束时**没有**停留在收窄态 && 本会话**没有**出现 unknown tool
 *                && 至少有一个收窄片段是自然结束的（不是撞上 maxDriftSteps 才停）
 * 为什么用这三项：`unknown tool` 正是本插件历史上最严重那次事故的可见症状（收窄把工具从注册表里摘掉，
 * 之后的调用就变成 unknown tool），所以它是"越干预越糟"的直接证据；"结束时仍在收窄态"同理。
 *
 * **非对称**（这是安全性的关键）：
 *   · 不产出 ⇒ 收紧（multiplier × 0.5，下限 base/64）——收紧只会让干预更少，永远是安全方向；
 *   · 放宽（× 1.25，上限 1.0 = 标定件给的值）只在样本足够多（minSessions×4）且产出率很高（≥0.8）时；
 *   · 产出率低于 feedbackRevokeEligibilityRate ⇒ **撤销该通道的能力层资格**（比全局降档精确得多）。
 */
function recordChannelFeedback(rec, outcomeRecord = null) {
  try {
    if (CONFIG.outcomeFeedbackEnabled !== true) return
    // 纪元是**时钟**：每个结束的会话都走一格——探索步（长期无变化 ⇒ 回升一档）依赖它。
    // 别把它也限制成"只对干预过的会话"：那样门限一旦收紧到不再触发，时钟就停了，
    // 探索永远不来，单向棘轮又回来（实测：探索用例三条全红）。
    feedbackEpoch += 1
    const per = rec.channelActFires || null
    const names = per ? Object.keys(per).filter((n) => per[n] > 0) : []
    // ① 有触发的通道：**且本会话真的干预过**才记账。
    //   为什么：回灌度量的是"我的干预有没有帮助"；能力层关着时（出厂默认）通道即便触发
    //   也什么都没发生，那些会话的 productive 必然 false ⇒ 会把门限无故一路收紧并撤销通道。
    //   这是"用没有干预的会话去评价干预"的错配（自查发现，不是测试抓的）。
    if (names.length > 0 && rec.didNarrow === true) {
      // productive 优先取**同一条记录**里的判定（单一来源）；没有记录时才现算。
      const productive = outcomeRecord
        ? outcomeRecord.productive === true
        : (!(rec.surfacePhase === 'narrowed' || rec.machineState === 'drift') && rec.sawUnknownTool !== true && rec.episodesEndedNaturally > 0)
      for (const name of names) {
        const fb = feedbackFor(name)
        fb.sessions += 1
        fb.fires += per[name]
        if (productive) fb.productive += 1
        fb.lastAt = Date.now()
        const rate = fb.productive / fb.sessions
        fb.lastRate = round2(rate)
        if (rate < CONFIG.feedbackRevokeEligibilityRate && fb.sessions >= CONFIG.feedbackMinSessions && !fb.revoked) {
          fb.revoked = true
          fb.lastChangeEpoch = feedbackEpoch
          warnOnce(`channel "${name}" lost capability eligibility: productive rate ${(rate * 100).toFixed(1)}% over ${fb.sessions} sessions (floor ${(CONFIG.feedbackRevokeEligibilityRate * 100).toFixed(0)}%)`)
          logAudit(rec, 'feedback-revoke', { channel: name, sessions: fb.sessions, fires: fb.fires, rate: fb.lastRate, floor: CONFIG.feedbackRevokeEligibilityRate })
          continue
        }
        const floor = 1 / Math.max(2, CONFIG.feedbackAlphaFloorDivisor)
        if (rate < CONFIG.feedbackMinProductiveRate && fb.sessions >= CONFIG.feedbackMinSessions && fb.multiplier > floor) {
          const before = fb.multiplier
          fb.multiplier = Math.max(floor, fb.multiplier * 0.5)
          fb.lastChangeEpoch = feedbackEpoch
          logAudit(rec, 'feedback-tighten', { channel: name, sessions: fb.sessions, rate: fb.lastRate, from: before, to: fb.multiplier })
          warnOnce(`channel "${name}" threshold tightened ×${fb.multiplier} (productive ${(rate * 100).toFixed(1)}% < ${(CONFIG.feedbackMinProductiveRate * 100).toFixed(0)}% over ${fb.sessions} sessions)`)
        } else if (rate >= 0.8 && fb.sessions >= CONFIG.feedbackMinSessions * 4 && fb.multiplier < 1) {
          const before = fb.multiplier
          fb.multiplier = Math.min(1, fb.multiplier * 1.25)
          fb.lastChangeEpoch = feedbackEpoch
          logAudit(rec, 'feedback-relax', { channel: name, sessions: fb.sessions, rate: fb.lastRate, from: before, to: fb.multiplier })
        }
      }
    }
    // ② 探索步（**这条是测试逼出来的**）：收紧到"不再触发"之后，证据也就断了——
    // 没有触发就没有结局数据，于是永远无法放宽。那是**单向棘轮**：门限会被锁死在一个
    // 可能过严的点上，而且外面看起来"很安全"（从不触发）。
    // 所以：长期没有任何变化 ⇒ 周期性把门限回升一档（仍受标定值为上限）。
    // 代价是重新引入一些误报，所以周期长（默认 30 个会话）且每次只回升 ×1.25。
    if (CONFIG.feedbackExploreAfterSessions > 0) {
      for (const name of Object.keys(channelFeedback)) {
        const fb = channelFeedback[name]
        if (fb.revoked || fb.multiplier >= 1) continue
        if (feedbackEpoch - fb.lastChangeEpoch < CONFIG.feedbackExploreAfterSessions) continue
        const before = fb.multiplier
        fb.multiplier = Math.min(1, fb.multiplier * 1.25)
        fb.lastChangeEpoch = feedbackEpoch
        fb.explores += 1
        logAudit(rec, 'feedback-explore', { channel: name, from: before, to: fb.multiplier, epoch: feedbackEpoch, note: '长期无变化 ⇒ 回升一档，避免单向棘轮把门限锁死' })
      }
    }
  } catch (e) {
    warnOnce(`channel feedback failed (ignored): ${msg(e)}`)
  }
}

/** 该通道的**有效** actAlpha：标定值 × 回灌倍数（撤销资格时返回 Infinity ⇒ 永不触发）。 */
function effectiveActAlpha(name, base) {
  if (CONFIG.outcomeFeedbackEnabled !== true) return base
  const fb = channelFeedback[name]
  if (!fb) return base
  if (fb.revoked) return Number.POSITIVE_INFINITY
  const v = Number.isFinite(base) ? base * fb.multiplier : base
  return Math.max(v, (Number.isFinite(base) ? base : 0.01) / Math.max(2, CONFIG.feedbackAlphaFloorDivisor))
}

/**
 * L2 重锚定文本：把**首轮 Minimal 载荷**原样带回近因位置，并自报依据。
 *
 * 为什么是"原样带回"（社区依据）：dsh-anchored-monitor 的 L2 是"重置载荷——逐字节对齐官方
 * Minimal 预设"，即不发明新指令，而是把已知有效的首轮载荷重新灌回去。发明新指令会引入
 * 未验证的措辞风险（措辞纪律那一条已经证明措辞本身会改变轨迹）。
 * 同样按 L1 的措辞纪律：陈述事实 + 建议，不用命令式。
 */
export function reanchorText(persona, info, count) {
  const CONFIRM_LABEL = { 'user-correction': '人类指出不对', 'unknown-tool': '调用了不存在的工具', 'verify-failed': '验证命令未通过' }
  const whyConfirm = info && info.confirm ? `（本节确认信号：${CONFIRM_LABEL[info.confirm] || info.confirm}）` : ''
  const why = whyConfirm || (info && info.path ? `（上次提醒针对 ${info.path}）` : '')
  return `[trajectory-anchor] 重锚定${count > 1 ? `（第 ${count} 次）` : ''}：前面的提醒之后轨迹仍未回到任务骨架${why}，`
    + '这里把首轮的工作方式原样带回来：'
    + `\n\n${persona}`
    + '\n\n说明：这是把**已知有效**的首轮载荷重新放回近因位置（不改写系统基线）。'
    + '若你已经在按这个方式工作，忽略本条即可。'
}

/** 助手消息的**文本**（用于"是否宣告完成"判定；reasoning 块不算——计划里说"接下来做完"不是宣告）。 */
function planTextFor(event) {
  const blocks = event && event.data && event.data.message && event.data.message.content
  if (!Array.isArray(blocks)) return ''
  return blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n')
}

/** 助手消息的**文本**（"宣告完成"只看 text 块：reasoning 里说"做完了"不算对外的宣告）。 */

/**
 * 记一个**确认信号**（不是预测，是"当场能确证出问题了"）。三类：
 *   · `user-correction` —— 人类消息里出现纠偏线索（共用 `CORRECTION_CUES` 那一份判据）
 *   · `unknown-tool`    —— 工具面/计划不匹配的确认症状（本插件最重那次事故的可见形态）
 *   · `verify-failed`   —— 刚跑过的验证命令输出里仍有失败标记
 * 只保留**最近一个未被消费**的确认；一旦被"确认即恢复"消费就标 handled（每会话至多一次动作）。
 */
function noteConfirmation(rec, reason, turn, step, detail) {
  if (rec.confirm && rec.confirm.handled === true) return false
  rec.confirm = { reason, turn: turn ?? null, step: step ?? null, at: Date.now(), detail: detail ?? null, handled: false }
  logAudit(rec, 'confirm-signal', { reason, turn, step, detail: detail ?? null })
  return true
}

/** L2'（确认即恢复）是否被允许：**先判两道硬闸门**，再看装配开关。
 *  顺序与 trialRelease 一致（都由 C27 的"次序断言"守着）：硬闸门必须排在开关之前，
 *  否则将来一次改动就可能让开关绕过硬闸门。 */
function confirmReanchorAllowed(rec) {
  if (CONFIG.measurementSafe === true) return false
  if (autoDemote) return false
  if (CONFIG.reanchorOnConfirm !== true) return false
  return true
}

/**
 * L2 重锚定决策：**两条路径，判据不同**（混在一起会让人以为门被放宽了）。
 *   ① 证据路径（原样）：`reanchorEnabled` ∧ 在线效果件 PASS-online ∧ L1 已说过 ∧ 有新证据
 *      —— 回答"拉回**有没有用**"；
 *   ② 确认路径（L2'）：`reanchorOnConfirm` ∧ **当场确认过**（user-correction / unknown-tool /
 *      verify-failed）—— 回答"**已经确认出问题了**，把已知有效的首轮载荷放回去"。
 * 两条都保持：每会话一次、measurementSafe/autoDemote 优先、全程留痕。
 */
function reanchorDecision(rec, turn) {
  if (effectiveReanchor()) {
    if (rec.reanchor.count > 0) { rec.reanchor.suppressed.alreadyDone += 1; return null }
    if (rec.pullback.count === 0) { rec.reanchor.suppressed.noPriorPullback += 1; return null }
    if (rec.reanchor.lastPullbackCount === rec.pullback.count) { rec.reanchor.suppressed.noNewEvidence += 1; return null }
    return { info: rec.pullback.lastInfo || null, reason: 'reanchor', via: 'evidence' }
  }
  if (confirmReanchorAllowed(rec)) {
    if (rec.reanchor.count > 0) { rec.reanchor.suppressed.alreadyDone += 1; return null }
    if (!rec.confirm || rec.confirm.handled === true) { rec.reanchor.suppressed.noConfirmation = (rec.reanchor.suppressed.noConfirmation || 0) + 1; return null }
    return { info: { confirm: rec.confirm.reason }, reason: `confirm-${rec.confirm.reason}`, via: 'confirm' }
  }
  return null
}

/**
 * L1/L4 效果采集（L2 门的唯一数据来源）：**每次触发一行**，两条臂同一口径。
 *
 * 采集的是可直接观测的行为指标（不需要人工标签）：
 *   · verifiesAfterPullback  —— 该触发点之后到会话结束之间跑了几次验证
 *   · scopeViolationsAfter   —— 该触发点之后是否仍有越界写
 *   · claimedUnverifiedAfter —— 会话结束时是否仍处于"改完没验证"状态
 *
 * 两条纪律，都是被真实数据打出来的：
 *   ① **对称**：窗口计数与"说不说"无关。对照臂若不计窗口，它恒为"未改善"，
 *      于是比较变成"有窗口 vs 没窗口"——那是**测量口径**造出来的假阳性。
 *   ② **按触发点一行**：会话级一行会把同会话的多次触发与两条臂揉在一起。
 * 终态字段（claimedUnverifiedAfter / endedNarrowed / sawUnknownTool / finalState）是
 * **会话级**事实，同会话各行共用，行里以 sessionLevelFields 显式标注，
 * 免得被下游当成逐触发点指标。
 */
function markObs(rec, kind, turn, step) {
  const n = (rec.pullback.obsN = (rec.pullback.obsN || 0) + 1)
  const list = kind === 'verify' ? rec.pullback.verifyMarks : rec.pullback.violationMarks
  list.push({ n, turn: turn ?? null, step: step ?? null })
  if (list.length > 200) list.shift()
  return n
}

/** 记一次触发（两条臂走同一条记录路径——口径对称是靠"共用代码"保证的，不是靠自觉）。
 *  `rate` 记下**这次触发时生效的控制率**：它是这条单元的**随机化分层标识**。
 *  为什么要记：控制率中途调整**不产生偏差**（臂是在触发点上随机分配的，意向性比较依然有效），
 *  但会产生"时段效应"——所以分析器要能按比例分层复核，而不是把不同比例的单元混在一起说不清。
 *  `action` 区分**哪一种动作**：`pullback`（L1 信息型提醒）与 `reanchor`（L2' 确认即恢复）。
 *  两者风险类别不同、门也不同，混在一起算会把两种效果糊成一种。 */
function markTrigger(rec, arm, reason, turn, step, action = 'pullback') {
  const n = (rec.pullback.obsN = (rec.pullback.obsN || 0) + 1)
  const t = {
    arm, n, turn: turn ?? null, step: step ?? null, at: Date.now(), reason: reason ?? null,
    action: action === 'reanchor' ? 'reanchor' : 'pullback',
    rate: Number.isFinite(CONFIG.pullbackControlRate) ? CONFIG.pullbackControlRate : null,
  }
  rec.pullback.triggers.push(t)
  if (rec.pullback.triggers.length > 50) rec.pullback.triggers.shift()
  return t
}

/** 某次触发之后的观测窗口（**唯一口径**：落盘行、状态、离线分析都从这里来）。 */
function windowAfter(rec, trig) {  return {
    verifiesAfterPullback: rec.pullback.verifyMarks.filter((m) => m.n > trig.n).length,
    scopeViolationsAfter: rec.pullback.violationMarks.filter((m) => m.n > trig.n).length,
  }
}

const SESSION_LEVEL_FIELDS = ['claimedUnverifiedAfter', 'endedNarrowed', 'sawUnknownTool', 'finalState']

function recordPullbackOutcome(rec) {
  try {
    // 落盘的判据是"**有没有信息型执行器在工作**"，而不是"L1 开没开"：
    // 只开 L2'（确认即恢复）时，它的效果同样必须被记下来——否则那条路径的效果**永远测不出来**
    // （"打开了但没人量"是本项目反复出现的形态：可测性必须跟着执行器走）。
    if (CONFIG.pullbackEnabled !== true && CONFIG.reanchorOnConfirm !== true) return
    const triggers = rec.pullback.triggers || []
    // 没有触发点就没有观测窗口——**不再**用"会话里说过话"当兜底（那正是把两条臂
    // 揉成一条的旧口径）。
    if (triggers.length === 0) return
    const claimedUnverifiedAtClose = rec.codeEditsAfterVerify.length > 0 && rec.lastVerifyAt !== null
    const endedNarrowed = rec.surfacePhase === 'narrowed' || rec.machineState === 'drift'
    const dir = CONFIG.pullbackOutcomePath
      ? (isAbsolute(CONFIG.pullbackOutcomePath) ? CONFIG.pullbackOutcomePath : resolvePath(baseDir || process.cwd(), CONFIG.pullbackOutcomePath))
      : resolvePath(baseDir || process.cwd(), '.dsh-trajectory-logs', 'pullback-outcomes.jsonl')
    mkdirSync(dirname2(dir), { recursive: true })
    const rows = []
    for (let i = 0; i < triggers.length; i++) {
      const t = triggers[i]
      const row = {
        schemaVersion: 2,
        at: Date.now(),
        sessionId: rec.sessionId,
        arm: t.arm,                                  // intervened | control（每行一臂，不再合并）
        intervened: t.arm === 'intervened',
        triggerIndex: i + 1,
        triggersInSession: triggers.length,
        triggerTurn: t.turn,
        triggerStep: t.step,
        // 哪一种动作：pullback（L1 信息型提醒）| reanchor（L2' 确认即恢复）
        action: t.action || 'pullback',
        // 随机化分层标识：这条单元是在多大的控制率下分配的（分析器按它做分层复核）
        controlRate: Number.isFinite(t.rate) ? t.rate : null,
        reason: t.reason,
        pullbacks: rec.pullback.count,               // 会话累计，仅作背景
        controls: rec.pullback.controls,             // 会话累计，仅作背景
        ...windowAfter(rec, t),
        claimedUnverifiedAfter: claimedUnverifiedAtClose,
        family: rec.family ? familyKeyOf(rec).full : null,
        endedNarrowed,
        sawUnknownTool: rec.sawUnknownTool === true,
        finalState: { machineState: rec.machineState, surfacePhase: rec.surfacePhase, anchored: rec.anchored, lifted: rec.lifted },
        sessionLevelFields: SESSION_LEVEL_FIELDS,
      }
      rows.push(row)
      appendFileSync(dir, `${JSON.stringify(row)}\n`, 'utf8')
      logAudit(rec, 'pullback-outcome', row)
    }
    rec.pullbackOutcome = rows[rows.length - 1]
    rec.pullbackOutcomeRows = rows.length
  } catch (e) {
    warnOnce(`pullback outcome record failed (ignored): ${msg(e)}`)
  }
}

function closeRec(rec, reason) {
  if (rec.closed) return
  if (rec.anchored && !rec.lifted) lift(rec, 'close:' + reason)
  if (CONFIG.mineCounterfactualCandidates && rec.counterfactual) {
    logAudit(rec, 'counterfactual', {
      startedAt: rec.counterfactual.startedAt,
      injected: rec.counterfactual.injected,
      restored: { at: Date.now(), reason: 'agent-closed-unresolved', requests: rec.requests, ratio: round2(rec.weightedRatio) },
    })
    rec.counterfactual = null
  }
  annotateReward(rec)
  rec.closed = true
  // L1 效果采集：按触发点结算观测窗口并落盘（L2 门的唯一数据来源）。
  // 终态代理（claimedUnverifiedAfter）在 recordPullbackOutcome 里从会话状态现算，
  // 不再往 rec.pullback 上写一份状态——避免"两处各算一遍"（本项目栽过两次）。
  recordPullbackOutcome(rec)
  // 累积状态（记忆）：**算一次，三处共用**——落盘、回灌、降档都用同一条记录，
  // 避免三处各算一遍导致口径漂移（本项目已经栽过两次"两套规则各说各话"）。
  const outcomeRecord = sessionOutcomeRecord(rec)
  if (outcomeRecord) {
    persistAdaptiveState(outcomeRecord)
    rec.adaptiveRecord = { didNarrow: outcomeRecord.didNarrow, fires: Object.keys(outcomeRecord.fires || {}), productive: outcomeRecord.productive }
  }
  recordChannelFeedback(rec, outcomeRecord)
  logAudit(rec, 'closed', { reason })
  recordSessionOutcome(rec)
  recs.delete(rec.sessionId)
  if (finished.length >= 50) finished.shift()
  finished.push(rec)
}

/** True when the session already contains real work (assistant messages or
 * tool calls) that predates this process — i.e. a resumed/forked session.
 * 动态判据（无固定阈值）：工作事件的 seq < session.firstLiveSeq ⇒ 该事件写于
 * 本进程构造种子之前，是恢复/分叉携带的历史 → 只审计；所有工作事件
 * seq ≥ firstLiveSeq ⇒ 全部是本进程 live 新产生 → 新鲜会话，锚定。
 * firstLiveSeq 是「本进程第一个 live 事件」的构造事实，天然免疫 agent/created
 * 晚到竞态，且对任意种子长度自适应（固定阈值 8/24 均会因种子形态变化失效）。 */
function sessionHasWork(agent) {
  try {
    const session = agent && agent.session
    if (!session) return false
    const events = session.events
    if (!events) return false
    const list = Array.isArray(events) ? events : Array.from(events)
    const firstLive = typeof session.firstLiveSeq === 'number' ? session.firstLiveSeq : null
    for (const ev of list) {
      if (ev && (ev.type === 'assistant/message' || ev.type === 'tool/call')) {
        if (firstLive !== null && typeof ev.seq === 'number') {
          if (ev.seq < firstLive) return true
          continue
        }
        // seq/firstLiveSeq 不可用时保守回退：有工作即视为历史
        return true
      }
    }
    return false
  } catch (e) {
    return false
  }
}

function adopt(agent, doAnchor, channel) {
  bump(channel)
  if (!agent || typeof agent.id !== 'string' || agent.id.length === 0) return null
  const existing = recs.get(agent.id)
  if (existing) return existing
  if (doAnchor && sessionHasWork(agent)) {
    doAnchor = false
    channel = channel + '->resumed-history'
  }
  if (doAnchor && !CONFIG.anchorEnabled) {
    doAnchor = false
    channel = channel + '->anchor-disabled'
  }
  const rec = {
    sessionId: agent.id,
    adoptedAt: Date.now(),
    adoptedSelf: false,
    anchored: false,
    anchorChannel: null,
    anchorError: null,
    anchorDegraded: false,
    anchorAllow: [],
    requests: 0,
    messages: 0,
    toolCalls: 0,
    toolNames: [],
    firstRequestAt: null,
    lifted: false,
    liftReason: null,
    liftedAt: null,
    liftError: null,
    pendingPromote: false,
    lastMessages: [],
    ratioHistory: [],
    weightedRatio: 0,
    personaRatio: 0,
    band: 'spec',
    percentile: null,
    ewma: 0,
    ewmaCount: 0,
    lastState: 'stable',
    machineState: 'stable',
    driftSteps: 0,
    // P1：模型可见工具面 = 由该阶段在组装期派生（不再突变注册层）。
    surfacePhase: 'stable',
    surfaceNarrowedAt: null,
    surfaceRestoredAt: null,
    surfaceDeniedCount: 0,
    // P3：会话内自参考偏离检验的输入与结论。
    stepsScored: 0,
    positiveHitSteps: 0,
    negativeHitSteps: 0,
    lexiconDegenerate: null,
    narrowedSteps: 0,
    didNarrow: false,        // 单调：本会话是否动过手（用于自动降档的正确分母）
    capabilityBudgetExhausted: false,
    lastPolicy: null,
    lastPolicyAction: null,
    lastPolicyP: null,
    lastPolicyChannel: null,
    lastNoticeReason: null,
    lastPolicyReason: null,
    lastPolicySkip: null,
    // B1 行为通道台账：每步一格（定稿后才参与判定）+ 近期调用指纹（重复检测）
    ledger: [],
    recentCalls: [],
    fireRuns: {},
    channels: null,
    // ── L1 任务锚定拉回（默认关）────────────────────────────────────────────
    // anchors 从**首条人类消息**解析（读不出就 parsed:false，绝不猜）；下列状态全部为审计可见。
    taskAnchors: null,
    anchorsFromMessage: null,
    lastVerifyAt: null,
    codeEditsAfterVerify: [],
    scopeViolations: [],
    // ── 证据捕获（criteria 层重构 phase 1：把统计通道换成"可自证事实"的原料）──────
    // 全部 append-only、有界、只存叶子字段；F3（越界）/F5（验证过期）的事实谓词吃这些料。
    verifyEvidence: [],   // 每次验证运行一条：{turn,step,at,kind,cmd,artifacts,failed,failCount,outputTail}
    edits: [],            // 每次**落地**的写：{turn,step,tool,path,invalidates,at}
    claims: [],           // 每次完成/通过声明：{turn,step,text,claimedDone,claimedPass,claimedTotal}
    lastVerifyCmd: null,  // 最近一次验证命令（结果回来时补全证据记录）
    lastVerifyKind: null,
    // F3/F5 事实的镜像干预标记（served 一次性语义与 done-gap 一致）
    scopeBreachMirror: null,
    verifyStalenessMirror: null,
    /** 待发出的拉回原因（工具调用时置位，pre-step 时消费；保证"触发点=说出口的点"）。 */
    pendingPullback: null,
    pullback: {
      count: 0, lastTurn: null, lastReason: null, lastAt: null, lastInfo: null,
      // 触发（两条臂）的每回合节流标记：与 lastTurn 分开，因为 lastTurn/lastReason
      // 讲的是"**说过**的最后一次"（状态与文案用它），而节流必须两臂同规则。
      lastTriggerTurn: null,
      // ── L1/L4 效果采集：**按触发点**记账，两条臂同一口径 ────────────────────
      // 为什么不是会话级计数器（本轮修掉的两个真实缺陷）：
      //   ① 对照组（触发但故意不说）以前根本不进窗口 ⇒ 对照臂恒为"未改善"，
      //      于是 Fisher 比较变成"有窗口 vs 没窗口"，会**假阳性**地开门；
      //   ② 会话级一行会把同会话的多次触发、两条臂揉成一条（实测真数据里就有一条
      //      arm=intervened 的行同时带着 1 次对照触发，对照观测被静默吞掉）。
      // 窗口用**单调观测序号** n 界定：turn/step 可能为 null，不能当序用。
      obsN: 0,
      triggers: [],        // [{ arm, n, turn, step, at, reason }]（有界）
      verifyMarks: [],     // [{ n, turn, step }] 每次验证
      violationMarks: [],  // [{ n, turn, step }] 每次越界写（同一步只记一次）
      suppressed: { throttled: 0, cap: 0, noAnchors: 0 },
      arm: null,          // intervened | control | null（未触发）
      controls: 0,        // 被"故意不说"的次数（对照组）
    },
    // L2 重锚定状态（每会话只做一次）
    reanchor: { count: 0, lastTurn: null, lastPullbackCount: null, lastAt: null, suppressed: { alreadyDone: 0, noPriorPullback: 0, noNewEvidence: 0, noConfirmation: 0 } },
    // L3 第三层：本会话各通道的行动级触发次数 + 结局代理
    channelActFires: {},
    sawUnknownTool: false,
    verifyKinds: {},           // 本会话实际跑过的验证命令形态（L1"未验证"信号的第二种来源）
    episodesEndedNaturally: 0,
    pullbackOutcome: null,
    bandHistory: [],        // 审计用：personaRatio 导出的波段序列（离线回放读日志）
    driftEnteredAt: null,
    rollbackDeny: [],
    counterfactual: null,
    lastTurn: null,
    lastStep: null,
    skillCatalogSeen: false,
    sourceKinds: {},
    contextSuppressed: false,
    contextSuppressedAt: null,
    contextSuppressError: null,
    personaDispose: null,
    runtimeContextDispose: null,
    reward: null,
    events: [],
    lifecycle: [],
    closed: false,
    fileError: null,
    maxTokensRewritten: false,
    maxTokensStripped: false,
  }
  if (initiatorSessionId !== null && agent.id === initiatorSessionId) rec.adoptedSelf = true
  recs.set(rec.sessionId, rec)
  logAudit(rec, 'adopted', { channel, anchor: doAnchor, self: rec.adoptedSelf })
  backfill(rec, agent)
  if (doAnchor) anchorAgent(agent, rec, channel)
  return rec
}

// ---------- shared session-event feed ----------

function feedSessionEvent(session, event) {
  let rec = null
  try {
    rec = recs.get(session.id)
  } catch (e) {
    return
  }
  if (!rec) {
    if (event.type !== 'assistant/message' && event.type !== 'tool/call') return
    if (lateLookupDenied.has(session.id)) return
    let agent = null
    try {
      agent = agentsSvc && typeof agentsSvc.get === 'function' ? agentsSvc.get(session.id) : undefined
    } catch (e) {
      agent = null
    }
    if (!agent || typeof agent.id !== 'string') {
      lateLookupDenied.add(session.id)
      return
    }
    // 晚收养也走同样的年轻会话判定：刚起步的会话值得补锚定，而不是直接只审计。
    rec = adopt(agent, !sessionHasWork(agent), 'session-event-late')
    if (!rec) return
  }
  if (event.type === 'tool/call') {
    rec.toolCalls += 1
    const name = event.data && event.data.name
    if (typeof name === 'string') {
      rec.toolNames.push(name)
      if (rec.toolNames.length > 50) rec.toolNames.shift()
    }
    ledgerNoteToolCall(rec, event.data && event.data.turn, event.data && event.data.step, name, event.data && event.data.arguments)
    logAudit(rec, 'tool-call', { name, turn: event.data && event.data.turn, step: event.data && event.data.step })
    noteTaskSignal(rec, event)
    if (rec.anchored && !rec.lifted) {
      if (CONFIG.gateEnabled) {
        if (!rec.pendingPromote) {
          rec.pendingPromote = true
          logAudit(rec, 'gate-armed', { via: 'first-tool-call', requests: rec.requests })
        }
      } else {
        lift(rec, 'first-tool-call')
      }
    }
  } else if (event.type === 'user/message') {
    // 纠偏检测必须在 noteHumanMessage **之前**判"是不是第一条"（首条是任务陈述，不是纠偏）
    const wasFirst = rec.anchorsFromMessage === null
    noteHumanMessage(rec, event)
    if (!wasFirst) {
      try {
        const d = event.data || {}
        const blocks = Array.isArray(d.content) ? d.content : []
        const txt = blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n')
        if (txt && CORRECTION_CUES.some((re) => re.test(txt))) {
          noteConfirmation(rec, 'user-correction', d.turn, d.step, txt.slice(0, 100))
        }
      } catch (e) { /* 观测侧永不抛 */ }
    }
  } else if (event.type === 'request/header') {
    noteRequestHeader(rec, event)
  } else if (event.type === 'session') {
    noteSessionEvent(rec, event)
  } else if (event.type === 'tool/result') {
    ledgerNoteToolResult(rec, event.data && event.data.turn, event.data && event.data.step, toolResultText(event))
    // L1 成功门：工具**没落地**就撤回它刚贡献的信号（见 retractArm 的长注释）。
    // 注意**验证运行不设这道门**：命令跑过就是跑过，即使报错/非零退出也算"验证过了"
    // （本项目早已定下的口径：报错的测试同样携带信息；要撤的是"根本没发生的事"）。
    if (toolResultFailed(event)) retractArm(rec, event)
    // ⚠ 判据必须**同时**满足：① 这次调用真的**失败**了（结构化标记）② 失败文本说的是 unknown tool。
    // 只看文本会在"读到的内容里恰好写了这几个字"时误报——实测本会话有 29 次文本命中，
    // **全是成功的 read**（读的正是本插件自己的代码与笔记，里面写着 "unknown tool" /
    // "not a known tool"）。而 sawUnknownTool 是 L3.3 结局代理的一项、也是落盘行里的
    // sessionLevelFields，误报会把健康会话记成"不产出" ⇒ 回灌朝错误方向收紧。
    // 顺带：原来的 `\\bunknown tool\\b` 是双重转义 ⇒ 那一半从来没匹配过（静默死掉的分支）。
    if (toolResultFailed(event) && /\bunknown tool\b|not a known tool/i.test(toolResultText(event))) {
      rec.sawUnknownTool = true
      logAudit(rec, 'unknown-tool', { turn: event.data && event.data.turn, step: event.data && event.data.step })
      noteConfirmation(rec, 'unknown-tool', event.data && event.data.turn, event.data && event.data.step)
    }
    // **验证未通过**也是确认信号 —— 但**必须"已经宣告完成"才算**。
    // 为什么收紧（2026-10-09 线上真实误触发）：红色测试是**正常工作状态**
    // （跑红的 → 改 → 再跑），计划书自己就写过"重复调用是正常迭代调试的签名"。
    // 第一版把"验证失败"直接当确认 ⇒ 我跑一次**故意红**的基准夹具就把重锚定触发了。
    // 收紧后：只有"代理**说过做完了**、而验证仍然失败"才算确认出问题。
    {
      const k = `${event.data && event.data.turn}#${event.data && event.data.step}`
      if (rec.lastVerifyCallKey && rec.lastVerifyCallKey === k) {
        const txt = toolResultText(event)
        const failed = Boolean(txt && FAILURE_MARKERS.some((re) => re.test(txt)))
        let failCount = null
        if (failed) {
          // 交付缺口回放的**证据源**：无论说没说完成，都把"这次验证仍有失败"的证据记下来
          // （失败条数与原文尾段）——宣告完成时拿它做"缺口回放"。
          rec.lastVerifyFailureTail = txt.slice(-600)
          const m = txt.match(/failed=(\d+)/) || txt.match(/(\d+) failed/)
          failCount = m ? Number(m[1]) : null
          rec.lastVerifyFailCount = failCount
          if (rec.claimedDoneAt) {
            noteConfirmation(rec, 'verify-failed', event.data && event.data.turn, event.data && event.data.step,
              `claimed@${rec.claimedDoneAt.turn}#${rec.claimedDoneAt.step} | ${txt.slice(-120)}`)
          } else {
            rec.confirmDeclined = (rec.confirmDeclined || 0) + 1
            logAudit(rec, 'confirm-declined', { reason: 'verify-failed', note: '还未宣告完成 ⇒ 红色测试是正常工作状态，不算确认' })
          }
        }
        // 证据捕获（F5 原料）：**每次**验证（通过/失败）都记一条证据记录——
        // 过期事实需要"验证过哪些工件、在什么位置验证的"，与过没过无关。
        rec.verifyEvidence.push({
          turn: typeof (event.data && event.data.turn) === 'number' ? event.data.turn : null,
          step: typeof (event.data && event.data.step) === 'number' ? event.data.step : null,
          at: Date.now(),
          kind: rec.lastVerifyKind || null,
          cmd: rec.lastVerifyCmd || null,
          artifacts: (rec.lastVerifyCmd ? commandPaths(rec.lastVerifyCmd) : []).slice(0, 12),
          failed,
          failCount,
          outputTail: failed ? txt.slice(-600) : null,
        })
        if (rec.verifyEvidence.length > 30) rec.verifyEvidence.shift()
        logAudit(rec, 'verify-evidence', {
          turn: typeof (event.data && event.data.turn) === 'number' ? event.data.turn : null,
          step: typeof (event.data && event.data.step) === 'number' ? event.data.step : null,
          failed, failCount,
          artifacts: rec.verifyEvidence[rec.verifyEvidence.length - 1].artifacts,
        })
        rec.lastVerifyCallKey = null
      }
    }
  } else if (event.type === 'turn/end') {
    // A′ 的关键排除：回合到此结束 ⇒ 最后一格"无工具调用"是合法收尾，不是停手。
    ledgerCloseTurn(rec, event.data && event.data.turn)
    // done-gap 的**边界触发**：代理常常不按"语言宣告"格式报告完成（实测交付报告是
    // "HIDDEN: failed=… passed=…"，claim 正则匹配不上 ⇒ 镜像一次都不开火，见 §29）。
    // 回合结束就是天然交付边界：最近一次验证仍带失败就回放缺口。
    // 与宣告路径共用 served 标记 ⇒ 两条路径都只注入一次。
    if (CONFIG.doneGapMirror === true && !rec.doneGapMirror
      && typeof rec.lastVerifyFailureTail === 'string' && rec.lastVerifyFailureTail.trim()) {
      rec.doneGapMirror = { atTurn: (event.data && event.data.turn) ?? null, atStep: null, served: false, failCount: rec.lastVerifyFailCount }
      logAudit(rec, 'done-gap-mirror', { via: 'turn-end', atTurn: rec.doneGapMirror.atTurn, failCount: rec.lastVerifyFailCount })
    }
    // F3 越界事实的**边界触发**：回合结束时还有**落地**的越界写（失败的在 tool/result
    // 已被成功门撤回）⇒ 挂标记，组装期回放一次。与 done-gap 共用"先挂标记、组装期注入"。
    if (CONFIG.scopeBreachMirror === true && !rec.scopeBreachMirror && rec.scopeViolations.length > 0) {
      rec.scopeBreachMirror = { served: false, via: 'turn-end', paths: rec.scopeViolations.slice(-10).map((v) => v.path) }
      logAudit(rec, 'scope-breach-mirror', { via: 'turn-end', paths: rec.scopeBreachMirror.paths })
    }
  } else if (event.type === 'assistant/message') {
    rec.messages += 1
    const turn = event.data && event.data.turn
    const step = event.data && event.data.step
    // 先为**本步**建格（纯文本步没有工具调用，若不在建格就永远无法被计为"中途停手"），
    // 再推进：新的一步出现 ⇒ 上一步"没有工具调用"就是回合中途停手。
    // （若上一步是回合末步，会先被 turn/end 关掉，不会走到这里。这是 A′ 双判的第一判。）
    ledgerCell(rec, turn, step)
    ledgerAdvanceStep(rec, turn, step)
    if (typeof turn === 'number') rec.lastTurn = turn
    if (typeof step === 'number') rec.lastStep = step
    const texts = reasoningBlocks(event)
    logAudit(rec, 'assistant-message', { blocks: texts.length, turn, step })
    // "宣告完成"的时刻：确认信号 `verify-failed` 必须**晚于**它才算确认
    // （否则红色测试=正常工作状态，会误触发重锚定——2026-10-09 线上真实误触发后收紧）。
    try {
      const claimText = planTextFor(event)
      if (claimText) {
        const c = claimsFromFinalMessage(claimText)
        if (c && (c.claimedDone === true || c.claimedPass !== null)) {
          const first = rec.claimedDoneAt == null
          rec.claimedDoneAt = { turn: turn ?? null, step: step ?? null }
          // 证据捕获（F2/F5 原料）：每次完成/通过声明都记一条（含原文，有界）。
          rec.claims.push({
            turn: turn ?? null, step: step ?? null,
            text: claimText.slice(0, 300),
            claimedDone: c.claimedDone === true, claimedPass: c.claimedPass, claimedTotal: c.claimedTotal,
          })
          if (rec.claims.length > 20) rec.claims.shift()
          // F5 验证过期事实：宣告完成，但其**最后一次验证之后**又改过同一工件 ⇒ 挂标记，
          // 组装期回放"验证命令 + 事后编辑"。纯函数在 tools/task-anchor-core.mjs（单一实现）。
          if (!rec.verifyStalenessMirror && CONFIG.verifyStalenessMirror === true) {
            const stale = verifyStaleness({
              claim: { turn: turn ?? null, step: step ?? null, claimedDone: c.claimedDone === true, claimedPass: c.claimedPass },
              verifyEvidence: rec.verifyEvidence,
              edits: rec.edits,
              scopeDirs: (rec.taskAnchors && rec.taskAnchors.scopeDirs) || [],
            })
            if (stale.stale === true) {
              rec.verifyStalenessMirror = { ...stale.evidence, served: false, via: 'claim', atTurn: turn ?? null, atStep: step ?? null }
              logAudit(rec, 'verify-staleness-mirror', { via: 'claim', ...stale.evidence })
            }
          }
          // 契约重锚定（只读、一次性）：**第一次**宣告完成时挂标记，组装期注入一次摘要。
          if (first && CONFIG.contractReanchor === true && typeof rec.anchorsFromMessage === 'string' && rec.anchorsFromMessage.trim()) {
            rec.contractReanchor = { atTurn: rec.claimedDoneAt.turn, atStep: rec.claimedDoneAt.step, served: false }
            logAudit(rec, 'contract-reanchor', { atTurn: rec.claimedDoneAt.turn, atStep: rec.claimedDoneAt.step })
          }
          // 交付缺口回放：宣告完成，但它自己的最近一次验证**仍带失败** ⇒ 把缺口回放给它。
          if (first && CONFIG.doneGapMirror === true && typeof rec.lastVerifyFailureTail === 'string' && rec.lastVerifyFailureTail.trim()) {
            rec.doneGapMirror = { atTurn: rec.claimedDoneAt.turn, atStep: rec.claimedDoneAt.step, served: false, failCount: rec.lastVerifyFailCount }
            logAudit(rec, 'done-gap-mirror', { atTurn: rec.claimedDoneAt.turn, atStep: rec.claimedDoneAt.step, failCount: rec.lastVerifyFailCount })
          }
        }
      }
    } catch (e) { /* 观测侧永不抛 */ }
    const agent = agentsSvc ? safeGet(agentsSvc, rec.sessionId) : null
    updateWindow(rec, texts, agent || undefined)
    if (CONFIG.gateEnabled && rec.anchored && !rec.lifted && rec.pendingPromote) {
      const latest = rec.lastMessages[rec.lastMessages.length - 1]
      // 泛化锚定门：当前词典的正标记命中且无负标记命中（DS 词典下即 we 无 let me；
      // 换任意词典自动跟随该词典的极性词）。负桶为空时 !hasNegative 恒真是
      // 「无法判断」而非「通过」——此时不提前放行，回退 max-steps 的完整 bootstrap
      // （避免 0 负词典让 gate 形同虚设、bootstrap 提前结束）。
      if (latest && gateEarlyLift(latest.flags, Object.keys(CONFIG.lexicon.negative).length > 0)) {
        lift(rec, 'anchor-gate:minimal-like')
      }
    }
  }
}

/** 门提前放行判定（纯函数，可单测）：仅当负桶非空且正命中、无负命中时为真。 */
export function gateEarlyLift(flags, hasNegTerms) {
  if (!hasNegTerms) return false
  return flags.some(f => f.hasPositive) && !flags.some(f => f.hasNegative)
}

function safeGet(service, id) {
  try {
    return service.get(id)
  } catch (e) {
    return null
  }
}

// ---------- status tool ----------

/** L3：从会话事件流采集族信息（provider/model 来自 request/header，预设来自 session 事件）。 */
function noteRequestHeader(rec, event) {
  try {
    const cfg = event && event.data && event.data.header && event.data.header.config
    if (!cfg) return
    if (!rec.family) rec.family = { provider: null, model: null, preset: null, at: null }
    let changed = false
    if (typeof cfg.provider === 'string' && rec.family.provider !== cfg.provider) { rec.family.provider = cfg.provider; changed = true }
    if (typeof cfg.model === 'string' && rec.family.model !== cfg.model) { rec.family.model = cfg.model; changed = true }
    if (changed) {
      rec.family.at = Date.now()
      logAudit(rec, 'family', { provider: rec.family.provider, model: rec.family.model, preset: rec.family.preset, key: familyKeyOf(rec).full })
    }
  } catch (e) {
    warnOnce(`family note (request/header) failed (ignored): ${msg(e)}`)
  }
}
function noteSessionEvent(rec, event) {
  try {
    const d = event && event.data
    if (!d || typeof d.agentPreset !== 'string') return
    if (!rec.family) rec.family = { provider: null, model: null, preset: null, at: null }
    if (rec.family.preset !== d.agentPreset) {
      rec.family.preset = d.agentPreset
      logAudit(rec, 'family', { provider: rec.family.provider, model: rec.family.model, preset: rec.family.preset, key: familyKeyOf(rec).full })
    }
  } catch (e) {
    warnOnce(`family note (session) failed (ignored): ${msg(e)}`)
  }
}

/** 收第一条人类消息（= 任务陈述），从中解析任务锚点。读不出范围就 parsed:false——绝不猜。 */
function noteHumanMessage(rec, event) {
  try {
    const d = event && event.data
    if (!d || !d.source || d.source.kind !== 'user') return
    if (rec.anchorsFromMessage !== null) return          // 只认第一条人类消息
    const blocks = Array.isArray(d.content) ? d.content : []
    const text = blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n')
    rec.anchorsFromMessage = text.slice(0, 4000)
    const anchors = parseTaskAnchors(text)
    rec.taskAnchors = anchors
    logAudit(rec, 'task-anchors', {
      parsed: anchors.parsed === true,
      reason: anchors.reason || null,
      scopeNames: anchors.scopeNames || [],
      scopeDirs: anchors.scopeDirs || [],
      outsideForbidden: anchors.outsideForbidden === true,
      verifyTokens: anchors.verifyTokens || [],
      reportFormat: anchors.reportFormat || null,
    })
  } catch (e) {
    // 观测侧永不抛：解析失败不许影响会话
    warnOnce(`task-anchor parse failed (ignored): ${msg(e)}`)
  }
}

/**
 * L1：把一次工具调用折算成"任务锚定信号"。
 *   · 命中验证命令 ⇒ 记 lastVerifyAt 并清空"验证后的代码改动"
 *   · 越界写（提示声明的范围之外，且不属于临时/venv/缓存）⇒ 置 pendingPullback='scope'
 *   · 范围内的**代码**改动 ⇒ 记入 codeEditsAfterVerify（文档类改动不记，见
 *     changeInvalidatesVerification 的实测来由）；若此前已验证过 ⇒ 置 pendingPullback='unverified'
 * 判据一律保守：认不出范围/认不出文件类型就什么都不做（宁可漏检也不误报）。
 *
 * ⚠ `tool/call` 只代表"**发起**了写操作"，不代表写成功（2026-10-08 实测：一次被 harness
 * 拒绝的 edit —— `read the file, then retry` —— 仍然被算作"改了代码"，L1 随即说出一句
 * **前提为假**的提醒）。所以这里只**暂记**（按 callId 存进 pendingArms），等 tool/result
 * 回来再定：失败 ⇒ 撤回（retractArm），成功/无结果 ⇒ 保留。
 * 为什么用 callId 而不是 (turn,step)：同一步可以有并行工具调用，按步匹配会误撤别人的信号。
 */
function noteTaskSignal(rec, event) {
  try {
    const anchors = rec.taskAnchors
    const d = event && event.data
    if (!d) return
    const name = typeof d.name === 'string' ? d.name : ''
    const turn = typeof d.turn === 'number' ? d.turn : null
    const step = typeof d.step === 'number' ? d.step : null
    const args = typeof d.arguments === 'string' ? d.arguments : (d.arguments === undefined ? '' : JSON.stringify(d.arguments))
    // 命令文本：优先解码，抽不到就用**原始参数文本**兜底。
    // 为什么必须有兜底（实测踩到，属于"能力其实没在跑"的那一类）：真实会话里的命令常是多行
    // PowerShell 脚本、内含转义引号，此时 `"command"\s*:\s*"([^"]*)"` 只截到一个片段——
    // 于是本会话明明跑了 `node tools/test-pullback.mjs`，verifyKinds 仍是空的、anchorsMode
    // 停在 none，拉回一次都不会触发。判据本身够保守（都是明确的测试/构建形态），
    // 所以直接在原始文本上匹配是安全的，而且对"抽不出来"免疫。
    const cmdDecoded = (() => {
      if (d.arguments && typeof d.arguments === 'object' && typeof d.arguments.command === 'string') return d.arguments.command
      if (typeof d.arguments === 'string') {
        const s = d.arguments.trim()
        if (s.startsWith('{')) {
          try {
            const o = JSON.parse(s)
            if (o && typeof o.command === 'string') return o.command
          } catch (e) { /* 落到兜底 */ }
        } else return d.arguments
      }
      const m = args.match(/"command"\s*:\s*"([^"]*)"/)
      return m ? m[1] : ''
    })()
    /** 参与命令形态识别的文本（解码结果 + 原始参数文本）。 */
    const cmdTexts = [cmdDecoded, args].filter((x) => typeof x === 'string' && x.length > 0)
    // 回放门（§8 门 2）实测假阳：edit/write 的**参数文本**里常带着测试命令
    // （new_string: "python -X utf8 tests/test_all.py"）⇒ 形态识别把它当"验证运行"，
    // 证据记录里 cmd 变成一坨 JSON ⇒ F5 假火。写/读工具的参数不是命令，直接跳过验证检测。
    const canRunCommands = !isWriteTool(name) && !isReadTool(name)
    // ① 验证运行——两种来源取并集：
    //    · 提示里声明的验证命令（anchors.verifyTokens，要求范围子句能解析出锚点）
    //    · **会话自身行为**里识别出的验证命令（verifyCommandKind）
    //      为什么必须有第二种：只认提示的话，自由形态的长会话（提示里没有"Work only inside X"
    //      这类子句）永远沉默，L1 就停在"存在但从不运行"，观察期也攒不到数据。
    //      而"跑过测试/构建"这件事在会话里本来就看得见，不需要提示声明。
    const fromPrompt = Boolean(anchors) && (anchors.verifyTokens || []).some((t) => cmdTexts.some((c) => c.includes(t)))
    // 形态识别对**解码文本与原始参数文本**都试一遍（对"命令抽不出来"免疫）
    let observedKind = null
    let observedIn = null
    for (const c of cmdTexts) {
      const k = verifyCommandKind(c)
      if (k) { observedKind = k; observedIn = c === cmdDecoded ? 'decoded' : 'raw-args'; break }
    }
    const isVerify = canRunCommands && cmdTexts.length > 0 && (fromPrompt || observedKind !== null)
    if (isVerify) {
      if (observedKind && !rec.verifyKinds[observedKind]) {
        rec.verifyKinds[observedKind] = 1
        logAudit(rec, 'verify-kind', {
          kind: observedKind, turn, step, via: fromPrompt ? 'prompt+observed' : 'observed',
          matchedIn: observedIn, cmd: String(cmdDecoded || args).slice(0, 120),
        })
      }
      rec.lastVerifyAt = { turn, step }
      // 证据捕获：记住这次验证的命令与形态——它的**结果**回来时补全 verifyEvidence 记录
      // （通过/失败都要记：F5 要的是"验证过哪些工件、什么时候验证的"，与过没过无关）。
      rec.lastVerifyCmd = String(cmdDecoded || args).slice(0, 300)
      rec.lastVerifyKind = observedKind || (fromPrompt ? 'prompt-token' : null)
      if (rec.codeEditsAfterVerify.length > 0) {
        logAudit(rec, 'verify-run', { turn, step, clearedEdits: rec.codeEditsAfterVerify.length, cmd: String(cmdDecoded || args).slice(0, 160) })
      }
      rec.codeEditsAfterVerify = []
      // 观测窗口：**与说不说无关**地记一个验证 mark（旧代码这里是
      // `if (rec.pullback.count > 0) …`，于是对照臂永远没有窗口 ⇒ 两臂口径不对称）。
      markObs(rec, 'verify', turn, step)
      // 记住这次验证调用的位置：它的**结果**回来时才知道这次验证过没过（确认信号 verify-failed）
      rec.lastVerifyCallKey = `${turn}#${step}`
      // 重新验证会**解决**"未验证"这件事 ⇒ 必须同时清掉待发的提醒，否则会说出过期的提醒。
      // （实测：验证→改码→再验证 之后仍注入了提醒，测试用例 ⑥ 抓出来的。）
      if (rec.pendingPullback && rec.pendingPullback.reason === 'unverified') rec.pendingPullback = null
      return
    }
    // ② 文件改动（**只把写当信号**：越界读是另一类弱信号，本轮刻意不用）
    if (!isWriteTool(name)) return
    const scopeKnown = Boolean(anchors && anchors.parsed === true)
    const callId = typeof d.callId === 'string' ? d.callId : null
    const arm = { callId, turn, step, tool: name, addedEdit: false, addedViolation: false, editCount: 0, markN: null, armedReason: null }
    let sawViolation = false
    for (const path of pathsFromCallStrict(name, d.arguments)) {
      if (isIgnorablePath(path)) continue
      // 证据捕获（F3/F5 的事实原料）：记下这次**发起**的写（失败由成功门在 tool/result 撤回）。
      rec.edits.push({ turn, step, tool: name, path, invalidates: changeInvalidatesVerification(path), at: Date.now() })
      if (rec.edits.length > 100) rec.edits.shift()
      arm.editCount += 1
      if (scopeKnown && !inScope(path, anchors)) {
        const v = { turn, step, tool: name, path, at: Date.now() }
        rec.scopeViolations.push(v)
        if (rec.scopeViolations.length > 50) rec.scopeViolations.shift()
        rec.pendingPullback = { reason: 'scope', turn, step, path, tool: name, byCall: callId }
        arm.addedViolation = true
        arm.armedReason = 'scope'
        sawViolation = true
        logAudit(rec, 'scope-violation', { turn, step, tool: name, path, note: '写操作落在提示声明的范围之外（**暂记**：等 tool/result 确认是否真的落地）' })
        continue
      }
      if (changeInvalidatesVerification(path)) {
        rec.codeEditsAfterVerify.push({ turn, step, path, tool: name })
        if (rec.codeEditsAfterVerify.length > 50) rec.codeEditsAfterVerify.shift()
        arm.addedEdit = true
        // "未验证"只需要"本会话确实验证过"（lastVerifyAt 来自提示**或**行为），
        // **不要求提示里有范围子句**——范围只约束"越界写"，与"改完没验证"是两件事
        // （这条区分由用例 ⑬ 守住；否则自由会话永远沉默）。
        if (rec.lastVerifyAt) {
          rec.pendingPullback = { reason: 'unverified', turn, step, path, lastVerifyAt: rec.lastVerifyAt, byCall: callId }
          arm.armedReason = 'unverified'
        }
      }
    }
    // ③ 越界写**照记不误**（归属哪个触发点的窗口在结算时按观测序号算）。
    // 旧代码要求"已经说过话"才累加 ⇒ 对照臂永远拿不到窗口（本次修掉的口径不对称）。
    // 同一步只记一次（一次调用里可能有多个越界路径）。
    if (sawViolation) {
      const lastM = rec.pullback.violationMarks[rec.pullback.violationMarks.length - 1]
      if (!lastM || lastM.turn !== turn || lastM.step !== step) arm.markN = markObs(rec, 'violation', turn, step)
    }
    // 暂记这次调用的贡献（按 callId）——tool/result 回来若报失败就整条撤回。
    if (arm.addedEdit || arm.addedViolation) {
      if (!rec.pendingArms) rec.pendingArms = new Map()
      if (rec.pendingArms.size >= 20) {
        const oldest = rec.pendingArms.keys().next().value
        rec.pendingArms.delete(oldest)
      }
      rec.pendingArms.set(callId === null ? `${turn}:${step}` : callId, arm)
    }
  } catch (e) {
    warnOnce(`task-signal scan failed (ignored): ${msg(e)}`)
  }
}

/**
 * 工具结果是否**失败/被拒**。判据只用结构化字段（实测形态：
 * `data.message.content[i].isError === true` 与顶层 `data.error = {name,code}`），
 * **不做文本匹配**——文本匹配要么漏（漏则退回旧行为，无害）要么误伤（误伤会把 L1 说哑，
 * 那是本项目栽过两次的"能力其实没在跑"）。所以：
 * 没有明确失败标记 ⇒ 当作成功（保留信号）。
 */
export function toolResultFailed(event) {
  const d = (event && event.data) || null
  if (!d) return false
  if (d.error) return true
  const msg2 = d.message
  const blocks = msg2 && Array.isArray(msg2.content) ? msg2.content : (Array.isArray(d.content) ? d.content : [])
  for (const b of blocks) if (b && b.isError === true) return true
  return false
}

/**
 * 撤回一次**没有落地**的写操作所贡献的信号（成功门）。
 * 为什么必须撤：`tool/call` 只说明"发起了"。被拒的 edit 会让 L1 说出"你在上次验证之后
 * 又改了代码"——那句话是**假的**（实测 turn 676），而"假提醒"正是本项目最在意的那类缺陷。
 * 撤回是**有痕**的（`arm-retracted` 审计 + `pullback.armRetracted` 计数），不是静默忽略。
 */
function retractArm(rec, event) {
  try {
    if (!rec.pendingArms || rec.pendingArms.size === 0) return false
    const d = (event && event.data) || {}
    const callId = (d.message && d.message.source && d.message.source.callId) || d.callId || null
    const key = callId === null ? `${d.turn}:${d.step}` : callId
    const a = rec.pendingArms.get(key)
    if (!a) return false
    rec.pendingArms.delete(key)
    // 证据捕获的写台账也要同步撤回（成功门与 L1 信号同口径）。
    if ((a.editCount || 0) > 0) {
      for (let i = 0; i < a.editCount; i++) {
        const lastE = rec.edits[rec.edits.length - 1]
        if (lastE && lastE.turn === a.turn && lastE.step === a.step) rec.edits.pop()
      }
    }
    if (a.addedEdit) {
      const last = rec.codeEditsAfterVerify[rec.codeEditsAfterVerify.length - 1]
      if (last && last.turn === a.turn && last.step === a.step) rec.codeEditsAfterVerify.pop()
    }
    if (a.addedViolation) {
      const lastV = rec.scopeViolations[rec.scopeViolations.length - 1]
      if (lastV && lastV.turn === a.turn && lastV.step === a.step) rec.scopeViolations.pop()
      const lastM = rec.pullback.violationMarks[rec.pullback.violationMarks.length - 1]
      if (a.markN !== null && lastM && lastM.n === a.markN) rec.pullback.violationMarks.pop()
    }
    // 只清**这次调用**置位的待发提醒（byCall 对齐），不误伤同一步里别的调用的信号
    if (rec.pendingPullback && rec.pendingPullback.byCall === a.callId) rec.pendingPullback = null
    rec.armRetracted = (rec.armRetracted || 0) + 1
    logAudit(rec, 'arm-retracted', {
      turn: a.turn, step: a.step, tool: a.tool, addedEdit: a.addedEdit, addedViolation: a.addedViolation,
      reason: a.armedReason, note: '工具调用失败/被拒 ⇒ 不算"改了代码/越界写"，也不据此拉回',
    })
    return true
  } catch (e) {
    warnOnce(`arm retract failed (ignored): ${msg(e)}`)
    return false
  }
}

/**
 * L1 拉回文本：**建议式**、带证据、带明确豁免。
 *
 * 措辞纪律来自社区实测（dsh-anchored-monitor 的 hint_templates，实验 E1/E1.5）：
 * "仅中性声明/建议式，**禁止命令式**（must/first/follow），命令式会把 we 轨迹打回 let me"。
 * 也就是说：命令式的"拉回"会**加剧**我们要检测的那个信号。所以这里：
 *   · 只陈述事实（谁在什么时候改了什么、上次验证在哪一步）
 *   · 只给建议（"可以考虑…"），不给命令
 *   · 明确写出豁免（文档改动不算、临时文件不算），免得代理为了讨好提醒而不敢正常做事
 *   · 自报"这是本会话第 N 次"，重复出现时不是纯噪音
 */
export function pullbackText(reason, info, count) {
  const head = count > 1 ? `（第 ${count} 次）` : ''
  if (reason === 'scope') {
    return `[trajectory-anchor] 范围提醒${head}：上一步的 ${info.tool} 写到了提示声明的范围之外（${info.path}）。`
      + '如果这是有意的（例如生成临时脚本或改动工具链），说明一句即可；'
      + '否则建议把它改回声明的范围内。注意：临时目录/虚拟环境/包缓存不算越界，这里只标了声明的范围之外。'
  }
  if (reason === 'unverified') {
    const at = info.lastVerifyAt ? `（上次验证在 turn ${info.lastVerifyAt.turn} step ${info.lastVerifyAt.step}）` : ''
    return `[trajectory-anchor] 验证提醒${head}：你在上次验证之后又改了代码（${info.path}）${at}。`
      + '在宣布完成之前，建议重新跑一次验证命令并引用它的输出。'
      + '注意：只改文档、注释或说明文件不算——这里只在**代码**改动晚于验证时提醒。'
  }
  return null
}

/**
 * L1：是否该在**本步**说一句，以及说什么。返回 null 表示不说。
 * 节流：同一 turn 至多一次（社区 allostasis 的 admitPerTurn + monitor 的分级冷却），
 * 以及每会话硬上限（pullbackMaxPerSession）——"按需出现"是它作为信号的前提。
 */
function pullbackDecision(rec, turn) {
  if (CONFIG.pullbackEnabled !== true) return null
  const anchors = rec.taskAnchors
  const anchorsParsed = Boolean(anchors && anchors.parsed === true)
  const observedVerify = Object.keys(rec.verifyKinds || {}).length > 0 || rec.lastVerifyAt !== null
  // 门槛**按原因分别判定**，不再统一要求"解析出提示锚点"：
  //   · scope      需要提示里的范围（越界只能相对声明来判，不许凭空）
  //   · unverified 只需要"本会话确实验证过"（提示或行为皆可）
  // 原先统一要求 parsed ⇒ 自由形态会话永远沉默（实测：用例 ⑬ 的 n=0 正是这道门槛挡的）。
  if (!anchorsParsed && !observedVerify) {
    rec.pullback.suppressed.noAnchors += 1
    rec.pendingPullback = null
    return null
  }
  const pending = rec.pendingPullback
  if (!pending) return null
  if (pending.reason === 'scope' && !anchorsParsed) { rec.pendingPullback = null; return null }
  // 预算与节流对**两条臂**同一规则（干预 + 对照一起数）：
  // 以前只有干预计入"每会话 3 次"与"每回合一次"，对照触发不受限 ⇒ 干预预算用尽后
  // 仍在产生对照单元，而那些单元的窗口**更短**（会话剩下的时间更少）⇒
  // verifiesAfterPullback 系统性偏低 ⇒ 对照臂被做差，朝"干预更好"的方向偏。
  // 这与刚修掉的"对照臂根本没有窗口"是同一类缺陷：采样/测量口径造出来的效应。
  // 出厂 pullbackControlRate=0（不产生对照）时，这条改动**不改变任何行为**。
  const triggersSoFar = rec.pullback.count + rec.pullback.controls
  if (triggersSoFar >= CONFIG.pullbackMaxPerSession) {
    rec.pullback.suppressed.cap += 1
    rec.pendingPullback = null
    return null
  }
  if (rec.pullback.lastTriggerTurn !== null && rec.pullback.lastTriggerTurn === turn) {
    rec.pullback.suppressed.throttled += 1
    rec.pendingPullback = null
    return null
  }
  const text = pullbackText(pending.reason, pending, rec.pullback.count + 1)
  if (!text) { rec.pendingPullback = null; return null }
  return { reason: pending.reason, text, info: pending }
}

function summaryOf(rec) {
  // 行为通道的**实时**窗口（与判定走同一套 channelTest；`channels` 是上次判定时的快照，
  // 而台账在 turn/end 之后还会被定稿，所以两者会短暂不同——这里把"现在"也暴露出来）。
  let channelWindows = null
  try {
    const live = channelSeries(rec)
    channelWindows = {}
    for (const nm of ['inaction', 'repetition', 'failure']) {
      const t = channelTest(nm, live[nm] || [])
      channelWindows[nm] = { observed: t.observed ?? null, window: t.window ?? null, refLen: t.refLen, p: roundP(t.p) }
    }
  } catch (e) { channelWindows = { error: msg(e) } }
  return {
    sessionId: rec.sessionId,
    self: rec.adoptedSelf,
    anchored: rec.anchored,
    anchorChannel: rec.anchorChannel,
    anchorError: rec.anchorError,
    anchorDegraded: rec.anchorDegraded,
    anchorAllow: rec.anchorAllow,
    lifted: rec.lifted,
    liftReason: rec.liftReason,
    liftError: rec.liftError,
    pendingPromote: rec.pendingPromote,
    contextSuppressed: rec.contextSuppressed,
    contextSuppressError: rec.contextSuppressError,
    // 还原阶段自己的错误（与抑制阶段的 contextSuppressError 分开）：
    // 失败时 contextSuppressed 会**保持 true**（状态说实话），重试机会也留着。
    contextRestoreError: rec.contextRestoreError || null,
    band: rec.band,
    ratio: round2(rec.weightedRatio),
    personaRatio: round2(rec.personaRatio),
    percentile: rec.percentile,
    history: rec.ratioHistory.length,
    machineState: rec.machineState,
    driftSteps: rec.driftSteps,
    rollbackDeny: rec.rollbackDeny,
    surfacePhase: rec.surfacePhase,
    narrowedNow: rec.surfacePhase === 'narrowed',
    narrowedSteps: rec.narrowedSteps,
    didNarrow: rec.didNarrow === true,
    capabilityBudgetExhausted: rec.capabilityBudgetExhausted,
    // 本会话的资格是否由**人工试运行**授予（null = 本会话没走到那条路径）
    trialReleaseArmed: rec.trialReleaseArmed || null,
    trialReleaseUnavailable: rec.trialReleaseUnavailable || null,
    contractReanchor: rec.contractReanchor ? { atTurn: rec.contractReanchor.atTurn ?? null, atStep: rec.contractReanchor.atStep ?? null, served: rec.contractReanchor.served === true } : null,
    doneGapMirror: rec.doneGapMirror ? { atTurn: rec.doneGapMirror.atTurn ?? null, atStep: rec.doneGapMirror.atStep ?? null, served: rec.doneGapMirror.served === true, failCount: rec.doneGapMirror.failCount ?? null } : null,
    // F3/F5 事实与证据捕获（criteria 层重构 phase 1）：触发、证据、台账计数全部可见
    scopeBreachMirror: rec.scopeBreachMirror ? { served: rec.scopeBreachMirror.served === true, via: rec.scopeBreachMirror.via || null, paths: rec.scopeBreachMirror.paths || [] } : null,
    verifyStalenessMirror: rec.verifyStalenessMirror ? { served: rec.verifyStalenessMirror.served === true, via: rec.verifyStalenessMirror.via || null, verifyCmd: rec.verifyStalenessMirror.verifyCmd || null, editPath: rec.verifyStalenessMirror.editPath || null, verifyTurn: rec.verifyStalenessMirror.verifyTurn ?? null, verifyStep: rec.verifyStalenessMirror.verifyStep ?? null, editTurn: rec.verifyStalenessMirror.editTurn ?? null, editStep: rec.verifyStalenessMirror.editStep ?? null } : null,
    evidence: {
      verifyEvidence: rec.verifyEvidence.length,
      edits: rec.edits.length,
      claims: rec.claims.length,
    },
    policy: rec.lastPolicy,
    policyAction: rec.lastPolicyAction,
    policyChannel: rec.lastPolicyChannel,
    policyP: rec.lastPolicyP,
    policyReason: rec.lastPolicyReason,
    channels: rec.channels,
    channelWindows,
    ledgerSize: rec.ledger.length,
    // L3 族信息（模型/预设/任务范围 + 实际匹配到的族键）
    family: rec.family
      ? { provider: rec.family.provider, model: rec.family.model, preset: rec.family.preset, key: familyKeyOf(rec).full }
      : null,
    // L1 任务锚定拉回：状态与留痕全部可见（"为什么没说/说了几次/依据是什么"）。
    taskAnchors: rec.taskAnchors
      ? {
          parsed: rec.taskAnchors.parsed === true,
          reason: rec.taskAnchors.reason || null,
          scopeNames: rec.taskAnchors.scopeNames || [],
          scopeDirs: rec.taskAnchors.scopeDirs || [],
          outsideForbidden: rec.taskAnchors.outsideForbidden === true,
          verifyTokens: rec.taskAnchors.verifyTokens || [],
          evidence: rec.taskAnchors.evidence || {},
        }
      : null,
    pullback: {
      enabled: CONFIG.pullbackEnabled === true,
      count: rec.pullback.count,
      lastReason: rec.pullback.lastReason,
      lastTurn: rec.pullback.lastTurn,
      maxPerSession: CONFIG.pullbackMaxPerSession,
      scopeViolations: rec.scopeViolations.length,
      pendingCodeEdits: rec.codeEditsAfterVerify.length,
      lastVerifyAt: rec.lastVerifyAt,
      verifyKinds: Object.keys(rec.verifyKinds),
      anchorsMode: (rec.taskAnchors && rec.taskAnchors.parsed === true) ? "prompt" : (Object.keys(rec.verifyKinds).length > 0 ? "observed-verify" : "none"),
      suppressed: { ...rec.pullback.suppressed },
      arm: rec.pullback.arm,
      controls: rec.pullback.controls,
      // L4 观测单元：**触发点数**才是样本量（不是会话数），两臂都在这里可见
      triggers: rec.pullback.triggers.length,
      triggersByArm: rec.pullback.triggers.reduce((a, t) => { a[t.arm] = (a[t.arm] || 0) + 1; return a }, {}),
      triggersBudget: CONFIG.pullbackMaxPerSession,   // 两条臂**共用**这个预算（采样规则必须一样）
      lastTriggerTurn: rec.pullback.lastTriggerTurn,
      verifyMarks: rec.pullback.verifyMarks.length,
      violationMarks: rec.pullback.violationMarks.length,
      outcomeRows: rec.pullbackOutcomeRows || 0,
      // 成功门：有多少次"发起了但没落地"的写被撤回（撤回不是静默忽略，必须可见）
      armRetracted: rec.armRetracted || 0,
      pendingArms: rec.pendingArms ? rec.pendingArms.size : 0,
      // 事故症状（L3.3 结局代理的一项，也是落盘行的 sessionLevelFields）：必须可见，
      // 否则"这一项为什么是 true"只能靠翻日志。
      sawUnknownTool: rec.sawUnknownTool === true,
    },
    // L2 重锚定：状态、门与在线证据
    reanchor: {
      enabled: effectiveReanchor(),
      gate: reanchorGateReason(),
      count: rec.reanchor.count,
      lastTurn: rec.reanchor.lastTurn,
      suppressed: { ...rec.reanchor.suppressed },
      // L2'（确认即恢复）：开关、是否被允许、当前确认信号、对照比例 —— 全部可见
      onConfirm: CONFIG.reanchorOnConfirm === true,
      confirmAllowed: confirmReanchorAllowed(rec),
      confirm: rec.confirm ? { reason: rec.confirm.reason, turn: rec.confirm.turn, step: rec.confirm.step, handled: rec.confirm.handled === true, detail: rec.confirm.detail || null } : null,
      confirmDeclined: rec.confirmDeclined || 0,
      claimedDoneAt: rec.claimedDoneAt || null,
      confirmControlRate: CONFIG.reanchorConfirmControlRate,
    },
    pullbackOutcome: rec.pullbackOutcome || null,
    lexiconDegenerate: rec.lexiconDegenerate,
    stepsScored: rec.stepsScored,
    positiveHitSteps: rec.positiveHitSteps,
    negativeHitSteps: rec.negativeHitSteps,
    hasCounterfactual: rec.counterfactual !== null,
    // 最近审计种类摘要：让"判定为何没启动"这类问题不必翻日志就能看见
    // （也是 policy-skipped 两档留痕的可测面）。
    auditTail: rec.events.slice(-8).map(e => e.kind),
    // 同一缓冲里的**去重**种类集合：`auditTail` 只有最近 8 条，凡在更早位置发生的种类
    // （例如开局一次的 trial-release-* 治理事件）在那 8 条里看不见，于是"这条审计到底
    // 发生过没有"只能靠翻文件。范围与 auditTail 完全同源（当前内存缓冲，即上次成块
    // 落盘之后的事件），条数上界是种类数而不是事件数，所以可以安全地全量给出。
    auditKinds: [...new Set(rec.events.map(e => e.kind))],
    maxTokensRewritten: rec.maxTokensRewritten,
    maxTokensStripped: rec.maxTokensStripped,
    reward: rec.reward,
    requests: rec.requests,
    messages: rec.messages,
    toolCalls: rec.toolCalls,
    toolNames: rec.toolNames.slice(-8),
    ewma: round2(rec.ewma),
    skillCatalogSeen: rec.skillCatalogSeen,
    sourceKinds: rec.sourceKinds,
    fileError: rec.fileError,
    auditEvents: rec.events.length,
    closed: rec.closed,
  }
}

function buildSummary(filter) {
  const rows = []
  let anchoredCount = 0
  let liftedCount = 0
  let rollbackCount = 0
  for (const rec of recs.values()) {
    if (filter && rec.sessionId !== filter) continue
    if (rec.anchored) anchoredCount += 1
    if (rec.lifted) liftedCount += 1
    if (rec.rollbackDeny.length > 0) rollbackCount += 1
    rows.push(summaryOf(rec))
  }
  const topNames = {}
  for (const name of Object.keys(dispatchStats.names).sort((a, b) => dispatchStats.names[b] - dispatchStats.names[a]).slice(0, 12)) {
    topNames[name] = dispatchStats.names[name]
  }
  return {
    plugin: 'dsh-trajectory-anchor',
    initiatorSessionId,
    baseDir: baseDir || null,
    sessionCwd: sessionCwd || null,
    lexicon: {
      source: CONFIG.lexiconPath ? String(CONFIG.lexiconPath) : 'default',
      positive: Object.keys(CONFIG.lexicon.positive).length,
      negative: Object.keys(CONFIG.lexicon.negative).length,
      neutral: Object.keys(CONFIG.lexicon.neutral).length,
      ratioWeights: { ...CONFIG.ratioWeights },
    },
    config: {
      gateEnabled: CONFIG.gateEnabled,
      maxBootstrapSteps: CONFIG.maxBootstrapSteps,
      suppressContextOnBootstrap: CONFIG.suppressContextOnBootstrap,
      // 抑制清单必须可见：否则"到底摘掉了什么"只能翻源码
      suppressedSources: CONFIG.suppressedSources.slice(),
      bootstrapPersona: CONFIG.bootstrapPersona,
      bootstrapMaxTokens: CONFIG.bootstrapMaxTokens,
      specMax: CONFIG.specMax,
      reactMin: CONFIG.reactMin,
      // P3 响应策略（会话内自参考偏离检验）
      refMinSteps: CONFIG.refMinSteps,
      testWindow: CONFIG.testWindow,
      notifyAlpha: CONFIG.notifyAlpha,
      actAlpha: CONFIG.actAlpha,
      maxDriftSteps: CONFIG.maxDriftSteps,
      rollbackEnabled: CONFIG.rollbackEnabled,
      notifyEnabled: CONFIG.notifyEnabled,
      responsePolicyPath: CONFIG.responsePolicyPath || null,
      measurementSafe: CONFIG.measurementSafe === true,
      effectiveRollback: effectiveRollback(),
      effectiveNotify: effectiveNotify(),
      suppressSkillCatalog: CONFIG.suppressSkillCatalog,
      pullbackEnabled: CONFIG.pullbackEnabled === true,
      pullbackMaxPerSession: CONFIG.pullbackMaxPerSession,
      pullbackControlRate: CONFIG.pullbackControlRate,
      reanchorEnabled: CONFIG.reanchorEnabled === true,
      reanchorEvidencePath: CONFIG.reanchorEvidencePath || null,
      pullbackOutcomePath: CONFIG.pullbackOutcomePath || null,
      familyPriorPath: CONFIG.familyPriorPath || null,
      priorStrength: CONFIG.priorStrength,
      adaptiveStateEnabled: CONFIG.adaptiveStateEnabled === true,
      adaptiveStatePath: CONFIG.adaptiveStatePath || null,
      adaptiveStateWindow: CONFIG.adaptiveStateWindow,
      outcomeFeedbackEnabled: CONFIG.outcomeFeedbackEnabled === true,
      feedbackMinSessions: CONFIG.feedbackMinSessions,
      feedbackMinProductiveRate: CONFIG.feedbackMinProductiveRate,
      feedbackExploreAfterSessions: CONFIG.feedbackExploreAfterSessions,
      rewardAnnotator: CONFIG.rewardAnnotator,
    },
    configWarnings: configWarnings.slice(),
    policyArtifact,
    autoDemote,
    capabilityGate: capabilityGateReason(),
    // 人工试运行放行：通道 / 显式工作点 α / 到期时间 / 剩余时长 / 放行理由。
    // 它必须**一眼可见**，否则"为什么能力层在动手"会变成只有翻源码才知道的事。
    trialRelease: (() => {
      const t = trialReleaseActive()
      const raw = CONFIG.trialRelease
      if (!t) return raw ? { active: false, configured: true, reason: 'expired-or-invalid', until: (raw && raw.until) || null, channels: (raw && raw.channels) || [] } : null
      return { active: true, configured: true, channels: t.channels, alpha: t.alpha, until: t.until, remainingMs: Math.max(0, t.untilMs - Date.now()), note: t.note }   // time-ok: 纯展示剩余时长
    })(),
    reanchorGate: reanchorGateReason(),
    reanchorEvidence,
    familyPriors: familyPriors ? { source: familyPriors.source, families: Object.keys(familyPriors.byKey || {}).length } : null,
    adaptiveState,
    feedbackEpoch,
    channelFeedback: Object.fromEntries(Object.entries(channelFeedback).map(([k, v]) => [k, { sessions: v.sessions, fires: v.fires, productive: v.productive, rate: v.lastRate, multiplier: v.multiplier, revoked: v.revoked, explores: v.explores }])),
    feedbackEpoch,
    effectiveSwitches: { rollback: effectiveRollback(), notify: effectiveNotify() },
    sessionOutcomes: { window: sessionOutcomes.length, narrowed: sessionOutcomes.filter((o) => o.narrowed).length, budget: CONFIG.autoDemoteBudget },
    listAtApply,
    tracked: recs.size,
    anchored: anchoredCount,
    lifted: liftedCount,
    rollbackCount,
    channelStats,
    waterfallAgentRequest,
    waterfallPreStep,
    dispatchStats: { total: dispatchStats.total, top: topNames },
    rows,
  }
}

// ---------- plugin ----------

function mergeConfig(config) {
  if (config === undefined || config === null || typeof config !== 'object') return
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) {
      // 未知配置键：按"响亮 warn 但继续"处理（不阻断挂载）——写错的键在运行期会
      // 静默失效，所以必须响亮且可在 anchor_status / 收尾 record 里查到。
      noteConfigWarning(`unknown config key "${key}" — ignored (allowed: ${[...CONFIG_KEYS].sort().join(', ')})`)
      continue
    }
    if (key === 'suppressedSources') {
      // 抑制清单**不许含插件自己的消息种类**：否则 L1 的拉回提醒会被自己的抑制吃掉
      // （"用安全机制干掉安全机制"是这类配置里最容易踩的坑，而且完全静默）。
      const own = ['trajectory-anchor-pullback', 'trajectory-anchor-reanchor']
      const v = config[key]
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
        noteConfigWarning('invalid suppressedSources (needs an array of source kinds); keeping current list')
        continue
      }
      const clash = v.filter((x) => own.includes(x))
      if (clash.length > 0) {
        noteConfigWarning(`suppressedSources must not contain the plugin's own message kinds (${clash.join(', ')}); those entries were dropped`)
        CONFIG[key] = v.filter((x) => !own.includes(x))
        continue
      }
      CONFIG[key] = v
      continue
    }
    if (key === 'trialRelease') {
      // 人工试运行放行：形状必须精确，否则**整条路径作废**（fail-safe 回到只观察）。
      // 为什么这么严：它是唯一能绕过"标定件不合格"的动作路径，写法含糊就等于放行了一个
      // 说不清边界的执行器 —— 那正是本插件最重那次事故的形态。
      const t = config[key]
      if (!t || typeof t !== 'object' || Array.isArray(t)) {
        noteConfigWarning('invalid trialRelease (needs an object {channels, alpha, until, note}); keeping observe-only')
        continue
      }
      const channels = Array.isArray(t.channels) ? t.channels.filter((c) => typeof c === 'string' && c.length > 0) : []
      const alpha = Number(t.alpha)
      const untilMs = typeof t.until === 'string' ? Date.parse(t.until) : NaN
      if (channels.length === 0) { noteConfigWarning('trialRelease.channels is empty; keeping observe-only'); continue }
      if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) { noteConfigWarning('trialRelease.alpha must be in (0,1); keeping observe-only'); continue }
      if (!Number.isFinite(untilMs)) { noteConfigWarning('trialRelease.until must be an ISO timestamp (a trial without an expiry is unbounded); keeping observe-only'); continue }
      const known = channels.filter((c) => Object.prototype.hasOwnProperty.call(CONFIG.responseChannels, c))
      if (known.length !== channels.length) {
        noteConfigWarning(`trialRelease.channels has unknown channel(s): ${channels.filter((c) => !known.includes(c)).join(',')}; keeping observe-only`)
        continue
      }
      CONFIG[key] = { channels: known, alpha, until: t.until, note: typeof t.note === 'string' ? t.note : null }
      continue
    }
    if (key === 'lexicon') {
      const l = config[key]
      if (!l || typeof l !== 'object' ||
        typeof l.positive !== 'object' || typeof l.negative !== 'object' || typeof l.neutral !== 'object') {
        noteConfigWarning('invalid inline lexicon (needs positive/negative/neutral buckets); keeping current lexicon')
        continue
      }
    }
    if (key === 'responseChannels') {
      // 嵌套对象**逐通道合并**：只覆盖你写的那条通道，兄弟通道保持默认。
      // （否则 `responseChannels: {lexicon: {...}}` 会把 inaction/repetition/failure 抹掉，
      //   表现为"看不见的降级"——这类静默失效正是本项目反复栽的坑。）
      const incoming = config[key]
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
        noteConfigWarning('invalid responseChannels (needs an object of channel overrides); keeping current channels')
        continue
      }
      const merged = { ...CONFIG.responseChannels }
      for (const [chName, chCfg] of Object.entries(incoming)) {
        if (!chCfg || typeof chCfg !== 'object' || Array.isArray(chCfg)) {
          noteConfigWarning(`invalid responseChannels.${chName} (needs an object); keeping defaults for that channel`)
          continue
        }
        merged[chName] = { ...(CONFIG.responseChannels[chName] || {}), ...chCfg }
      }
      CONFIG[key] = merged
      continue
    }
    CONFIG[key] = config[key]
  }
}

/**
 * 从 DEFAULTS 深拷贝一份运行时配置。
 *
 * 为什么必须深拷贝 + 每次挂载重播种（实测踩到的静默降级）：
 *   ① `{ ...DEFAULTS }` 是浅拷贝 ⇒ `CONFIG.responseChannels` 与
 *      `DEFAULTS.responseChannels` 是**同一个对象**；标定件装载时执行
 *      `CONFIG.responseChannels[ch] = {...}` 会就地改掉 DEFAULTS，
 *      于是"默认值"在第一次装标定件后就不再是默认值了。
 *   ② `apply` 可能在同一个进程内被**再次调用**（热重载 / 改配置后重挂载）。
 *      若沿用上一轮的 CONFIG，标定件写入的 `measurementSafe=true`、
 *      `capabilityEligible=true`、反解出来的 `actAlpha` 会**粘住**：表现为
 *      "明明删了标定件/改了配置，行为却不变"，且找不到原因。
 * 因此每次挂载都从 DEFAULTS 重新播种，并把本插件自己的运行期门禁状态一并清空。
 */
function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULTS))
}

export function apply(ctx, config) {
  // ① **派生状态**：每次挂载重算（配置 + 产物算出来的东西）——必须清空，
  //    否则出现"标定件状态跨挂载粘住"（修过的事故）。
  CONFIG = cloneDefaults()
  policyArtifact = null
  reanchorEvidence = null
  familyPriors = null
  configWarnings.length = 0
  warned.clear()
  try {
    PLUGIN_VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version || 'unknown'
  } catch (e) {
    PLUGIN_VERSION = 'unknown'
  }
  mergeConfig(config)
  // ② **累积状态**（记忆）：降档窗口 / 通道回灌计数 / 倍率 / 纪元——按会话落盘、挂载时装载。
  //   为什么与派生状态分开：清掉它等于"每次重启都把最近 N 个会话抹平"，
  //   跨天自适应永远从零开始（回灌与降档都攒不满）。
  //   注意 baseDir 在下面才解析出来，所以这里先用默认（进程 cwd），稍后若拿到 workspaceRoot
  //   会以同一路径规则重算；装载失败一律 fail-safe（空记忆 + 响亮告警，不阻断挂载）。
  loadAdaptiveState()
  // 词典文件加载（在 mergeConfig 之后：lexiconPath 优先于内联 lexicon——
  // 这样"仅加 lexiconPath"即可换词典，无需删除 patch 行里内联的默认词表）
  const envLex = typeof process !== 'undefined' && process.env && process.env.TRAJECTORY_ANCHOR_LEXICON_PATH
  const lexiconPath = (config && typeof config.lexiconPath === 'string' && config.lexiconPath) || envLex || ''
  if (lexiconPath) {
    try {
      const p = isAbsolute(lexiconPath) ? lexiconPath : resolvePath(process.cwd(), lexiconPath)
      const loaded = parseLexiconJson(readFileSync(p, 'utf8'))
      CONFIG.lexicon = { positive: loaded.positive, negative: loaded.negative, neutral: loaded.neutral }
      if (loaded.ratioWeights) CONFIG.ratioWeights = loaded.ratioWeights
      const n = (x) => Object.keys(x).length
      console.log(`[${name}] lexicon loaded from ${p} (${n(loaded.positive)}p/${n(loaded.negative)}n/${n(loaded.neutral)}u)`)
    } catch (e) {
      console.error(`[${name}] failed to load lexicon from "${lexiconPath}": ${e && e.message}; keeping default lexicon`)
    }
  }
  // ⚠ 顺序很重要：先验必须在**标定件之前**加载——标定件要按"先验是否真的在用"
  // 在两套 α（derived / derivedWithFamilyPrior）之间选一套。反过来就会出现
  // "装了先验却用了无先验的 α"（实测踩到：门禁用例 ⑫ 抓出来的）。
  // L3 族先验加载（tools/family-priors.mjs 的产物）。fail-safe：任何一步不通过 ⇒ **不收缩**
  // （退回固定 Jeffreys 伪计数，即本轮之前的行为），并留响亮告警。
  const envPriors = typeof process !== 'undefined' && process.env && process.env.TRAJECTORY_ANCHOR_FAMILY_PRIORS
  const priorPath = (config && typeof config.familyPriorPath === 'string' && config.familyPriorPath) || envPriors || ''
  if (priorPath) {
    try {
      const p = isAbsolute(priorPath) ? priorPath : resolvePath(process.cwd(), priorPath)
      const art = JSON.parse(readFileSync(p, 'utf8'))
      const byKey = {}
      for (const fam of (Array.isArray(art && art.families) ? art.families : [])) {
        if (!fam || typeof fam.key !== 'string' || !fam.baseRates) continue
        const rates = {}
        for (const ch of ['inaction', 'repetition', 'failure']) {
          const v = fam.baseRates[ch]
          if (Number.isFinite(v)) rates[ch] = v
        }
        if (Object.keys(rates).length > 0) byKey[fam.key] = { key: fam.key, sessions: fam.sessions ?? null, steps: fam.steps ?? null, baseRates: rates }
      }
      if (Object.keys(byKey).length === 0) {
        familyPriors = null
  for (const k of Object.keys(channelFeedback)) delete channelFeedback[k]
        noteConfigWarning(`family priors at "${p}" contained no usable families; shrinkage disabled`)
      } else {
        familyPriors = { source: p, byKey, generatedAtUtc: art.generatedAtUtc ?? null, corpus: art.corpus ?? null }
        console.log(`[${name}] family priors loaded from ${p} (${Object.keys(byKey).length} families)`)
      }
    } catch (e) {
      familyPriors = null
  for (const k of Object.keys(channelFeedback)) delete channelFeedback[k]
      noteConfigWarning(`failed to load family priors from "${priorPath}": ${msg(e)}; shrinkage disabled (fixed Jeffreys)`)
    }
  }

  // 标定件加载（B3 门禁）：给了路径就按它决定"哪些通道有资格动能力面"。
  // 任何一步不通过都**只观察**——fail-safe 而不是 fail-open（能力面不同于工具面：
  // 工具面出错要暴露全量，能力面出错必须不动手）。
  const envPolicy = typeof process !== 'undefined' && process.env && process.env.TRAJECTORY_ANCHOR_POLICY_PATH
  const policyPath = (config && typeof config.responsePolicyPath === 'string' && config.responsePolicyPath) || envPolicy || ''
  if (policyPath) {
    try {
      const p = isAbsolute(policyPath) ? policyPath : resolvePath(process.cwd(), policyPath)
      const art = JSON.parse(readFileSync(p, 'utf8'))
      const reject = (why) => {
        policyArtifact = { source: p, verdict: 'REJECTED', rejectReason: why, eligibleChannels: [] }
        noteConfigWarning(`response policy rejected (${why}); capability layer stays off (observe-only)`)
      }
      if (!art || typeof art !== 'object') reject('not an object')
      else if (art.measurementSafe === true) {
        policyArtifact = { source: p, verdict: art.verdict ?? 'UNKNOWN', eligibleChannels: [], measurementSafe: true }
        CONFIG.measurementSafe = true
        noteConfigWarning('response policy declares measurementSafe; forcing observe-only')
      } else if (typeof art.expiresAtUtc === 'string' && Date.parse(art.expiresAtUtc) < Date.now()) { // time-ok: artifact-expiry
        reject(`expired at ${art.expiresAtUtc}`)
      } else if (art.verdict !== 'PASS' && art.verdict !== 'PARTIAL-PASS') {
        reject(`verdict=${art.verdict}`)
      } else {
        const eligible = Array.isArray(art.capabilityEligibleChannels) ? art.capabilityEligibleChannels : []
        const applied = []
        const derivedSource = {}
        for (const chName of eligible) {
          if (!CONFIG.responseChannels[chName]) continue
          const chArt = (art.channels && art.channels[chName]) || {}
          // **两套 α，按估计器选**：先验真的装载了才用"带先验反解"的那一套。
          // 为什么必须分开：收缩会改变 null 率（实测让判定更敏感），带先验反解出的 α 严得多
          // （A′ 0.001 → 0.0001，10 倍）。只写一套的话，无论哪边错配都等于**悄悄改了预算**。
          const usePrior = Boolean(familyPriors) && Boolean(chArt.derivedWithFamilyPrior)
          const derived = (usePrior ? chArt.derivedWithFamilyPrior : chArt.derived) || null
          CONFIG.responseChannels[chName] = {
            ...CONFIG.responseChannels[chName],
            capabilityEligible: true,
            ...(derived && Number.isFinite(derived.consecutive) ? { consecutive: derived.consecutive } : {}),
            ...(derived && Number.isFinite(derived.alpha) ? { actAlpha: derived.alpha } : {}),
          }
          applied.push(chName)
          derivedSource[chName] = usePrior ? 'derivedWithFamilyPrior' : 'derived'
        }
        policyArtifact = {
          source: p, verdict: art.verdict, eligibleChannels: applied, derivedSource,
          corpusFingerprint: art.corpusFingerprint ?? null, generatedAtUtc: art.generatedAtUtc ?? null,
        }
        console.log(`[${name}] response policy loaded from ${p} (verdict=${art.verdict}; eligible: ${applied.join(', ') || '(none)'}; α 来源: ${Object.values(derivedSource).join(',') || '-'})`)
      }
    } catch (e) {
      policyArtifact = { source: policyPath, verdict: 'REJECTED', rejectReason: msg(e), eligibleChannels: [] }
      noteConfigWarning(`failed to load response policy from "${policyPath}": ${msg(e)}; capability layer stays off`)
    }
  }

  // L2：在线证据件加载（重锚定的前置门）。与标定件同样的 fail-safe 姿态：
  // 缺/坏/过期/verdict≠PASS-online ⇒ 一律不开。
  const envEvidence = typeof process !== 'undefined' && process.env && process.env.TRAJECTORY_ANCHOR_EVIDENCE_PATH
  const evidencePath = (config && typeof config.reanchorEvidencePath === 'string' && config.reanchorEvidencePath) || envEvidence || ''
  if (evidencePath) {
    try {
      const p = isAbsolute(evidencePath) ? evidencePath : resolvePath(process.cwd(), evidencePath)
      const ev = JSON.parse(readFileSync(p, 'utf8'))
      const reject = (why) => {
        reanchorEvidence = { source: p, verdict: 'REJECTED', rejectReason: why }
        noteConfigWarning(`re-anchor evidence rejected (${why}); re-anchor stays off`)
      }
      if (!ev || typeof ev !== 'object') reject('not an object')
      // 合成/演示数据不得当证据（analyze-pullback-outcomes.mjs --synthesize 会标 synthetic:true）。
      // 这条是实测出来的：第一版链路上，合成证据喂进去门**照样开了**。
      else if (ev.synthetic === true) reject('synthetic-evidence')
      else if (ev.verdict !== 'PASS-online') reject(`verdict=${ev.verdict}`)
      else if (typeof ev.expiresAtUtc === 'string' && Date.parse(ev.expiresAtUtc) < Date.now()) reject(`expired at ${ev.expiresAtUtc}`) // time-ok: artifact-expiry
      else {
        reanchorEvidence = {
          source: p, verdict: 'PASS-online',
          pullbacksObserved: ev.pullbacksObserved ?? null,
          effectiveness: ev.effectiveness ?? null,
          generatedAtUtc: ev.generatedAtUtc ?? null,
        }
        console.log(`[${name}] re-anchor evidence loaded from ${p} (${reanchorEvidence.pullbacksObserved ?? '?'} pull-backs observed)`)
      }
    } catch (e) {
      reanchorEvidence = { source: evidencePath, verdict: 'REJECTED', rejectReason: msg(e) }
      noteConfigWarning(`failed to load re-anchor evidence from "${evidencePath}": ${msg(e)}; re-anchor stays off`)
    }
  }


  agentsSvc = ctx.get('agents')
  fsSvc = ctx.get('fs')
  spSvc = ctx.get('sandboxPolicy')

  if (spSvc && typeof spSvc.workspaceRoot === 'string' && spSvc.workspaceRoot.length > 0) baseDir = spSvc.workspaceRoot
  // baseDir 变化会改变累积状态的默认路径 ⇒ 重新装载一次。
  // **只有路径真的变了才重装**：否则每次挂载都会重复装载一遍（日志重复、且白做一次 I/O）。
  if (CONFIG.adaptiveStateEnabled === true && adaptiveStateFile() !== (adaptiveState && adaptiveState.source)) {
    for (const k of Object.keys(channelFeedback)) delete channelFeedback[k]
    sessionOutcomes.length = 0
    autoDemote = null
    feedbackEpoch = 0
    loadAdaptiveState()
  }

  // ---- guaranteed perception channel ----
  disposers.push(ctx.on('internal/dispatch', (type, name, args, thisArg) => {
    try {
      dispatchStats.total += 1
      if (INTERESTING.has(name)) dispatchStats.names[name] = (dispatchStats.names[name] || 0) + 1
      if (name === 'agent/created') {
        const payload = args && args[0]
        const agent = payload && payload.agent ? payload.agent : payload
        if (agent && typeof agent.id === 'string') adopt(agent, true, 'dispatch:agent/created')
      } else if (name === 'session/event') {
        const session = args && args[0]
        const event = args && args[1]
        if (session && session.id && event && event.type) feedSessionEvent(session, event)
      } else if (name === 'agent/disposed') {
        const payload = args && args[0]
        const agent = payload && payload.agent
        if (agent && typeof agent.id === 'string') {
          const rec = recs.get(agent.id)
          if (rec) closeRec(rec, 'agent-disposed')
        }
      } else if (name === 'agent/request') {
        const payload = args && args[0]
        const agent = payload && payload.agent
        if (agent && typeof agent.id === 'string') {
          let rec = recs.get(agent.id)
          if (!rec) rec = adopt(agent, payload.turn === 1 && payload.step === 1, 'dispatch:agent/request')
          if (rec) {
            rec.requests += 1
            if (rec.firstRequestAt === null) rec.firstRequestAt = Date.now()
            if (rec.anchored && !rec.lifted && CONFIG.promoteAfterFirstResponse
              && rec.requests >= 2 && rec.toolCalls === 0 && rec.messages >= 1) {
              lift(rec, 'first-response-no-tool')
            }
            if (rec.anchored && !rec.lifted && rec.requests >= CONFIG.maxBootstrapSteps) {
              lift(rec, 'max-steps')
            }
          }
        }
      }
    } catch (e) {
      // observers never throw
    }
  }))

  // ---- system-prompt/assemble: 工具面在组装期派生（P1）+ 变更对模型可见（P4）----
  // 每次请求重新求值：阶段回到 stable 时**下一次组装即全量**，无需任何"归还"调用。
  // 任何异常都返回原 assembly（fail-open：本插件的 bug 绝不能吃掉用户的能力）。
  disposers.push(ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const out = await next()
    try {
      const agent = context && context.agent
      const rec = agent && typeof agent.id === 'string' ? recs.get(agent.id) : undefined
      if (!rec || rec.surfacePhase !== 'narrowed') {
        if (rec && rec.noticePhase === 'narrowed') {
          rec.noticePhase = 'stable'
          logAudit(rec, 'notice', { phase: 'stable', text: 'tool surface restored to full catalog' })
        }
        return out
      }
      if (!effectiveRollback()) return out
      const before = Array.isArray(out.tools) ? out.tools : []
      const after = surfaceForPhase('narrowed', before, CONFIG.leanDenyPatterns)
      const denied = before.length - after.length
      if (rec.surfaceDeniedCount !== denied) {
        rec.surfaceDeniedCount = denied
        logAudit(rec, 'surface-applied', { kept: after.length, denied })
      }
      // P4：阶段变化时给模型一条**可见**说明（也是它不再调用已消失工具的原因）。
      if (rec.noticePhase !== 'narrowed') {
        rec.noticePhase = 'narrowed'
        logAudit(rec, 'notice', { phase: 'narrowed', kept: after.length, denied })
      }
      const notice = {
        name: 'trajectory-anchor:notice',
        text: '[trajectory-anchor] Trajectory deviation detected (session-local reference test). '
          + `The tool catalog for this turn is narrowed to ${after.length} tools (${denied} hidden). `
          + 'Continue the task from where you left off, in plan-first style ("we will …"). '
          + 'The full catalog returns automatically once the trajectory recovers; '
          + 'do not call the hidden tools — they are absent this turn.',
      }
      return {
        ...out,
        tools: Array.isArray(after) ? after : out.tools,
        sections: Array.isArray(out.sections) ? [...out.sections, notice] : out.sections,
      }
    } catch (e) {
      warnOnce(`surface filter failed, exposing full catalog: ${msg(e)}`)
      return out
    }
  }))

  // ---- 契约重锚定（只读、一次性）：宣告完成后的第一次组装注入首轮契约摘要 ----
  // 通道与 P4 相同（trajectory-anchor:* 段），不改工具面、不删信息，信息型。
  disposers.push(ctx.on('system-prompt/assemble', (out, payload, next) => {
    try {
      const id = payload && payload.agent && payload.agent.id
      const rec = id ? recs.get(id) : null
      if (!rec || !rec.contractReanchor || rec.contractReanchor.served === true) return next(out)
      rec.contractReanchor.served = true
      const summary = rec.anchorsFromMessage.slice(0, 700)
      const section = {
        name: 'trajectory-anchor:contract',
        text: '[trajectory-anchor] You are about to declare this task done. Re-check your work against the '
          + 'ORIGINAL contract from the first instruction:\n\n'
          + summary
          + '\n\nIf a later instruction appeared to change or cancel part of this contract, verify which one '
          + 'governs before finishing — and say so explicitly if they conflict.',
      }
      // 注入后**继续链**（next(modified)）：同名监听器是瀑布链——直接 return 会短路，
      // 把链上更后面的镜像（done-gap/越界/过期）全部堵死（回放门 §8 门 2 实测：
      // 越界开火后过期镜像在同一会话 served=false）。每个事实各自注入、互不堵链。
      return next({
        ...out,
        sections: Array.isArray(out.sections) ? [...out.sections, section] : out.sections,
      })
    } catch (e) {
      warnOnce(`contract re-anchor failed, skipping: ${msg(e)}`)
      return next(out)
    }
  }))

  // ---- 交付缺口回放（只读、一次性）：失败验证之后的下一次组装即回放"你自己还有 N 个失败" ----
  // 触发改成**惰性**：不再要求"宣告完成"或 turn/end（实测这两个边界都可能缺失——a5 那次
  // 会话在失败验证后没有 turn/end ⇒ 4/5 开火未达预注册门槛）。现在只要"最近一次验证仍带
  // 失败证据 + 出现下一次提示组装"，就注入一次。宣告/turn-end 路径保留（它们只是提前挂标记）。
  disposers.push(ctx.on('system-prompt/assemble', (out, payload, next) => {
    try {
      const id = payload && payload.agent && payload.agent.id
      const rec = id ? recs.get(id) : null
      if (!rec) return next(out)
      if (rec.doneGapMirror && rec.doneGapMirror.served === true) return next(out)
      if (!rec.doneGapMirror) {
        if (CONFIG.doneGapMirror !== true) return next(out)
        if (typeof rec.lastVerifyFailureTail !== 'string' || !rec.lastVerifyFailureTail.trim()) return next(out)
        rec.doneGapMirror = { atTurn: null, atStep: null, served: false, failCount: rec.lastVerifyFailCount }
        logAudit(rec, 'done-gap-mirror', { via: 'post-failure-assemble', failCount: rec.lastVerifyFailCount })
      }
      rec.doneGapMirror.served = true
      const fail = rec.lastVerifyFailCount === null ? 'failures' : `${rec.lastVerifyFailCount} failures`
      const section = {
        name: 'trajectory-anchor:done-gap',
        text: `[trajectory-anchor] Your most recent verification still reported ${fail}. Evidence:\n\n${rec.lastVerifyFailureTail}\n\nMap each failure to its module and keep fixing; if you believe some of them do not count, say so explicitly before finishing.`,
      }
      // 注入后**继续链**（next(modified)），不短路后面的镜像（见契约处理器同处注释）。
      return next({
        ...out,
        sections: Array.isArray(out.sections) ? [...out.sections, section] : out.sections,
      })
    } catch (e) {
      warnOnce(`done-gap mirror failed, skipping: ${msg(e)}`)
      return next(out)
    }
  }))

  // ---- 越界回放（只读、一次性）：写到了声明范围之外 ⇒ 回放路径清单 + 原始范围条款 ----
  // F3 事实：判据是转录事实（路径 vs 范围子句），不是统计分数。触发同样**惰性**：turn/end
  // 只提前挂标记；下一次组装即注入一次（与 done-gap v3 同一惰性模式，两个边界都可能缺失）。
  disposers.push(ctx.on('system-prompt/assemble', (out, payload, next) => {
    try {
      const id = payload && payload.agent && payload.agent.id
      const rec = id ? recs.get(id) : null
      if (!rec) return next(out)
      if (rec.scopeBreachMirror && rec.scopeBreachMirror.served === true) return next(out)
      if (!rec.scopeBreachMirror) {
        if (CONFIG.scopeBreachMirror !== true) return next(out)
        if (!Array.isArray(rec.scopeViolations) || rec.scopeViolations.length === 0) return next(out)
        rec.scopeBreachMirror = { served: false, via: 'post-fact-assemble', paths: rec.scopeViolations.slice(-10).map((v) => v.path) }
        logAudit(rec, 'scope-breach-mirror', { via: rec.scopeBreachMirror.via, paths: rec.scopeBreachMirror.paths })
      }
      rec.scopeBreachMirror.served = true
      const scopeClause = (rec.taskAnchors && rec.taskAnchors.evidence && rec.taskAnchors.evidence.scopeClause) || null
      const section = {
        name: 'trajectory-anchor:scope-breach',
        text: '[trajectory-anchor] You wrote outside the declared scope:\n\n'
          + (rec.scopeBreachMirror.paths || []).join('\n')
          + `\n\nDeclared scope: ${scopeClause || '(parsed from the first instruction)'}`
          + '\n\nRevert these writes or justify explicitly why they belong to the task before finishing.',
      }
      // 注入后**继续链**（next(modified)），不短路后面的镜像（见契约处理器同处注释）。
      return next({
        ...out,
        sections: Array.isArray(out.sections) ? [...out.sections, section] : out.sections,
      })
    } catch (e) {
      warnOnce(`scope-breach mirror failed, skipping: ${msg(e)}`)
      return next(out)
    }
  }))

  // ---- 验证过期回放（只读、一次性）：宣告完成，但验证**之后**又改过同一文件 ----
  // F5 事实："验证早于这次改动"。宣告路径先挂标记；若宣告事件缺失（实测交付报告形态
  // 可能对不上宣告正则），组装期按最近一条声明记录**惰性**补判一次——两条路径共用 served。
  disposers.push(ctx.on('system-prompt/assemble', (out, payload, next) => {
    try {
      const id = payload && payload.agent && payload.agent.id
      const rec = id ? recs.get(id) : null
      if (!rec) return next(out)
      if (rec.verifyStalenessMirror && rec.verifyStalenessMirror.served === true) return next(out)
      if (!rec.verifyStalenessMirror) {
        if (CONFIG.verifyStalenessMirror !== true) return next(out)
        const lastClaim = Array.isArray(rec.claims) ? rec.claims[rec.claims.length - 1] : null
        if (!lastClaim) return next(out)
        const stale = verifyStaleness({
          claim: lastClaim,
          verifyEvidence: rec.verifyEvidence,
          edits: rec.edits,
          scopeDirs: (rec.taskAnchors && rec.taskAnchors.scopeDirs) || [],
        })
        if (stale.stale !== true) return next(out)
        rec.verifyStalenessMirror = { ...stale.evidence, served: false, via: 'post-claim-assemble' }
        logAudit(rec, 'verify-staleness-mirror', { via: 'post-claim-assemble', ...stale.evidence })
      }
      rec.verifyStalenessMirror.served = true
      const e = rec.verifyStalenessMirror
      const section = {
        name: 'trajectory-anchor:verify-staleness',
        text: '[trajectory-anchor] You are declaring done, but your most recent verification ran BEFORE a later edit of the same file:\n\n'
          + `Verification: ${e.verifyCmd || '(unrecognized)'} (turn ${e.verifyTurn ?? '?'}#${e.verifyStep ?? '?'})\n`
          + `Edit after it: ${e.editPath} (turn ${e.editTurn ?? '?'}#${e.editStep ?? '?'})\n\n`
          + 'Re-run the verification now and report the fresh result before finishing.',
      }
      // 注入后**继续链**（next(modified)），不短路后面的镜像（见契约处理器同处注释）。
      return next({
        ...out,
        sections: Array.isArray(out.sections) ? [...out.sections, section] : out.sections,
      })
    } catch (e) {
      warnOnce(`verify-staleness mirror failed, skipping: ${msg(e)}`)
      return next(out)
    }
  }))

  // ---- agent/request waterfall: opt-in first-round cap + explicit post-lift strip ----
  disposers.push(ctx.on('agent/request', async (payload, next) => {
    waterfallAgentRequest += 1
    try {
      const agent = payload && payload.agent
      const rec = agent && typeof agent.id === 'string' ? recs.get(agent.id) : undefined
      if (!rec) return await next()
      const base = await next()
      const capOn = typeof CONFIG.bootstrapMaxTokens === 'number' && CONFIG.bootstrapMaxTokens > 0
      if (!capOn) return base
      const firstRound = payload.turn === 1 && payload.step === 1
      if (rec.anchored && !rec.lifted && firstRound && base && typeof base === 'object' && rec.maxTokensRewritten !== true) {
        rec.maxTokensRewritten = true
        logAudit(rec, 'maxTokens-rewrite', { from: base.maxTokens, to: CONFIG.bootstrapMaxTokens })
        return Object.assign({}, base, { maxTokens: CONFIG.bootstrapMaxTokens })
      }
      if (rec.lifted && base && typeof base === 'object' && base.maxTokens === CONFIG.bootstrapMaxTokens) {
        const { maxTokens: _cap, ...rest } = base
        if (!rec.maxTokensStripped) {
          rec.maxTokensStripped = true
          logAudit(rec, 'maxTokens-strip', {})
        }
        return rest
      }
      return base
    } catch (e) {
      return await next()
    }
  }, { prepend: true }))

  // ---- agent/pre-step waterfall: skill-catalog suppression during bootstrap ----
  disposers.push(ctx.on('agent/pre-step', async (payload, next) => {
    waterfallPreStep += 1
    try {
      const agent = payload && payload.agent
      const rec = agent && typeof agent.id === 'string' ? recs.get(agent.id) : undefined
      if (!rec) return await next()
      const claimed = Array.isArray(payload.messages) ? payload.messages : []
      for (const m of claimed) {
        const kind = m && m.source && m.source.kind
        if (typeof kind === 'string' && !Object.prototype.hasOwnProperty.call(rec.sourceKinds, kind)) {
          rec.sourceKinds[kind] = 1
        }
      }
      const decision = await next()
      if (decision && decision.kind === 'reject') return decision
      // ── L1 任务锚定拉回：在**近因位置**追加一条独立消息 ───────────────────────
      // 为什么挂 pre-step 而不是 system prompt 前缀（社区 allostasis 的原文理由）：
      // 固定前缀离输出最远，长会话里纠偏信号会被近因压过去；这条必须落在近因位置。
      // 为什么是 messages 追加而不是改写 system：不改写基线语义，且天然可逆（只有这一条）。
      const pull = pullbackDecision(rec, typeof payload.turn === 'number' ? payload.turn : null)
      // ── L4 在线对照：触发时以 pullbackControlRate 的概率**故意不说**，从而拿到对照组 ──
      // 没有对照组就只能看见"说过之后"的那一侧，无法区分"起了作用"与"本来就会这样"。
      // 默认 rate=0（不抑制）；做效果测量时才调大。被抑制的会话同样记账（arm='control'）。
      if (pull && CONFIG.pullbackControlRate > 0 && Math.random() < CONFIG.pullbackControlRate) {
        rec.pullback.controls += 1
        rec.pullback.arm = 'control'
        // 对照臂也**开观测窗口**（与干预臂共用 markTrigger）——不这么做对照臂就恒为
        // "未改善"，两臂比较测的是测量口径而不是效果。
        const cTrig = markTrigger(rec, 'control', pull.reason, payload.turn, payload.step)
        rec.pullback.lastTriggerTurn = typeof payload.turn === 'number' ? payload.turn : null
        rec.pendingPullback = null
        logAudit(rec, 'pullback-control', {
          reason: pull.reason, turn: payload.turn, step: payload.step, n: cTrig.n,
          controls: rec.pullback.controls, rate: CONFIG.pullbackControlRate,
          note: '触发但按对照组比例故意不说（用于在线对照估计效果）',
        })
        return decision
      }
      if (pull && decision && Array.isArray(decision.messages)) {
        rec.pullback.count += 1
        rec.pullback.arm = 'intervened'
        rec.pullback.lastTurn = typeof payload.turn === 'number' ? payload.turn : null
        rec.pullback.lastReason = pull.reason
        rec.pullback.lastInfo = { path: pull.info.path || null, lastVerifyAt: pull.info.lastVerifyAt || null }
        rec.pullback.lastAt = Date.now()
        const trig = markTrigger(rec, 'intervened', pull.reason, payload.turn, payload.step)
        rec.pullback.lastTriggerTurn = typeof payload.turn === 'number' ? payload.turn : null
        rec.pendingPullback = null
        logAudit(rec, 'pullback', {
          reason: pull.reason, turn: payload.turn, step: payload.step, n: trig.n,
          count: rec.pullback.count, path: pull.info.path || null, text: pull.text,
        })
        const injected = {
          source: { kind: 'trajectory-anchor-pullback' },
          content: [{ type: 'text', text: pull.text }],
        }
        const withPullback = { ...decision, messages: [...decision.messages, injected] }
        if (!CONFIG.suppressSkillCatalog || !(rec.anchored && !rec.lifted)) return withPullback
        // 若同一步还要做 bootstrap 期的 skill-catalog 抑制，两件事一起做完再返回
        const kept = withPullback.messages.filter((m) => {
          const kind = m && m.source && m.source.kind
          return !(typeof kind === 'string' && CONFIG.suppressedSources.includes(kind))
        })
        if (kept.length !== withPullback.messages.length) {
          rec.skillCatalogSeen = true
          logAudit(rec, 'skill-catalog-suppressed', { removed: withPullback.messages.length - kept.length, turn: payload.turn, step: payload.step })
        }
        return { ...withPullback, messages: kept }
      }
      // ── L2 重锚定：先轻后重。两条路径（在线证据 / 当场确认），见 reanchorDecision 的注释 ──
      const re = reanchorDecision(rec, typeof payload.turn === 'number' ? payload.turn : null)
      if (re && decision && Array.isArray(decision.messages)) {
        // 确认路径同样有**随机化对照**：按比例故意不恢复，这样"恢复有没有用"照样可估
        // （否则又是一次"只有单臂 ⇒ 无法估计效果"）。
        if (re.via === 'confirm' && CONFIG.reanchorConfirmControlRate > 0 && Math.random() < CONFIG.reanchorConfirmControlRate) {
          rec.confirm.handled = true
          const ct = markTrigger(rec, 'control', re.reason, payload.turn, payload.step, 'reanchor')
          logAudit(rec, 'reanchor-control', {
            reason: re.reason, turn: payload.turn, step: payload.step, n: ct.n,
            rate: CONFIG.reanchorConfirmControlRate,
            note: '确认信号成立但按对照比例**故意不恢复**（用于估计"确认即恢复"的效果）',
          })
          return decision
        }
        const text = reanchorText(CONFIG.bootstrapPersona, re.info, rec.reanchor.count + 1)
        if (re.via === 'confirm' && rec.confirm) rec.confirm.handled = true
        rec.reanchor.count += 1
        rec.reanchor.lastTurn = typeof payload.turn === 'number' ? payload.turn : null
        rec.reanchor.lastPullbackCount = rec.pullback.count
        rec.reanchor.lastAt = Date.now()
        const trig = markTrigger(rec, 'intervened', re.reason, payload.turn, payload.step, 'reanchor')
        logAudit(rec, 'reanchor', {
          turn: payload.turn, step: payload.step, count: rec.reanchor.count, n: trig.n, via: re.via,
          afterPullbacks: rec.pullback.count, evidence: reanchorEvidence ? reanchorEvidence.source : null,
          confirm: re.info && re.info.confirm ? re.info.confirm : null,
          personaBytes: CONFIG.bootstrapPersona.length,
        })
        const injected = { source: { kind: 'trajectory-anchor-reanchor' }, content: [{ type: 'text', text }] }
        return { ...decision, messages: [...decision.messages, injected] }
      }
      if (!CONFIG.suppressSkillCatalog || !(rec.anchored && !rec.lifted)) return decision
      if (!decision || !Array.isArray(decision.messages)) return decision
      const kept = decision.messages.filter(m => {
        const kind = m && m.source && m.source.kind
        return !(typeof kind === 'string' && CONFIG.suppressedSources.includes(kind))
      })
      if (kept.length === decision.messages.length) return decision
      rec.skillCatalogSeen = true
      logAudit(rec, 'skill-catalog-suppressed', { removed: decision.messages.length - kept.length, turn: payload.turn, step: payload.step })
      return { ...decision, messages: kept }
    } catch (e) {
      return await next()
    }
  }, { prepend: true }))

  // ---- adopt live agents at start (audit-only) ----
  if (agentsSvc) {
    try {
      const live = agentsSvc.list()
      listAtApply = { length: Array.isArray(live) ? live.length : -1, error: null }
      for (const agent of live) {
        if (!agent || typeof agent.id !== 'string') continue
        adopt(agent, false, 'apply-existing')
      }
    } catch (e) {
      listAtApply = { length: -1, error: msg(e) }
    }
  } else {
    listAtApply = { length: -1, error: 'agents service unavailable' }
  }

  // ---- audit status tool (plain ToolRuntime registration) ----
  try {
    const tool = {
      name: 'anchor_status',
      description: 'Read the live audit state of the dsh-trajectory-anchor plugin: adopted/anchored agents, '
        + 'bootstrap tool allow-lists, promotion-gate state, bootstrap context suppression, lexicon-weighted trajectory '
        + 'scores (ratio / persona-ratio bands / baseline percentile), drift-rollback state, counterfactual candidates, '
        + 'reward annotations, and event-channel reachability.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Optional session id filter; omit for all tracked agents.' },
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => [{ type: 'text', text: 'anchor_status: ' + JSON.stringify(value, null, 2) }],
      },
      execute: async (args) => buildSummary(args && typeof args.sessionId === 'string' ? args.sessionId : null),
    }
    const toolsSvc = ctx.get('tools')
    if (toolsSvc && typeof toolsSvc.register === 'function') {
      auditToolDispose = toolsSvc.register(tool)
    }
  } catch (e) {
    // anchor_status absence is the signal; the plugin itself stays functional
  }

  // ---- teardown ----
  ctx.effect(() => () => {
    try {
      for (const rec of recs.values()) closeRec(rec, 'plugin-stop')
      for (const d of disposers) {
        try { d() } catch (e) { /* already disposed */ }
      }
      disposers.length = 0
      if (typeof auditToolDispose === 'function') {
        try { auditToolDispose() } catch (e) { /* ignore */ }
      }
    } catch (e) {
      // teardown must not throw
    }
  })
}
