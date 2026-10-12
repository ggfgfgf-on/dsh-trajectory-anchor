/**
 * replay-facts.mjs —— 观测层回放（只读）
 *
 * 把历史会话日志（session.jsonl.zstd）逐条喂进**真实 index.js 的事件管线**（同一份
 * apply/feedSessionEvent 实现），在历史语料上重放**观测层**，报告：
 *   · 任务锚点解析率、验证/落地写/完成宣告的会话计数；
 *   · 越界写（scope pullback 的事实源）与会话拉回（L1 pullback）的触发与留痕；
 *   · 审计事件种类分布（auditKinds）。
 *
 * 只读：不改任何历史文件。用法：
 *   node tools/replay-facts.mjs [--dir <sessionsDir>] [--json <报告路径>] [--only <任务目录名正则>]
 */
import { writeFileSync } from 'node:fs'
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
await mod.apply(ctx, { adaptiveStateEnabled: false })
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
  // 组装一次：让锚定/拉回相关的组装期路径走一遍。
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
    anchored: row.anchored === true,
    lifted: row.lifted === true,
    anchorsParsed: row.taskAnchors?.parsed === true,
    scopeClause: row.taskAnchors?.evidence?.scopeClause || null,
    evidence: row.evidence,
    pullback: row.pullback || null,
    auditKinds: row.auditKinds || [],
    fed,
  })
}

// ── 报告 ──────────────────────────────────────────────────────────────────────
const withAnchors = rows.filter((r) => r.anchorsParsed)
const withClaims = rows.filter((r) => (r.evidence?.claims ?? 0) > 0)
const withVerify = rows.filter((r) => (r.evidence?.verifyEvidence ?? 0) > 0)
const withEdits = rows.filter((r) => (r.evidence?.edits ?? 0) > 0)
const withPullback = rows.filter((r) => (r.pullback?.count ?? 0) > 0)

console.log(`\n=== 观测层回放（${rows.length} 个会话）===`)
console.log(`锚定过的会话                ${rows.filter((r) => r.anchored).length}`)
console.log(`解析出范围子句的会话        ${withAnchors.length}`)
console.log(`有过验证运行的会话          ${withVerify.length}`)
console.log(`有过落地写的会话            ${withEdits.length}`)
console.log(`有过完成/通过宣告的会话     ${withClaims.length}`)
console.log(`L1 拉回过的会话             ${withPullback.length}`)

console.log('\n--- L1 拉回留痕（人工复核）---')
for (const r of withPullback) {
  console.log(`  [${r.label}] ${r.sid}  count=${r.pullback.count} controls=${r.pullback.controls} last=${r.pullback.lastReason}`)
}
if (withPullback.length === 0) console.log('  （无拉回）')

if (onlyRe) console.log(`（--only ${onlyRe} 过滤中）`)

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ at: new Date().toISOString(), sessionsDir, rows }, null, 2))
  console.log(`\n报告已写：${jsonOut}`)
}
