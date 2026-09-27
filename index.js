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
  rollbackEnabled: true,
  lexicon: {
    positive: { we: 2, "let's": 1.5, "we'll": 1.2, 'we need': 1.2, our: 0.8 },
    negative: { 'let me': 3 },
    neutral: { 'i will': 1, "i'll": 1, 'i need': 0.8, check: 0.4, verify: 0.4 },
  },
  ratioWeights: { alpha: 2, beta: 0.5, gamma: 1.5, epsilon: 1 },
  lexiconPath: null,
  specMax: 0.2,
  reactMin: 0.5,
  baselineMinSamples: 10,
  rollbackPercentile: 25,
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
  const percentile = percentileRank(ratio, rec.ratioHistory)
  rec.weightedRatio = ratio
  rec.personaRatio = pr
  rec.band = band
  rec.percentile = percentile === null ? null : Math.round(percentile * 10) / 10
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

function applyRollback(rec, agent, via) {
  if (!CONFIG.rollbackEnabled) return
  if (!rec.anchored || !rec.lifted) return
  if (rec.rollbackLift) return
  const probe = probeFor(agent)
  if (probe.error) {
    logAudit(rec, 'rollback-failed', { error: probe.error, via })
    return
  }
  const deny = probe.visible.filter(n => matchPatterns(n, CONFIG.leanDenyPatterns))
  if (deny.length === 0) {
    logAudit(rec, 'rollback-skipped', { reason: 'no deny matches', visibleCount: probe.visible.length, via })
    return
  }
  const scopedTools = agent.ctx && agent.ctx.tools
  if (!scopedTools || typeof scopedTools.restrict !== 'function') {
    logAudit(rec, 'rollback-failed', { error: 'agent.ctx.tools.restrict unavailable', via })
    return
  }
  const outcome = restrictWithCull(scopedTools, { deny })
  if (outcome.error) {
    logAudit(rec, 'rollback-failed', { error: outcome.error, via })
    return
  }
  rec.rollbackLift = outcome.lift
  rec.rollbackDeny = outcome.applied.slice()
  if (CONFIG.mineCounterfactualCandidates) {
    rec.counterfactual = {
      startedAt: Date.now(),
      decisionPoint: 'drift-entry',
      injected: outcome.applied.slice(),
      requests: rec.requests,
      turn: rec.lastTurn,
      step: rec.lastStep,
      restored: null,
    }
  }
  logAudit(rec, 'rollback', { deny: outcome.applied.slice(), ratio: round2(rec.weightedRatio), percentile: rec.percentile, via })
}

function enterDrift(rec, agent, via) {
  rec.machineState = 'drift'
  rec.driftSteps = 1
  rec.driftEnteredAt = Date.now()
  rec.rollbackAttempted = false
  logAudit(rec, 'state', { state: 'drift', via, band: rec.band, percentile: rec.percentile })
  applyRollback(rec, agent, 'drift-entry')
}

function recoverRollback(rec, reason) {
  rec.machineState = 'stable'
  rec.driftSteps = 0
  rec.rollbackAttempted = false
  if (typeof rec.rollbackLift === 'function') {
    try {
      rec.rollbackLift()
      rec.rollbackLift = null
    } catch (e) {
      logAudit(rec, 'rollback-lift-error', { error: msg(e) })
    }
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

function stateMachine(rec, agent) {
  const prev = rec.machineState
  if (prev === 'drift') {
    rec.driftSteps += 1
    if (rec.anchored && rec.lifted && !rec.rollbackLift && !rec.rollbackAttempted) {
      rec.rollbackAttempted = true
      applyRollback(rec, agent, 'drift-retry')
    }
    if (rec.band === 'spec' && rec.driftSteps >= CONFIG.minDriftSteps) {
      recoverRollback(rec, 'spec-band')
    }
    return
  }
  if (rec.band === 'spec') {
    if (prev !== 'stable') {
      rec.machineState = 'stable'
      logAudit(rec, 'state', { state: 'stable', via: 'spec-band' })
    }
    return
  }
  if (rec.band === 'mixed') {
    if (prev !== 'watch') {
      rec.machineState = 'watch'
      logAudit(rec, 'state', { state: 'watch', band: 'mixed' })
    }
    return
  }
  const baselineReady = rec.ratioHistory.length >= CONFIG.baselineMinSamples
  const degraded = baselineReady && rec.percentile !== null && rec.percentile < CONFIG.rollbackPercentile
  if (degraded) {
    enterDrift(rec, agent, 'react-band+percentile')
    return
  }
  if (prev !== 'watch') {
    rec.machineState = 'watch'
    logAudit(rec, 'state', { state: 'watch', band: 'react', baselineReady, percentile: rec.percentile })
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
  rec.contextSuppressed = false
  logAudit(rec, 'context-restored', { ok })
}

function anchorAgent(agent, rec, channel) {
  const probe = probeFor(agent)
  if (probe.error) {
    rec.anchorError = probe.error
    logAudit(rec, 'anchor-failed', { error: probe.error, channel })
    return
  }
  const candidates = CONFIG.bootstrapTools.filter(n => probe.visible.includes(n))
  if (candidates.length === 0) {
    logAudit(rec, 'anchor-skipped', { reason: 'no bootstrap tool visible to agent', visibleCount: probe.visible.length, channel })
    return
  }
  const scopedTools = agent.ctx && agent.ctx.tools
  if (!scopedTools || typeof scopedTools.restrict !== 'function') {
    rec.anchorError = 'agent.ctx.tools.restrict unavailable'
    logAudit(rec, 'anchor-failed', { error: rec.anchorError, channel })
    return
  }
  const outcome = restrictWithCull(scopedTools, { allow: candidates })
  if (outcome.error) {
    rec.anchorError = outcome.error
    logAudit(rec, 'anchor-failed', { error: outcome.error, channel })
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
    anchorAllow: [],
    restrictLift: null,
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
    driftEnteredAt: null,
    rollbackLift: null,
    rollbackDeny: [],
    rollbackAttempted: false,
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
  } else if (event.type === 'assistant/message') {
    rec.messages += 1
    const turn = event.data && event.data.turn
    const step = event.data && event.data.step
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
  return {
    sessionId: rec.sessionId,
    self: rec.adoptedSelf,
    anchored: rec.anchored,
    anchorChannel: rec.anchorChannel,
    anchorError: rec.anchorError,
    anchorAllow: rec.anchorAllow,
    lifted: rec.lifted,
    liftReason: rec.liftReason,
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
    hasCounterfactual: rec.counterfactual !== null,
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
      baselineMinSamples: CONFIG.baselineMinSamples,
      rollbackPercentile: CONFIG.rollbackPercentile,
      rollbackEnabled: CONFIG.rollbackEnabled,
      suppressSkillCatalog: CONFIG.suppressSkillCatalog,
      rewardAnnotator: CONFIG.rewardAnnotator,
    },
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
    if (!CONFIG_KEYS.has(key)) { console.error(`[${name}] unknown config key "${key}"`); continue }
    if (key === 'lexicon') {
      const l = config[key]
      if (!l || typeof l !== 'object' ||
        typeof l.positive !== 'object' || typeof l.negative !== 'object' || typeof l.neutral !== 'object') {
        console.error(`[${name}] invalid inline lexicon (needs positive/negative/neutral buckets); keeping current lexicon`)
        continue
      }
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
