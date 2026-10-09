/**
 * measure-clean-outcome.mjs —— 造一个**与规模无关**的会话结局标签，并用它检验那句
 * 愿景最上游的前提：**首轮好 ⇒ 后面好？**
 *
 * 为什么需要（上一轮的结论）：之前用的"延迟锚点"结局（unknown-tool / user-correction /
 * abandoned-turn）**本身是会话规模的代理**（出现率随规模 4% → 20% → 100%，与步数 ρ=0.53-0.68），
 * 于是"首轮能不能预测后面"这个问题**根本测不了**——测出来的只是"规模对规模"。
 *
 * 本工具换一个**客观、按会话、与规模弱相关**的结局：
 *   **会话最后一次验证（测试/构建）是否通过**。
 *   · 判据共用 `verifyCommandKind`（会话行为里识别验证命令）与 `FAILURE_MARKERS`（失败标记）
 *     —— 与运行时同一份实现，不另写一套；
 *   · 结局三态：`pass` / `fail` / `no-verify`（没跑过验证的会话不参与统计，也不猜）。
 *
 * 纪律（都是被上一轮打出来的）：
 *   ① **先检验结局本身是否依赖规模**（ρ(结局, 步数)）——不然又在量规模；
 *   ② 首轮变量只取**首轮**（第一条助手消息 + 前 3 步），与结局之间用置换检验（样本小、分布未知）。
 *
 * 用法：node tools/measure-clean-outcome.mjs [会话目录] [--out 前缀] [--perm 5000]
 */
import { writeFileSync } from 'node:fs'
import { resolve, basename, join } from 'node:path'
import { decodeSessionLog, walk } from './session-log-core.mjs'
import { verifyCommandKind, isWriteTool } from './task-anchor-core.mjs'
import { FAILURE_MARKERS } from './drift-label-core.mjs'
import { buildLedgerFromEvents } from '../index.js'

const args = process.argv.slice(2)
const FLAGS = new Set(['--out', '--perm'])
const positional = []
for (let i = 0; i < args.length; i++) {
  if (FLAGS.has(args[i])) { i += 1; continue }
  if (args[i].startsWith('--')) continue
  positional.push(args[i])
}
const sessionsDir = resolve(positional[0] || (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.dsh\\sessions` : '.'))
const outPrefix = resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : './clean-outcome')
const PERM = Number(args.includes('--perm') ? args[args.indexOf('--perm') + 1] : 5000)

const SUCCESS_MARKERS = /(all (?:public )?tests passed|all green|\bOK\b|PASS\s*=\s*\d+\s*\/\s*\d+|\d+ passed|0 failed)/i
const argOf = (d) => {
  const a = d && d.arguments
  if (a && typeof a === 'object') return a
  if (typeof a === 'string') { try { return JSON.parse(a) } catch { return null } }
  return null
}
const resultText = (ev) => {
  const blocks = ev && ev.data && ev.data.message && Array.isArray(ev.data.message.content) ? ev.data.message.content : []
  return blocks.filter((b) => b && b.type === 'tool-result' && Array.isArray(b.content))
    .map((b) => b.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n')).join('\n')
}

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
  // 结局：**最后一次验证**的结果
  const verifyKeys = []
  const byCallId = new Map()
  for (const ev of events) {
    if (!ev) continue
    if (ev.type === 'tool/call') {
      const d = ev.data || {}
      const a = argOf(d)
      const cmd = a && typeof a.command === 'string' ? a.command : (typeof d.arguments === 'string' ? d.arguments : '')
      if (cmd && verifyCommandKind(cmd)) verifyKeys.push({ key: `${d.turn}#${d.step}`, callId: d.callId })
    } else if (ev.type === 'tool/result') {
      const cid = ev.data && ev.data.message && ev.data.message.source && ev.data.message.source.callId
      if (cid) byCallId.set(cid, resultText(ev))
    }
  }
  const last = verifyKeys[verifyKeys.length - 1]
  const lastText = last ? (byCallId.get(last.callId) || '') : ''
  const failed = lastText ? FAILURE_MARKERS.some((re) => re.test(lastText)) : false
  const passed = lastText ? SUCCESS_MARKERS.test(lastText) : false
  const outcome = !last ? 'no-verify' : (failed && !passed ? 'fail' : (passed ? 'pass' : 'unclear'))

  // 首轮特征（只取首轮：第一条助手消息 + 前 3 步）
  const built = buildLedgerFromEvents(events, { repetitionWindow: 5, minRepeats: 2, testWindow: 3 })
  const steps = built.series.steps
  if (steps.length < 10) continue
  let planBlocks = null
  let firstTextLen = 0
  for (const ev of events) {
    if (!ev || ev.type !== 'assistant/message') continue
    if (ev.data && ev.data.turn !== 1) continue
    const blocks = ev.data.message && Array.isArray(ev.data.message.content) ? ev.data.message.content : []
    planBlocks = blocks.filter((b) => b && b.type === 'reasoning').length
    firstTextLen = blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('').length
    break
  }
  if (planBlocks === null) continue
  const early = steps.slice(0, 3)
  rows.push({
    sid,
    steps: steps.length,
    turns: new Set(steps.map((s) => s.turn)).size,
    outcome,
    verifyRuns: verifyKeys.length,
    planBlocks,
    firstTextLen,
    earlyTools: early.reduce((a, s) => a + (s.tools || 0), 0),
    earlyFailures: early.reduce((a, s) => a + (s.failures || 0), 0),
  })
}

const withOutcome = rows.filter((r) => r.outcome === 'pass' || r.outcome === 'fail')
const dist = rows.reduce((a, r) => { a[r.outcome] = (a[r.outcome] || 0) + 1; return a }, {})
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const fmt = (x, d = 2) => (x === null || x === undefined ? '—' : Number(x).toFixed(d))

function spearman(xs, ys) {
  const rank = (a) => { const s = a.map((v, i) => ({ v, i })).sort((x, y) => x.v - y.v); const r = new Array(a.length); for (let k = 0; k < s.length; k++) r[s[k].i] = k + 1; return r }
  const rx = rank(xs), ry = rank(ys)
  const m = (a) => a.reduce((x, y) => x + y, 0) / a.length
  const mx = m(rx), my = m(ry)
  const num = rx.reduce((a, v, i) => a + (v - mx) * (ry[i] - my), 0)
  const den = Math.sqrt(rx.reduce((a, v) => a + (v - mx) ** 2, 0) * ry.reduce((a, v) => a + (v - my) ** 2, 0))
  return den === 0 ? 0 : num / den
}
function permDiff(values, labels, iters) {
  const m = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
  const g1 = values.filter((_, i) => labels[i])
  const g0 = values.filter((_, i) => !labels[i])
  if (!g1.length || !g0.length) return { p: null, diff: null, n1: g1.length, n0: g0.length, m1: null, m0: null }
  const obs = Math.abs(m(g1) - m(g0))
  let ge = 0
  const n = values.length
  for (let it = 0; it < iters; it++) {
    const idx = values.map((_, i) => i)
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]] }
    const lab = new Array(n)
    for (let i = 0; i < n; i++) lab[idx[i]] = i < g1.length
    if (Math.abs(m(values.filter((_, i) => lab[i])) - m(values.filter((_, i) => !lab[i]))) >= obs) ge++
  }
  return { p: (ge + 1) / (iters + 1), diff: m(g1) - m(g0), n1: g1.length, n0: g0.length, m1: m(g1), m0: m(g0) }
}

console.log(`语料：${files.length} 个日志 → ${rows.length} 个会话（≥10 定稿步）`)
console.log(`结局分布：${JSON.stringify(dist)}`)
console.log(`可判定结局（pass/fail）：${withOutcome.length}（pass ${dist.pass || 0} / fail ${dist.fail || 0}）`)

const report = {
  generatedAtUtc: new Date().toISOString(),
  kind: 'clean-session-outcome',
  command: 'node tools/measure-clean-outcome.mjs [会话目录] --out <前缀>',
  note: '造一个与规模无关的会话结局（**最后一次验证是否通过**）来检验"首轮好 ⇒ 后面好"。'
    + '实测（78 会话）：pass=20 / fail=**0** / no-verify=35 / unclear=23 ⇒ **没有反例**，'
    + '结局没有方差 ⇒ 观察性语料**无法**回答"某条件是否让它更好"。'
    + '这不是"效果为 0"，而是"缺对照"：要验证效果必须先有失败那一侧 ⇒ 只能做**干预实验**'
    + '（固定任务 × 条件 A/B，如锚定开/关），不能继续在历史语料里找信号。'
    + '另一个数字同样重要：**45%（35/78）的会话根本没跑过验证** ⇒ 用"最终验证"做结局时覆盖面只有一半。',
  sessions: rows.length, dist, usable: withOutcome.length,
}

const nPass = withOutcome.filter((r) => r.outcome === 'pass').length
const nFail = withOutcome.filter((r) => r.outcome === 'fail').length
if (withOutcome.length < 12) {
  console.log('\n⚠ 可判定结局的会话太少（<12）⇒ 不做统计（宁可说"样本不足"，也不在小样本上编结论）')
  console.log('   这本身是**结论**：当前语料里"能判定通过/失败的验证"覆盖面不足 ⇒ 需要让任务跑完就留下结局')
} else if (nFail === 0 || nPass === 0) {
  // ⚠ **没有反例**同样做不了统计——这是本轮最重要的发现之一：
  // 20 个可判定会话**全部通过**，于是"结局"没有方差，任何"某特征能否预测结局"都无从谈起。
  console.log(`\n⚠ **没有反例**：可判定结局 ${withOutcome.length} 个里 pass=${nPass} / fail=${nFail} ⇒ **无法做任何对照**`)
  console.log('   这不是"效果为 0"，而是"结局没有方差"：要验证"某条件 ⇒ 更好"，必须先有**失败**这一侧。')
  console.log('   ⇒ 只能靠**干预实验**（固定任务 × 条件 A/B），不能靠观察历史语料。')
  report.noContrast = { pass: nPass, fail: nFail }
} else {
  // ① 结局本身是否依赖规模（必须先过这一关）
  const y = withOutcome.map((r) => (r.outcome === 'fail' ? 1 : 0))
  const rhoSize = spearman(withOutcome.map((r) => r.steps), y)
  console.log(`\n=== ① 结局 vs 规模（必须先过这一关）===`)
  console.log(`  ρ(fail, 步数) = ${fmt(rhoSize, 3)}   p(约) 见置换检验`)
  const st = permDiff(withOutcome.map((r) => r.steps), y.map((v) => v === 1), PERM)
  console.log(`  fail 组平均步数 ${fmt(st.m1, 1)}（n=${st.n1}） vs pass 组 ${fmt(st.m0, 1)}（n=${st.n0}）  置换 p=${st.p.toFixed(4)}`)
  report.sizeIndependence = { rho: rhoSize, ...st }

  console.log(`\n=== ② 首轮特征能否预测"最后一次验证失败"（置换检验）===`)
  console.log('特征                    fail 均值   pass 均值   差值      置换 p')
  for (const [label, key] of [['首轮推理块数', 'planBlocks'], ['首轮文本长度', 'firstTextLen'], ['首轮 3 步工具调用', 'earlyTools'], ['首轮 3 步失败数', 'earlyFailures']]) {
    const vals = withOutcome.map((r) => Number(r[key]) || 0)
    const t = permDiff(vals, y.map((v) => v === 1), PERM)
    console.log(`${label.padEnd(22)} ${fmt(t.m1, 2).padStart(9)} ${fmt(t.m0, 2).padStart(10)} ${fmt(t.diff, 2).padStart(9)} ${t.p.toFixed(4).padStart(9)}`)
    report[label] = t
  }
  console.log('\n（若所有 p 都远大于 0.05 ⇒ "首轮好 ⇒ 后面好"在这批语料上**没有支持**；反过来也一样，样本量决定能说多强）')
  report.rows = withOutcome
}
writeFileSync(`${outPrefix}.json`, JSON.stringify(report, null, 2), 'utf8')
console.log(`\n产物：${outPrefix}.json`)
