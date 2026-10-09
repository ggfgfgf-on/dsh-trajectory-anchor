/**
 * analyze-pullback-outcomes.mjs —— 从拉回效果数据生成**在线证据件**（L2 门的唯一输入）
 *
 * 观测单元（v2 口径，必须与 runtime 一致）：
 *   **一次触发 = 一个观测单元**。干预臂（说了）与对照臂（触发但按比例故意没说）走
 *   同一条记录路径，各自开一个"从该触发点起算"的窗口：
 *   · verifiesAfterPullback  —— 该触发点之后跑了几次验证（越大越好）
 *   · scopeViolationsAfter   —— 该触发点之后又越界几次（越小越好）
 *   · claimedUnverifiedAfter —— 会话结束时是否仍处于"未验证"状态（false 为好；**会话级**）
 *
 * 为什么必须区分 v2 行（这条是被真实数据逼出来的）：
 *   v1 行按**会话**记账，且验证计数被 `count > 0` 把守 ⇒ 对照臂的 verifiesAfterPullback
 *   恒为 0，而 good() 要求它 > 0 ⇒ 对照臂**恒为未改善**，两臂比较测的是测量口径而不是
 *   效果，会假阳性开门。所以 v1 行一律**不参与**统计，并且要把忽略条数**报出来**（静默丢弃不可接受）。
 *
 * 判定纪律（与其它标定一致，宁可保守）：三关都过才算 PASS-online——
 *   ① 样本量：观测单元 ≥ --min-samples（默认 10）且**会话数** ≥ --min-sessions（默认 5）
 *      （独立性在会话层：同会话的多次触发是相关观测，不能当独立样本充数）；
 *   ② 方向 + 显著性：Fisher 单侧 p ≤ 0.05 且干预臂更好；
 *   ③ 稳健性：**逐会话留一**（每次丢掉一个会话重算）后最大 p 仍 ≤ 0.05
 *      —— 否则只要有一个会话撑着，就不算证据。
 * 产物带 expiresAtUtc（默认 14 天）与语料指纹，过期即失效。
 *
 * 用法：
 *   node tools/analyze-pullback-outcomes.mjs <outcomes.jsonl> [--out 前缀] [--min-samples 10] [--min-sessions 5] [--min-improve 0.5] [--days 14]
 *   node tools/analyze-pullback-outcomes.mjs --synthesize 12 --out 前缀   # 合成演示数据（仅用于验证链路）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const FLAGS_WITH_VALUE = new Set(['--out', '--min-samples', '--min-sessions', '--min-improve', '--days', '--synthesize'])
const positional = []
for (let i = 0; i < args.length; i++) {
  if (FLAGS_WITH_VALUE.has(args[i])) { i += 1; continue }
  if (args[i].startsWith('--')) continue
  positional.push(args[i])
}
const val = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt)
const minSamples = Number(val('--min-samples', 10))
const minSessions = Number(val('--min-sessions', 5))
const minImprove = Number(val('--min-improve', 0.5))
const days = Number(val('--days', 14))
const outPrefix = resolve(val('--out', './pullbackEvidence'))
const synth = args.includes('--synthesize') ? Number(val('--synthesize', 12)) : null

let raw = []
if (synth !== null) {
  // 合成数据只用来验证"链路能跑通"，且 verdict 会标明是合成的（防止把演示当证据）
  for (let i = 0; i < synth; i++) {
    raw.push({
      schemaVersion: 2, sessionId: `synthetic-${i}`, arm: i % 2 === 0 ? 'intervened' : 'control',
      intervened: i % 2 === 0, triggerIndex: 1, triggersInSession: 1, pullbacks: 1,
      verifiesAfterPullback: i % 3 === 0 ? 0 : 1,
      scopeViolationsAfter: i % 4 === 0 ? 1 : 0, claimedUnverifiedAfter: i % 5 === 0,
      synthetic: true,
    })
  }
} else {
  const p = positional[0]
  if (!p) { console.error('用法：node tools/analyze-pullback-outcomes.mjs <outcomes.jsonl> [--out 前缀]'); process.exit(1) }
  const text = readFileSync(resolve(p), 'utf8')
  raw = text.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

// ── v2 口径过滤：v1 行的窗口与 v2 不可比，必须排除，且**报出**排除条数 ──────────
const isV2 = (r) => r.schemaVersion === 2 && (r.arm === 'intervened' || r.arm === 'control' || r.intervened === false)
const rows = raw.filter(isV2)
const legacyIgnored = raw.length - rows.length

const improved = rows.filter((r) => (r.verifiesAfterPullback > 0) || (r.scopeViolationsAfter === 0 && r.claimedUnverifiedAfter !== true))
const rate = rows.length ? improved.length / rows.length : 0
const sessions = [...new Set(rows.map((r) => r.sessionId))]

// ── 两臂比较（Fisher 单侧：干预臂是否更好）────────────────────────────────────
const armOf = (r) => (r.arm === 'control' || r.intervened === false ? 'control' : 'intervened')
const good = (r) => (r.verifiesAfterPullback > 0) && r.scopeViolationsAfter === 0 && r.claimedUnverifiedAfter !== true

/** 单侧 Fisher（干预臂更好）。纯函数，小样本也准。 */
function fisherGreater(a, b, c, d) {
  const logFact = (n) => { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s }
  const hyper = (x) => Math.exp(
    logFact(a + b) + logFact(c + d) + logFact(a + c) + logFact(b + d) - logFact(a + b + c + d)
    - logFact(x) - logFact(a + b - x) - logFact(a + c - x) - logFact(d - a + x))
  const minX = Math.max(0, a - d)
  const maxX = Math.min(a + b, a + c)
  let p = 0
  for (let x = minX; x <= maxX; x++) if (x >= a) p += hyper(x)
  return Math.min(1, p)
}

/** 对一组行做两臂比较；任一条臂为空 ⇒ null（无法估计）。 */
function compareRows(list) {
  const byArm = { intervened: [], control: [] }
  for (const r of list) byArm[armOf(r)].push(r)
  if (byArm.intervened.length === 0 || byArm.control.length === 0) return null
  const rateOf = (a) => (byArm[a].length ? byArm[a].filter(good).length / byArm[a].length : null)
  const a = byArm.intervened.filter(good).length
  const b = byArm.intervened.length - a
  const c = byArm.control.filter(good).length
  const d = byArm.control.length - c
  return {
    intervened: { n: byArm.intervened.length, goodRate: rateOf('intervened') },
    control: { n: byArm.control.length, goodRate: rateOf('control') },
    table: { intervenedGood: a, intervenedBad: b, controlGood: c, controlBad: d },
    oneSidedP: fisherGreater(a, b, c, d),
    effectPP: (rateOf('intervened') - rateOf('control')) * 100,
  }
}

const cmp = compareRows(rows)

// ── 敏感性：会话级独立性（同会话多次触发是相关观测）───────────────────────────
// ① 逐会话留一：只要有一个会话撑着结论，就不算证据 ⇒ 取最大 p（最保守）
let looMaxP = null
let looWorstSession = null
if (cmp && sessions.length > 1) {
  looMaxP = 0
  for (const s of sessions) {
    const rest = rows.filter((r) => r.sessionId !== s)
    const c2 = compareRows(rest)
    const p = c2 ? c2.oneSidedP : 1   // 丢掉该会话后无法比较 ⇒ 按"最不显著"处理
    if (p > looMaxP) { looMaxP = p; looWorstSession = s }
  }
}
// ② 每会话只取首个触发点（去相关的最粗口径），看方向是否还在
const firstPerSession = []
{
  const seen = new Set()
  const sorted = [...rows].sort((x, y) => (x.triggerIndex || 1) - (y.triggerIndex || 1))
  for (const r of sorted) {
    if (seen.has(r.sessionId)) continue
    seen.add(r.sessionId)
    firstPerSession.push(r)
  }
}
const cmpFirst = compareRows(firstPerSession)

// ③ 随机化分层：控制率中途变了怎么办？
// 臂是在**触发点**上随机分配的 ⇒ 改分配比例**不产生偏差**（意向性比较依然有效），
// "改了就当数据作废"是不准确的说法；真正要防的是**时段效应**（后期会话的任务/模型分布漂移）。
// 口径：**合并检验为主**（它本就是随机化比较），**分层复核为闸**——任何"足够大"的分层
// （两臂各 ≥2 单元）只要方向相反，就不许判定 PASS。
const rateOfRow = (r) => (Number.isFinite(r.controlRate) ? String(r.controlRate) : 'unspecified')
const strataKeys = [...new Set(rows.map(rateOfRow))]
const strata = []
let stratumContradiction = null
for (const k of strataKeys) {
  const sub = rows.filter((r) => rateOfRow(r) === k)
  const byArm = { intervened: 0, control: 0 }
  for (const r of sub) byArm[armOf(r)] += 1
  const c = compareRows(sub)
  const big = Boolean(c) && byArm.intervened >= 2 && byArm.control >= 2
  const entry = {
    rate: k, n: sub.length, intervened: byArm.intervened, control: byArm.control,
    goodRateIntervened: c ? c.intervened.goodRate : null,
    goodRateControl: c ? c.control.goodRate : null,
    effectPP: c ? c.effectPP : null,
    oneSidedP: c ? c.oneSidedP : null,
    gating: big,
    contradicts: big && c.effectPP <= 0,
  }
  strata.push(entry)
  if (entry.contradicts && !stratumContradiction) stratumContradiction = entry
}

// 判定：方向 + 显著性 + 会话级样本量 + 留一稳健性 + 分层不矛盾 + 绝对水平，全部要过
let verdict = 'FAIL'
let verdictReason = ''
if (rows.length < minSamples) { verdict = 'INSUFFICIENT'; verdictReason = `观测单元 ${rows.length} < ${minSamples}` }
else if (sessions.length < minSessions) { verdict = 'INSUFFICIENT'; verdictReason = `会话数 ${sessions.length} < ${minSessions}（独立性在会话层）` }
else if (!cmp) { verdict = 'INSUFFICIENT'; verdictReason = '只有单臂（无对照数据）⇒ 无法估计效果' }
else if (cmp.effectPP <= 0) { verdict = 'FAIL'; verdictReason = `干预臂并不更好（${cmp.effectPP.toFixed(1)}pp）` }
else if (cmp.oneSidedP > 0.05) { verdict = 'INSUFFICIENT'; verdictReason = `方向为正但未显著（单侧 p=${cmp.oneSidedP.toFixed(3)}）` }
else if (looMaxP !== null && looMaxP > 0.05) {
  verdict = 'INSUFFICIENT'
  verdictReason = `去掉会话 ${looWorstSession} 后不再显著（留一最大 p=${looMaxP.toFixed(3)}）⇒ 单个会话撑着，不算证据`
} else if (stratumContradiction) {
  verdict = 'INSUFFICIENT'
  verdictReason = `分层方向矛盾：控制率 ${stratumContradiction.rate} 上干预并不更好（${stratumContradiction.effectPP.toFixed(1)}pp）⇒ 时段效应未排清，不许开门`
} else if (rate < minImprove) { verdict = 'FAIL'; verdictReason = `显著但绝对产出率不足（${(rate * 100).toFixed(1)}% < ${(minImprove * 100).toFixed(0)}%）` }
else { verdict = 'PASS-online'; verdictReason = `干预臂显著更好（+${cmp.effectPP.toFixed(1)}pp，单侧 p=${cmp.oneSidedP.toFixed(3)}，留一最大 p=${looMaxP === null ? 'n/a' : looMaxP.toFixed(3)}，分层 ${strata.length} 组无矛盾）` }

const artifact = {
  generatedAtUtc: new Date().toISOString(),
  expiresAtUtc: new Date(Date.now() + days * 24 * 3600 * 1000).toISOString(), // time-ok: artifact-expiry
  kind: 'reanchor-online-evidence',
  verdict,
  verdictReason,
  schema: 'pullback-outcomes/v2',
  pullbacksObserved: rows.length,     // 观测单元数（= 触发点数；字段名保持兼容）
  sessionsObserved: sessions.length,
  legacyIgnored,                      // v1 行（窗口不可比）被排除的条数——必须可见
  minSamples,
  minSessions,
  minImprove,
  comparison: cmp,
  sensitivity: {
    looMaxP,                          // 逐会话留一后的最大 p（≤0.05 才算稳）
    looWorstSession,
    firstPerSessionN: cmpFirst ? { intervened: cmpFirst.intervened.n, control: cmpFirst.control.n } : null,
    firstPerSessionP: cmpFirst ? cmpFirst.oneSidedP : null,
    firstPerSessionEffectPP: cmpFirst ? cmpFirst.effectPP : null,
  },
  // 随机化分层（控制率）：合并检验为主、分层复核为闸（任何大分层方向相反即不许开门）
  rateStrata: {
    rates: strataKeys,
    mixed: strataKeys.length > 1,
    perRate: strata,
    contradiction: stratumContradiction ? { rate: stratumContradiction.rate, effectPP: stratumContradiction.effectPP } : null,
  },
  effectiveness: {
    improvedRate: Number(rate.toFixed(4)),
    verifyAfterRate: rows.length ? Number((rows.filter((r) => r.verifiesAfterPullback > 0).length / rows.length).toFixed(4)) : null,
    scopeViolationsAfterRate: rows.length ? Number((rows.filter((r) => r.scopeViolationsAfter > 0).length / rows.length).toFixed(4)) : null,
    claimedUnverifiedAfterRate: rows.length ? Number((rows.filter((r) => r.claimedUnverifiedAfter === true).length / rows.length).toFixed(4)) : null,
  },
  armCounts: rows.reduce((a, r) => { const k = armOf(r); a[k] = (a[k] || 0) + 1; return a }, {}),
  synthetic: synth !== null,
  note: synth !== null
    ? '**合成数据**：仅用于验证"采集→分析→门禁"链路，不得当作效果证据（装载器会拒绝 synthetic:true）'
    : '由真实会话的拉回效果采集聚合而来（v2：一次触发一个观测单元）；**两条臂**都要有样本、'
      + '会话数达下限、且逐会话留一后仍显著，才可能 PASS-online',
}
writeFileSync(`${outPrefix}.json`, JSON.stringify(artifact, null, 2), 'utf8')
console.log(`观测单元 ${rows.length}（要求 ≥${minSamples}）  会话 ${sessions.length}（要求 ≥${minSessions}）  改善率 ${(rate * 100).toFixed(1)}%（要求 ≥${(minImprove * 100).toFixed(0)}%）`)
if (legacyIgnored > 0) console.log(`已排除 v1 行 ${legacyIgnored} 条（v1 按会话记账、对照臂无窗口 ⇒ 与 v2 不可比）`)
if (cmp) {
  console.log(`对照：干预臂 ${(cmp.intervened.goodRate * 100).toFixed(1)}%（n=${cmp.intervened.n}） vs 对照臂 ${(cmp.control.goodRate * 100).toFixed(1)}%（n=${cmp.control.n}）`
    + `  效应 ${cmp.effectPP >= 0 ? '+' : ''}${cmp.effectPP.toFixed(1)}pp  单侧 p=${cmp.oneSidedP.toFixed(4)}`)
  console.log(`敏感性：逐会话留一最大 p=${looMaxP === null ? 'n/a' : looMaxP.toFixed(4)}（最差会话 ${looWorstSession ?? 'n/a'}）`
    + `；每会话首个触发点 p=${cmpFirst ? cmpFirst.oneSidedP.toFixed(4) : 'n/a'}`)
  if (strata.length > 1) {
    for (const s of strata) {
      console.log(`分层 控制率=${s.rate}  n=${s.n}（干预 ${s.intervened} / 对照 ${s.control}）`
        + `  效应 ${s.effectPP === null ? 'n/a' : (s.effectPP >= 0 ? '+' : '') + s.effectPP.toFixed(1) + 'pp'}`
        + `${s.gating ? '（参与闸门）' : '（样本太小，仅报出）'}${s.contradicts ? ' **方向相反**' : ''}`)
    }
  }
} else {
  console.log('对照：**只有单臂** ⇒ 无法估计效果（需要 pullbackControlRate > 0 攒对照数据）')
}
console.log(`verdict=${verdict}（${verdictReason}）`)
console.log(`产物：${outPrefix}.json`)
