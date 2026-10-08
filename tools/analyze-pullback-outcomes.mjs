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
let verdict = 'FAIL'
if (rows.length < minSamples) verdict = 'INSUFFICIENT'
else if (rate >= minImprove) verdict = 'PASS-online'

const artifact = {
  generatedAtUtc: new Date().toISOString(),
  expiresAtUtc: new Date(Date.now() + days * 24 * 3600 * 1000).toISOString(), // time-ok: artifact-expiry
  kind: 'reanchor-online-evidence',
  verdict,
  pullbacksObserved: rows.length,
  minSamples,
  minImprove,
  effectiveness: {
    improvedRate: Number(rate.toFixed(4)),
    verifyAfterRate: rows.length ? Number((rows.filter((r) => r.verifiesAfterPullback > 0).length / rows.length).toFixed(4)) : null,
    scopeViolationsAfterRate: rows.length ? Number((rows.filter((r) => r.scopeViolationsAfter > 0).length / rows.length).toFixed(4)) : null,
    claimedUnverifiedAfterRate: rows.length ? Number((rows.filter((r) => r.claimedUnverifiedAfter === true).length / rows.length).toFixed(4)) : null,
  },
  synthetic: synth !== null,
  note: synth !== null
    ? '**合成数据**：仅用于验证"采集→分析→门禁"链路，不得当作效果证据'
    : '由真实会话的拉回效果采集聚合而来；样本不足时 verdict=INSUFFICIENT（不开门）',
}
writeFileSync(`${outPrefix}.json`, JSON.stringify(artifact, null, 2), 'utf8')
console.log(`样本 ${rows.length}（要求 ≥${minSamples}）  改善率 ${(rate * 100).toFixed(1)}%（要求 ≥${(minImprove * 100).toFixed(0)}%）`)
console.log(`verdict=${verdict}${verdict === 'INSUFFICIENT' ? '（样本不足 ⇒ 重锚定保持关闭）' : ''}`)
console.log(`产物：${outPrefix}.json`)
