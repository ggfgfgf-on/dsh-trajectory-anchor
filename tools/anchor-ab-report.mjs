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
// ⚠ The paired sign-flip permutation test has a **floor on its own p-value**: with n pairs the
// smallest attainable p is 1/2^n, so n=4 can never reach 0.05 (1/16 = 0.0625) no matter how clean
// the separation is. A run of 4 pairs therefore cannot return PASS even in principle — the harness
// would be quietly unable to answer the question it was built for. Hence the default is 5 (1/32 =
// 0.031), and fewer pairs is reported as unreachable rather than merely "insufficient".
const minPairs = Number(val('--min-pairs', 5))
const permFloor = (n) => 1 / (2 ** n)
const PERM = Number(val('--perm', 20000))
const outPrefix = resolve(val('--out', './anchor-ab-report'))

const rows = readFileSync(resolve(src), 'utf8').split('\n').filter((l) => l.trim())
  .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
const A = rows.filter((r) => r.condition === 'anchor-on')
const B = rows.filter((r) => r.condition === 'anchor-off')
const fmt = (x, d = 2) => (x === null || x === undefined ? '—' : Number(x).toFixed(d))
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

/**
 * Paired deltas. The **pre-registered primary outcome is the tail** (the last module's checks),
 * because that is the quantity drift is supposed to destroy: a run that loses steam finishes the
 * early modules and leaves the tedious tail behind. `final - start` (total checks) is reported as
 * the secondary outcome.
 *
 * Rows must therefore carry `tail` (and ideally `tailStart`, which the v3 fixtures report as 0).
 * If a row set predates those fields the analyzer says so explicitly instead of silently
 * substituting a different outcome ("switching the outcome after seeing the data" is exactly the
 * failure mode this file exists to prevent).
 */
const hasTail = (r) => Number.isFinite(r.tail) && Number.isFinite(r.tailTotal)
const tailComplete = A.length > 0 && B.length > 0 && A.every(hasTail) && B.every(hasTail)
const tailGain = (r) => r.tail - (Number.isFinite(r.tailStart) ? r.tailStart : 0)
const totalGain = (r) => r.final - r.start
const primaryGain = tailComplete ? tailGain : totalGain

const byTask = (set) => Object.fromEntries(set.map((r) => [r.task, r]))
const mA = byTask(A)
const mB = byTask(B)
const paired = Object.keys(mA).filter((t) => mB[t]).map((t) => ({
  task: t,
  a: primaryGain(mA[t]), b: primaryGain(mB[t]), delta: primaryGain(mA[t]) - primaryGain(mB[t]),
  finalA: totalGain(mA[t]), finalB: totalGain(mB[t]), finalDelta: totalGain(mA[t]) - totalGain(mB[t]),
}))

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
  note: '锚定 A/B 干预实验的判定件。**主要结局 = 尾巴**（最后一个模块的检查数；漂移破坏的正是它），'
    + '总量 final−start 作次要结局；配对差消掉任务难度。'
    + '单条件或配对数不足一律 INSUFFICIENT（"没有对照就没有效果"）；'
    + '主要结局饱和（两组都满分）也报 INSUFFICIENT —— 前提是结局必须有方差。'
    + '行缺 tail 字段时会**明说**退回了总量口径，而不是悄悄换结局。',
  n: { on: A.length, off: B.length, paired: paired.length },
  primaryOutcome: tailComplete ? 'tail' : 'total (fallback: rows lack tail fields)',
  perCondition: {
    'anchor-on': { tasks: A.length, meanGain: mean(A.map(primaryGain)), meanFinal: mean(A.map(totalGain)), perfect: A.filter((r) => r.final === r.total).length, tailPerfect: tailComplete ? A.filter((r) => r.tail === r.tailTotal).length : null },
    'anchor-off': { tasks: B.length, meanGain: mean(B.map(primaryGain)), meanFinal: mean(B.map(totalGain)), perfect: B.filter((r) => r.final === r.total).length, tailPerfect: tailComplete ? B.filter((r) => r.tail === r.tailTotal).length : null },
  },
  paired: paired.map((p) => ({ task: p.task, a: p.a, b: p.b, delta: p.delta, finalDelta: p.finalDelta })),
}

let verdict = 'INSUFFICIENT'
let reason = ''
if (A.length === 0 || B.length === 0) reason = '只有单条件（没有对照）⇒ 无法估计效果'
else if (paired.length < minPairs) {
  reason = `可配对任务 ${paired.length} < ${minPairs}`
  if (paired.length > 0) {
    const floor = permFloor(paired.length)
    if (floor > 0.05) reason += `（且 n=${paired.length} 时配对置换的最小可能 p=1/2^${paired.length}=${floor.toFixed(4)} > 0.05 ⇒ **构造上不可能显著**，多跑几对，别重复读同一批数据）`
  }
}
else {
  const deltas = paired.map((p) => p.delta)
  const pPaired = permPaired(deltas, PERM)
  const pUnpaired = permUnpaired(A.map(primaryGain), B.map(primaryGain), PERM)
  const e = mean(deltas)
  artifact.pairedTest = { outcome: artifact.primaryOutcome, meanDelta: e, oneSidedP: pPaired, unpairedP: pUnpaired, deltas }
  console.log(`主要结局=${artifact.primaryOutcome}；配对差均值 ${fmt(e)}（正 = 锚定更好）；配对置换 p=${pPaired.toFixed(4)}；非配对 p=${pUnpaired.toFixed(4)}`)
  // Saturation is checked on the **primary** outcome: if both arms are perfect on the tail there is
  // nothing to explain, however much the secondary total varies.
  const noVariance = tailComplete
    ? (A.every((r) => r.tail === r.tailTotal) && B.every((r) => r.tail === r.tailTotal))
    : (A.every((r) => r.final === r.total) && B.every((r) => r.final === r.total))
  if (noVariance) {
    verdict = 'INSUFFICIENT'
    reason = tailComplete
      ? '两组**尾巴**都满分 ⇒ 主要结局没有方差（尾部太容易，测不出差异）'
      : '两组全部满分 ⇒ 结局没有方差（任务太容易，测不出差异）'
  }
  else if (e <= 0) { verdict = 'FAIL'; reason = `锚定并不更好（${artifact.primaryOutcome} 配对差均值 ${fmt(e)}）` }
  else if (pPaired > 0.05) { verdict = 'INSUFFICIENT'; reason = `方向为正但未显著（配对置换 p=${pPaired.toFixed(3)}）` }
  else { verdict = 'PASS'; reason = `锚定更好且显著（${artifact.primaryOutcome} 配对差均值 ${fmt(e)}，p=${pPaired.toFixed(4)}）` }
}
artifact.verdict = verdict
artifact.verdictReason = reason
console.log(`\nverdict=${verdict}（${reason}）`)
writeFileSync(`${outPrefix}.json`, JSON.stringify(artifact, null, 2), 'utf8')
console.log(`产物：${outPrefix}.json`)
