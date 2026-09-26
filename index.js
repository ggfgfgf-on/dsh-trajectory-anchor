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
 */

import { contrastPolarity, ngrams } from './tools/lexicon-core.mjs'

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
  // 名字提示的内置词典（可选）：model/provider 名字只是提示，候选词典照样要
  // 过输出拟合检测——输出对不上就弃用。键可以是模型名或供应商名。
  lexiconProfiles: {},
  // 词典的识别、选择、积累、合并全部针对输出文本：
  //   开头探测：拿候选词典（默认 + 已标定桶 + 名字提示的 profile）对会话开头
  //     的输出做拟合检测（标记命中率 + 比率离散度）——输出说话，名字不说话；
  //   自动标定桶：按「输出风格签名」（本会话高分/低分样本的 contrast 词条）匹配
  //     或新建桶，名字只是桶上的标签。同名模型换了风格→自动开新桶；
  //     不同名模型风格相同→自动合并进同一个桶。
  lexiconAuto: {
    enabled: true,
    // 开头适配探测：候选词典对该会话前几段输出做拟合检测。
    probeMaxBlocks: 8,
    probeMinChars: 2500,
    probeMinBlocks: 4,
    probeMinHitRate: 0.25,
    probeMinSignalBlocks: 3,
    probeMinRatioSpread: 0.15,
    // 风格签名匹配阈值：会话签名与桶签名的词条 Jaccard ≥ 该值才并入该桶。
    bucketMatchThreshold: 0.25,
    // 极性神谕：bootstrap 期（锚定阶段）是该模型的已知良好状态。
    // 若某候选词典把 bootstrap 期判为负向主导（如豆包的 let-me 锚定风），
    // 说明该词典对此模型的极性是反的 → 不采用，走自动标定（用 bootstrap 块当正样本）。
    polarityMinBootstrapBlocks: 3,
    minSessions: 3,
    minChars: 40000,
    maxChars: 160000,
    concentrationScale: 0.5,
    minStability: 0.6,
    percentileHigh: 75,
    percentileLow: 25,
    minFreq: 5,
    top: 60,
  },
  ratioWeights: { alpha: 2, beta: 0.5, gamma: 1.5, epsilon: 1 },
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
// 输出风格桶（跨重启持久化）：识别与积累都靠输出签名，名字只是标签。
// 每个桶: { id, names: [model/provider 标签], sessions, chars, samples: [{text,percentile}],
//           signature: [contrast 词条], lexicon: {positive,negative,neutral}|null,
//           targetChars, concentration, lastStability, calibratedAt }
const lexiconBuckets = []

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

/** 词条 → 匹配正则：纯 ASCII 词条用 \b 词边界（英文词语义）；
 *  含非 ASCII 的词条（中文/假名/谚文等）\b 永不成立（CJK 字符非 \w），
 *  必须按字面子串匹配——否则标定出的中文词条在运行时永远命中不了。 */
function termRegex(term, flags) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')
  const asciiOnly = /^[\x20-\x7e]+$/.test(term)
  return new RegExp(asciiOnly ? '\\b' + escaped + '\\b' : escaped, flags)
}

function measureText(text, lexicon) {
  if (!lexicon) lexicon = CONFIG.lexicon
  const normalized = text.replace(/[\u2018\u2019]/g, "'")
  const lower = normalized.toLowerCase()
  let positive = 0
  let negative = 0
  let neutral = 0
  let positiveWords = 0
  let negativeWords = 0
  for (const term of Object.keys(lexicon.positive || {})) {
    const n = (lower.match(termRegex(term, 'g')) || []).length
    if (n > 0) {
      positive += n * lexicon.positive[term]
      positiveWords += n
    }
  }
  for (const term of Object.keys(lexicon.negative || {})) {
    const n = (lower.match(termRegex(term, 'g')) || []).length
    if (n > 0) {
      negative += n * lexicon.negative[term]
      negativeWords += n
    }
  }
  for (const term of Object.keys(lexicon.neutral || {})) {
    const n = (lower.match(termRegex(term, 'g')) || []).length
    if (n > 0) neutral += n * lexicon.neutral[term]
  }
  // 极性语义与具体词无关：正/负命中由当前词典的标记词决定，
  // 换一套词典（如 let-me 为正向的桶词典）这些计数自动跟着翻转。
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

function flagsOf(texts, lexicon) {
  const flags = []
  for (const text of texts) flags.push(measureText(text, lexicon))
  return flags
}

/** 风格样本积累：探测未判「匹配」的都先攒着（探测期样本在判定匹配时丢弃，
 *  判定不匹配时留作自动标定语料）。收集不依赖任何名字——只看输出。 */
function sampleStyle(rec, texts) {
  const auto = CONFIG.lexiconAuto
  if (!auto || auto.enabled === false) return
  if (rec.lexiconMismatch === false) return
  const joined = texts.join('\n')
  if (joined.length < 40) return
  rec.styleSamples.push({ text: joined, percentile: rec.percentile, anchored: !!(rec.anchored && !rec.lifted) })
  if (rec.styleSamples.length > 400) rec.styleSamples.shift()
}

// ---------- 开头适配探测：哪个候选词典读得懂这段输出？ ----------

function newProbe() {
  return { blocks: 0, chars: 0, texts: [], extended: 0 }
}

/** 探测只吃「自然风格」：锚定会话在 lift 之后才开始，因为 bootstrap 期
 *  是 Minimal persona 强灌的 we 风格，不能代表模型本色。 */
function probeFeed(rec, texts, flags) {
  const auto = CONFIG.lexiconAuto
  if (!auto || auto.enabled === false) return
  if (rec.lexiconMismatch !== null) return
  if (rec.anchored && !rec.lifted) return
  if (!Array.isArray(flags) || flags.length === 0) return
  const p = rec.probe
  const baseBlocks = typeof auto.probeMaxBlocks === 'number' ? auto.probeMaxBlocks : 8
  const baseChars = typeof auto.probeMinChars === 'number' ? auto.probeMinChars : 2500
  const maxBlocks = baseBlocks * (1 + (p.extended || 0))
  const minChars = baseChars * (1 + (p.extended || 0))
  for (let i = 0; i < flags.length; i++) {
    if (p.blocks >= maxBlocks || p.chars >= minChars) break
    p.blocks += 1
    p.chars += (texts[i] || '').length
    p.texts.push(texts[i] || '')
  }
  if (p.blocks >= maxBlocks || p.chars >= minChars) {
    // 窗口满但标记信号还太少：开头几块可能恰好是标记稀疏的文本（中文为主等），
    // 一锤定音会误判。证据不足就扩窗继续采样（最多 2 次扩窗）。
    const signal0 = probeFit(rec.lexicon, p.texts).signalBlocks
    const minSignal = typeof auto.probeMinSignalBlocks === 'number' ? auto.probeMinSignalBlocks : 3
    if (signal0 < minSignal && (p.extended || 0) < 2) {
      p.extended = (p.extended || 0) + 1
      logAudit(rec, 'lexicon-probe-extend', { blocks: p.blocks, chars: p.chars, signalBlocks: signal0, extended: p.extended, hint: 'marker signal too thin to decide; widening the probe window' })
      return
    }
    selectLexicon(rec)
  }
}

/** 单个词典对一段输出的拟合指标：标记命中率（词条出现得多不多）
 *  × 比率离散度（词典能否把不同推理块区分开）。 */
function probeFit(lexicon, texts) {
  let signalBlocks = 0
  const ratios = []
  for (const t of texts) {
    const f = measureText(t, lexicon)
    const signal = f.positive + f.neutral + f.negative
    if (signal > 0) {
      signalBlocks += 1
      ratios.push(weightedRatio(f))
    }
  }
  const hitRate = texts.length === 0 ? 0 : signalBlocks / texts.length
  let cv = 0
  if (ratios.length >= 2) {
    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length
    const variance = ratios.reduce((a, b) => a + (b - mean) * (b - mean), 0) / ratios.length
    cv = mean === 0 ? 0 : Math.sqrt(variance) / mean
  }
  return { hitRate, signalBlocks, cv }
}

function probeFits(p, auto) {
  const minHitRate = typeof auto.probeMinHitRate === 'number' ? auto.probeMinHitRate : 0.25
  const minSignalBlocks = typeof auto.probeMinSignalBlocks === 'number' ? auto.probeMinSignalBlocks : 3
  const minRatioSpread = typeof auto.probeMinRatioSpread === 'number' ? auto.probeMinRatioSpread : 0.15
  return p.hitRate >= minHitRate && p.signalBlocks >= minSignalBlocks && p.cv >= minRatioSpread
}

/** 输出说话，名字不说话：候选词典 = 名字提示的 profile（可选）→ 已标定桶 → 默认 DS。
 *  逐个对探测文本做拟合检测，取拟合最好（命中率最高）的那个。
 *  一个都不拟合 → 判 mismatch，攒样本走自动标定。 */
/** 逐块结果验证：把候选词典给「输出块 → 工具结果」关联重打分，
 *  正标记块的后续错误率应低于负标记块；反转说明极性标反了。 */
function outcomeValidates(lexicon, blocks) {
  let posOk = 0
  let posErr = 0
  let negOk = 0
  let negErr = 0
  for (const b of blocks) {
    if (!b || !Array.isArray(b.texts) || b.texts.length === 0) continue
    const total = (b.ok || 0) + (b.err || 0)
    if (total === 0) continue
    let pos = 0
    let neg = 0
    for (const t of b.texts) {
      const f = measureText(t, lexicon)
      pos += f.positive
      neg += f.negative
    }
    if (pos + neg <= 0) continue
    if (pos >= neg) {
      posOk += b.ok || 0
      posErr += b.err || 0
    } else {
      negOk += b.ok || 0
      negErr += b.err || 0
    }
  }
  const posTotal = posOk + posErr
  const negTotal = negOk + negErr
  const posRate = posTotal > 0 ? posErr / posTotal : 0
  const negRate = negTotal > 0 ? negErr / negTotal : 0
  return {
    posBlocks: posTotal,
    negBlocks: negTotal,
    posErrRate: Math.round(posRate * 100) / 100,
    negErrRate: Math.round(negRate * 100) / 100,
    inverted: posTotal >= 5 && negTotal >= 5 && posRate > negRate + 0.2,
  }
}

/** 极性神谕检查：用 bootstrap（锚定阶段）参考块给候选词典验极性。
 *  锚定阶段是已知良好状态；若某词典把这段输出判为负向主导
 *  （负标记总分 > 正标记总分），该词典对此模型的极性就是反的。 */
function bootstrapPolarity(lexicon, texts) {
  let pos = 0
  let neg = 0
  let neu = 0
  for (const t of texts) {
    const f = measureText(t, lexicon)
    pos += f.positive
    neg += f.negative
    neu += f.neutral
  }
  return { pos: Math.round(pos * 100) / 100, neg: Math.round(neg * 100) / 100, neu: Math.round(neu * 100) / 100, suspect: neg > pos }
}

function selectLexicon(rec) {
  if (rec.lexiconMismatch !== null) return
  const p = rec.probe
  const auto = CONFIG.lexiconAuto
  const minBlocks = typeof auto.probeMinBlocks === 'number' ? auto.probeMinBlocks : 4
  if (!p || p.blocks < minBlocks) return
  const texts = p.texts
  const names = { model: rec.model, provider: rec.provider }
  const candidates = []
  const seen = new Set()
  if (typeof rec.model === 'string' && rec.model.length > 0) seen.add(rec.model)
  if (typeof rec.provider === 'string' && rec.provider.length > 0) seen.add(rec.provider)
  for (const n of seen) {
    const lp = CONFIG.lexiconProfiles && CONFIG.lexiconProfiles[n]
    if (lp) candidates.push({ lexicon: lp, label: 'profile:' + n })
  }
  for (const b of lexiconBuckets) {
    if (b && b.lexicon) candidates.push({ lexicon: b.lexicon, label: 'bucket:' + b.id })
  }
  candidates.push({ lexicon: CONFIG.lexicon, label: 'default' })
  const minBootstrap = typeof auto.polarityMinBootstrapBlocks === 'number' ? auto.polarityMinBootstrapBlocks : 3
  const haveBootstrap = rec.anchorPhaseTexts.length >= minBootstrap
  const attempts = []
  let best = null
  let polarityBlocked = false
  for (const c of candidates) {
    const fit = probeFit(c.lexicon, texts)
    const pol = haveBootstrap ? bootstrapPolarity(c.lexicon, rec.anchorPhaseTexts) : null
    const row = {
      label: c.label,
      hitRate: Math.round(fit.hitRate * 1000) / 1000,
      signalBlocks: fit.signalBlocks,
      ratioCV: Math.round(fit.cv * 1000) / 1000,
      polaritySuspect: pol ? pol.suspect : null,
      bootstrap: pol ? { pos: pol.pos, neg: pol.neg } : null,
    }
    attempts.push(row)
    const fits = probeFits(fit, auto)
    if (fits && pol && pol.suspect) polarityBlocked = true
    if (fits && (!pol || !pol.suspect) && (!best || fit.hitRate > best.hitRate)) {
      best = { ...c, ...row }
    }
  }
  if (best) {
    rec.lexiconMismatch = false
    rec.lexiconSource = best.label
    if (best.lexicon !== rec.lexicon) {
      // 换词典 → 旧计分基线作废：窗口、历史、样本全部重置
      rec.lexicon = best.lexicon
      rec.lastMessages = []
      rec.ratioHistory = []
      rec.styleSamples = []
    } else {
      rec.styleSamples = []
    }
    logAudit(rec, 'lexicon-fit', { ...names, chosen: best.label, hitRate: best.hitRate, signalBlocks: best.signalBlocks, ratioCV: best.ratioCV, attempts, hint: 'chosen lexicon fits this session output and passes the bootstrap polarity check' })
    return
  }
  rec.lexiconMismatch = true
  rec.lexiconSource = 'mismatch'
  logAudit(rec, 'lexicon-mismatch', {
    ...names,
    candidatesTested: candidates.length,
    attempts,
    reason: polarityBlocked ? 'polarity-inverted' : 'unreadable',
    hint: polarityBlocked
      ? 'a candidate read the output but scored the anchored bootstrap phase negative-dominant (inverted polarity); collecting samples for auto-calibration'
      : 'no candidate lexicon reads this output; collecting samples for auto-calibration',
  })
}

// ---------- 输出风格词典：探测选词 + 签名桶自动标定 ----------

function lexiconStateDir() {
  let dir = CONFIG.logDir
  if (typeof baseDir === 'string' && baseDir.length > 0) dir = baseDir + '/' + CONFIG.logDir
  return dir
}

function saveLexiconState() {
  if (!fsSvc) return
  const file = lexiconStateDir() + '/lexicon-state.json'
  const text = JSON.stringify({ generated_utc: new Date().toISOString(), buckets: lexiconBuckets })
  Promise.resolve()
    .then(() => fsSvc.resolve(file, typeof baseDir === 'string' ? { cwd: baseDir } : undefined))
    .then(target => fsSvc.writeText(target, text))
    .catch(() => { /* persistence is best-effort */ })
}

function loadLexiconState() {
  if (!fsSvc) return
  const file = lexiconStateDir() + '/lexicon-state.json'
  Promise.resolve()
    .then(() => fsSvc.resolve(file, typeof baseDir === 'string' ? { cwd: baseDir } : undefined))
    .then(target => fsSvc.readText(target))
    .then(text => {
      const state = JSON.parse(text)
      if (!state || typeof state !== 'object') return
      if (!Array.isArray(state.buckets)) return
      for (const b of state.buckets) {
        if (!b || typeof b !== 'object' || typeof b.id !== 'string') continue
        lexiconBuckets.push({
          id: b.id,
          names: Array.isArray(b.names) ? b.names.filter(n => typeof n === 'string') : [],
          sessions: typeof b.sessions === 'number' ? b.sessions : 0,
          chars: typeof b.chars === 'number' ? b.chars : 0,
          samples: Array.isArray(b.samples) ? b.samples : [],
          signature: Array.isArray(b.signature) ? b.signature : [],
          lexicon: b.lexicon || null,
          targetChars: b.targetChars,
          concentration: b.concentration,
          lastStability: b.lastStability || null,
          calibratedAt: b.calibratedAt || null,
        })
      }
    })
    .catch(() => { /* first boot: no state file */ })
}

function rowsToLexicon(rows) {
  const lexicon = { positive: {}, negative: {}, neutral: {} }
  for (const r of rows) {
    const bucket = r.polarity === 'positive' ? lexicon.positive : r.polarity === 'negative' ? lexicon.negative : lexicon.neutral
    bucket[r.term] = Math.round(Math.min(3, Math.max(0.5, Math.abs(r.odds))) * 10) / 10
  }
  return lexicon
}

/** 按模型特点计算语料目标量：词表集中度 C（top-50 n-gram 频次占比）。
 *  风格标记越集中（C 高）→ log-odds 收敛越快 → 目标越小；
 *  词汇越发散（C 低）→ 需要更多语料才能让标记浮出来。
 *  target = minChars × (1 + (1 − C) × concentrationScale)，clamp [minChars, maxChars]。 */
function autoTargetChars(L, auto) {
  try {
    const freq = new Map()
    let total = 0
    const cap = 300
    const texts = []
    for (const s of L.samples) {
      texts.push(s.text)
      if (texts.length >= cap) break
    }
    for (const g of ngrams(texts)) {
      freq.set(g, (freq.get(g) || 0) + 1)
      total += 1
    }
    if (total < 2000) return null // 集中度估算本身还不够可信，退回上限
    const top50 = Array.from(freq.values()).sort((a, b) => b - a).slice(0, 50).reduce((a, b) => a + b, 0)
    const C = top50 / total
    const minChars = typeof auto.minChars === 'number' ? auto.minChars : 40000
    const maxChars = typeof auto.maxChars === 'number' ? auto.maxChars : 160000
    const scale = typeof auto.concentrationScale === 'number' ? auto.concentrationScale : 0.5
    return { target: Math.min(maxChars, Math.round(minChars * (1 + (1 - C) * scale))), C: Math.round(C * 1000) / 1000 }
  } catch (e) {
    return null
  }
}

/** split-half 稳定性验收：把高分/低分样本各分两半独立 contrast，
 *  比较两份词典的 top 词集合（Jaccard）与权重一致率。
 *  两份独立词典长得像 → 语料已收敛；不像 → 语料还薄，继续攒。 */
function stabilityOf(L, auto) {
  const high = []
  const low = []
  for (const s of L.samples) {
    if (s.percentile >= auto.percentileHigh) high.push(s.text)
    else if (s.percentile <= auto.percentileLow) low.push(s.text)
  }
  const halves = [
    { a: high.slice(0, high.length >> 1), d: low.slice(0, low.length >> 1) },
    { a: high.slice(high.length >> 1), d: low.slice(low.length >> 1) },
  ]
  const minFreq = typeof auto.minFreq === 'number' ? auto.minFreq : 5
  const top = typeof auto.top === 'number' ? auto.top : 60
  const lexA = rowsToLexicon(contrastPolarity(halves[0].a, halves[0].d, minFreq, top))
  const lexB = rowsToLexicon(contrastPolarity(halves[1].a, halves[1].d, minFreq, top))
  const termsA = new Set([...Object.keys(lexA.positive), ...Object.keys(lexA.negative), ...Object.keys(lexA.neutral)])
  const termsB = new Set([...Object.keys(lexB.positive), ...Object.keys(lexB.negative), ...Object.keys(lexB.neutral)])
  const inter = Array.from(termsA).filter(t => termsB.has(t)).length
  const union = new Set([...termsA, ...termsB]).size
  const jaccard = union === 0 ? 0 : inter / union
  let wsum = 0
  let wagree = 0
  for (const pol of ['positive', 'negative', 'neutral']) {
    for (const t of Object.keys(lexA[pol])) {
      const wB = lexB[pol] && lexB[pol][t]
      if (typeof wB !== 'number') continue
      wsum += 1
      if (Math.abs(lexA[pol][t] - wB) / Math.abs(lexA[pol][t]) < 0.5) wagree += 1
    }
  }
  const weightAgree = wsum === 0 ? 1 : wagree / wsum
  const minStability = typeof auto.minStability === 'number' ? auto.minStability : 0.6
  return {
    jaccard: Math.round(jaccard * 1000) / 1000,
    weightAgree: Math.round(weightAgree * 1000) / 1000,
    anchored: high.length,
    drifted: low.length,
    stable: jaccard >= minStability && weightAgree >= minStability,
  }
}

/** 会话关闭时：输出签名找桶 → 并入/新建桶 → 语料达到自适应目标且通过
 *  稳定性验收 → 标定出词典挂在桶上（以后按输出拟合自动选用）。
 *  名字不参与识别：同名换风格自动开新桶，异名同风格自动并入同桶。 */
function maybeAutoCalibrate(rec) {
  const auto = CONFIG.lexiconAuto
  if (!auto || auto.enabled === false) return
  if (rec.lexiconMismatch !== true) return
  const minFreq = typeof auto.minFreq === 'number' ? auto.minFreq : 5
  const top = typeof auto.top === 'number' ? auto.top : 60
  // 极性神谕优先：bootstrap（锚定阶段）文本 = 已知良好正样本；
  // 负样本 = 晋升后的自然输出。对比「锚定→晋升」的风格增量给出正确极性
  // （let me 反而是锚定风的模型也会得到 let-me 正向词典，不会被 DS 词典的
  // 极性反转污染）。无神谕（未锚定/自会话）退回百分位标签。
  const anchoredRef = []
  const postLift = []
  const high = []
  const low = []
  for (const s of rec.styleSamples) {
    if (s.anchored) anchoredRef.push(s.text)
    else {
      postLift.push(s.text)
      if (s.percentile >= auto.percentileHigh) high.push(s.text)
      else if (s.percentile <= auto.percentileLow) low.push(s.text)
    }
  }
  let useOracle = anchoredRef.length >= 10 && postLift.length >= 10
  if (useOracle) {
    // 神谕前提验证：bootstrap 期的「计划性」（带推理块的消息占比）不得明显差于晋升后。
    // 若该模型在锚定期反而更浅（无推理裸答），「锚定=已知良好」的前提对该模型不成立，
    // 退回百分位标签（独立的计划性信号来自消息结构，与词典无关）。
    const bRich = rec.bootstrapMsgs > 0 ? rec.bootstrapBlocks / rec.bootstrapMsgs : 0
    const pRich = rec.postLiftMsgs > 0 ? rec.postLiftBlocks / rec.postLiftMsgs : 0
    if (rec.bootstrapMsgs >= 3 && pRich > 0 && bRich < pRich * 0.6) {
      useOracle = false
      logAudit(rec, 'oracle-unvalidated', {
        bootstrapMsgs: rec.bootstrapMsgs,
        bootstrapRich: Math.round(bRich * 100) / 100,
        postLiftRich: Math.round(pRich * 100) / 100,
        hint: 'bootstrap phase not planning-rich; polarity oracle premise fails for this model, falling back to percentile labels',
      })
    }
    // 结果侧验证（稀疏但真实）：bootstrap 期工具操作的错误率不得明显高于晋升后。
    // 信号来源：非零退出码 / 沙箱拒绝 / 结构化 ok:false|error 字段。
    if (useOracle) {
      const bOut = rec.bootstrapOutcomes || { ok: 0, err: 0 }
      const pOut = rec.postLiftOutcomes || { ok: 0, err: 0 }
      const bErr = bOut.err > 0 ? bOut.err / (bOut.err + bOut.ok) : 0
      const pErr = pOut.err > 0 ? pOut.err / (pOut.err + pOut.ok) : 0
      if (bOut.err >= 2 && bErr > pErr + 0.15) {
        useOracle = false
        logAudit(rec, 'oracle-unvalidated', {
          reason: 'bootstrap operational error rate worse than post-lift',
          bootstrapOutcomes: bOut,
          postLiftOutcomes: pOut,
          hint: 'anchored phase behaves operationally worse than natural output; polarity oracle premise fails, falling back to percentile labels',
        })
      }
    }
  }
  const posSet = useOracle ? anchoredRef : high
  const negSet = useOracle ? postLift : low
  if (posSet.length < 10 || negSet.length < 10) {
    logAudit(rec, 'lexicon-auto-pending', { reason: 'insufficient contrast samples', oracle: useOracle, anchoredRef: anchoredRef.length, postLift: postLift.length, high: high.length, low: low.length })
    return
  }
  let rows
  try {
    rows = contrastPolarity(posSet, negSet, minFreq, top)
  } catch (e) {
    logAudit(rec, 'lexicon-auto-error', { error: msg(e) })
    return
  }
  if (!rows || rows.length === 0) {
    logAudit(rec, 'lexicon-auto-pending', { reason: 'no contrast terms' })
    return
  }
  const signature = rows.map(r => r.term)
  // 按输出签名匹配已有桶（Jaccard ≥ bucketMatchThreshold 并入最像的那个）
  const threshold = typeof auto.bucketMatchThreshold === 'number' ? auto.bucketMatchThreshold : 0.25
  let B = null
  let bestSim = 0
  for (const b of lexiconBuckets) {
    const inter = b.signature.filter(t => signature.includes(t)).length
    const union = new Set([...b.signature, ...signature]).size
    const sim = union === 0 ? 0 : inter / union
    if (sim >= threshold && sim > bestSim) {
      B = b
      bestSim = sim
    }
  }
  if (!B) {
    B = {
      id: 'style-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      names: [],
      sessions: 0,
      chars: 0,
      samples: [],
      signature: [],
      lexicon: null,
    }
    lexiconBuckets.push(B)
  }
  const tag = n => typeof n === 'string' && n.length > 0
  if (tag(rec.model) && !B.names.includes(rec.model)) B.names.push(rec.model)
  if (tag(rec.provider) && !B.names.includes(rec.provider)) B.names.push(rec.provider)
  B.sessions += 1
  let chars = 0
  for (const s of rec.styleSamples) {
    chars += s.text.length
    if (typeof s.percentile === 'number') B.samples.push(s)
  }
  B.chars += chars
  if (B.samples.length > 1500) B.samples.splice(0, B.samples.length - 1500)
  // 桶签名随语料刷新：取最近 400 条样本的 contrast 词条（神谕优先）
  const ba = []
  const bp = []
  const bh = []
  const bl = []
  for (let i = Math.max(0, B.samples.length - 400); i < B.samples.length; i++) {
    const s = B.samples[i]
    if (s.anchored) ba.push(s.text)
    else {
      bp.push(s.text)
      if (s.percentile >= auto.percentileHigh) bh.push(s.text)
      else if (s.percentile <= auto.percentileLow) bl.push(s.text)
    }
  }
  const bOracle = ba.length >= 10 && bp.length >= 10
  const bPos = bOracle ? ba : bh
  const bNeg = bOracle ? bp : bl
  if (bPos.length >= 10 && bNeg.length >= 10) {
    try {
      const rowsB = contrastPolarity(bPos, bNeg, minFreq, top)
      if (rowsB && rowsB.length > 0) B.signature = rowsB.map(r => r.term)
    } catch (e) { /* 签名刷新失败不影响主流程 */ }
  } else {
    B.signature = signature
  }
  saveLexiconState()
  const minSessions = typeof auto.minSessions === 'number' ? auto.minSessions : 3
  const minChars = typeof auto.minChars === 'number' ? auto.minChars : 40000
  const maxChars = typeof auto.maxChars === 'number' ? auto.maxChars : 160000
  if (B.sessions < minSessions || B.chars < minChars) {
    logAudit(rec, 'lexicon-auto-progress', { bucket: B.id, names: B.names, sessions: B.sessions, chars: B.chars, samples: B.samples.length, merged: bestSim > 0 })
    return
  }
  // 自适应目标：按该桶词表集中度计算（只算一次并随状态持久化展示）
  if (!B.targetChars) {
    const est = autoTargetChars(B, auto)
    B.targetChars = est ? est.target : maxChars
    B.concentration = est ? est.C : null
    logAudit(rec, 'lexicon-auto-target', { bucket: B.id, targetChars: B.targetChars, concentration: B.concentration })
  }
  if (B.chars < B.targetChars) {
    logAudit(rec, 'lexicon-auto-progress', { bucket: B.id, sessions: B.sessions, chars: B.chars, targetChars: B.targetChars, samples: B.samples.length })
    return
  }
  // 达到目标量 → 稳定性验收；不稳就自动把目标上调 1.5×（封顶 maxChars），继续攒
  const st = stabilityOf(B, auto)
  if (!st.stable) {
    B.lastStability = { jaccard: st.jaccard, weightAgree: st.weightAgree }
    if (st.anchored < 20 || st.drifted < 20) {
      logAudit(rec, 'lexicon-auto-pending', { bucket: B.id, reason: 'insufficient contrast samples', anchored: st.anchored, drifted: st.drifted })
      return
    }
    if (B.targetChars >= maxChars && B.chars >= maxChars) {
      logAudit(rec, 'lexicon-auto-pending', { bucket: B.id, reason: 'unstable at cap, waiting for more sessions', jaccard: st.jaccard, weightAgree: st.weightAgree })
      return
    }
    B.targetChars = Math.min(maxChars, Math.round(B.targetChars * 1.5))
    logAudit(rec, 'lexicon-auto-pending', { bucket: B.id, reason: 'corpus not yet stable', jaccard: st.jaccard, weightAgree: st.weightAgree, nextTargetChars: B.targetChars })
    return
  }
  // 终版词典：全桶语料 contrast（神谕优先，bootstrap=正、晋升后=负）
  const fA = []
  const fP = []
  const anchored = []
  const drifted = []
  for (const s of B.samples) {
    if (s.anchored) fA.push(s.text)
    else {
      fP.push(s.text)
      if (s.percentile >= auto.percentileHigh) anchored.push(s.text)
      else if (s.percentile <= auto.percentileLow) drifted.push(s.text)
    }
  }
  const finalOracle = fA.length >= 10 && fP.length >= 10
  const finalPos = finalOracle ? fA : anchored
  const finalNeg = finalOracle ? fP : drifted
  let rowsFull
  try {
    rowsFull = contrastPolarity(finalPos, finalNeg, minFreq, top)
  } catch (e) {
    logAudit(rec, 'lexicon-auto-error', { bucket: B.id, error: msg(e) })
    return
  }
  if (!rowsFull || rowsFull.length === 0) {
    logAudit(rec, 'lexicon-auto-pending', { bucket: B.id, reason: 'no contrast terms' })
    return
  }
  const lexicon = rowsToLexicon(rowsFull)
  // 结果侧发布门：新词典极性必须与逐块工具结果一致（正标记块错误率应低于负标记块；
  // 反转说明极性标反了——通用会话里不需要任务分数的逐块质量验证）。
  const align = outcomeValidates(lexicon, rec.blockOutcomes)
  if (align.inverted) {
    logAudit(rec, 'lexicon-outcome-inverted', { bucket: B.id, posBlocks: align.posBlocks, negBlocks: align.negBlocks, posErrRate: align.posErrRate, negErrRate: align.negErrRate, hint: 'new lexicon scores better-outcome blocks negative; refusing to publish, keeping samples for future sessions' })
    return
  }
  B.lexicon = lexicon
  B.signature = rowsFull.map(r => r.term)
  B.calibratedAt = Date.now()
  saveLexiconState()
  logAudit(rec, 'lexicon-calibrated', {
    bucket: B.id,
    names: B.names,
    oracle: finalOracle,
    sessions: B.sessions,
    chars: B.chars,
    targetChars: B.targetChars,
    concentration: B.concentration,
    samples: B.samples.length,
    anchored: anchored.length,
    drifted: drifted.length,
    stability: { jaccard: st.jaccard, weightAgree: st.weightAgree },
    positive: Object.keys(lexicon.positive).length,
    negative: Object.keys(lexicon.negative).length,
    neutral: Object.keys(lexicon.neutral).length,
  })
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
  let flags = null
  if (texts.length > 0) {
    flags = flagsOf(texts, rec.lexicon)
    rec.lastMessages.push({ flags })
    while (rec.lastMessages.length > CONFIG.trajectoryWindowSize) rec.lastMessages.shift()
  }
  if (rec.anchored) {
    // 计划性计数（神谕前提验证用）：bootstrap 期 vs 晋升后，有推理块的占比
    if (!rec.lifted) {
      rec.bootstrapMsgs = (rec.bootstrapMsgs || 0) + 1
      rec.bootstrapBlocks = (rec.bootstrapBlocks || 0) + texts.length
    } else {
      rec.postLiftMsgs = (rec.postLiftMsgs || 0) + 1
      rec.postLiftBlocks = (rec.postLiftBlocks || 0) + texts.length
    }
  }
  // bootstrap 期（锚定阶段）参考块：该模型的已知良好状态，用作极性神谕
  if (rec.anchored && !rec.lifted && texts.length > 0) {
    const joined = texts.join('\n')
    if (joined.length >= 40) {
      rec.anchorPhaseTexts.push(joined)
      if (rec.anchorPhaseTexts.length > 20) rec.anchorPhaseTexts.shift()
    }
  }
  recompute(rec, agent)
  probeFeed(rec, texts, flags)
  sampleStyle(rec, texts)
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
          rec.lastMessages.push({ flags: flagsOf(texts, rec.lexicon) })
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
  rec.liftedAtTurnStep = { turn: rec.lastTurn, step: rec.lastStep } // bootstrap 分界线
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
  selectLexicon(rec) // 短会话：探测窗口没满也在关闭时收尾判定
  maybeAutoCalibrate(rec)
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
    provider: null,
    model: null,
    namesLogged: false,
    lexicon: CONFIG.lexicon,
    lexiconSource: 'default',
    lexiconMismatch: null,
    probe: newProbe(),
    styleSamples: [],
    anchorPhaseTexts: [],
    blockOutcomes: [],
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

/** 工具结果 → 操作成败分类（保守：只认明确的信号，其余返回 null 不参与统计）。
 *  err：非零退出码 / 沙箱拒绝 / 结构化 ok:false|success:false|error 字段；
 *  ok：退出码 0 / ok:true|success:true。 */
function classifyToolResult(event) {
  try {
    const d = event.data || {}
    const r = d.result
    let text = ''
    if (typeof r === 'string') {
      text = r
    } else if (r && typeof r === 'object') {
      if (r.ok === false || r.success === false || r.error !== undefined && r.error !== null) return 'err'
      if (r.ok === true || r.success === true) return 'ok'
      text = JSON.stringify(r)
    } else {
      return null
    }
    if (/\[exit code:\s*[1-9]\d*\]/.test(text)) return 'err'
    if (/\[exit code:\s*0\]/.test(text)) return 'ok'
    if (/\[sandbox: file access denied/.test(text)) return 'err'
    return null
  } catch (e) {
    return null
  }
}

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
  if (event.type === 'request/header' || event.type === 'request/context') {
    const d = event.data || {}
    const provider = typeof d.provider === 'string' && d.provider.length > 0
      ? d.provider
      : (d.header && d.header.config && d.header.config.provider)
    const model = typeof d.model === 'string' && d.model.length > 0
      ? d.model
      : (d.header && d.header.config && d.header.config.model)
    if (typeof provider === 'string' && provider.length > 0) rec.provider = provider
    if (typeof model === 'string' && model.length > 0) rec.model = model
    // 名字只记标签，不参与词典选择——输出说话（selectLexicon 用输出拟合选词典）
    if (!rec.namesLogged && (rec.model || rec.provider)) {
      rec.namesLogged = true
      logAudit(rec, 'lexicon-names', { model: rec.model, provider: rec.provider, hint: 'names are labels only; output decides the lexicon' })
    }
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
  } else if (event.type === 'tool/result') {
    // 操作结果信号（稀疏但真实）：退出码 / 沙箱拒绝 / 结构化 ok:false|error。
    // 按 bootstrap 分界线归入各自阶段的 ok/err 计数，供神谕前提验证用。
    const outcome = classifyToolResult(event)
    if (outcome) {
      const turn = event.data && event.data.turn
      const step = event.data && event.data.step
      let phase = 'post'
      if (rec.liftedAtTurnStep && typeof turn === 'number' && typeof step === 'number') {
        const at = turn * 100000 + step
        const liftAt = (rec.liftedAtTurnStep.turn || 0) * 100000 + (rec.liftedAtTurnStep.step || 0)
        if (at < liftAt) phase = 'bootstrap'
      } else if (rec.anchored && !rec.lifted) {
        phase = 'bootstrap'
      }
      if (phase === 'bootstrap') {
        rec.bootstrapOutcomes = rec.bootstrapOutcomes || { ok: 0, err: 0 }
        rec.bootstrapOutcomes[outcome] += 1
      } else if (rec.anchored && rec.lifted) {
        rec.postLiftOutcomes = rec.postLiftOutcomes || { ok: 0, err: 0 }
        rec.postLiftOutcomes[outcome] += 1
      }
      // 逐块结果关联：把成败挂到同 turn/step 的最后一个推理块上，
      // 形成「输出块 → 结果」的质量代理（通用会话里不需要任务分数）。
      if (rec.lastBlock && typeof turn === 'number' && typeof step === 'number'
        && turn === rec.lastBlock.turn && step === rec.lastBlock.step) {
        rec.lastBlock[outcome] = (rec.lastBlock[outcome] || 0) + 1
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
    // 轮换「输出块 → 结果」关联：旧块归档（上限 100），新块开账
    if (rec.lastBlock) {
      if (rec.blockOutcomes.length >= 100) rec.blockOutcomes.shift()
      rec.blockOutcomes.push(rec.lastBlock)
    }
    rec.lastBlock = {
      turn: typeof turn === 'number' ? turn : null,
      step: typeof step === 'number' ? step : null,
      texts: texts.slice(),
      ok: 0,
      err: 0,
    }
    const agent = agentsSvc ? safeGet(agentsSvc, rec.sessionId) : null
    updateWindow(rec, texts, agent || undefined)
    if (CONFIG.gateEnabled && rec.anchored && !rec.lifted && rec.pendingPromote) {
      const latest = rec.lastMessages[rec.lastMessages.length - 1]
      // 泛化锚定门：当前词典的正标记命中且无负标记命中（DS 词典下即 we 无 let me；
      // 换任意词典自动跟随该词典的极性词）。
      if (latest && latest.flags.some(f => f.hasPositive) && !latest.flags.some(f => f.hasNegative)) {
        lift(rec, 'anchor-gate:minimal-like')
      }
    }
  }
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
    provider: rec.provider,
    model: rec.model,
    lexiconSource: rec.lexiconSource,
    lexiconMismatch: rec.lexiconMismatch,
    probeBlocks: rec.probe ? rec.probe.blocks : 0,
    styleSamples: rec.styleSamples.length,
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
    lexicon: {
      auto: CONFIG.lexiconAuto,
      profiles: Object.keys(CONFIG.lexiconProfiles || {}),
      buckets: lexiconBuckets.map(b => ({
        id: b.id,
        names: b.names,
        calibrated: b.lexicon !== null,
        terms: b.lexicon
          ? Object.keys(b.lexicon.positive || {}).length + Object.keys(b.lexicon.negative || {}).length + Object.keys(b.lexicon.neutral || {}).length
          : 0,
        sessions: b.sessions,
        chars: b.chars,
        targetChars: b.targetChars || null,
        concentration: b.concentration === undefined ? null : b.concentration,
        lastStability: b.lastStability || null,
        signature: b.signature.length,
      })),
    },
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
    if (CONFIG_KEYS.has(key)) CONFIG[key] = config[key]
    else console.error(`[${name}] unknown config key "${key}"`)
  }
}

export function apply(ctx, config) {
  mergeConfig(config)
  agentsSvc = ctx.get('agents')
  fsSvc = ctx.get('fs')
  spSvc = ctx.get('sandboxPolicy')

  if (spSvc && typeof spSvc.workspaceRoot === 'string' && spSvc.workspaceRoot.length > 0) baseDir = spSvc.workspaceRoot
  loadLexiconState()

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
        + 'reward annotations, output-fingerprinted lexicon selection (fit probe) and auto-calibration style buckets, '
        + 'and event-channel reachability.',
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
