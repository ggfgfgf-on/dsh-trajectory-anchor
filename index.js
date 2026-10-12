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

import { readFileSync, mkdirSync, appendFileSync, existsSync, readdirSync, writeFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, resolve as resolvePath, dirname as dirname2 } from 'node:path'
// L1：任务锚定信号的**单一实现**（tools/task-anchor-core.mjs 是纯模块，不反向 import 本文件，
// 因此没有循环依赖）。为什么不在这里再写一份：本项目已经两次栽在"两套规则各说各话"
// （台账定稿 51 倍偏差、两级连续计数混层），所以本轮一律共用一份实现。
import {
  parseTaskAnchors, inScope, isIgnorablePath, changeInvalidatesVerification, pathsFromCallStrict, isWriteTool, isReadTool,
  verifyCommandKind, claimsFromFinalMessage, commandPaths,
} from './tools/task-anchor-core.mjs'
// 纠偏线索**共用离线标注那一份**（`drift-label-core` 零依赖、只读）：避免"标注用的判据"
// 与"运行时触发的判据"各写一份、然后悄悄漂移（本项目在台账与形态识别上各栽过一次）。
import { CORRECTION_CUES } from './tools/drift-label-core.mjs'

// 瘦身重构（§61）：以下内部参数不再暴露为配置键——历史默认值固化为常量。
const TRAJECTORY_WINDOW = 3
const EWMA_ALPHA = 0.4
const RATIO_WEIGHTS = { alpha: 2, beta: 0.5, gamma: 1.5, epsilon: 1 }
const SPEC_MAX = 0.2
const REACT_MIN = 0.5
const HISTORY_CAP = 200
const REWARD_ANNOTATOR = 'default'

const DEFAULTS = {
  anchorEnabled: true,
  bootstrapTools: ['bash', 'str_replace_editor', 'pwsh'],
  bootstrapMaxTokens: null,
  bootstrapPersona: 'You are a helpful software engineer assistant.',
  gateEnabled: true,
  maxBootstrapSteps: 5,
  suppressContextOnBootstrap: true,
  suppressSkillCatalog: true,
  suppressedSources: ['skill-catalog'],
  lexicon: {
    positive: { we: 2, "let's": 1.5, "we'll": 1.2, 'we need': 1.2, our: 0.8 },
    negative: { 'let me': 3 },
    neutral: { 'i will': 1, "i'll": 1, 'i need': 0.8, check: 0.4, verify: 0.4 },
  },
  lexiconPath: null,
  // L1 pullback (informational): on a scope/verification gap, inject a reminder
  // into the prompt. Throttled to at most pullbackMaxPerSession per session.
  pullbackEnabled: false,
  pullbackMaxPerSession: 3,
  // Control-group rate for L4 online effect measurement; 0 = never suppress.
  pullbackControlRate: 0,
  // L2' confirm-reanchor: on in-turn confirmation (user correction / missing tool
  // / failed verification), re-inject the first-round Minimal payload once.
  // Randomized control rate for effect measurement.
  reanchorOnConfirm: false,
  reanchorConfirmControlRate: 0,
  pullbackOutcomePath: null,
  exportTrajectoryLogs: true,
  logDir: '.dsh-trajectory-logs',
  auditChunkEvents: 400,
  auditChunkBytes: 262144,
}

const CONFIG_KEYS = new Set(Object.keys(DEFAULTS))

export const name = 'dsh-trajectory-anchor'

/** 0.2.0 renamed the session event read: `session.events` property -> `session.snapshotEvents()` method. */
function sessionEventList(session) {
  if (!session) return []
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
  const legacy = session.events
  if (legacy === undefined || legacy === null) return []
  return Array.isArray(legacy) ? legacy : Array.from(legacy)
}
// Belt-and-braces: also expose globally in case a bundling boundary splits scope.
if (typeof globalThis !== 'undefined') globalThis.sessionEventList = sessionEventList

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
  const w = RATIO_WEIGHTS
  return (w.alpha * agg.positive + w.beta * agg.neutral) / (w.gamma * agg.negative + w.epsilon)
}

function personaRatio(agg) {
  const denom = agg.positiveWords + agg.negativeWords
  return denom === 0 ? 0 : agg.negativeWords / denom
}

function bandOf(ratio) {
  if (ratio < SPEC_MAX) return 'spec'
  if (ratio < REACT_MIN) return 'mixed'
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
  if (rec.ratioHistory.length > HISTORY_CAP) rec.ratioHistory.shift()
  // band / personaRatio / percentile：**仅供审计与离线标定**——标定工具
  // （calibrate-lexicon-v2、calibrate-response-policy）都从轨迹日志读这些字段。
  // 决策路径一律不得读它们（断言 C11 守护）；漂移判定已改为会话内自参考检验。
  rec.bandHistory.push(band)
  if (rec.bandHistory.length > HISTORY_CAP) rec.bandHistory.shift()
  const percentile = percentileRank(ratio, rec.ratioHistory)
  rec.weightedRatio = ratio
  rec.personaRatio = pr
  rec.band = band
  rec.percentile = percentile === null ? null : Math.round(percentile * 10) / 10
  // P5 词典非退化闸门所需：本会话累计的"桶是否命中过"证据。
  rec.stepsScored += 1
  if (agg.positiveWords > 0) rec.positiveHitSteps += 1
  if (agg.negativeWords > 0) rec.negativeHitSteps += 1
  const degen = lexiconDegenerate(rec.positiveHitSteps, rec.stepsScored, 12)
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
  else rec.ewma = EWMA_ALPHA * ratio + (1 - EWMA_ALPHA) * rec.ewma
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
}

function updateWindow(rec, texts, agent) {
  if (texts.length > 0) {
    rec.lastMessages.push({ flags: flagsOf(texts) })
    while (rec.lastMessages.length > TRAJECTORY_WINDOW) rec.lastMessages.shift()
  }
  recompute(rec, agent)
}

function backfill(rec, agent) {
  try {
    const events = agent && agent.session ? sessionEventList(agent.session) : undefined
    if (!events) return
    const list = Array.isArray(events) ? events : Array.from(events)
    let assistantCount = 0
    for (const ev of list) {
      if (ev && ev.type === 'assistant/message') {
        assistantCount += 1
        const texts = reasoningBlocks(ev)
        if (texts.length > 0) {
          rec.lastMessages.push({ flags: flagsOf(texts) })
          while (rec.lastMessages.length > TRAJECTORY_WINDOW) rec.lastMessages.shift()
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
  // 瘦身重构（§61）：首轮工具面**不再调用注册层 restrict**——组装期派生
  // （unpromoted ⇒ 只发 anchorAllow 里的工具）。restrict 的相交语义 + disposer
  // 单引用曾造成"上下文恢复、工具面回不来"的分裂（18 会话永久停在 23 的旧账 +
  // 用户实报症状），派生面无 disposer、无相交、无归还——分裂被结构性消灭。
  rec.anchored = true
  rec.anchorChannel = channel
  rec.anchorAllow = candidates.slice()
  const capNote = CONFIG.bootstrapMaxTokens === null || CONFIG.bootstrapMaxTokens === undefined
    ? 'no cap (opt-in per issue #85)'
    : CONFIG.bootstrapMaxTokens
  logAudit(rec, 'anchored', { allow: rec.anchorAllow.slice(), maxTokens: capNote, channel })
  suppressBootstrapContext(rec, agent)
}

function lift(rec, reason) {
  if (rec.lifted || rec.closed) return
  rec.lifted = true
  rec.liftReason = reason
  rec.liftedAt = Date.now()
  // 派生面：没有任何 disposer 要调——阶段一翻，下一次组装自然恢复全量。
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
  const annotator = REWARD_ANNOTATORS[REWARD_ANNOTATOR] || REWARD_ANNOTATORS.default
  try {
    rec.reward = annotator(rec)
    logAudit(rec, 'reward', rec.reward)
  } catch (e) {
    rec.reward = { planner: REWARD_ANNOTATOR, error: msg(e) }
    logAudit(rec, 'reward-error', { error: msg(e) })
  }
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
  const why = info && info.confirm ? `（确认信号：${CONFIRM_LABEL[info.confirm] || info.confirm}）` : ''
  return `[trajectory-anchor] 已确认出问题${why}，回到首轮任务骨架：`
    + `\n\n${persona}`
    + '\n\n（信息型提醒：把已知有效的首轮载荷放回近因位置；如已按此工作，忽略本条即可。）'
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

/** L2'（确认即恢复）是否被允许：装配开关开、且本会话还没消费过确认。 */
function confirmReanchorAllowed(rec) {
  if (CONFIG.reanchorOnConfirm !== true) return false
  return true
}

/**
 * L2' 重锚定决策（唯一路径=当场确认）：`reanchorOnConfirm` ∧ **当场确认过**
 * （user-correction / unknown-tool / verify-failed）——把已知有效的首轮载荷放回近因位置。
 * 每会话一次、全程留痕。
 */
function reanchorDecision(rec, turn) {
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
  annotateReward(rec)
  rec.closed = true
  // L1 效果采集：按触发点结算观测窗口并落盘。
  recordPullbackOutcome(rec)
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
    const events = sessionEventList(session)
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
    // P3：会话内自参考偏离检验的输入与结论。
    stepsScored: 0,
    positiveHitSteps: 0,
    negativeHitSteps: 0,
    lexiconDegenerate: null,
    // ── L1 任务锚定拉回（默认关）────────────────────────────────────────────
    // anchors 从**首条人类消息**解析（读不出就 parsed:false，绝不猜）；下列状态全部为审计可见。
    taskAnchors: null,
    anchorsFromMessage: null,
    lastVerifyAt: null,
    codeEditsAfterVerify: [],
    scopeViolations: [],
    // ── 证据捕获：全部 append-only、有界、只存叶子字段 ──────
    verifyEvidence: [],   // 每次验证运行一条：{turn,step,at,kind,cmd,artifacts,failed,failCount,outputTail}
    edits: [],            // 每次**落地**的写：{turn,step,tool,path,invalidates,at}
    claims: [],           // 每次完成/通过声明：{turn,step,text,claimedDone,claimedPass,claimedTotal}
    lastVerifyCmd: null,  // 最近一次验证命令（结果回来时补全证据记录）
    lastVerifyKind: null,
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
    sawUnknownTool: false,
    verifyKinds: {},           // 本会话实际跑过的验证命令形态（L1"未验证"信号的第二种来源）
    pullbackOutcome: null,
    bandHistory: [],        // 审计用：personaRatio 导出的波段序列（离线回放读日志）
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
  } else if (event.type === 'session') {
  } else if (event.type === 'tool/result') {
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
          const m = txt.match(/failed=(\d+)/) || txt.match(/(\d+) failed/)
          failCount = m ? Number(m[1]) : null
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
  } else if (event.type === 'assistant/message') {
    rec.messages += 1
    const turn = event.data && event.data.turn
    const step = event.data && event.data.step
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
          rec.claimedDoneAt = { turn: turn ?? null, step: step ?? null }
          // 观测台账：每次完成/通过声明都记一条（含原文，有界）。
          rec.claims.push({
            turn: turn ?? null, step: step ?? null,
            text: claimText.slice(0, 2000),
            claimedDone: c.claimedDone === true, claimedPass: c.claimedPass, claimedTotal: c.claimedTotal,
          })
          if (rec.claims.length > 20) rec.claims.shift()
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
    evidence: {
      verifyEvidence: rec.verifyEvidence.length,
      edits: rec.edits.length,
      claims: rec.claims.length,
    },
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
    // L2'（确认即恢复）：开关、是否被允许、当前确认信号、对照比例 —— 全部可见
    reanchor: {
      onConfirm: CONFIG.reanchorOnConfirm === true,
      count: rec.reanchor.count,
      lastTurn: rec.reanchor.lastTurn,
      suppressed: { ...rec.reanchor.suppressed },
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
  for (const rec of recs.values()) {
    if (filter && rec.sessionId !== filter) continue
    if (rec.anchored) anchoredCount += 1
    if (rec.lifted) liftedCount += 1
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
    lexicon: {
      source: CONFIG.lexiconPath ? String(CONFIG.lexiconPath) : 'default',
      positive: Object.keys(CONFIG.lexicon.positive).length,
      negative: Object.keys(CONFIG.lexicon.negative).length,
      neutral: Object.keys(CONFIG.lexicon.neutral).length,
      ratioWeights: { ...RATIO_WEIGHTS },
    },
    config: {
      gateEnabled: CONFIG.gateEnabled,
      suppressContextOnBootstrap: CONFIG.suppressContextOnBootstrap,
      // 抑制清单必须可见：否则"到底摘掉了什么"只能翻源码
      suppressedSources: CONFIG.suppressedSources.slice(),
      bootstrapPersona: CONFIG.bootstrapPersona,
      bootstrapMaxTokens: CONFIG.bootstrapMaxTokens,
      suppressSkillCatalog: CONFIG.suppressSkillCatalog,
      pullbackEnabled: CONFIG.pullbackEnabled === true,
      pullbackMaxPerSession: CONFIG.pullbackMaxPerSession,
      pullbackControlRate: CONFIG.pullbackControlRate,
      reanchorOnConfirm: CONFIG.reanchorOnConfirm === true,
      reanchorConfirmControlRate: CONFIG.reanchorConfirmControlRate,
      pullbackOutcomePath: CONFIG.pullbackOutcomePath || null,
    },
    configWarnings: configWarnings.slice(),
    listAtApply,
    tracked: recs.size,
    anchored: anchoredCount,
    lifted: liftedCount,
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
    if (key === 'lexicon') {
      const l = config[key]
      if (!l || typeof l !== 'object' ||
        typeof l.positive !== 'object' || typeof l.negative !== 'object' || typeof l.neutral !== 'object') {
        noteConfigWarning('invalid inline lexicon (needs positive/negative/neutral buckets); keeping current lexicon')
        continue
      }
    }
    CONFIG[key] = config[key]
  }
}

/**
 * 从 DEFAULTS 深拷贝一份运行时配置。
 *
 * 为什么必须深拷贝 + 每次挂载重播种：
 *   · `{ ...DEFAULTS }` 是浅拷贝 ⇒ 嵌套对象会与 DEFAULTS 共享同一引用；
 *   · `apply` 可能在同一个进程内被**再次调用**（热重载），沿用上一轮的 CONFIG
 *     会让旧配置值粘住（"改了配置行为却不变"）。
 * 因此每次挂载都从 DEFAULTS 重新播种。
 */
function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULTS))
}

export function apply(ctx, config) {
  // 派生状态：每次挂载重算（配置 + 产物算出来的东西）——必须清空。
  CONFIG = cloneDefaults()
  configWarnings.length = 0
  warned.clear()
  try {
    PLUGIN_VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version || 'unknown'
  } catch (e) {
    PLUGIN_VERSION = 'unknown'
  }
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
            if (rec.anchored && !rec.lifted
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
      if (!rec) return out
      // 瘦身重构（§61）：bootstrap 工具面在组装期**派生**——unpromoted ⇒ 只发 anchorAllow
      // 里的工具；无 disposer、无相交、无归还（旧 restrict 分裂 bug 结构性消灭）。
      if (rec.anchored === true && rec.lifted !== true && Array.isArray(rec.anchorAllow) && rec.anchorAllow.length > 0 && Array.isArray(out.tools)) {
        const boot = out.tools.filter((t) => t && rec.anchorAllow.includes(t.name))
        if (boot.length > 0) return { ...out, tools: boot }
        // 清单与可见面零交集 ⇒ fail-open 全量（能力永远优先）。
      }
      return out
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
          afterPullbacks: rec.pullback.count,
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
      description: 'Read the live audit state of the trajectory-anchor plugin: anchored agents, '
        + 'bootstrap tool allow-lists, promotion-gate state, bootstrap context suppression, lexicon-weighted trajectory '
        + 'scores (ratio / persona-ratio bands / baseline percentile), evidence capture, and pullback/reanchor state.',
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
