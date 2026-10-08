/**
 * measure-recall.mjs —— 用**事后确认的延迟标注**测出召回 / 延迟 / 精度（T4）
 *
 * 这是把 `recallSide.status = UNMEASURED` 变成数字的那个工具。
 *
 * 口径（全部写在 drift-label-core.mjs 里，此处不另立一套）：
 *   · 锚点 = 事后确认的劣化事件（tool-error / unknown-tool / user-correction / abandoned-turn；
 *     failure-marker 只用于评估**其它**通道——用它评估 failure 通道就是循环标注，会被守卫拦住）；
 *   · 命中 = 锚点之前 lead 步之内（或当步）有过触发；
 *   · 延迟 = 锚点下标 − 命中触发下标（正数 = 提前发现）；
 *   · 未解释触发 = 不落在任何锚点窗口内的触发 ⇒ 精度的分母；
 *   · 精度必须与**基线**比（触发位置随机时的期望精度 = 正样本窗口占比）。
 *
 * 用法：
 *   node tools/measure-recall.mjs [会话目录] [--lead 3] [--max-lead 6] [--out 前缀]
 * 输出：控制台表 + <前缀>.json
 */
import { writeFileSync, readFileSync } from 'node:fs'
import { resolve, basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeSessionLog, walk } from './session-log-core.mjs'
import { walkChannel } from './behaviour-channel-core.mjs'
import { ANCHOR_KINDS, assertIndependent, anchorsFromEvents, alignAnchors, aggregateDetection } from './drift-label-core.mjs'
import { buildLedgerFromEvents } from '../index.js'

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
const outPrefix = resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : './recall-report')

/**
 * 每条通道用哪套锚点：**必须排除它自己的信号**（守卫会抛错，这里就是被守的地方）。
 * failure 用 tool-error/unknown-tool/user-correction/abandoned-turn；
 * 其余通道同样排除 failure-marker（那是另一个通道的信号，用它当锚点虽不循环但会偏袒 failure）。
 */
const CHANNEL_ANCHORS = {
  inaction: [ANCHOR_KINDS.TOOL_ERROR, ANCHOR_KINDS.UNKNOWN_TOOL, ANCHOR_KINDS.USER_CORRECTION, ANCHOR_KINDS.ABANDONED_TURN],
  repetition: [ANCHOR_KINDS.TOOL_ERROR, ANCHOR_KINDS.UNKNOWN_TOOL, ANCHOR_KINDS.USER_CORRECTION, ANCHOR_KINDS.ABANDONED_TURN],
  failure: [ANCHOR_KINDS.TOOL_ERROR, ANCHOR_KINDS.UNKNOWN_TOOL, ANCHOR_KINDS.USER_CORRECTION, ANCHOR_KINDS.ABANDONED_TURN],
}
/** 每通道的走查参数（与 index.js DEFAULTS.responseChannels 对齐）。 */
const CHANNEL_CFG = {
  inaction: { testWindow: 3, refMinSteps: 20 },
  repetition: { testWindow: 3, refMinSteps: 20 },
  failure: { testWindow: 3, refMinSteps: 20 },
}

/**
 * α/k 从**出厂标定件**读（单一来源）；读不到就回落到保守默认值。
 * 允许 env 覆盖以便扫 α：MEASURE_ALPHA / MEASURE_K。
 */
let artifact = null
try { artifact = JSON.parse(readFileSync(resolve(here, '..', 'responsePolicy.json'), 'utf8')) } catch { artifact = null }
const derivedOf = (ch) => {
  const d = artifact && artifact.channels && artifact.channels[ch] && artifact.channels[ch].derived
  return d && Number.isFinite(d.alpha) ? d : null
}
const ALPHA_BY_CHANNEL = {
  inaction: Number(process.env.MEASURE_ALPHA) || derivedOf('inaction')?.alpha || 0.001,
  repetition: Number(process.env.MEASURE_ALPHA) || derivedOf('repetition')?.alpha || 1e-5,
  failure: Number(process.env.MEASURE_ALPHA) || derivedOf('failure')?.alpha || 1e-5,
}
const K_BY_CHANNEL = {
  inaction: Number(process.env.MEASURE_K) || derivedOf('inaction')?.consecutive || 1,
  repetition: Number(process.env.MEASURE_K) || derivedOf('repetition')?.consecutive || 1,
  failure: Number(process.env.MEASURE_K) || derivedOf('failure')?.consecutive || 1,
}

// 守卫：任何"锚点里含自有信号"的配置都必须在这里就炸掉，而不是安静地测出一个漂亮数字
for (const [ch, kinds] of Object.entries(CHANNEL_ANCHORS)) assertIndependent(ch, kinds)

const files = walk(sessionsDir, []).filter((f) => f.endsWith('session.jsonl.zstd'))
const perChannel = { inaction: [], repetition: [], failure: [] }
const anchorStats = {}
let sessionsUsed = 0
let sessionsWithAnchors = 0

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
  const anchorsAll = anchorsFromEvents(events)
  for (const a of anchorsAll) anchorStats[a.kind] = (anchorStats[a.kind] || 0) + 1
  const anchorsByKind = (kinds) => anchorsAll.filter((a) => kinds.includes(a.kind))
  if (anchorsAll.length > 0) sessionsWithAnchors++

  for (const ch of Object.keys(perChannel)) {
    const kinds = CHANNEL_ANCHORS[ch]
    const key = ch
    const series = built.series[key]
    const cfg = CHANNEL_CFG[ch]
    const alpha = ALPHA_BY_CHANNEL[ch]
    const consecutive = K_BY_CHANNEL[ch]
    const w = walkChannel([{ sid, [key]: series }], key, { ...cfg, alpha, consecutive })
    const fires = w.perSession[0].fires
    // 锚点对齐：turn/step 型直接用键映射；user-correction 用 trace 映到"此刻最后一个已定稿步"
    const { aligned, dropped } = alignAnchorsAnchors(steps, anchorsAll.filter((a) => kinds.includes(a.kind)), built.trace, events, anchorsAll, kinds)
    // 分锚点种类的下标集合（供"到底哪种锚点能被提前发现"的分析）
    const byKind = {}
    for (const a of aligned) {
      if (!byKind[a.kind]) byKind[a.kind] = []
      byKind[a.kind].push({ idx: a.idx })
    }
    perChannel[ch].push({
      sid,
      steps: steps.length,
      fires,
      seriesForSweep: series,
      anchors: aligned.map((a) => ({ idx: a.idx })),
      anchorsByKind: byKind,
      dropped,
    })
  }
}

/** 把锚点对齐到序列下标（含 user-correction 的轨迹映射）。 */
function alignAnchorsAnchors(steps, anchors, trace, events, allAnchors, kinds) {
  const plain = anchors.filter((a) => a.kind !== ANCHOR_KINDS.USER_CORRECTION)
  const userOnes = allAnchors.filter((a) => a.kind === ANCHOR_KINDS.USER_CORRECTION && kinds.includes(a.kind))
  const { aligned, dropped } = alignAnchors(steps, plain)
  let extra = 0
  let droppedUser = 0
  for (const a of userOnes) {
    const t = Number.isFinite(a.eventIndex) ? trace[a.eventIndex] : null
    const idx = t ? t.len - 1 : -1
    if (idx >= 0 && idx < steps.length) { aligned.push({ idx, kind: a.kind, detail: a.detail }); extra++ }
    else droppedUser++
  }
  aligned.sort((x, y) => x.idx - y.idx)
  return { aligned, dropped: dropped + droppedUser, userAligned: extra }
}

console.log(`语料：${sessionsUsed} 个会话（≥25 定稿步；共 ${files.length} 个日志）`)
console.log(`有锚点的会话：${sessionsWithAnchors}`)
console.log('锚点统计：' + Object.entries(anchorStats).map(([k, v]) => `${k}=${v}`).join('  '))
console.log(`\n按通道（每通道都排除了自有信号作为锚点；lead=${LEAD}，max-lead=${MAX_LEAD}）`)
console.log('通道        α/k            触发数  锚点  召回     精度    精度基线  中位提前   未解释触发')
const report = { generatedAtUtc: new Date().toISOString(), sessionsUsed, sessionsWithAnchors, anchorStats, lead: LEAD, channels: {} }
for (const [ch, rows] of Object.entries(perChannel)) {
  const alpha = ALPHA_BY_CHANNEL[ch]
  const k = K_BY_CHANNEL[ch]
  const agg = aggregateDetection(rows, { lead: LEAD })
  const p = agg.pooled
  const fmt = (x, d = 3) => (x === null || x === undefined ? '—' : Number(x).toFixed(d))
  console.log(`${ch.padEnd(11)} ${String(alpha).padEnd(8)} k=${k}  ${String(p.fires).padStart(6)}  ${String(p.anchors).padStart(4)}  `
    + `${(p.recall === null ? '—' : (p.recall * 100).toFixed(1) + '%').padStart(7)}  `
    + `${(p.precision === null ? '—' : (p.precision * 100).toFixed(1) + '%').padStart(6)}  `
    + `${(p.chancePrecision === null ? '—' : (p.chancePrecision * 100).toFixed(1) + '%').padStart(8)}  `
    + `${String(p.medianDelay ?? '—').padStart(8)}  ${String(p.unexplainedFires).padStart(10)}`)
  report.channels[ch] = { alpha, consecutive: k, pooled: p, macroRecall: agg.macroRecall, sessionsWithAnchors: agg.sessionsWithAnchors, perSession: agg.perSessionRecall.filter((s) => s.anchors > 0).slice(0, 40) }
}
console.log('\n召回 vs lead 曲线（lead = 允许提前多少步；值 = 召回率）')
const leads = []
for (let l = 0; l <= MAX_LEAD; l++) leads.push(l)
console.log('通道       ' + leads.map((l) => String(l).padStart(7)).join(''))
for (const [ch, rows] of Object.entries(perChannel)) {
  const cells = leads.map((l) => {
    const a = aggregateDetection(rows, { lead: l })
    return (a.pooled.recall === null ? '—' : (a.pooled.recall * 100).toFixed(1) + '%').padStart(7)
  })
  console.log(`${ch.padEnd(11)}` + cells.join(''))
}
report.leadCurve = Object.fromEntries(Object.entries(perChannel).map(([ch, rows]) => [ch, leads.map((l) => ({ lead: l, ...aggregateDetection(rows, { lead: l }).pooled }))]))

// ── 分锚点种类：不是所有锚点都代表"漂移" ────────────────────────────────────
// `tool-error` / `failure-marker` 在真实工作里是**常态**（跑测试就是要报错），把它当漂移确认
// 会让基线膨胀到 ~19%（每 5 步就有一步落在某个确认点之前）。真正带"跑偏"语义的是
// unknown-tool（工具面/计划不匹配）、user-correction（人说你跑偏了）、abandoned-turn（回合被弃）。
console.log('\n分锚点种类（lead=3；漂移语义强弱从左到右递减）')
console.log('通道        锚点种类              锚点数  召回     精度    基线     中位提前')
const perKind = {}
for (const [ch, rows] of Object.entries(perChannel)) {
  perKind[ch] = {}
  for (const kind of Object.values(ANCHOR_KINDS)) {
    const subset = rows.map((r) => ({ ...r, anchors: r.anchorsByKind[kind] || [] }))
    const anchorsTotal = subset.reduce((a, r) => a + r.anchors.length, 0)
    if (anchorsTotal === 0) continue
    const agg = aggregateDetection(subset, { lead: LEAD })
    const p = agg.pooled
    perKind[ch][kind] = { anchors: anchorsTotal, ...p }
    console.log(`${ch.padEnd(11)} ${kind.padEnd(20)} ${String(anchorsTotal).padStart(6)}  `
      + `${(p.recall === null ? '—' : (p.recall * 100).toFixed(1) + '%').padStart(6)}  `
      + `${(p.precision === null ? '—' : (p.precision * 100).toFixed(1) + '%').padStart(6)}  `
      + `${(p.chancePrecision === null ? '—' : (p.chancePrecision * 100).toFixed(1) + '%').padStart(6)}  `
      + `${String(p.medianDelay ?? '—').padStart(8)}`)
    if (!rows.anchorsByKind) rows.anchorsByKind = {}
  }
}
report.perAnchorKind = perKind

// ── α × k 扫描：这条信号到底有没有判别力（ROC 式视角）────────────────────────
// 若 α 放宽到 0.05 时召回仍然接近 0，而误报却按标定曲线爆炸，那结论不是"阈值选错了"，
// 而是"这条信号没有判别力"——这决定了后面该调参还是该换测量。
console.log('\nα × k 扫描（每次检验的 α；rm = 每次检验的命中率不成比例地上升 = 无判别力）')
console.log('通道        α        k   触发/会话  召回@3   精度     基线     误报会话率')
const sweep = {}
const ALPHAS = [0.05, 0.01, 0.005, 0.001, 1e-4, 1e-5, 1e-6]
const KS = [1, 2]
for (const ch of Object.keys(perChannel)) {
  sweep[ch] = []
  const rowsBase = perChannel[ch]
  for (const k of KS) {
    for (const alpha of ALPHAS) {
      const rows = rowsBase.map((r) => {
        const w = walkChannel([{ sid: r.sid, [ch]: r.seriesForSweep }], ch, { ...CHANNEL_CFG[ch], alpha, consecutive: k })
        return { ...r, fires: w.perSession[0].fires }
      })
      const agg = aggregateDetection(rows, { lead: LEAD })
      const p = agg.pooled
      const firesPerSession = rows.reduce((a, r) => a + r.fires.length, 0) / Math.max(1, rows.length)
      const firedSessions = rows.filter((r) => r.fires.length > 0).length / Math.max(1, rows.length)
      sweep[ch].push({ alpha, k, firesPerSession, firedSessions, recall: p.recall, precision: p.precision, chancePrecision: p.chancePrecision, medianDelay: p.medianDelay })
      console.log(`${ch.padEnd(11)} ${String(alpha).padEnd(8)} ${k}  ${firesPerSession.toFixed(2).padStart(9)}  `
        + `${(p.recall === null ? '—' : (p.recall * 100).toFixed(1) + '%').padStart(6)}  `
        + `${(p.precision === null ? '—' : (p.precision * 100).toFixed(1) + '%').padStart(6)}  `
        + `${(p.chancePrecision === null ? '—' : (p.chancePrecision * 100).toFixed(1) + '%').padStart(6)}  `
        + `${(firedSessions * 100).toFixed(1).padStart(6)}%`)
    }
  }
}
report.sweep = sweep
writeFileSync(`${outPrefix}.json`, JSON.stringify(report, null, 2), 'utf8')
console.log(`\n产物：${outPrefix}.json`)
