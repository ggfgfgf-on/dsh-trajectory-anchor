/**
 * analyze-pullback-outcomes.mjs —— 从拉回效果数据生成**在线证据件**（L2 门的唯一输入）
 *
 * 口径（为什么是这些指标）：拉回说的是"回到范围内"和"验证后再宣布完成"，所以效果代理就是
 * **这两个目标行为在说过之后有没有发生**：
 *   · verifiesAfterPullback  —— 说过之后跑了几次验证（越大越好）
 *   · scopeViolationsAfter    —— 说过之后又越界几次（越小越好）
 *   · claimedUnverifiedAfter  —— 说过之后是否仍处于"未验证"状态（false 为好）
 *
 * 判定纪律（与其它标定一致，宁可保守）：
 *   · 样本不足（pullbacksObserved < --min-samples，默认 10）⇒ verdict = INSUFFICIENT，**不开门**；
 *   · 达到样本量且"目标行为改善率" ≥ --min-improve（默认 0.5）⇒ verdict = PASS-online；
 *   · 否则 FAIL。产物带 expiresAtUtc（默认 14 天）与语料指纹，过期即失效。
 *
 * 用法：
 *   node tools/analyze-pullback-outcomes.mjs <outcomes.jsonl> [--out 前缀] [--min-samples 10] [--min-improve 0.5] [--days 14]
 *   node tools/analyze-pullback-outcomes.mjs --synthesize 12 --out 前缀   # 合成演示数据（仅用于验证链路）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const FLAGS_WITH_VALUE = new Set(['--out', '--min-samples', '--min-improve', '--days', '--synthesize'])
const positional = []
for (let i = 0; i < args.length; i++) {
  if (FLAGS_WITH_VALUE.has(args[i])) { i += 1; continue }
  if (args[i].startsWith('--')) continue
  positional.push(args[i])
}
const val = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt)
const minSamples = Number(val('--min-samples', 10))
const minImprove = Number(val('--min-improve', 0.5))
const days = Number(val('--days', 14))
const outPrefix = resolve(val('--out', './pullbackEvidence'))
const synth = args.includes('--synthesize') ? Number(val('--synthesize', 12)) : null

let rows = []
if (synth !== null) {
  // 合成数据只用来验证"链路能跑通"，且 verdict 会标明是合成的（防止把演示当证据）
  for (let i = 0; i < synth; i++) {
    rows.push({
      sessionId: `synthetic-${i}`, pullbacks: 1, verifiesAfterPullback: i % 3 === 0 ? 0 : 1,
      scopeViolationsAfter: i % 4 === 0 ? 1 : 0, claimedUnverifiedAfter: i % 5 === 0,
      synthetic: true,
    })
  }
} else {
  const p = positional[0]
  if (!p) { console.error('用法：node tools/analyze-pullback-outcomes.mjs <outcomes.jsonl> [--out 前缀]'); process.exit(1) }
  const text = readFileSync(resolve(p), 'utf8')
  rows = text.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

const improved = rows.filter((r) => (r.verifiesAfterPullback > 0) || (r.scopeViolationsAfter === 0 && r.claimedUnverifiedAfter !== true))
const rate = rows.length ? improved.length / rows.length : 0

// ── L4 在线对照：两条臂的**配对比较** ────────────────────────────────────────
// 只有"说过话"的一侧是观测，无法区分"起了作用"与"本来就会这样"；所以插件在触发时可按
// pullbackControlRate 故意不说，形成对照组。这里做两侧比例比较并给出**方向性**判定。
const armOf = (r) => (r.arm === 'control' || r.intervened === false ? 'control' : 'intervened')
const good = (r) => (r.verifiesAfterPullback > 0) && r.scopeViolationsAfter === 0 && r.claimedUnverifiedAfter !== true
const byArm = { intervened: [], control: [] }
for (const r of rows) byArm[armOf(r)].push(r)
const rateOfArm = (a) => (byArm[a].length ? byArm[a].filter(good).length / byArm[a].length : null)

/** Fisher 精确检验（单侧：干预臂是否更好）。纯函数，小样本也准。 */
function fisherGreater(a, b, c, d) {
  const logFact = (n) => { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s }
  const hyper = (x) => Math.exp(
    logFact(a + b) + logFact(c + d) + logFact(a + c) + logFact(b + d) - logFact(a + b + c + d)
    - logFact(x) - logFact(a + b - x) - logFact(a + c - x) - logFact(d - a + x))
  const minX = Math.max(0, a - d)
  const maxX = Math.min(a + b, a + c)
  const list = []
  for (let x = minX; x <= maxX; x++) list.push([x, hyper(x)])
  let p = 0
  for (const [x, v] of list) if (x >= a) p += v
  return Math.min(1, p)
}

const cmp = {
  intervened: { n: byArm.intervened.length, goodRate: rateOfArm('intervened') },
  control: { n: byArm.control.length, goodRate: rateOfArm('control') },
}
if (byArm.intervened.length > 0 && byArm.control.length > 0) {
  const a = byArm.intervened.filter(good).length
  const b = byArm.intervened.length - a
  const c = byArm.control.filter(good).length
  const d = byArm.control.length - c
  cmp.table = { intervenedGood: a, intervenedBad: b, controlGood: c, controlBad: d }
  cmp.oneSidedP = fisherGreater(a, b, c, d)
  cmp.effectPP = (rateOfArm('intervened') - rateOfArm('control')) * 100
}

// 判定（方向性 + 显著性 + 绝对水平，三者都要过）：
//   · 单臂 ⇒ INSUFFICIENT（无法估效果；这正是"只记说过话的会话"时的老状态）
//   · 干预臂不比对照好 ⇒ FAIL（并且这是**该被采纳的**结论，不是"测不出来"）
//   · 方向为正但未达显著 ⇒ INSUFFICIENT（继续攒样本，不冒险）
let verdict = 'FAIL'
let verdictReason = ''
if (rows.length < minSamples) { verdict = 'INSUFFICIENT'; verdictReason = `样本 ${rows.length} < ${minSamples}` }
else if (!cmp.table) { verdict = 'INSUFFICIENT'; verdictReason = '只有单臂（无对照数据）⇒ 无法估计效果' }
else if (cmp.effectPP <= 0) { verdict = 'FAIL'; verdictReason = `干预臂并不更好（${cmp.effectPP.toFixed(1)}pp）` }
else if (cmp.oneSidedP > 0.05) { verdict = 'INSUFFICIENT'; verdictReason = `方向为正但未显著（单侧 p=${cmp.oneSidedP.toFixed(3)}）` }
else if (rate >= minImprove) { verdict = 'PASS-online'; verdictReason = `干预臂显著更好（+${cmp.effectPP.toFixed(1)}pp，单侧 p=${cmp.oneSidedP.toFixed(3)}）` }
else { verdict = 'FAIL'; verdictReason = `显著但绝对产出率不足（${(rate * 100).toFixed(1)}% < ${(minImprove * 100).toFixed(0)}%）` }

const artifact = {
  generatedAtUtc: new Date().toISOString(),
  expiresAtUtc: new Date(Date.now() + days * 24 * 3600 * 1000).toISOString(), // time-ok: artifact-expiry
  kind: 'reanchor-online-evidence',
  verdict,
  verdictReason,
  pullbacksObserved: rows.length,
  minSamples,
  minImprove,
  comparison: cmp,
  effectiveness: {
    improvedRate: Number(rate.toFixed(4)),
    verifyAfterRate: rows.length ? Number((rows.filter((r) => r.verifiesAfterPullback > 0).length / rows.length).toFixed(4)) : null,
    scopeViolationsAfterRate: rows.length ? Number((rows.filter((r) => r.scopeViolationsAfter > 0).length / rows.length).toFixed(4)) : null,
    claimedUnverifiedAfterRate: rows.length ? Number((rows.filter((r) => r.claimedUnverifiedAfter === true).length / rows.length).toFixed(4)) : null,
  },
  synthetic: synth !== null,
  note: synth !== null
    ? '**合成数据**：仅用于验证"采集→分析→门禁"链路，不得当作效果证据（装载器会拒绝 synthetic:true）'
    : '由真实会话的拉回效果采集聚合而来；**两条臂**（intervened/control）都要有样本才可能 PASS-online',
}
writeFileSync(`${outPrefix}.json`, JSON.stringify(artifact, null, 2), 'utf8')
console.log(`样本 ${rows.length}（要求 ≥${minSamples}）  改善率 ${(rate * 100).toFixed(1)}%（要求 ≥${(minImprove * 100).toFixed(0)}%）`)
if (cmp.table) {
  console.log(`对照：干预臂 ${(cmp.intervened.goodRate * 100).toFixed(1)}%（n=${cmp.intervened.n}） vs 对照臂 ${(cmp.control.goodRate * 100).toFixed(1)}%（n=${cmp.control.n}）`
    + `  效应 ${cmp.effectPP >= 0 ? '+' : ''}${cmp.effectPP.toFixed(1)}pp  单侧 p=${cmp.oneSidedP.toFixed(4)}`)
} else {
  console.log('对照：**只有单臂** ⇒ 无法估计效果（需要 pullbackControlRate > 0 攒对照数据）')
}
console.log(`verdict=${verdict}（${verdictReason}）`)
console.log(`产物：${outPrefix}.json`)
