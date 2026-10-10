/**
 * replay-facts.mjs —— criteria 层事实回放（设计 §8 门 2，只读）
 *
 * 把历史会话日志（session.jsonl.zstd）逐条喂进**真实 index.js 的事件管线**（同一份
 * apply/feedSessionEvent/noteTaskSignal 实现），用 F3（越界）与 F5（验证过期）两个事实
 * 谓词在历史语料上重放，报告：
 *   · 每条事实的开火率（谁、在哪、凭什么证据）；
 *   · **每一次开火的完整证据**（越界路径清单 + 原始范围条款 / 验证命令 + 事后编辑），
 *     供人工逐条复核误报率——"回放复核"是 A/B 之前的硬门。
 *
 * 与 replay-interventions.mjs 的分工：那个回放 P3 收窄策略的**有界性**，这个回放
 * criteria 层**事实谓词**的触发与证据。两者都不改任何历史文件。
 *
 * 忠实性说明（两处已知、且已最小化）：
 *   · 日志里的 user/message 记录**不带** data.source.kind='user'（活体通道有）——回放时补上；
 *   · 日志里 session 记录的 agentPreset 在顶层而非 data 里——回放时挪进 data。
 *   其余记录（tool/call 的 arguments/callId、tool/result 的 isError/callId、turn/end）原样喂入。
 *
 * 用法：node tools/replay-facts.mjs [sessionsDir] [--json <报告路径>] [--only <任务目录名正则>]
 */
import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { decodeSessionLog, walk } from './session-log-core.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(resolve(here, '../index.js')).href)

const args = process.argv.slice(2)
const val = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt)
const sessionsDir = resolve(val('--dir', process.env.USERPROFILE ? join(process.env.USERPROFILE, '.dsh', 'sessions') : '.'))
const jsonOut = val('--json', '')
const onlyRe = args.includes('--only') ? new RegExp(val('--only', ''), 'i') : null

let handlers = {}
let registered = {}
const agentsById = new Map()
const ctx = {
  get: (n) => {
    if (n === 'tools') return { register: (t) => { registered[t.name] = t; return () => {} } }
    if (n === 'agents') return { get: (id) => agentsById.get(id), list: () => [...agentsById.values()] }
    return undefined
  },
  on: (name, fn) => {
    if (name === 'system-prompt/assemble') (handlers[name] = handlers[name] || []).push(fn)
    else handlers[name] = fn
    return () => {}
  },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
}
await mod.apply(ctx, {
  adaptiveStateEnabled: false,
  scopeBreachMirror: true,      // 回放要回答的正是"开了之后会在哪开火、凭什么证据"
  verifyStalenessMirror: true,
  doneGapMirror: false,
  contractReanchor: false,
  // phase-2 协议约束也全开：同一回放门测"会在哪拒绝交付/强制重验/要求格式"
  deliveryGate: true,
  verifyAfterEditBudget: true,
  verifyBudgetEvery: 3,
  claimFormatContract: true,
})
const dispatch = (name, ...a) => handlers['internal/dispatch']('x', name, a, null)

/** 把一条日志记录换成插件事件并喂给会话；返回 null 表示跳过。 */
function feedRecord(session, o) {
  if (!o || typeof o.type !== 'string') return null
  if (o.type === 'user/message') {
    const data = { ...(o.data || {}), source: { kind: 'user' } }
    dispatch('session/event', session, { type: o.type, data })
    return 'user'
  }
  if (o.type === 'session') {
    const data = { ...(o.data || {}), agentPreset: o.agentPreset }
    dispatch('session/event', session, { type: 'session', data })
    return 'session'
  }
  if (['tool/call', 'tool/result', 'assistant/message', 'turn/end', 'request/header'].includes(o.type)) {
    dispatch('session/event', session, { type: o.type, data: o.data || {} })
    return o.type
  }
  return null
}

const files = walk(sessionsDir, []).filter((f) => f.endsWith('session.jsonl.zstd'))
console.log(`语料：${files.length} 个会话（${sessionsDir}）`)

const rows = []
for (const f of files) {
  const sid = basename(dirname(f))
  let text
  try { text = decodeSessionLog(f) } catch { continue }
  let recs = []
  for (const l of text.split('\n')) {
    if (!l.trim()) continue
    try { recs.push(JSON.parse(l)) } catch { /* 跳过坏行 */ }
  }
  const agent = { id: sid, session: { id: sid, events: [] }, ctx: { tools: { schemas: () => [], restrict: () => () => {} } } }
  agentsById.set(sid, agent)
  dispatch('agent/created', { agent })
  const session = { id: sid }
  let fed = 0
  for (const o of recs) {
    const kind = feedRecord(session, o)
    if (kind) fed += 1
  }
  // 组装一次：让"惰性补判"路径（post-claim-assemble / post-fact-assemble）走一遍。
  await (async () => {
    const list = handlers['system-prompt/assemble'] || []
    let i = -1
    const run = (out) => {
      i += 1
      if (i >= list.length) return out
      return list[i](out, { agent: { id: sid } }, async (o) => run(o === undefined ? out : o))
    }
    await run({ sections: [], contexts: [], tools: [], variables: {} })
  })()
  const all = await registered.anchor_status.execute({})
  const row = (all.rows || []).find((r) => r.sessionId === sid)
  if (!row) continue
  // 任务标签：首条人类消息里的范围目录名
  const firstUser = recs.find((r) => r.type === 'user/message')
  let label = ''
  if (firstUser) {
    const blocks = firstUser.data?.content
    if (Array.isArray(blocks)) {
      const t = blocks.filter((b) => b?.type === 'text').map((b) => b.text || '').join(' ')
      const m = t.match(/`?([A-Za-z]:[\\/][^\s`]+)`?/i)
      label = m ? basename(m[1].replace(/[`'"]/g, '').replace(/[\\/]+$/, '')) : t.slice(0, 40)
    }
  }
  if (onlyRe && !onlyRe.test(label)) continue
  rows.push({
    sid, label,
    anchorsParsed: row.taskAnchors?.parsed === true,
    scopeClause: row.taskAnchors?.evidence?.scopeClause || null,
    evidence: row.evidence,
    scopeViolations: row.pullback?.scopeViolations ?? 0,
    scopeFire: row.scopeBreachMirror,
    stalenessFire: row.verifyStalenessMirror,
    deliveryGate: row.deliveryGate,
    verifyBudget: row.verifyBudget,
    claimFormat: row.claimFormat,
    auditKinds: row.auditKinds || [],
    fed,
  })
}

// ── 报告 ──────────────────────────────────────────────────────────────────────
const f3Fires = rows.filter((r) => r.scopeFire)
const f5Fires = rows.filter((r) => r.stalenessFire)
const p1Fires = rows.filter((r) => r.deliveryGate && r.deliveryGate.served === true)
// P2 的"武装"是会话**过程中**的事件：回放只在结尾组装一次，armed 已被那次组装消费复位，
// 所以开火率看**审计**里的 verify-budget-armed（机器可查的事件，不是终态字段）。
const p2Armed = rows.filter((r) => (r.auditKinds || []).includes('verify-budget-armed'))
const p3Fires = rows.filter((r) => r.claimFormat && r.claimFormat.served === true)
const withAnchors = rows.filter((r) => r.anchorsParsed)
const withClaims = rows.filter((r) => (r.evidence?.claims ?? 0) > 0)
const withVerify = rows.filter((r) => (r.evidence?.verifyEvidence ?? 0) > 0)
const withEdits = rows.filter((r) => (r.evidence?.edits ?? 0) > 0)

console.log(`\n=== F3/F5/P1/P2/P3 回放（${rows.length} 个会话）===`)
console.log(`解析出范围子句的会话        ${withAnchors.length}`)
console.log(`有过验证运行的会话          ${withVerify.length}`)
console.log(`有过落地写的会话            ${withEdits.length}`)
console.log(`有过完成/通过宣告的会话     ${withClaims.length}`)
console.log(`F3 越界开火                  ${f3Fires.length} 次（${withAnchors.length ? (f3Fires.length / withAnchors.length * 100).toFixed(1) : 0}% / 有范围会话）`)
console.log(`F5 过期开火                  ${f5Fires.length} 次（${withClaims.length ? (f5Fires.length / withClaims.length * 100).toFixed(1) : 0}% / 有宣告会话）`)
console.log(`P1 交付门拒绝               ${p1Fires.length} 次（${withClaims.length ? (p1Fires.length / withClaims.length * 100).toFixed(1) : 0}% / 有宣告会话）`)
console.log(`P2 改后必验武装             ${p2Armed.length} 次（${withEdits.length ? (p2Armed.length / withEdits.length * 100).toFixed(1) : 0}% / 有落地写会话）`)
console.log(`P3 格式要求                 ${p3Fires.length} 次（${withClaims.length ? (p3Fires.length / withClaims.length * 100).toFixed(1) : 0}% / 有宣告会话）`)

if (onlyRe) console.log(`（--only ${onlyRe} 过滤中）`)

console.log('\n--- P1 每次拒绝的证据（人工复核）---')
for (const r of p1Fires) {
  console.log(`  [${r.label}] ${r.sid}`)
  console.log(`    via=${r.deliveryGate.via} reason=${r.deliveryGate.reason}`)
}
if (p1Fires.length === 0) console.log('  （无拒绝）')

console.log('\n--- P3 每次格式要求的证据（人工复核）---')
for (const r of p3Fires) {
  console.log(`  [${r.label}] ${r.sid}  via=${r.claimFormat.via}`)
}
if (p3Fires.length === 0) console.log('  （无要求）')

console.log('\n--- F3 每次开火的证据（人工复核）---')
for (const r of f3Fires) {
  console.log(`  [${r.label}] ${r.sid}`)
  console.log(`    via=${r.scopeFire.via} served=${r.scopeFire.served}`)
  console.log(`    越界路径: ${(r.scopeFire.paths || []).join(' | ')}`)
  console.log(`    范围条款: ${r.scopeClause || '(无)'}`)
}
if (f3Fires.length === 0) console.log('  （无开火）')

console.log('\n--- F5 每次开火的证据（人工复核）---')
for (const r of f5Fires) {
  const e = r.stalenessFire
  console.log(`  [${r.label}] ${r.sid}`)
  console.log(`    via=${e.via} served=${e.served}`)
  console.log(`    验证: ${e.verifyCmd} @ turn ${e.verifyTurn}#${e.verifyStep}`)
  console.log(`    事后编辑: ${e.editPath} @ turn ${e.editTurn}#${e.editStep}`)
}
if (f5Fires.length === 0) console.log('  （无开火）')

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ at: new Date().toISOString(), sessionsDir, rows, f3Fires: f3Fires.map((r) => r.sid), f5Fires: f5Fires.map((r) => r.sid), p1Fires: p1Fires.map((r) => r.sid), p2Armed: p2Armed.map((r) => r.sid), p3Fires: p3Fires.map((r) => r.sid) }, null, 2))
  console.log(`\n报告已写：${jsonOut}`)
}
