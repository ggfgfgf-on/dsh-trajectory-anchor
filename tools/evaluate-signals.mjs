/**
 * evaluate-signals.mjs —— 候选漂移信号的**判别力**评估（与现役通道同口径，可直接比较）
 *
 * 为什么需要它：能力层现在是关着的，原因不是工程，而是**判别力**——
 * 统计通道在真实语料上被实测拒绝（词典 α=0.05 召回 4.3%、精确率 6.2% 低于 20% 随机基线；
 * 行为通道 α=0.01 时 A′ 14.3% / C 31.2% / B 41.6%，精度都低于基线）。
 * 而 L1 在用的**规则型**信号（越界写 / 改完没验证）是另一类东西：判据是"事实"而非统计，
 * 真实会话里它们**确实在说话**。它们对漂移的判别力此前从未被测过——本工具就是来测的。
 *
 * 口径（与 measure-recall.mjs / drift-label-core.mjs **完全一致**，不另立一套）：
 *   · 锚点 = 事后确认的劣化事件；评估用**强语义**子集 {unknown-tool, user-correction,
 *     abandoned-turn}（tool-error / failure-marker 在真实工作里是常态，会把基线膨胀到 ~19%）；
 *   · 命中 = 锚点之前 lead 步内（或当步）出现过触发；延迟 = 锚点 − 触发（正数 = 提前发现）；
 *   · 精度必须与**随机基线**比（触发位置随机时的期望精度）；
 *   · 每个候选信号只与**不含它自有信号**的锚点比较（自有信号已排除）。
 *
 * 用法：node tools/evaluate-signals.mjs [会话目录] [--lead 3] [--max-lead 6] [--out 前缀]
 */
import { writeFileSync } from 'node:fs'
import { resolve, basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeSessionLog, walk } from './session-log-core.mjs'
import { walkChannel } from './behaviour-channel-core.mjs'
import { ANCHOR_KINDS, anchorsFromEvents, alignAnchors, aggregateDetection } from './drift-label-core.mjs'
import { buildLedgerFromEvents } from '../index.js'
import {
  verifyCommandKind, changeInvalidatesVerification, isWriteTool, isReadTool,
  claimsFromFinalMessage, scanToolCalls,
} from './task-anchor-core.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const args = process.argv.slice(2)
const FLAGS_WITH_VALUE = new Set(['--lead', '--max-lead', '--out'])
const positional = []
for (let i = 0; i < args.length; i++) {
  if (FLAGS_WITH_VALUE.has(args[i])) { i += 1; continue }
  if (args[i].startsWith('--')) continue
  positional.push(args[i])
}
const sessionsDir = resolve(positional[0] || (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.dsh\\sessions` : '.'))
const LEAD = Number(args.includes('--lead') ? args[args.indexOf('--lead') + 1] : 3)
const MAX_LEAD = Number(args.includes('--max-lead') ? args[args.indexOf('--max-lead') + 1] : 6)
const outPrefix = resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : './signal-eval')

/** 强语义锚点：真正带"跑偏"含义的那几种（tool-error/failure-marker 是工作常态，不算）。 */
const STRONG = [ANCHOR_KINDS.UNKNOWN_TOOL, ANCHOR_KINDS.USER_CORRECTION, ANCHOR_KINDS.ABANDONED_TURN]

/** 每个候选信号的**自有信号**（评估时必须从锚点里排除，避免循环标注）。 */
const OWN_SIGNAL = {
  'scope-write': [],
  'unverified-edit': [],
  'unverified-claim': [],
  'edit-thrash': [],
  'repeat-failure': [ANCHOR_KINDS.TOOL_ERROR, 'failure-marker'],
  'write-before-read': [],
}

// ---------- 事件读取小工具 ----------
const argOf = (d) => {
  const a = d && d.arguments
  if (a && typeof a === 'object') return a
  if (typeof a === 'string') { try { return JSON.parse(a) } catch { return null } }
  return null
}
const textOfResult = (ev) => {
  const d = ev && ev.data
  const blocks = d && d.message && Array.isArray(d.message.content) ? d.message.content : []
  return blocks.filter((b) => b && b.type === 'tool-result' && Array.isArray(b.content))
    .map((b) => b.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n')).join('\n')
}
const errOfResult = (ev) => {
  const d = ev && ev.data
  if (!d) return false
  if (d.error) return true
  const blocks = d.message && Array.isArray(d.message.content) ? d.message.content : []
  return blocks.some((b) => b && b.isError === true)
}
const assistantText = (ev) => {
  const blocks = ev && ev.data && ev.data.message && ev.data.message.content
  if (!Array.isArray(blocks)) return ''
  return blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('')
}

// ---------- 六个候选信号：全部从事件直接算，输出 (turn, step) 触发点 ----------
function firesScopeWrite(events, anchors) {
  if (!anchors || anchors.parsed !== true) return []
  const scan = scanToolCalls(events, anchors)
  return scan.labels.filter((l) => l.kind === 'scope-write').map((l) => ({ turn: l.turn, step: l.step }))
}

/** 改完没验证（L1 现在实际在用的信号）：上一次验证之后的**代码**改动。 */
function firesUnverifiedEdit(events) {
  const out = []
  let lastVerifyAt = null
  for (const ev of events) {
    if (!ev || ev.type !== 'tool/call') continue
    const d = ev.data || {}
    const a = argOf(d)
    const cmd = a && typeof a.command === 'string' ? a.command : (typeof d.arguments === 'string' ? d.arguments : '')
    if (cmd && verifyCommandKind(cmd)) { lastVerifyAt = { turn: d.turn, step: d.step }; continue }
    if (!isWriteTool(d.name)) continue
    const p = a && typeof a.file_path === 'string' ? a.file_path : null
    if (p && lastVerifyAt && changeInvalidatesVerification(p)) out.push({ turn: d.turn, step: d.step })
  }
  return out
}

/** 改完没验证**并且宣告完成**（L1 的 pending 信号 + 一句"做完了"）。 */
function firesUnverifiedClaim(events) {
  const out = []
  let lastVerifyAt = null
  let pendingEditAt = null
  for (const ev of events) {
    if (!ev) continue
    if (ev.type === 'tool/call') {
      const d = ev.data || {}
      const a = argOf(d)
      const cmd = a && typeof a.command === 'string' ? a.command : (typeof d.arguments === 'string' ? d.arguments : '')
      if (cmd && verifyCommandKind(cmd)) { lastVerifyAt = { turn: d.turn, step: d.step }; pendingEditAt = null; continue }
      if (!isWriteTool(d.name)) continue
      const p = a && typeof a.file_path === 'string' ? a.file_path : null
      if (p && lastVerifyAt && changeInvalidatesVerification(p)) pendingEditAt = { turn: d.turn, step: d.step }
      continue
    }
    if (ev.type === 'assistant/message' && pendingEditAt) {
      const claim = claimsFromFinalMessage(assistantText(ev))
      const declares = claim && (claim.claimedDone === true || claim.claimedPass !== null)
      if (declares) out.push({ turn: ev.data && ev.data.turn, step: ev.data && ev.data.step })
    }
  }
  return out
}

/** 编辑抖动：同一文件的精确**撤销**（A→B 之后又 B→A）——"来回改"的抖动签名。 */
function firesEditThrash(events) {
  const out = []
  const hist = new Map()   // path -> [{old,new,turn,step}]
  for (const ev of events) {
    if (!ev || ev.type !== 'tool/call') continue
    const d = ev.data || {}
    const a = argOf(d)
    if (!a || typeof a.file_path !== 'string') continue
    if (d.name !== 'edit') continue
    const oldS = typeof a.old_string === 'string' ? a.old_string : null
    const newS = typeof a.new_string === 'string' ? a.new_string : null
    if (oldS === null || newS === null) continue
    const p = a.file_path
    const list = hist.get(p) || []
    const reverted = list.some((h) => h.old === newS && h.new === oldS)
    if (reverted) out.push({ turn: d.turn, step: d.step })
    list.push({ old: oldS, new: newS, turn: d.turn, step: d.step })
    if (list.length > 40) list.shift()
    hist.set(p, list)
  }
  return out
}

/** 同一命令反复失败（≥2 次同一命令报错）——卡住的经典签名。 */
function firesRepeatFailure(events) {
  const failByCall = new Map()
  for (const ev of events) {
    if (ev && ev.type === 'tool/result') {
      const cid = ev.data && ev.data.message && ev.data.message.source && ev.data.message.source.callId
      if (cid) failByCall.set(cid, errOfResult(ev))
    }
  }
  const seen = new Map()
  const out = []
  for (const ev of events) {
    if (!ev || ev.type !== 'tool/call') continue
    const d = ev.data || {}
    const a = argOf(d)
    const cmd = a && typeof a.command === 'string' ? a.command : null
    if (!cmd) continue
    if (failByCall.get(d.callId) !== true) continue
    const key = cmd.trim().replace(/\s+/g, ' ')
    const n = (seen.get(key) || 0) + 1
    seen.set(key, n)
    if (n >= 2) out.push({ turn: d.turn, step: d.step })
  }
  return out
}

/** 未读先写：**成功落地**的 edit 打在一个本会话从未读过的文件上（被拒的调用不算）。 */
function firesWriteBeforeRead(events) {
  const failByCall = new Map()
  for (const ev of events) {
    if (ev && ev.type === 'tool/result') {
      const cid = ev.data && ev.data.message && ev.data.message.source && ev.data.message.source.callId
      if (cid) failByCall.set(cid, errOfResult(ev))
    }
  }
  const read = new Set()
  const out = []
  for (const ev of events) {
    if (!ev || ev.type !== 'tool/call') continue
    const d = ev.data || {}
    const a = argOf(d)
    if (!a || typeof a.file_path !== 'string') continue
    if (isReadTool(d.name)) { read.add(a.file_path.toLowerCase()); continue }
    if (d.name !== 'edit') continue
    if (failByCall.get(d.callId) === true) continue          // 成功门：没落地就不算
    if (!read.has(a.file_path.toLowerCase())) out.push({ turn: d.turn, step: d.step })
  }
  return out
}

const SIGNALS = {
  'scope-write': firesScopeWrite,
  'unverified-edit': firesUnverifiedEdit,
  'unverified-claim': firesUnverifiedClaim,
  'edit-thrash': firesEditThrash,
  'repeat-failure': firesRepeatFailure,
  'write-before-read': firesWriteBeforeRead,
}

/**
 * **按运行期节流**后的信号：同一 turn 至多一次、每会话至多 `budget` 次
 * （与 `pullbackDecision` 的节流/预算同规则）。离线信号可以无节制地触发，那样测出来的
 * "召回"只是"触发得多、蒙上的也多"；而 L1 实际部署时是被节流的，所以必须单独测一遍
 * ——否则我们会拿一个根本不存在的触发模式去论证判别力。
 */
function throttleFires(raw, budget) {
  const seenTurn = new Map()
  const perSession = new Map()
  const out = []
  for (const f of raw) {
    const sid = f.sid
    const n = perSession.get(sid) || 0
    if (n >= budget) continue
    const last = seenTurn.get(sid)
    if (last !== undefined && last === f.turn) continue
    seenTurn.set(sid, f.turn)
    perSession.set(sid, n + 1)
    out.push(f)
  }
  return out
}

// ---------- 语料走查 ----------
const files = walk(sessionsDir, []).filter((f) => f.endsWith('session.jsonl.zstd'))
const perSignal = Object.fromEntries(Object.keys(SIGNALS).map((k) => [k, []]))
const refChannels = { inaction: [], repetition: [], failure: [] }
let sessionsUsed = 0
let sessionsWithAnchors = 0
const anchorStats = {}

for (const f of files) {
  const sid = basename(join(f, '..')).slice(0, 12)
  let text
  try { text = decodeSessionLog(f) } catch { continue }
  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch { /* 坏行 */ }
  }
  const built = buildLedgerFromEvents(events, { repetitionWindow: 5, minRepeats: 2, trace: true, testWindow: 3 })
  const steps = built.series.steps
  if (steps.length < 25) continue
  sessionsUsed++
  const idxOf = new Map(steps.map((s, i) => [`${s.turn}#${s.step}`, i]))
  const anchorsAll = anchorsFromEvents(events)
  for (const a of anchorsAll) anchorStats[a.kind] = (anchorStats[a.kind] || 0) + 1
  if (anchorsAll.length > 0) sessionsWithAnchors++

  // 强语义锚点（含 user-correction 的 trace 映射，与 measure-recall 同一套对齐）
  const strong = anchorsAll.filter((a) => STRONG.includes(a.kind))
  const plain = strong.filter((a) => a.kind !== ANCHOR_KINDS.USER_CORRECTION)
  const users = strong.filter((a) => a.kind === ANCHOR_KINDS.USER_CORRECTION)
  const aligned = alignAnchors(steps, plain).aligned
  for (const a of users) {
    const t = Number.isFinite(a.eventIndex) ? built.trace[a.eventIndex] : null
    const idx = t ? t.len - 1 : -1
    if (idx >= 0 && idx < steps.length) aligned.push({ idx, kind: a.kind })
  }
  aligned.sort((x, y) => x.idx - y.idx)
  const anchors = aligned.map((a) => ({ idx: a.idx }))
  const anchorsByKind = {}
  for (const a of aligned) {
    if (!anchorsByKind[a.kind]) anchorsByKind[a.kind] = []
    anchorsByKind[a.kind].push({ idx: a.idx })
  }

  // 首条人类提示（scope-write 需要它）
  let prompt = ''
  for (const ev of events) {
    const d = ev && ev.data
    if (ev && ev.type === 'user/message' && d && d.source && d.source.kind === 'user') {
      prompt = (Array.isArray(d.content) ? d.content : []).filter((b) => b && b.type === 'text').map((b) => b.text || '').join('')
      break
    }
  }
  const { parseTaskAnchors } = await import('./task-anchor-core.mjs')
  const taskAnchors = prompt ? parseTaskAnchors(prompt) : null

  for (const [name, fn] of Object.entries(SIGNALS)) {
    const raw = fn(events, taskAnchors)
    const idxed = (rs) => [...new Set(rs.map((r) => idxOf.get(`${r.turn}#${r.step}`)).filter((i) => i !== undefined))].sort((a, b) => a - b)
    // 自有信号排除（避免循环标注）
    const own = OWN_SIGNAL[name] || []
    const usableAnchors = anchors.filter((a) => {
      const k = aligned.find((x) => x.idx === a.idx)
      return !own.includes(k && k.kind)
    })
    const byKind = {}
    for (const [k, list] of Object.entries(anchorsByKind)) {
      if (own.includes(k)) continue
      byKind[k] = list
    }
    perSignal[name].push({ sid, steps: steps.length, fires: idxed(raw), anchors: usableAnchors, anchorsByKind: byKind })
    // 与运行期同规则的节流版本（1/turn、≤3/会话）
    const throttled = throttleFires(raw.map((r) => ({ ...r, sid })), 3)
    perSignal[`${name}·节流`] = perSignal[`${name}·节流`] || []
    perSignal[`${name}·节流`].push({ sid, steps: steps.length, fires: idxed(throttled), anchors: usableAnchors, anchorsByKind: byKind })
  }
  for (const ch of Object.keys(refChannels)) {
    const w = walkChannel([{ sid, [ch]: built.series[ch] }], ch, { testWindow: 3, refMinSteps: 20, alpha: 0.01, consecutive: 1 })
    refChannels[ch].push({ sid, steps: steps.length, fires: w.perSession[0].fires, anchors, anchorsByKind })
  }
}

// ---------- 汇总输出 ----------
/**
 * **同预算随机基线召回**：一个触发位置随机的信号，在同样的"每会话触发数"下能拿到多少召回。
 * 为什么必须有它：召回绝对值离开触发数就没有意义——高频信号当然召回高。
 * 口径：窗口宽 W = lead + tolerance + 1；F 个随机落在 N 步里的触发，至少一个落进窗口的概率
 *       = 1 − C(N−W, F)/C(N, F) ≈ 1 − (1 − W/N)^F。
 */
function chanceRecall(rows, lead, tol = 1) {
  const W = lead + tol + 1
  let sum = 0
  let n = 0
  for (const r of rows) {
    const N = r.steps
    const F = r.fires.length
    if (!N || !r.anchors.length) continue
    const p = F === 0 ? 0 : 1 - Math.pow(Math.max(0, (N - W) / N), F)
    sum += p * r.anchors.length
    n += r.anchors.length
  }
  return n ? sum / n : null
}

/** 每步触发率（判断"这个信号是不是几乎一直在触发"）。 */
function fireRate(rows) {
  const f = rows.reduce((a, r) => a + r.fires.length, 0)
  const s = rows.reduce((a, r) => a + r.steps, 0)
  return s ? f / s : 0
}

const fmt = (x, d = 1) => (x === null || x === undefined ? '—' : (typeof x === 'number' ? (x * 100).toFixed(d) + '%' : String(x)))
console.log(`语料：${sessionsUsed} 个会话（≥25 定稿步）；有锚点 ${sessionsWithAnchors}`)
console.log('锚点统计：' + Object.entries(anchorStats).map(([k, v]) => `${k}=${v}`).join('  '))
/** 输出顺序：每个信号紧跟它的"按运行期节流"版本（便于对照），最后是现役通道参照行。 */
const ORDERED = []
for (const name of Object.keys(SIGNALS)) {
  ORDERED.push(name)
  if (perSignal[`${name}·节流`]) ORDERED.push(`${name}·节流`)
}
for (const ch of Object.keys(refChannels)) ORDERED.push(ch)

console.log(`\n强语义锚点（评估用）：${STRONG.join(' / ')}    lead=${LEAD}`)
console.log('信号                 触发/会话 每步率  锚点数  召回     随机召回  提前量  精度     基线    精度倍数')
const report = {
  generatedAtUtc: new Date().toISOString(),
  kind: 'drift-signal-discriminative-power',
  command: 'node tools/evaluate-signals.mjs [会话目录] --out <前缀>',
  note: '候选漂移信号的判别力评估（与 measure-recall 同口径）。**召回必须与"同预算随机召回"比较**：'
    + '按运行期节流(1/turn、≤3/会话)后的信号才是实际部署形态，未节流的召回只是"触发得多、蒙上的也多"。'
    + '结论（60 会话 / 285 强锚点）：没有任何候选同时具备"精度倍数 > 1"与"正提前量"；'
    + 'inaction 是唯一有正提前量(+3)的；repetition/failure 在漂移预测意义上低于随机(0.35×/0.50×)；'
    + 'L1 的 unverified-edit 按部署节流后≈随机(1.06×)——它是**事实提醒**，不是漂移预测器。',
  sessionsUsed, sessionsWithAnchors, anchorStats, strong: STRONG, lead: LEAD, signals: {}, leadCurve: {}, reference: {},
}
for (const name of ORDERED) {
  const rows = perSignal[name] || refChannels[name]
  const agg = aggregateDetection(rows, { lead: LEAD })
  const p = agg.pooled
  const totalFires = rows.reduce((a, r) => a + r.fires.length, 0)
  const firedSessions = rows.filter((r) => r.fires.length > 0).length
  const cr = chanceRecall(rows, LEAD)
  const fr = fireRate(rows)
  const lift = p.precision !== null && p.chancePrecision ? p.precision / p.chancePrecision : null
  const line = `${name.padEnd(18)} ${(totalFires / Math.max(1, rows.length)).toFixed(1).padStart(7)} ${fmt(fr).padStart(6)}  ${String(p.anchors).padStart(6)}  `
    + `${fmt(p.recall).padStart(7)}  ${fmt(cr).padStart(8)}  ${String(p.medianDelay ?? '—').padStart(6)}  ${fmt(p.precision).padStart(7)}  ${fmt(p.chancePrecision).padStart(6)}  ${(lift === null ? '—' : lift.toFixed(2) + '×').padStart(8)}`
  console.log(line)
  const entry = { fires: totalFires, firesPerSession: totalFires / Math.max(1, rows.length), fireRate: fr, firedSessionRate: firedSessions / Math.max(1, rows.length), pooled: p, chanceRecall: cr, precisionLift: lift, macroRecall: agg.macroRecall }
  if (perSignal[name]) report.signals[name] = entry
  else report.reference[name] = entry
}

// lead 曲线（+1 = 精确率提升倍数）
console.log('\n召回 vs lead（允许提前多少步）')
const leads = []
for (let l = 0; l <= MAX_LEAD; l++) leads.push(l)
console.log('信号              ' + leads.map((l) => String(l).padStart(7)).join(''))
for (const name of ORDERED) {
  const rows = perSignal[name] || refChannels[name]
  const cells = leads.map((l) => {
    const a = aggregateDetection(rows, { lead: l })
    return (a.pooled.recall === null ? '—' : (a.pooled.recall * 100).toFixed(1) + '%').padStart(7)
  })
  console.log(`${name.padEnd(18)}` + cells.join(''))
  report.leadCurve[name] = leads.map((l) => ({ lead: l, ...aggregateDetection(rows, { lead: l }).pooled }))
}

// 分锚点种类（哪个信号能提前发现哪种劣化）
console.log('\n分锚点种类（lead=3）')
console.log('信号               锚点种类              锚点数  召回     精度    基线     中位提前')
for (const name of ORDERED) {
  const rows = perSignal[name] || refChannels[name]
  for (const kind of Object.values(ANCHOR_KINDS)) {
    const subset = rows.map((r) => ({ ...r, anchors: (r.anchorsByKind && r.anchorsByKind[kind]) || [] }))
    const total = subset.reduce((a, r) => a + r.anchors.length, 0)
    if (total === 0) continue
    const p = aggregateDetection(subset, { lead: LEAD }).pooled
    console.log(`${name.padEnd(18)} ${kind.padEnd(20)} ${String(total).padStart(6)}  ${fmt(p.recall).padStart(7)}  ${fmt(p.precision).padStart(6)}  ${fmt(p.chancePrecision).padStart(6)}  ${String(p.medianDelay ?? '—').padStart(8)}`)
  }
}

writeFileSync(`${outPrefix}.json`, JSON.stringify(report, null, 2), 'utf8')
console.log(`\n产物：${outPrefix}.json`)
