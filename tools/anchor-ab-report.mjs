/**
 * anchor-ab-report.mjs —— 锚定 A/B 干预实验的判定件
 *
 * 背景（为什么必须做实验而不是继续看历史语料）：历史语料里"最后一次验证是否通过"
 * 是 pass=20 / fail=**0**（没有反例），而延迟锚点结局又是**会话规模的代理** ⇒
 * 观察性数据**无法**回答"锚定是否让结果更好"。所以只能做**干预实验**：
 * 固定任务 × 条件 A（锚定开）/ B（锚定关），配对比较。
 *
 * 判定纪律（与 L2 分析器同一套精神：单臂 ⇒ 不估计；方向 + 显著性 + 配对稳健性都要过）：
 *   · 只有单条件 ⇒ INSUFFICIENT（"没有对照就没有效果"）；
 *   · 用 **配对差**（同一任务在两条件下的 final 之差）做主检验 ⇒ 消掉任务难度；
 *   · 同时报**非配对**的置换检验（两组 final 分布）与"是否全通过"的二值对照；
 *   · 样本不足（配对数 < --min-pairs，默认 4）⇒ INSUFFICIENT。
 *
 * 用法：node tools/anchor-ab-report.mjs <results.jsonl> [--out 前缀] [--min-pairs 4] [--perm 20000]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const FLAGS = new Set(['--out', '--min-pairs', '--perm'])
const pos = []
for (let i = 0; i < args.length; i++) {
  if (FLAGS.has(args[i])) { i += 1; continue }
  if (args[i].startsWith('--')) continue
  pos.push(args[i])
}
const src = pos[0]
if (!src) { console.error('用法：node tools/anchor-ab-report.mjs <results.jsonl> [--out 前缀]'); process.exit(1) }
const val = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d)
const minPairs = Number(val('--min-pairs', 4))
const PERM = Number(val('--perm', 20000))
const outPrefix = resolve(val('--out', './anchor-ab-report'))

const rows = readFileSync(resolve(src), 'utf8').split('\n').filter((l) => l.trim())
  .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
const A = rows.filter((r) => r.condition === 'anchor-on')
const B = rows.filter((r) => r.condition === 'anchor-off')
const fmt = (x, d = 2) => (x === null || x === undefined ? '—' : Number(x).toFixed(d))
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

/** 配对差：同一任务在两条件下的 final 之差（A − B）。 */
const byTask = (set) => Object.fromEntries(set.map((r) => [r.task, r]))
const mA = byTask(A)
const mB = byTask(B)
const paired = Object.keys(mA).filter((t) => mB[t]).map((t) => ({ task: t, a: mA[t].final - mA[t].start, b: mB[t].final - mB[t].start, delta: (mA[t].final - mA[t].start) - (mB[t].final - mB[t].start) }))

function permPaired(deltas, iters) {
  const obs = Math.abs(mean(deltas))
  let ge = 0
  for (let it = 0; it < iters; it++) {
    let s = 0
    for (const d of deltas) s += Math.random() < 0.5 ? -d : d      // 随机翻转符号（配对置换）
    if (Math.abs(s / deltas.length) >= obs) ge++
  }
  return (ge + 1) / (iters + 1)
}
function permUnpaired(a, b, iters) {
  const obs = Math.abs(mean(a) - mean(b))
  const all = [...a, ...b]
  let ge = 0
  for (let it = 0; it < iters; it++) {
    const idx = all.map((_, i) => i)
    for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]] }
    const g1 = idx.slice(0, a.length).map((i) => all[i])
    const g0 = idx.slice(a.length).map((i) => all[i])
    if (Math.abs(mean(g1) - mean(g0)) >= obs) ge++
  }
  return (ge + 1) / (iters + 1)
}

console.log(`样本：A（锚定开）${A.length} 行 / B（锚定关）${B.length} 行；可配对任务 ${paired.length} 个`)
const artifact = {
  generatedAtUtc: new Date().toISOString(),
  kind: 'anchor-ab-intervention',
  command: 'node tools/anchor-ab-report.mjs <results.jsonl> --out <前缀>',
  note: '锚定 A/B 干预实验的判定件。配对差（同一任务 final−start 之差）为主检验，消掉任务难度；'
    + '单条件或配对数不足一律 INSUFFICIENT（"没有对照就没有效果"）。'
    + '本实验的前提是**结局必须有方差**：若两组都满分，什么都测不出来。',
  n: { on: A.length, off: B.length, paired: paired.length },
  perCondition: {
    'anchor-on': { tasks: A.length, meanFinal: mean(A.map((r) => r.final - r.start)), perfect: A.filter((r) => r.final === r.total).length },
    'anchor-off': { tasks: B.length, meanFinal: mean(B.map((r) => r.final - r.start)), perfect: B.filter((r) => r.final === r.total).length },
  },
  paired: paired.map((p) => ({ task: p.task, gainOn: p.a, gainOff: p.b, delta: p.delta })),
}

let verdict = 'INSUFFICIENT'
let reason = ''
if (A.length === 0 || B.length === 0) reason = '只有单条件（没有对照）⇒ 无法估计效果'
else if (paired.length < minPairs) reason = `可配对任务 ${paired.length} < ${minPairs}`
else {
  const deltas = paired.map((p) => p.delta)
  const pPaired = permPaired(deltas, PERM)
  const pUnpaired = permUnpaired(A.map((r) => r.final - r.start), B.map((r) => r.final - r.start), PERM)
  const e = mean(deltas)
  artifact.pairedTest = { meanDelta: e, oneSidedP: pPaired, unpairedP: pUnpaired, deltas }
  console.log(`配对差均值 ${fmt(e)}（正 = 锚定更好）；配对置换 p=${pPaired.toFixed(4)}；非配对 p=${pUnpaired.toFixed(4)}`)
  const noVariance = A.every((r) => r.final === r.total) && B.every((r) => r.final === r.total)
  if (noVariance) { verdict = 'INSUFFICIENT'; reason = '两组全部满分 ⇒ 结局没有方差（任务太容易，测不出差异）' }
  else if (e <= 0) { verdict = 'FAIL'; reason = `锚定并不更好（配对差均值 ${fmt(e)}）` }
  else if (pPaired > 0.05) { verdict = 'INSUFFICIENT'; reason = `方向为正但未显著（配对置换 p=${pPaired.toFixed(3)}）` }
  else { verdict = 'PASS'; reason = `锚定更好且显著（配对差均值 ${fmt(e)}，p=${pPaired.toFixed(4)}）` }
}
artifact.verdict = verdict
artifact.verdictReason = reason
console.log(`\nverdict=${verdict}（${reason}）`)
writeFileSync(`${outPrefix}.json`, JSON.stringify(artifact, null, 2), 'utf8')
console.log(`产物：${outPrefix}.json`)
