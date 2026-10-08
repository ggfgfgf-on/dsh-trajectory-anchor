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

import { readFileSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
// L1：任务锚定信号的**单一实现**（tools/task-anchor-core.mjs 是纯模块，不反向 import 本文件，
// 因此没有循环依赖）。为什么不在这里再写一份：本项目已经两次栽在"两套规则各说各话"
// （台账定稿 51 倍偏差、两级连续计数混层），所以本轮一律共用一份实现。
import {
  parseTaskAnchors, inScope, isIgnorablePath, changeInvalidatesVerification, pathsFromCallStrict, isWriteTool,
} from './tools/task-anchor-core.mjs'

const DEFAULTS = {
  anchorEnabled: true,
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
    // 但它的能力层资格本就是 false（标定 FAIL），所以这里保留历史值 0.01/0.05 并在
    // 标定件接入后按各自的反解值覆盖。
    lexicon: { enabled: true, refMinSteps: 12, testWindow: 4, actAlpha: 0.01, notifyAlpha: 0.05, consecutive: 1, capabilityEligible: false },
  },
  // ── L1 任务锚定拉回（信息型，默认关）──────────────────────────────────────────
  // 它是**第一个把话直接说给模型听**的动作。机制已验证（注入漂移必须触发、措辞/节流/豁免合规），
  // 但**效果**只能靠在线对照或真实长会话积累——离线语料里"可客观标注的漂移"实测为 0
  // （tools/measure-task-signal.mjs：42 个可解析会话里越界写 0、未验证声明 0；
  //   曾经报出的 8 条经人工审计全为假阳）。所以先关、先审计。
  pullbackEnabled: false,
  // 每会话最多说几次（节流见 allostasis 的 admitPerTurn：同一 turn 至多一次）。
  pullbackMaxPerSession: 3,
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

/**
 * 能力层**有效**开关（决策路径必须用这个，而不是直接读 CONFIG.rollbackEnabled）：
 * 配置开关 ∧ 标定件允许 ∧ 未被自动降档 ∧ 不在评测保护下。
 * 任何一项不满足 → 只观察。这是"默认安全"的最后一道闸门。
 */
function effectiveRollback() {
  if (CONFIG.measurementSafe === true) return false
  if (autoDemote) return false
  if (policyArtifact && policyArtifact.verdict !== 'PASS' && policyArtifact.verdict !== 'PARTIAL-PASS') return false
  return CONFIG.rollbackEnabled === true
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
  if (policyArtifact && policyArtifact.verdict !== 'PASS' && policyArtifact.verdict !== 'PARTIAL-PASS') return `policy-${policyArtifact.verdict}`
  if (CONFIG.rollbackEnabled !== true) return 'switch-off'
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
 *  块文件按序号单调追加，永不重写——长任务的事件流因此零丢失。 */
function drainAuditChunk(rec) {
  if (rec.events.length === 0) return
  if (!CONFIG.exportTrajectoryLogs || !fsSvc) { rec.events = []; rec.auditBytes = 0; return }
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

function flushRec(rec) {
  if (!CONFIG.exportTrajectoryLogs || !fsSvc) return Promise.resolve()
  // 主文件只持有当前未满块的缓冲 + 终态 record（每次 flush 重算新鲜摘要）；历史在块文件里。
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
 * pHat 用 Jeffreys 伪计数（a=0.5）估计：否则"历史 0 命中 → p̂=0 → 任何一次命中
 * 都无限显著"。数值示例（参考 20 步全干净、窗 3、命中 2）：p̂=0.0238 → p≈0.0016。
 *
 * @returns 上侧尾概率 P(Binom(m, p̂) ≥ observed)，[0,1]；样本不足返回 1（无证据）。
 */
export function binomialLowerP(observed, m, refHits, refLen, pseudo = 0.5) {
  if (!Number.isFinite(observed) || !Number.isFinite(m) || m <= 0) return 1
  if (!Number.isFinite(refHits) || !Number.isFinite(refLen) || refLen <= 0) return 1
  const pHat = (refHits + pseudo) / (refLen + 2 * pseudo)
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
  logAudit(rec, 'surface', { phase: 'narrowed', denied: CONFIG.leanDenyPatterns.slice(), via, p: round2(p), ratio: round2(rec.weightedRatio) })
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
    const actA = Number.isFinite(c.actAlpha) ? c.actAlpha : CONFIG.actAlpha
    const notA = Number.isFinite(c.notifyAlpha) ? c.notifyAlpha : CONFIG.notifyAlpha
    const hitAct = Number.isFinite(c.p) && c.p <= actA
    const hitNot = Number.isFinite(c.p) && c.p <= notA
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
    if (rec.machineState !== 'stable') recoverRollback(rec, decision.reason)
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

/** 单通道的二值检验输入。 */
function channelTest(name, series) {
  const cfg = (CONFIG.responseChannels && CONFIG.responseChannels[name]) || {}
  const base = {
    name,
    refMinSteps: cfg.refMinSteps || CONFIG.refMinSteps,
    actAlpha: Number.isFinite(cfg.actAlpha) ? cfg.actAlpha : CONFIG.actAlpha,
    notifyAlpha: Number.isFinite(cfg.notifyAlpha) ? cfg.notifyAlpha : CONFIG.notifyAlpha,
    consecutive: Math.max(1, cfg.consecutive ?? 1),
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
  const p = binomialLowerP(observed, m, refHits, reference.length)
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
  for (const name of ['inaction', 'repetition', 'failure']) out.push(channelTest(name, series[name] || []))
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
  rec.contextSuppressed = false
  logAudit(rec, 'context-restored', { ok })
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
 * 只记录"真的动过"的会话（narrowedSteps > 0），不收窄的会话算分母。
 */
function recordSessionOutcome(rec) {
  try {
    if (!(CONFIG.autoDemoteWindow > 0)) return
    sessionOutcomes.push({ narrowed: rec.narrowedSteps > 0 })
    while (sessionOutcomes.length > CONFIG.autoDemoteWindow) sessionOutcomes.shift()
    if (autoDemote) return
    if (sessionOutcomes.length < CONFIG.autoDemoteWindow) return
    const rate = sessionOutcomes.filter((o) => o.narrowed).length / sessionOutcomes.length
    if (rate > CONFIG.autoDemoteBudget) {
      autoDemote = { reason: 'session-rate-over-budget', rate: round2(rate), budget: CONFIG.autoDemoteBudget, window: sessionOutcomes.length, at: Date.now() }
      warnOnce(`auto-demoted to observe-only: ${(rate * 100).toFixed(1)}% of the last ${sessionOutcomes.length} sessions narrowed (budget ${(CONFIG.autoDemoteBudget * 100).toFixed(1)}%)`)
      logAudit(rec, 'auto-demote', { ...autoDemote, note: '能力层与通知层即刻关闭，只保留审计' })
    }
  } catch (e) {
    // 观测侧永不抛
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
    /** 待发出的拉回原因（工具调用时置位，pre-step 时消费；保证"触发点=说出口的点"）。 */
    pendingPullback: null,
    pullback: { count: 0, lastTurn: null, lastReason: null, lastAt: null, suppressed: { throttled: 0, cap: 0, noAnchors: 0 } },
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
    noteHumanMessage(rec, event)
  } else if (event.type === 'tool/result') {
    ledgerNoteToolResult(rec, event.data && event.data.turn, event.data && event.data.step, toolResultText(event))
  } else if (event.type === 'turn/end') {
    // A′ 的关键排除：回合到此结束 ⇒ 最后一格"无工具调用"是合法收尾，不是停手。
    ledgerCloseTurn(rec, event.data && event.data.turn)
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
 */
function noteTaskSignal(rec, event) {
  try {
    const anchors = rec.taskAnchors
    if (!anchors || anchors.parsed !== true) return
    const d = event && event.data
    if (!d) return
    const name = typeof d.name === 'string' ? d.name : ''
    const turn = typeof d.turn === 'number' ? d.turn : null
    const step = typeof d.step === 'number' ? d.step : null
    const args = typeof d.arguments === 'string' ? d.arguments : (d.arguments === undefined ? '' : JSON.stringify(d.arguments))
    const cmd = (() => {
      if (d.arguments && typeof d.arguments === 'object' && typeof d.arguments.command === 'string') return d.arguments.command
      const m = args.match(/"command"\s*:\s*"([^"]*)"/)
      return m ? m[1] : (typeof d.arguments === 'string' && !args.trim().startsWith('{') ? d.arguments : '')
    })()
    // ① 验证运行
    const isVerify = (anchors.verifyTokens || []).some((t) => cmd && cmd.includes(t))
    if (isVerify) {
      rec.lastVerifyAt = { turn, step }
      if (rec.codeEditsAfterVerify.length > 0) {
        logAudit(rec, 'verify-run', { turn, step, clearedEdits: rec.codeEditsAfterVerify.length, cmd: String(cmd).slice(0, 160) })
      }
      rec.codeEditsAfterVerify = []
      // 重新验证会**解决**"未验证"这件事 ⇒ 必须同时清掉待发的提醒，否则会说出过期的提醒。
      // （实测：验证→改码→再验证 之后仍注入了提醒，测试用例 ⑥ 抓出来的。）
      if (rec.pendingPullback && rec.pendingPullback.reason === 'unverified') rec.pendingPullback = null
      return
    }
    // ② 文件改动（**只把写当信号**：越界读是另一类弱信号，本轮刻意不用）
    if (!isWriteTool(name)) return
    for (const path of pathsFromCallStrict(name, d.arguments)) {
      if (isIgnorablePath(path)) continue
      if (!inScope(path, anchors)) {
        const v = { turn, step, tool: name, path, at: Date.now() }
        rec.scopeViolations.push(v)
        if (rec.scopeViolations.length > 50) rec.scopeViolations.shift()
        rec.pendingPullback = { reason: 'scope', turn, step, path, tool: name }
        logAudit(rec, 'scope-violation', { turn, step, tool: name, path, note: '写操作落在提示声明的范围之外' })
        continue
      }
      if (changeInvalidatesVerification(path)) {
        rec.codeEditsAfterVerify.push({ turn, step, path, tool: name })
        if (rec.codeEditsAfterVerify.length > 50) rec.codeEditsAfterVerify.shift()
        if (rec.lastVerifyAt) {
          rec.pendingPullback = { reason: 'unverified', turn, step, path, lastVerifyAt: rec.lastVerifyAt }
        }
      }
    }
  } catch (e) {
    warnOnce(`task-signal scan failed (ignored): ${msg(e)}`)
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
  if (!anchors || anchors.parsed !== true) { rec.pullback.suppressed.noAnchors += 1; return null }
  const pending = rec.pendingPullback
  if (!pending) return null
  if (rec.pullback.count >= CONFIG.pullbackMaxPerSession) {
    rec.pullback.suppressed.cap += 1
    rec.pendingPullback = null
    return null
  }
  if (rec.pullback.lastTurn !== null && rec.pullback.lastTurn === turn) {
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
    capabilityBudgetExhausted: rec.capabilityBudgetExhausted,
    policy: rec.lastPolicy,
    policyAction: rec.lastPolicyAction,
    policyChannel: rec.lastPolicyChannel,
    policyP: rec.lastPolicyP,
    policyReason: rec.lastPolicyReason,
    channels: rec.channels,
    channelWindows,
    ledgerSize: rec.ledger.length,
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
      suppressed: { ...rec.pullback.suppressed },
    },
    lexiconDegenerate: rec.lexiconDegenerate,
    stepsScored: rec.stepsScored,
    positiveHitSteps: rec.positiveHitSteps,
    negativeHitSteps: rec.negativeHitSteps,
    hasCounterfactual: rec.counterfactual !== null,
    // 最近审计种类摘要：让"判定为何没启动"这类问题不必翻日志就能看见
    // （也是 policy-skipped 两档留痕的可测面）。
    auditTail: rec.events.slice(-8).map(e => e.kind),
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
      rewardAnnotator: CONFIG.rewardAnnotator,
    },
    configWarnings: configWarnings.slice(),
    policyArtifact,
    autoDemote,
    capabilityGate: capabilityGateReason(),
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
  CONFIG = cloneDefaults()
  policyArtifact = null
  autoDemote = null
  sessionOutcomes.length = 0
  configWarnings.length = 0
  warned.clear()
  mergeConfig(config)
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
        for (const chName of eligible) {
          if (!CONFIG.responseChannels[chName]) continue
          const derived = (art.channels && art.channels[chName] && art.channels[chName].derived) || null
          CONFIG.responseChannels[chName] = {
            ...CONFIG.responseChannels[chName],
            capabilityEligible: true,
            ...(derived && Number.isFinite(derived.consecutive) ? { consecutive: derived.consecutive } : {}),
            ...(derived && Number.isFinite(derived.alpha) ? { actAlpha: derived.alpha } : {}),
          }
          applied.push(chName)
        }
        policyArtifact = { source: p, verdict: art.verdict, eligibleChannels: applied, corpusFingerprint: art.corpusFingerprint ?? null, generatedAtUtc: art.generatedAtUtc ?? null }
        console.log(`[${name}] response policy loaded from ${p} (verdict=${art.verdict}; eligible: ${applied.join(', ') || '(none)'})`)
      }
    } catch (e) {
      policyArtifact = { source: policyPath, verdict: 'REJECTED', rejectReason: msg(e), eligibleChannels: [] }
      noteConfigWarning(`failed to load response policy from "${policyPath}": ${msg(e)}; capability layer stays off`)
    }
  }

  agentsSvc = ctx.get('agents')
  fsSvc = ctx.get('fs')
  spSvc = ctx.get('sandboxPolicy')

  if (spSvc && typeof spSvc.workspaceRoot === 'string' && spSvc.workspaceRoot.length > 0) baseDir = spSvc.workspaceRoot

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
      if (pull && decision && Array.isArray(decision.messages)) {
        rec.pullback.count += 1
        rec.pullback.lastTurn = typeof payload.turn === 'number' ? payload.turn : null
        rec.pullback.lastReason = pull.reason
        rec.pullback.lastAt = Date.now()
        rec.pendingPullback = null
        logAudit(rec, 'pullback', {
          reason: pull.reason, turn: payload.turn, step: payload.step,
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
