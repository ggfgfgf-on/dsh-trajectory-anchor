/**
 * measure-task-signal.mjs —— 任务锚定漂移的**发生率**与老信号的召回（真实基准语料）
 *
 * 回答三个问题：
 *   ① 解析覆盖率：多少会话的提示里能读出任务锚点（读不出就不产出标签，不猜）；
 *   ② 发生率：越界写 / 越界读 / 未验证声明 各出现在多少会话、多少次；
 *   ③ 老信号（A′ 中途停手 / C 重复）在这些**有金标准的**漂移步上召回是多少
 *      —— 这是"要不要换信号"的直接证据。
 *
 * 用法：node tools/measure-task-signal.mjs [会话目录] [--out 前缀]
 */
import { writeFileSync, readFileSync } from 'node:fs'
import { resolve, basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeSessionLog, walk } from './session-log-core.mjs'
import { walkChannel } from './behaviour-channel-core.mjs'
import { parseTaskAnchors, scanToolCalls, claimsFromFinalMessage, unverifiedClaim } from './task-anchor-core.mjs'
import { buildLedgerFromEvents } from '../index.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const args = process.argv.slice(2)
const FLAGS_WITH_VALUE = new Set(['--out'])
const positional = []
for (let i = 0; i < args.length; i++) {
  if (FLAGS_WITH_VALUE.has(args[i])) { i += 1; continue }
  if (args[i].startsWith('--')) continue
  positional.push(args[i])
}
const sessionsDir = resolve(positional[0] || (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.dsh\\sessions` : '.'))
const outPrefix = resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : './task-signal-report')

const LEAD = 3
const ALPHA = 0.05          // 老信号用最宽的 α（对它最有利的档位）
const K = 1
const files = walk(sessionsDir, []).filter((f) => f.endsWith('session.jsonl.zstd'))

const rows = []
let parsedScope = 0
let scanned = 0
const totals = { 'scope-write': 0, 'scope-read': 0, unverified: 0 }
const sessionsWith = { 'scope-write': 0, 'scope-read': 0, unverified: 0 }

for (const f of files) {
  const sid = basename(join(f, '..')).slice(0, 12)
  let text
  try { text = decodeSessionLog(f) } catch { continue }
  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch { /* 坏行 */ }
  }
  // 首条人类消息 = 任务陈述
  let prompt = ''
  for (const ev of events) {
    const d = ev && ev.data
    if (ev && ev.type === 'user/message' && d && d.source && d.source.kind === 'user') {
      const blocks = Array.isArray(d.content) ? d.content : []
      prompt = blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('')
      break
    }
  }
  if (!prompt) continue
  const anchors = parseTaskAnchors(prompt)
  if (!anchors.parsed) continue
  parsedScope++
  scanned++
  const scan = scanToolCalls(events, anchors)
  // 末条助手文本
  let finalText = ''
  for (const ev of events) {
    if (ev && ev.type === 'assistant/message') {
      const blocks = ev.data && ev.data.message && ev.data.message.content
      if (Array.isArray(blocks)) {
        const t = blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('')
        if (t.trim()) finalText = t
      }
    }
  }
  const claim = claimsFromFinalMessage(finalText)
  // 最后一次验证运行的输出（用于"输出里仍有失败"判定）
  let lastVerifyKey = null
  let lastVerifyText = ''
  if (scan.verifyRuns.length) {
    const lv = scan.verifyRuns[scan.verifyRuns.length - 1]
    lastVerifyKey = `${lv.turn}#${lv.step}`
  }
  if (lastVerifyKey) {
    for (const ev of events) {
      const d = ev && ev.data
      if (ev && ev.type === 'tool/result' && d && `${d.turn}#${d.step}` === lastVerifyKey) {
        const blocks = d.message && d.message.content
        if (Array.isArray(blocks)) {
          lastVerifyText += blocks.filter((b) => b && b.type === 'tool-result' && Array.isArray(b.content))
            .map((b) => b.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n')).join('\n')
        }
      }
    }
  }
  const allWrites = [...scan.writes, ...scan.labels.filter((l) => l.kind === 'scope-write')]
  // 取回后台作业结果也算"验证证据已消费"（实测 99265511 就是把构建放后台跑再取回结果的）
  const jobPolls = events.filter((e) => e && e.type === 'tool/call' && e.data && e.data.name === 'job_output')
    .map((e) => ({ turn: e.data.turn, step: e.data.step }))
  const unv = unverifiedClaim({ writes: allWrites, verifyRuns: scan.verifyRuns, jobPolls, claim, lastVerifyText })
  if (unv.unverified) { totals.unverified++; sessionsWith.unverified++ }

  const sw = scan.labels.filter((l) => l.kind === 'scope-write')
  const sr = scan.labels.filter((l) => l.kind === 'scope-read')
  totals['scope-write'] += sw.length
  totals['scope-read'] += sr.length
  if (sw.length) sessionsWith['scope-write']++
  if (sr.length) sessionsWith['scope-read']++

  // 老信号（A′/C）在同一条会话上最宽 α 下的触发步
  const built = buildLedgerFromEvents(events, { repetitionWindow: 5, minRepeats: 2 })
  const stepKeys = built.series.steps.map((s) => `${s.turn}#${s.step}`)
  const idxOf = new Map(stepKeys.map((k, i) => [k, i]))
  const firesA = walkChannel([{ sid, inaction: built.series.inaction }], 'inaction', { testWindow: 3, refMinSteps: 20, alpha: ALPHA, consecutive: K }).perSession[0].fires
  const firesC = walkChannel([{ sid, repetition: built.series.repetition }], 'repetition', { testWindow: 3, refMinSteps: 20, alpha: ALPHA, consecutive: K }).perSession[0].fires
  const fires = [...new Set([...firesA, ...firesC])].sort((a, b) => a - b)
  const labelIdx = []
  const labelDetail = []
  for (const l of [...sw, ...sr]) {
    const i = idxOf.get(`${l.turn}#${l.step}`)
    if (i !== undefined) { labelIdx.push(i); labelDetail.push(`${l.kind}@${l.turn}#${l.step} ${l.path}`) }
  }
  // 命中 = 有触发出现在 [label-LEAD, label] 内
  let hit = 0
  const used = new Set()
  for (const li of labelIdx) {
    const idx = fires.findIndex((f, i) => !used.has(i) && f >= li - LEAD && f <= li)
    if (idx >= 0) { used.add(idx); hit++ }
  }
  rows.push({
    sid,
    steps: stepKeys.length,
    scopeWrite: sw.length,
    scopeRead: sr.length,
    unverified: unv.unverified,
    unverifiedReason: unv.reason,
    claim,
    firesOldSignal: fires.length,
    labelIdx: labelIdx.length,
    hits: hit,
    evidence: labelDetail.slice(0, 4),
    promptScope: (anchors.evidence.scopeClause || '').slice(0, 70),
  })
}

const withLabels = rows.filter((r) => r.labelIdx > 0)
const totalLabels = rows.reduce((a, r) => a + r.labelIdx, 0)
const totalHits = rows.reduce((a, r) => a + r.hits, 0)
const totalFires = rows.reduce((a, r) => a + r.firesOldSignal, 0)

console.log(`会话总数 ${files.length}；提示里可解析出任务锚点的 ${parsedScope} 个（解析不出的一律不产出标签）\n`)
console.log('=== 任务锚定漂移的发生率（有金标准，非统计推断）===')
console.log(`  越界写 scope-write ： ${String(totals['scope-write']).padStart(4)} 次 / ${sessionsWith['scope-write']} 会话`)
console.log(`  越界读 scope-read  ： ${String(totals['scope-read']).padStart(4)} 次 / ${sessionsWith['scope-read']} 会话（仅统计"提示明确禁止越界"的会话）`)
console.log(`  未验证声明         ： ${String(totals.unverified).padStart(4)} 次 / ${sessionsWith.unverified} 会话`)
console.log(`\n=== 老信号（A′+C，最宽 α=${ALPHA}、k=${K}）在这些金标准标签上的召回 ===`)
console.log(`  有标签的会话 ${withLabels.length} 个；标签步共 ${totalLabels} 个`)
console.log(`  老信号在同批会话上触发 ${totalFires} 次，其中落在标签前 ${LEAD} 步内的 ${totalHits} 次`)
console.log(`  召回 = ${totalLabels ? (totalHits / totalLabels * 100).toFixed(1) : '—'}%`)
console.log(`\n=== 逐个会话（只列有标签或有触发的）===`)
console.log('会话          步数  越界写 越界读 未验证  老信号触发  标签  命中   证据 / 未验证原因')
for (const r of rows.filter((x) => x.labelIdx > 0 || x.firesOldSignal > 0 || x.unverified).sort((a, b) => (b.labelIdx + b.firesOldSignal) - (a.labelIdx + a.firesOldSignal))) {
  console.log(`${r.sid.padEnd(13)} ${String(r.steps).padStart(4)} ${String(r.scopeWrite).padStart(6)} ${String(r.scopeRead).padStart(6)} `
    + `${(r.unverified ? '是' : '否').padStart(6)} ${String(r.firesOldSignal).padStart(10)} ${String(r.labelIdx).padStart(5)} ${String(r.hits).padStart(5)}   `
    + `${(r.evidence[0] || r.unverifiedReason || '').slice(0, 60)}`)
}
const report = {
  generatedAtUtc: new Date().toISOString(),
  sessionsTotal: files.length,
  sessionsWithParsedScope: parsedScope,
  totals, sessionsWith,
  oldSignal: { alpha: ALPHA, k: K, lead: LEAD, sessionsWithLabels: withLabels.length, labels: totalLabels, fires: totalFires, hits: totalHits, recall: totalLabels ? totalHits / totalLabels : null },
  rows,
}
writeFileSync(`${outPrefix}.json`, JSON.stringify(report, null, 2), 'utf8')
console.log(`\n产物：${outPrefix}.json`)
