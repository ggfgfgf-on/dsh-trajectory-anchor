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
  notifyAlpha: 0.05,    // 通知预算（p ≤ 该值 → 通知，不动能力）
  actAlpha: 0.01,       // 能力层预算（更严；还需通道有资格 + 开关打开）
  // ── 行为通道（B1）────────────────────────────────────────────────────────
  // 为什么加：词表信号实测无判别力（会话级误触发 15.9%–43.2%，预算 5%）；行为通道
  //   的实测空转侧：A′ 中途停手 0/26 会话、C 重复调用 0/26、B 工具失败 12/26（46%）。
  //   → A′/C 够格驱动能力层，B 只做通知（见 docs/community-reference-matrix.md）。
  // A′ 的定义**必须**带"回合未结束"硬条件：实测 67 个"无工具调用"步 100% 是回合末步
  //   （代理干完活回答了），不分回合末步就是 100% 误判。
  // capabilityEligible 默认全 false：由标定件（responsePolicy.json）按预算翻转。
  responseChannels: {
    inaction: { enabled: true, refMinSteps: 20, testWindow: 3, capabilityEligible: false },
    repetition: { enabled: true, refMinSteps: 20, testWindow: 3, window: 5, minRepeats: 2, capabilityEligible: false },
    failure: { enabled: true, refMinSteps: 20, testWindow: 3, capabilityEligible: false },
    lexicon: { enabled: true, refMinSteps: 12, testWindow: 4, capabilityEligible: false },
  },
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

function round2(n) {
  return Math.round(n * 100) / 100
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
  const none = { channel: null, p: null, perChannel: chans.map((c) => ({ name: c.name, p: Number.isFinite(c.p) ? round2(c.p) : null })) }
  if (usable.length === 0) {
    return {
      ...none,
      level: 'stable',
      action: 'none',
      reason: anyWindow ? 'insufficient-reference' : 'no-observation',
    }
  }
  const byP = usable.slice().sort((a, b) => a.p - b.p)
  const strong = byP.filter((c) => c.p <= input.actAlpha)
  const weak = byP.filter((c) => c.p <= input.notifyAlpha)
  const notice = input.notifyEnabled === true ? 'notice' : 'none'
  if (strong.length > 0) {
    // OR 入口的正确语义：**任一"有资格"的通道够强即可收窄**。
    // 不能只看 p 最小的那条——否则一条无资格通道（p 更小）会挡住另一条有资格通道
    // 本该成立的收窄（这条语义错误是被回归用例 H/I/J 里的 "OR 入口" 用例抓出来的）。
    const strongEligible = strong.filter((c) => c.capabilityEligible === true)
    const pick = strongEligible.length > 0 ? strongEligible[0] : strong[0]
    if (input.rollbackEnabled !== true) {
      return { ...none, level: 'narrowed', action: notice, reason: input.notifyEnabled === true ? 'capability-disabled' : 'observe-only', channel: pick.name, p: round2(pick.p) }
    }
    if (strongEligible.length === 0) {
      return { ...none, level: 'narrowed', action: notice, reason: pick.blockedBy || 'channel-not-eligible', channel: pick.name, p: round2(pick.p) }
    }
    if (input.budgetExhausted === true) {
      return { ...none, level: 'narrowed', action: notice, reason: 'capability-budget-exhausted', channel: pick.name, p: round2(pick.p) }
    }
    return { ...none, level: 'narrowed', action: 'narrow', reason: 'deviation', channel: pick.name, p: round2(pick.p) }
  }
  if (weak.length > 0) {
    const pick = weak[0]
    return { ...none, level: 'watch', action: notice, reason: input.notifyEnabled === true ? 'deviation-weak' : 'observe-only', channel: pick.name, p: round2(pick.p) }
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
  if (!CONFIG.rollbackEnabled) return
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
  const decision = evaluateChannels({
    perChannel,
    refMinSteps: CONFIG.refMinSteps,
    notifyAlpha: CONFIG.notifyAlpha,
    actAlpha: CONFIG.actAlpha,
    budgetExhausted: Boolean(rec.capabilityBudgetExhausted),
    rollbackEnabled: Boolean(CONFIG.rollbackEnabled),
    notifyEnabled: Boolean(CONFIG.notifyEnabled),
  })
  rec.channels = perChannel.map((c) => ({
    name: c.name,
    p: Number.isFinite(c.p) ? round2(c.p) : null,
    observed: c.observed,
    window: c.window,
    refLen: c.refLen,
    refHits: c.refHits,
    eligible: c.capabilityEligible === true,
  }))
  rec.lastPolicy = decision.level
  rec.lastPolicyAction = decision.action
  rec.lastPolicyP = decision.p === null || decision.p === undefined ? null : round2(decision.p)
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
  if (cfg.enabled === false) return { name, p: null, refLen: 0, refMinSteps: cfg.refMinSteps || CONFIG.refMinSteps, capabilityEligible: false, blockedBy: 'channel-disabled' }
  const m = cfg.testWindow || CONFIG.testWindow
  const refLen = series.length - m
  if (refLen < 1) {
    return { name, p: null, refLen, refMinSteps: cfg.refMinSteps || CONFIG.refMinSteps, capabilityEligible: cfg.capabilityEligible === true }
  }
  const test = series.slice(series.length - m)
  const reference = series.slice(0, series.length - m)
  const observed = test.reduce((a, b) => a + b, 0)
  const refHits = reference.reduce((a, b) => a + b, 0)
  const p = binomialLowerP(observed, m, refHits, reference.length)
  return {
    name,
    p,
    refLen: reference.length,
    refMinSteps: cfg.refMinSteps || CONFIG.refMinSteps,
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
    channels: null,
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

function summaryOf(rec) {
  // 行为通道的**实时**窗口（与判定走同一套 channelTest；`channels` 是上次判定时的快照，
  // 而台账在 turn/end 之后还会被定稿，所以两者会短暂不同——这里把"现在"也暴露出来）。
  let channelWindows = null
  try {
    const live = channelSeries(rec)
    channelWindows = {}
    for (const nm of ['inaction', 'repetition', 'failure']) {
      const t = channelTest(nm, live[nm] || [])
      channelWindows[nm] = { observed: t.observed ?? null, window: t.window ?? null, refLen: t.refLen, p: Number.isFinite(t.p) ? round2(t.p) : null }
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
      suppressSkillCatalog: CONFIG.suppressSkillCatalog,
      rewardAnnotator: CONFIG.rewardAnnotator,
    },
    configWarnings: configWarnings.slice(),
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

export function apply(ctx, config) {
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
      if (!CONFIG.rollbackEnabled) return out
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
