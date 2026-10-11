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
  // criteria 第二波事实也全开
  unsupportedClaimMirror: true,
  evidenceContradictionMirror: true,
  // criteria 第三波（F2 分项对证）也全开
  itemizedClaimMirror: true,
  // process-front-loaded 约束（Q1/Q2/Q4）也全开
  deliveryArtifactGate: true,
  deliveryArtifactStateGate: true,
  editHoldEvery: 3,
  editBudgetCap: 60,
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
    unsupportedFire: row.unsupportedClaimMirror,
    contradictionFire: row.evidenceContradictionMirror,
    itemizedFire: row.itemizedClaimMirror,
    f2Unsupported: (row.itemizedClaimMirror && row.itemizedClaimMirror.served === true && Array.isArray(row.itemizedClaimMirror.unsupported)) ? row.itemizedClaimMirror.unsupported : null,
    artifactGate: row.deliveryArtifactGate,
    artifactBinding: row.artifactBinding,
    editBudget: row.editBudget,
    editHold: row.editHold,
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
const f6Fires = rows.filter((r) => r.unsupportedFire && r.unsupportedFire.served === true)
const f7Fires = rows.filter((r) => r.contradictionFire && r.contradictionFire.served === true)
const f2Fires = rows.filter((r) => r.itemizedFire && r.itemizedFire.served === true)
const q1Fires = rows.filter((r) => r.artifactGate && r.artifactGate.served === true)
// Q1' 回放只测**绑定武装率**（绑定捕获在验证证据路径，回放可及；开火在 pre-step，回放不派发，
// 且历史会话的文件状态今天已不可复现——开火率只能活体审计测，process-gate §6 已写明该边界）。
const q1pBound = rows.filter((r) => (r.auditKinds || []).includes('artifact-binding'))
const q2Armed = rows.filter((r) => (r.auditKinds || []).includes('edit-hold-armed'))
const q4Exhausted = rows.filter((r) => (r.auditKinds || []).includes('edit-budget-exhausted'))
const withAnchors = rows.filter((r) => r.anchorsParsed)
const withClaims = rows.filter((r) => (r.evidence?.claims ?? 0) > 0)
const withVerify = rows.filter((r) => (r.evidence?.verifyEvidence ?? 0) > 0)
const withEdits = rows.filter((r) => (r.evidence?.edits ?? 0) > 0)

console.log(`\n=== F3/F5/P1/P2/P3/F6/F7 回放（${rows.length} 个会话）===`)
console.log(`解析出范围子句的会话        ${withAnchors.length}`)
console.log(`有过验证运行的会话          ${withVerify.length}`)
console.log(`有过落地写的会话            ${withEdits.length}`)
console.log(`有过完成/通过宣告的会话     ${withClaims.length}`)
console.log(`F3 越界开火                  ${f3Fires.length} 次（${withAnchors.length ? (f3Fires.length / withAnchors.length * 100).toFixed(1) : 0}% / 有范围会话）`)
console.log(`F5 过期开火                  ${f5Fires.length} 次（${withClaims.length ? (f5Fires.length / withClaims.length * 100).toFixed(1) : 0}% / 有宣告会话）`)
console.log(`P1 交付门拒绝               ${p1Fires.length} 次（${withClaims.length ? (p1Fires.length / withClaims.length * 100).toFixed(1) : 0}% / 有宣告会话）`)
console.log(`P2 改后必验武装             ${p2Armed.length} 次（${withEdits.length ? (p2Armed.length / withEdits.length * 100).toFixed(1) : 0}% / 有落地写会话）`)
console.log(`P3 格式要求                 ${p3Fires.length} 次（${withClaims.length ? (p3Fires.length / withClaims.length * 100).toFixed(1) : 0}% / 有宣告会话）`)
console.log(`F6 无出处断言               ${f6Fires.length} 次（${withClaims.length ? (f6Fires.length / withClaims.length * 100).toFixed(1) : 0}% / 有宣告会话）`)
console.log(`F7 证据矛盾                 ${f7Fires.length} 次（${withClaims.length ? (f7Fires.length / withClaims.length * 100).toFixed(1) : 0}% / 有宣告会话）`)
console.log(`F2 分项缺口                 ${f2Fires.length} 次（${withClaims.length ? (f2Fires.length / withClaims.length * 100).toFixed(1) : 0}% / 有宣告会话）`)
console.log(`Q1 工件门拒绝               ${q1Fires.length} 次`)
console.log(`Q2 编辑保持武装             ${q2Armed.length} 次（${withEdits.length ? (q2Armed.length / withEdits.length * 100).toFixed(1) : 0}% / 有落地写会话）`)
console.log(`Q4 编辑预算耗尽             ${q4Exhausted.length} 次（${withEdits.length ? (q4Exhausted.length / withEdits.length * 100).toFixed(1) : 0}% / 有落地写会话）`)
console.log(`Q1' 工件绑定武装           ${q1pBound.length} 次（${withVerify.length ? (q1pBound.length / withVerify.length * 100).toFixed(1) : 0}% / 有验证会话；只含今天仍能解析出工件文件的工具通道子集——脚本通道写入的开火率只能活体审计测）`)

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

console.log('\n--- F6 每次开火的证据（人工复核）---')
for (const r of f6Fires) {
  console.log(`  [${r.label}] ${r.sid}  via=${r.unsupportedFire.via} reason=${r.unsupportedFire.reason}`)
}
if (f6Fires.length === 0) console.log('  （无开火）')

console.log('\n--- F7 每次开火的证据（人工复核）---')
for (const r of f7Fires) {
  console.log(`  [${r.label}] ${r.sid}  via=${r.contradictionFire.via} reason=${r.contradictionFire.reason}`)
}
if (f7Fires.length === 0) console.log('  （无开火）')

// ── F2 复核材料导出（§55 记的债务）：每次开火的会话 + 被点名的无证据条目 ──────
const f2ReviewPath = val('--f2-review', '')
if (f2ReviewPath) {
  const lines = []
  let n = 0
  for (const r of rows) {
    if (!r.f2Unsupported || r.f2Unsupported.length === 0) continue
    n += 1
    lines.push(JSON.stringify({ sid: r.sid, label: r.label, unsupported: r.f2Unsupported, verifies: r.evidence ? r.evidence.verifyEvidence : null, edits: r.evidence ? r.evidence.edits : null }))
  }
  writeFileSync(resolve(f2ReviewPath), lines.join('\n') + '\n', 'utf8')
  console.log(`\nF2 复核材料已写：${f2ReviewPath}（${n} 次开火）`)
}

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ at: new Date().toISOString(), sessionsDir, rows, f3Fires: f3Fires.map((r) => r.sid), f5Fires: f5Fires.map((r) => r.sid), p1Fires: p1Fires.map((r) => r.sid), p2Armed: p2Armed.map((r) => r.sid), p3Fires: p3Fires.map((r) => r.sid), f6Fires: f6Fires.map((r) => r.sid), f7Fires: f7Fires.map((r) => r.sid), q1pBound: q1pBound.map((r) => r.sid) }, null, 2))
  console.log(`\n报告已写：${jsonOut}`)
}
