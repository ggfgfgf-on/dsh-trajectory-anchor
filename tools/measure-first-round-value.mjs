/**
 * measure-first-round-value.mjs —— 检验那句愿景里**从未被检验过的前提**：
 * 「首轮的好行为值得锁定」—— 也就是：**首轮特征能不能预测后半程会不会出问题？**
 *
 * 为什么必须先检验这个：整句话的第一半（"locks in the good first-round behavior"）默认
 * "首轮好 ⇒ 后面好"。如果这个相关性在真实语料里不存在，那么 L2（把首轮载荷放回近因位置）
 * 与整套锚定机制**锁的是一个与结果无关的东西**——那比"信号弱"更根本。
 *
 * 口径（防泄漏，两条都重要）：
 *   · 预测变量只取**首轮**：第一条助手消息的推理块数/文本长度，以及**前 3 步**的工具调用与失败；
 *   · 结果只取**第 4 步之后**的强语义锚点（unknown-tool / user-correction / abandoned-turn），
 *     并按百步归一化（否则长会话天然锚点多）；
 *   · 显著性用**置换检验**（打乱标签 10000 次），因为样本小、分布未知。
 *
 * 用法：node tools/measure-first-round-value.mjs [会话目录] [--out 前缀] [--perm 10000]
 */
import { writeFileSync } from 'node:fs'
import { resolve, basename, join } from 'node:path'
import { decodeSessionLog, walk } from './session-log-core.mjs'
import { ANCHOR_KINDS, anchorsFromEvents, alignAnchors } from './drift-label-core.mjs'
import { buildLedgerFromEvents } from '../index.js'

const args = process.argv.slice(2)
const FLAGS_WITH_VALUE = new Set(['--out', '--perm'])
const positional = []
for (let i = 0; i < args.length; i++) {
  if (FLAGS_WITH_VALUE.has(args[i])) { i += 1; continue }
  if (args[i].startsWith('--')) continue
  positional.push(args[i])
}
const sessionsDir = resolve(positional[0] || (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.dsh\\sessions` : '.'))
const outPrefix = resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : './first-round-value')
const PERM = Number(args.includes('--perm') ? args[args.indexOf('--perm') + 1] : 10000)
const STRONG = [ANCHOR_KINDS.UNKNOWN_TOOL, ANCHOR_KINDS.USER_CORRECTION, ANCHOR_KINDS.ABANDONED_TURN]
const WARMUP = 3            // 前 3 步算"首轮"，结果只看第 4 步之后（防泄漏）

const files = walk(sessionsDir, []).filter((f) => f.endsWith('session.jsonl.zstd'))
const rows = []
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

  // ── 首轮特征（只有前 3 步 + 第一条助手消息）──
  let planBlocks = null
  let firstTextLen = 0
  let firstHasReasoning = false
  for (const ev of events) {
    if (!ev || ev.type !== 'assistant/message') continue
    const d = ev.data || {}
    if (d.turn !== 1) continue
    const blocks = d.message && Array.isArray(d.message.content) ? d.message.content : []
    const reas = blocks.filter((b) => b && b.type === 'reasoning')
    const texts = blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('')
    planBlocks = reas.length
    firstTextLen = texts.length
    firstHasReasoning = reas.length > 0
    break
  }
  if (planBlocks === null) continue
  const early = steps.slice(0, WARMUP)
  const earlyTools = early.reduce((a, s) => a + (s.tools || 0), 0)
  const earlyFailures = early.reduce((a, s) => a + (s.failures || 0), 0)

  // ── 结果：第 4 步之后的强语义锚点（按百步归一化）──
  const anchorsAll = anchorsFromEvents(events)
  const plain = anchorsAll.filter((a) => STRONG.includes(a.kind) && a.kind !== ANCHOR_KINDS.USER_CORRECTION)
  const aligned = alignAnchors(steps, plain).aligned
  const users = anchorsAll.filter((a) => a.kind === ANCHOR_KINDS.USER_CORRECTION)
  for (const a of users) {
    const t = Number.isFinite(a.eventIndex) ? built.trace[a.eventIndex] : null
    const idx = t ? t.len - 1 : -1
    if (idx >= 0 && idx < steps.length) aligned.push({ idx, kind: a.kind })
  }
  const late = aligned.filter((a) => a.idx >= WARMUP)
  const lateStrong = late.length
  const restSteps = Math.max(1, steps.length - WARMUP)
  // ⚠ 单位选择很关键（第一次跑就被自己的数据打回来）：强语义锚点里 user-correction 与
  // abandoned-turn **本来就是"按回合"的事件**，用"每百步"归一化仍会随会话变长而升高
  // （实测 0.05 → 0.18 → 0.90 随 <100 / 100-300 / ≥300 步单调上升，ρ(锚点率, 步数)=0.61）
  // ⇒ 那样测出来的"相关"一部分只是长度伪装。所以同时给出**按回合**率与**二值**结局。
  const lateTurns = new Set(steps.slice(WARMUP).map((s) => s.turn)).size
  rows.push({
    sid,
    steps: steps.length,
    turns: new Set(steps.map((s) => s.turn)).size,
    planBlocks,
    firstTextLen,
    firstHasReasoning,
    earlyTools,
    earlyFailures,
    lateStrong,
    latePer100: (lateStrong / restSteps) * 100,
    latePerTurn: lateTurns ? (lateStrong / lateTurns) * 100 : null,
    hasLateStrong: lateStrong > 0,
    lateUnknownTool: late.filter((a) => a.kind === ANCHOR_KINDS.UNKNOWN_TOOL).length,
    lateUserCorrection: late.filter((a) => a.kind === ANCHOR_KINDS.USER_CORRECTION).length,
    lateAbandoned: late.filter((a) => a.kind === ANCHOR_KINDS.ABANDONED_TURN).length,
  })
}

// ── 统计：置换检验（打乱标签）──
function permP(values, labels, iters) {
  const n = values.length
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
  const g1 = values.filter((_, i) => labels[i])
  const g0 = values.filter((_, i) => !labels[i])
  if (g1.length === 0 || g0.length === 0) return { p: null, diff: null }
  const observed = Math.abs(mean(g1) - mean(g0))
  let ge = 0
  const idx = values.map((_, i) => i)
  for (let it = 0; it < iters; it++) {
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]] }
    const permLabels = new Array(n)
    for (let i = 0; i < n; i++) permLabels[idx[i]] = i < g1.length
    const p1 = values.filter((_, i) => permLabels[i])
    const p0 = values.filter((_, i) => !permLabels[i])
    if (Math.abs(mean(p1) - mean(p0)) >= observed) ge++
  }
  return { p: (ge + 1) / (iters + 1), diff: mean(g1) - mean(g0), n1: g1.length, n0: g0.length, mean1: mean(g1), mean0: mean(g0) }
}

/** Spearman 秩相关 + 置换 p。 */
function spearman(xs, ys, iters) {
  const rank = (arr) => {
    const sorted = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v)
    const r = new Array(arr.length)
    for (let k = 0; k < sorted.length; k++) r[sorted[k].i] = k + 1
    return r
  }
  const rx = rank(xs)
  const ry = rank(ys)
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length
  const mx = mean(rx)
  const my = mean(ry)
  const num = rx.reduce((a, v, i) => a + (v - mx) * (ry[i] - my), 0)
  const den = Math.sqrt(rx.reduce((a, v) => a + (v - mx) ** 2, 0) * ry.reduce((a, v) => a + (v - my) ** 2, 0))
  const rho = den === 0 ? 0 : num / den
  let ge = 0
  const idx = ys.map((_, i) => i)
  for (let it = 0; it < iters; it++) {
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]] }
    const sy = idx.map((i) => ys[i])
    const ry2 = rank(sy)
    const n2 = rx.reduce((a, v, i) => a + (v - mx) * (ry2[i] - my), 0)
    const d2 = Math.sqrt(rx.reduce((a, v) => a + (v - mx) ** 2, 0) * ry2.reduce((a, v) => a + (v - my) ** 2, 0))
    const r2 = d2 === 0 ? 0 : n2 / d2
    if (Math.abs(r2) >= Math.abs(rho)) ge++
  }
  return { rho, p: (ge + 1) / (iters + 1) }
}

const n = rows.length
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const fmt = (x, d = 2) => (x === null || x === undefined ? '—' : Number(x).toFixed(d))
console.log(`语料：${n} 个会话（≥25 定稿步）`)
console.log(`结果口径：第 ${WARMUP + 1} 步之后的强语义锚点（unknown-tool / user-correction / abandoned-turn），按百步归一化`)
console.log(`总体：anchors=${rows.reduce((a, r) => a + r.lateStrong, 0)}  平均 ${fmt(mean(rows.map((r) => r.latePer100)), 2)} /百步\n`)

console.log('=== 二值首轮特征：有 vs 无（置换检验 打乱标签 %d 次）===', PERM)
console.log('特征                        有(n)     无(n)   有:锚点/百步  无:锚点/百步   差值     置换 p')
const binary = [
  ['首轮有推理块（先想再做）', rows.map((r) => r.planBlocks > 0)],
  ['首轮第一步就动工具', rows.map((r) => r.earlyTools > 0)],
  ['首轮 3 步内出现过失败', rows.map((r) => r.earlyFailures > 0)],
]
const report = {
  generatedAtUtc: new Date().toISOString(),
  kind: 'first-round-predictive-value',
  command: 'node tools/measure-first-round-value.mjs [会话目录] --perm 3000 --out <前缀>',
  note: '检验那句愿景最上游的前提：首轮好 ⇒ 后面好。**结论：这批语料回答不了这个问题** —— '
    + '因为结局指标本身是会话规模的代理：强语义锚点的出现率随规模 4% → 20% → 100%（<100 / 100-300 / ≥300 步），'
    + '每种锚点与步数的 ρ=0.53-0.68；首轮特征也与规模相关（0.42-0.53）⇒ 观察到的 ρ=0.70-0.84 主要是"规模对规模"。'
    + '所以"首轮预测力"悬置，而更根本的问题是**标签不干净**：在这批语料上，"有锚点"≈"是大会话"。',
  sessions: n, warmup: WARMUP, binary: {}, correlations: {},
}
for (const [label, labels] of binary) {
  const st = permP(rows.map((r) => r.latePer100), labels, PERM)
  console.log(`${label.padEnd(26)} ${String(st.n1 ?? 0).padStart(4)} ${String(st.n0 ?? 0).padStart(6)}  ${fmt(st.mean1).padStart(12)} ${fmt(st.mean0).padStart(13)} ${fmt(st.diff).padStart(8)} ${(st.p === null ? '—' : st.p.toFixed(4)).padStart(8)}`)
  report.binary[label] = st
}

console.log('\n=== 先检查单位：结局指标本身是否仍依赖会话规模（应当是"不依赖"）===')
for (const [label, ys] of [['锚点/百步', rows.map((r) => r.latePer100)], ['锚点/百回合', rows.map((r) => r.latePerTurn ?? 0)], ['是否出现过锚点(0/1)', rows.map((r) => (r.hasLateStrong ? 1 : 0))]]) {
  const s = spearman(rows.map((r) => r.steps), ys, Math.min(PERM, 2000))
  console.log(`  ρ(${label}, 会话步数) = ${fmt(s.rho, 3)}  p=${s.p.toFixed(4)}`)
}

console.log('\n=== 数值首轮特征：与三种结局口径的秩相关 ===')
console.log('特征                      vs 锚点/百步        vs 锚点/百回合      vs 是否出现锚点')
for (const [label, xs] of [
  ['首轮推理块数', rows.map((r) => r.planBlocks)],
  ['首轮文本长度', rows.map((r) => r.firstTextLen)],
  ['首轮 3 步工具调用数', rows.map((r) => r.earlyTools)],
  ['首轮 3 步失败数', rows.map((r) => r.earlyFailures)],
]) {
  const a = spearman(xs, rows.map((r) => r.latePer100), PERM)
  const b = spearman(xs, rows.map((r) => r.latePerTurn ?? 0), PERM)
  const c = spearman(xs, rows.map((r) => (r.hasLateStrong ? 1 : 0)), PERM)
  console.log(`${label.padEnd(22)} ρ=${fmt(a.rho, 3)} p=${a.p.toFixed(3)}   ρ=${fmt(b.rho, 3)} p=${b.p.toFixed(3)}   ρ=${fmt(c.rho, 3)} p=${c.p.toFixed(3)}`)
  report.correlations[label] = { per100: a, perTurn: b, binary: c }
}

console.log('\n=== 二值首轮特征：有 vs 无（结局 = 是否出现过锚点，置换检验）===')
console.log('特征                        有(n) 出现锚点率   无(n) 出现锚点率   差值    置换 p')
for (const [label, labels] of [
  ['首轮有推理块（先想再做）', rows.map((r) => r.planBlocks > 0)],
  ['首轮第一步就动工具', rows.map((r) => r.earlyTools > 0)],
  ['首轮 3 步内出现过失败', rows.map((r) => r.earlyFailures > 0)],
]) {
  const st = permP(rows.map((r) => (r.hasLateStrong ? 1 : 0)), labels, PERM)
  console.log(`${label.padEnd(26)} ${String(st.n1 ?? 0).padStart(4)} ${fmt(st.mean1 === null ? null : st.mean1 * 100, 1).padStart(10)}% ${String(st.n0 ?? 0).padStart(5)} ${fmt(st.mean0 === null ? null : st.mean0 * 100, 1).padStart(10)}% ${fmt(st.diff, 3).padStart(8)} ${(st.p === null ? '—' : st.p.toFixed(4)).padStart(8)}`)
  report.binary[label] = st
}

console.log('\n=== 分位数视角（按"后半程锚点率"分两组）===')
const sorted = [...rows].sort((a, b) => a.latePer100 - b.latePer100)
const half = Math.floor(sorted.length / 2)
const low = sorted.slice(0, half)
const high = sorted.slice(-half)
for (const [label, key] of [['首轮推理块数', 'planBlocks'], ['首轮 3 步工具调用', 'earlyTools'], ['首轮 3 步失败', 'earlyFailures'], ['首轮文本长度', 'firstTextLen']]) {
  console.log(`  ${label.padEnd(20)} 后半程最好的一半=${fmt(mean(low.map((r) => r[key])))}  最差的一半=${fmt(mean(high.map((r) => r[key])))}`)
}
report.quartiles = { lowHalf: { planBlocks: mean(low.map((r) => r.planBlocks)), earlyTools: mean(low.map((r) => r.earlyTools)), earlyFailures: mean(low.map((r) => r.earlyFailures)), firstTextLen: mean(low.map((r) => r.firstTextLen)) }, highHalf: { planBlocks: mean(high.map((r) => r.planBlocks)), earlyTools: mean(high.map((r) => r.earlyTools)), earlyFailures: mean(high.map((r) => r.earlyFailures)), firstTextLen: mean(high.map((r) => r.firstTextLen)) } }
report.rows = rows
writeFileSync(`${outPrefix}.json`, JSON.stringify(report, null, 2), 'utf8')
console.log(`\n产物：${outPrefix}.json`)
