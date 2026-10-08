/**
 * test-drift-label.mjs —— 延迟标注与检测指标的单测（手算期望 + 负向验证）
 *
 * 三块：
 *   ① detectionMetrics 的判定口径（命中/漏掉/未解释触发/精度/精度基线）——全部手算；
 *   ② 锚点抽取（tool-error / unknown-tool / failure-marker / user-correction / abandoned-turn）
 *      含两条"不该抽出来"的负向：第 1 条人类消息不算纠偏；**会话断在最后的回合**算截断，
 *      不是弃置（这条错了会把"会话自然结束"当成漂移确认，直接污染召回）；
 *   ③ **循环标注必须响亮失败**，并且证明这条守卫是承重的：
 *      用 failure 通道自己的失败标记去评估 failure 通道，召回会被抬到 1.0——
 *      而正确口径（用 isError 这种独立信号）给出的召回低得多。守卫拦的就是后者被写成前者。
 *
 * 用法：node tools/test-drift-label.mjs [index.js 路径]
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const here = fileURLToPath(new URL('.', import.meta.url))
const target = resolve(here, process.argv[2] || '../index.js')
const mod = await import(pathToFileURL(target).href)
const {
  ANCHOR_KINDS, CHANNEL_OWN_KINDS, assertIndependent, anchorsFromEvents,
  alignAnchors, detectionMetrics, aggregateDetection,
} = await import(pathToFileURL(resolve(here, 'drift-label-core.mjs')).href)
const { buildLedgerFromEvents } = mod
const { walkChannel } = await import(pathToFileURL(resolve(here, 'behaviour-channel-core.mjs')).href)

let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ': ' + detail}`)
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ── ① detectionMetrics：手算 ────────────────────────────────────────────────
{
  // 触发在 10、50；锚点在 12（lead=3 内 ⇒ 命中，提前 2 步）与 100（无触发 ⇒ 漏）
  const m = detectionMetrics({ fires: [10, 50], anchors: [{ idx: 12 }, { idx: 100 }], totalSteps: 120, lead: 3 })
  check('① 召回 = 命中锚点/锚点总数', m.recall === 0.5, String(m.recall))
  check('① 提前量（anchor - fire）= 2', m.medianDelay === 2, String(m.medianDelay))
  check('① 未解释触发计入精度分母', m.hits === 1 && m.unexplainedFires === 1 && m.precision === 0.5, JSON.stringify({ h: m.hits, u: m.unexplainedFires, p: m.precision }))
  check('① 精度基线 = 正样本窗口占比', Math.abs(m.chancePrecision - (2 * 5) / 120) < 1e-9, String(m.chancePrecision))
}
{
  // lead=0：只认"锚点当步或之后 1 步"⇒ 10 步之前那次触发不再算提前发现
  const m = detectionMetrics({ fires: [10], anchors: [{ idx: 12 }], totalSteps: 20, lead: 0, tolerance: 1 })
  check('① lead=0 时提前触发不算命中（口径变化必须体现出来）', m.hits === 0 && m.recall === 0, JSON.stringify(m))
  const m2 = detectionMetrics({ fires: [12], anchors: [{ idx: 12 }], totalSteps: 20, lead: 0, tolerance: 1 })
  check('① 当步触发算命中、提前量 0', m2.hits === 1 && m2.medianDelay === 0, JSON.stringify({ h: m2.hits, d: m2.medianDelay }))
}
{
  // 一次触发只能"解释"一个锚点（不许一个触发把多个锚点都算命中）
  const m = detectionMetrics({ fires: [10], anchors: [{ idx: 10 }, { idx: 11 }], totalSteps: 20, lead: 1, tolerance: 1 })
  check('① 一次触发只解释一个锚点', m.hits === 1 && m.unexplainedFires === 0, JSON.stringify({ h: m.hits, u: m.unexplainedFires }))
}
{
  // 无锚点：召回为 null（不是 0——"没测到东西"与"一个都没抓到"是两回事）
  const m = detectionMetrics({ fires: [3], anchors: [], totalSteps: 10 })
  check('① 没有锚点时召回为 null（不伪装成 0）', m.recall === null && m.anchors === 0, JSON.stringify({ r: m.recall, a: m.anchors }))
}

// ── ② 锚点抽取 ─────────────────────────────────────────────────────────────
const callEv = (turn, step, name = 'pwsh') => ({ type: 'tool/call', data: { turn, step, name, arguments: 'a' } })
const msgEv = (turn, step) => ({ type: 'assistant/message', data: { turn, step, message: { content: [{ type: 'reasoning', text: 'x' }] } } })
const resultEv = (turn, step, text, isError = false) => ({
  type: 'tool/result',
  data: { turn, step, message: { content: [{ type: 'tool-result', isError, content: [{ type: 'text', text }] }] } },
})
const humanEv = (text) => ({ type: 'user/message', data: { source: { kind: 'user' }, role: 'user', content: [{ type: 'text', text }] } })
const turnEndEv = (turn) => ({ type: 'turn/end', data: { turn } })

{
  const ev = [
    humanEv('原始任务：修好 calc.py'),
    msgEv(1, 1), callEv(1, 1), resultEv(1, 1, 'unknown tool: vision_crop', true), msgEv(1, 2), turnEndEv(1),
    humanEv('不对，你没有修好，重新做'),
    msgEv(2, 1), callEv(2, 1), resultEv(2, 1, '[exit code: 1]', false), msgEv(2, 2), turnEndEv(2),
  ]
  const a = anchorsFromEvents(ev)
  const kinds = a.map((x) => x.kind)
  check('② 抽到 tool-error', kinds.includes(ANCHOR_KINDS.TOOL_ERROR), JSON.stringify(kinds))
  check('② 抽到 unknown-tool', kinds.includes(ANCHOR_KINDS.UNKNOWN_TOOL), JSON.stringify(kinds))
  check('② 抽到 failure-marker', kinds.includes(ANCHOR_KINDS.FAILURE_MARKER), JSON.stringify(kinds))
  check('② 抽到 user-correction（第 2 条人类消息）', kinds.includes(ANCHOR_KINDS.USER_CORRECTION), JSON.stringify(kinds))
  check('② 第 1 条人类消息不算纠偏', a.filter((x) => x.kind === ANCHOR_KINDS.USER_CORRECTION).length === 1, String(a.length))
  check('② 全部回合都有 turn/end ⇒ 无弃置锚点', !kinds.includes(ANCHOR_KINDS.ABANDONED_TURN), JSON.stringify(kinds))
}
{
  // 弃置：turn 1 没有 turn/end，但后面还有 turn 2 ⇒ 算弃置
  const abandoned = [msgEv(1, 1), callEv(1, 1), msgEv(1, 2), msgEv(2, 1), turnEndEv(2)]
  const a1 = anchorsFromEvents(abandoned)
  check('② 后面还有回合却缺 turn/end ⇒ 弃置锚点', a1.some((x) => x.kind === ANCHOR_KINDS.ABANDONED_TURN), JSON.stringify(a1.map((x) => x.kind)))
  // 截断：最后一个回合没有 turn/end ⇒ **不算**弃置
  const truncated = [msgEv(1, 1), callEv(1, 1), msgEv(1, 2), turnEndEv(1), msgEv(2, 1), callEv(2, 1), msgEv(2, 2)]
  const a2 = anchorsFromEvents(truncated)
  check('② 会话断在最后的回合 ⇒ 截断，不算弃置锚点',
    !a2.some((x) => x.kind === ANCHOR_KINDS.ABANDONED_TURN), JSON.stringify(a2.map((x) => x.kind)))
  // 只抽指定种类
  const a3 = anchorsFromEvents(abandoned, { kinds: [ANCHOR_KINDS.TOOL_ERROR] })
  check('② kinds 过滤生效（只要 tool-error 时其余不出现）', a3.every((x) => x.kind === ANCHOR_KINDS.TOOL_ERROR), JSON.stringify(a3))
}

// ── alignAnchors：对齐与丢弃计数 ───────────────────────────────────────────
{
  const steps = [{ turn: 1, step: 1 }, { turn: 1, step: 2 }, { turn: 2, step: 1 }]
  const { aligned, dropped } = alignAnchors(steps, [
    { kind: ANCHOR_KINDS.TOOL_ERROR, turn: 1, step: 2 },
    { kind: ANCHOR_KINDS.TOOL_ERROR, turn: 9, step: 9 },
  ])
  check('② 对齐命中 1 个、丢弃 1 个（未定稿步上的锚点必须计入丢弃而不是静默消失）',
    aligned.length === 1 && dropped === 1 && aligned[0].idx === 1, JSON.stringify({ aligned, dropped }))
}

// ── ③ 循环标注守卫（承重性验证）────────────────────────────────────────────
{
  check('③ failure 通道的自有信号就是 failure-marker', eq(CHANNEL_OWN_KINDS.failure, [ANCHOR_KINDS.FAILURE_MARKER]))
  let threw = null
  try { assertIndependent('failure', [ANCHOR_KINDS.FAILURE_MARKER]) } catch (e) { threw = e.message }
  check('③ 用自有信号评估 failure ⇒ 响亮抛错', typeof threw === 'string' && /循环标注/.test(threw), String(threw))
  check('③ 用独立信号评估 failure ⇒ 放行', assertIndependent('failure', [ANCHOR_KINDS.TOOL_ERROR, ANCHOR_KINDS.UNKNOWN_TOOL]) === true)
  let threw2 = null
  try { assertIndependent('nosuch', []) } catch (e) { threw2 = e.message }
  check('③ 未知通道 ⇒ 抛错（避免打错字变成"没有自有信号"从而静默放过）', typeof threw2 === 'string', String(threw2))

  // 承重性：同一段数据，用循环锚点 vs 独立锚点，召回差异必须出现。
  // 序列构造：60 个 0 + 10 个 1（下标 60..69），α=1e-3 ⇒ 从下标 62 起能连续触发
  // （参考段够长，且命中对 p̂ 的抬升要好几步才越过 α——所以这里能真的"连续命中"）。
  const series = [...Array(60).fill(0), ...Array(10).fill(1)]
  const cfg = { testWindow: 3, refMinSteps: 20, alpha: 1e-3, consecutive: 1 }
  const walk = walkChannel([{ sid: 'x', failure: series }], 'failure', cfg)
  const fires = walk.perSession[0].fires
  check('③ 该构造确实触发了（否则下面的对比无意义）', fires.length > 0, JSON.stringify(fires))
  // 独立锚点：isError 出现在远离触发处（下标 80/90 不存在 → 用 lead 之外的位置）
  const independent = detectionMetrics({ fires, anchors: [{ idx: fires[fires.length - 1] + 10 }], totalSteps: series.length, lead: 3 })
  // 循环锚点：失败文本标记恰好落在通道会触发的那些步
  const circular = detectionMetrics({ fires, anchors: [{ idx: fires[0] }], totalSteps: series.length, lead: 3 })
  check('③ 循环锚点会把召回抬到 1.0（这正是必须禁止它的原因）', circular.recall === 1, JSON.stringify(circular))
  check('③ 同一批触发用独立锚点时召回更低（守卫是承重的，不是装饰）',
    independent.recall !== null && independent.recall < circular.recall, JSON.stringify({ ind: independent.recall, cir: circular.recall }))
}

// ── ④ 离线走查的窗口/连续确认语义（手算）────────────────────────────────────
{
  // 序列：60 个 0，其后 10 个 1。refMinSteps=20/testWindow=3 ⇒ 最早可判定于下标 62
  // （长度 ≥ 23 即可判定，但下标 60/61 的窗口还不满 3 个 1）。
  const series = [...Array(60).fill(0), ...Array(10).fill(1)]
  const k1 = walkChannel([{ sid: 's', inaction: series }], 'inaction', { testWindow: 3, refMinSteps: 20, alpha: 1e-3, consecutive: 1 })
  const k2 = walkChannel([{ sid: 's', inaction: series }], 'inaction', { testWindow: 3, refMinSteps: 20, alpha: 1e-3, consecutive: 2 })
  check('④ k=1：首个可判定的命中窗在下标 61（60 个 0 之后）', k1.perSession[0].fires[0] === 61, JSON.stringify(k1.perSession[0].fires.slice(0, 6)))
  check('④ k=2：需要连续两次 ⇒ 首触发推迟到下标 62',
    k2.perSession[0].fires[0] === 62, JSON.stringify(k2.perSession[0].fires.slice(0, 6)))
  check('④ k=2 的触发集合是 k=1 的子集（迟滞只会更保守）',
    k2.perSession[0].fires.every((f) => k1.perSession[0].fires.includes(f)),
    JSON.stringify({ k1: k1.perSession[0].fires, k2: k2.perSession[0].fires }))
  // firstFireStep 是 1-based 的"确认游程第一步"：k=1 时 = fires[0]+1；k=2 时比 fires[0] 早一步
  // （游程从 61 起，触发落在 62）。做召回一律用 fires（0-based），不要混两套编号。
  check('④ firstFireStep 为 1-based 且指向确认游程首步',
    k1.perSession[0].firstFireStep === k1.perSession[0].fires[0] + 1
    && k2.perSession[0].firstFireStep === k2.perSession[0].fires[0],
    JSON.stringify({ k1: k1.perSession[0].firstFireStep, k2: k2.perSession[0].firstFireStep, f1: k1.perSession[0].fires[0], f2: k2.perSession[0].fires[0] }))
  // 参考段不够长时**不判定**（不许提前触发）
  const short = walkChannel([{ sid: 's', inaction: [1, 1, 1, 1, 1] }], 'inaction', { testWindow: 3, refMinSteps: 20, alpha: 0.5, consecutive: 1 })
  check('④ 参考段不足 ⇒ 零触发（α 放到 0.5 也不许判）', short.perSession[0].fires.length === 0, JSON.stringify(short.perSession[0].fires))
}

// ── ⑤ 聚合：池化与按会话平均 ───────────────────────────────────────────────
{
  const agg = aggregateDetection([
    { sid: 'a', steps: 30, fires: [22], anchors: [{ idx: 22 }] },
    { sid: 'b', steps: 30, fires: [], anchors: [{ idx: 25 }] },
  ], { lead: 3 })
  check('⑤ 池化召回 = 2 个锚点里命中 1 个', agg.pooled.recall === 0.5, String(agg.pooled.recall))
  check('⑤ 按会话平均召回 = (1 + 0)/2', agg.macroRecall === 0.5, String(agg.macroRecall))
  check('⑤ 会话级明细可见（能看出是哪个会话漏的）', agg.perSessionRecall.length === 2 && agg.perSessionRecall[1].recall === 0,
    JSON.stringify(agg.perSessionRecall))
}

// ── ⑥ 与真实台账对接：锚点必须能对齐到定稿步 ────────────────────────────────
{
  const events = [
    msgEv(1, 1), callEv(1, 1), resultEv(1, 1, 'ok', true), msgEv(1, 2), turnEndEv(1),
    msgEv(2, 1), callEv(2, 1), resultEv(2, 1, 'ok', false), msgEv(2, 2), turnEndEv(2),
  ]
  const { series } = buildLedgerFromEvents(events)
  const anchors = anchorsFromEvents(events)
  const { aligned, dropped } = alignAnchors(series.steps, anchors)
  check('⑥ 真实台账的定稿步可承载锚点对齐', aligned.length >= 1 && dropped === 0, JSON.stringify({ aligned, dropped }))
  check('⑥ 对齐后的下标在序列范围内', aligned.every((a) => a.idx >= 0 && a.idx < series.inaction.length),
    JSON.stringify({ idx: aligned.map((a) => a.idx), len: series.inaction.length }))
}

console.log(`\n${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
