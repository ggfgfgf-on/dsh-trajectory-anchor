/**
 * test-scope-breach-mirror.mjs -- the read-only "scope breach mirror" (F3 fact).
 *
 * Theory (design doc `docs/design-criteria-refactor.md`): the criteria layer moves from
 * statistical channels to self-verifiable facts. F3 = a write landed outside the scope spans
 * declared in the FIRST human instruction. The intervention mirrors the fact back:
 * the out-of-scope path list + the original scope clause.
 *
 * Acceptance shape (same discipline as done-gap): both directions, the one-shot guarantee,
 * the success gate (a write that never landed must not fire), and the "must not fire" controls
 * (in-scope write / ignorable path / no scope parsed).
 * Usage: node tools/test-scope-breach-mirror.mjs [path/to/index.js]
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const here = fileURLToPath(new URL('.', import.meta.url))
const mod = await import(pathToFileURL(resolve(here, process.argv[2] || '../index.js')).href)

let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ': ' + detail}`)
}

let handlers = {}
let registered = {}
const agentsById = new Map()
async function boot(config) {
  handlers = {}
  registered = {}
  agentsById.clear()
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
  await mod.apply(ctx, { adaptiveStateEnabled: false, ...config })
}
const dispatch = (name, ...args) => handlers['internal/dispatch']('x', name, args, null)
const sessionEvent = (session, event) => dispatch('session/event', session, event)
const summaryOf = async (sid) => (await registered.anchor_status.execute({})).rows.find((r) => r.sessionId === sid)

const SCOPED = { type: 'user/message', data: { source: { kind: 'user' }, turn: 1, step: 1, content: [{ type: 'text', text: 'Work only inside `bugfix-a1` directory. Verify with python tests/run_tests.py' }] } }
const UNSC = { type: 'user/message', data: { source: { kind: 'user' }, turn: 1, step: 1, content: [{ type: 'text', text: 'Fix the bug. Verify with python tests/run_tests.py' }] } }
const editCall = (turn, step, path, callId) => ({ type: 'tool/call', data: { turn, step, name: 'edit', callId, arguments: JSON.stringify({ file_path: path }) } })
const editOk = (turn, step, callId) => ({ type: 'tool/result', data: { turn, step, message: { source: { callId }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }] } } })
const editFail = (turn, step, callId) => ({ type: 'tool/result', data: { turn, step, error: { name: 'Denied' }, message: { source: { callId }, content: [{ type: 'tool-result', isError: true, content: [] }] } } })

function makeAgent(sid) {
  const agent = { id: sid, session: { id: sid, events: [] }, ctx: { tools: { schemas: () => [], restrict: () => () => {} } } }
  agentsById.set(sid, agent)
  dispatch('agent/created', { agent })
  return { agent, session: { id: sid } }
}
// 多监听器瀑布：真实运行时同名 assemble 监听器**全部**依次运行（P1/P4 → 契约 → 缺口 →
// 越界 → 过期），next() 指向链上剩余监听器。旧的单槽 mock 只留最后一个（测试台缺陷，
// 基线 79a8fa1 上契约套件已被它"影子"成红——见 test-contract-reanchor.mjs 的同名注释）。
const assemble = (sid) => {
  const list = handlers['system-prompt/assemble'] || []
  let i = -1
  const run = (out) => {
    i += 1
    if (i >= list.length) return out
    return list[i](out, { agent: { id: sid } }, async (o) => run(o === undefined ? out : o))
  }
  return run({ sections: [], contexts: [], tools: [], variables: {} })
}
const breachSection = (out) => (out.sections || []).find((s) => s.name === 'trajectory-anchor:scope-breach')

// ── ① 默认关 ──────────────────────────────────────────────────────────────
await boot({})
{
  const { session } = makeAgent('sb-off')
  sessionEvent(session, SCOPED)
  sessionEvent(session, editCall(1, 2, 'D:/elsewhere/extra.py', 'c1'))
  sessionEvent(session, editOk(1, 2, 'c1'))
  const out = await assemble('sb-off')
  const row = await summaryOf('sb-off')
  check('① 默认关：没有越界回放段', breachSection(out) === undefined, JSON.stringify((out.sections || []).map((s) => s.name)))
  check('① 默认关：也没有 scope-breach-mirror 审计', !(row.auditKinds || []).includes('scope-breach-mirror'), JSON.stringify(row.auditKinds))
}

// ── ② 开：落地越界写 ⇒ 一次性回放（路径 + 原始范围条款）────────────────────
await boot({ scopeBreachMirror: true })
{
  const { session } = makeAgent('sb-on')
  sessionEvent(session, SCOPED)
  sessionEvent(session, editCall(1, 2, 'D:/elsewhere/extra.py', 'c1'))
  sessionEvent(session, editOk(1, 2, 'c1'))
  const out = await assemble('sb-on')
  const sec = breachSection(out)
  const row = await summaryOf('sb-on')
  check('② 开：组装里有越界回放段', sec !== undefined, JSON.stringify((out.sections || []).map((s) => s.name)))
  check('② 开：回放的是**越界路径**与**原始范围条款**（不是统计分数）',
    sec && /extra\.py/.test(sec.text) && /bugfix-a1/.test(sec.text) && /Work only inside/.test(sec.text), sec && sec.text.slice(0, 160))
  check('② 开：留审计且状态可见（via=post-fact-assemble）',
    Array.isArray(row.auditKinds) && row.auditKinds.includes('scope-breach-mirror') && row.scopeBreachMirror && row.scopeBreachMirror.served === true && row.scopeBreachMirror.via === 'post-fact-assemble',
    JSON.stringify(row.scopeBreachMirror))
  const out2 = await assemble('sb-on')
  check('② 开：**只注入一次**', breachSection(out2) === undefined, JSON.stringify((out2.sections || []).map((s) => s.name)))
}

// ── ③ 反向：范围内的写 ⇒ 不注入 ────────────────────────────────────────────
await boot({ scopeBreachMirror: true })
{
  const { session } = makeAgent('sb-in')
  sessionEvent(session, SCOPED)
  sessionEvent(session, editCall(1, 2, 'bugfix-a1/file.py', 'c1'))
  sessionEvent(session, editOk(1, 2, 'c1'))
  const out = await assemble('sb-in')
  const row = await summaryOf('sb-in')
  check('③ 反向：范围内写不注入', breachSection(out) === undefined, JSON.stringify((out.sections || []).map((s) => s.name)))
  check('③ 反向：写台账照记（证据捕获与触发无关）', row.evidence && row.evidence.edits === 1, JSON.stringify(row.evidence))
}

// ── ④ 反向：越界写**没落地**（tool/result 失败）⇒ 成功门撤回，不注入 ──────────
await boot({ scopeBreachMirror: true })
{
  const { session } = makeAgent('sb-denied')
  sessionEvent(session, SCOPED)
  sessionEvent(session, editCall(1, 2, 'D:/elsewhere/extra.py', 'c1'))
  sessionEvent(session, editFail(1, 2, 'c1'))
  const out = await assemble('sb-denied')
  const row = await summaryOf('sb-denied')
  check('④ 反向：被拒的写不注入（成功门撤回）', breachSection(out) === undefined, JSON.stringify((out.sections || []).map((s) => s.name)))
  check('④ 反向：撤回有痕（armRetracted≥1）且写台账同步撤回', (row.pullback && row.pullback.armRetracted >= 1) && row.evidence.edits === 0, JSON.stringify({ retracted: row.pullback && row.pullback.armRetracted, edits: row.evidence.edits }))
}

// ── ⑤ 反向：临时/缓存类路径 ⇒ 不算越界，不注入 ──────────────────────────────
await boot({ scopeBreachMirror: true })
{
  const { session } = makeAgent('sb-temp')
  sessionEvent(session, SCOPED)
  sessionEvent(session, editCall(1, 2, 'C:/Users/x/AppData/Local/Temp/t.py', 'c1'))
  sessionEvent(session, editOk(1, 2, 'c1'))
  const out = await assemble('sb-temp')
  check('⑤ 反向：临时路径不注入', breachSection(out) === undefined, JSON.stringify((out.sections || []).map((s) => s.name)))
}

// ── ⑥ 反向：首条指令没有范围子句 ⇒ 无从判越界，不注入 ────────────────────────
await boot({ scopeBreachMirror: true })
{
  const { session } = makeAgent('sb-noscope')
  sessionEvent(session, UNSC)
  sessionEvent(session, editCall(1, 2, 'D:/anywhere/file.py', 'c1'))
  sessionEvent(session, editOk(1, 2, 'c1'))
  const out = await assemble('sb-noscope')
  check('⑥ 反向：无范围子句不注入（不猜）', breachSection(out) === undefined, JSON.stringify((out.sections || []).map((s) => s.name)))
}

// ── ⑦ 惰性 + 边界：无 turn/end 也在下一次组装回放；有 turn/end 则先挂标记 ──────
await boot({ scopeBreachMirror: true })
{
  const a = makeAgent('sb-lazy')
  sessionEvent(a.session, SCOPED)
  sessionEvent(a.session, editCall(1, 2, 'D:/elsewhere/extra.py', 'c1'))
  sessionEvent(a.session, editOk(1, 2, 'c1'))
  const out = await assemble('sb-lazy')
  check('⑦ 惰性：无 turn/end 也回放', breachSection(out) !== undefined, JSON.stringify((out.sections || []).map((s) => s.name)))

  const b = makeAgent('sb-boundary')
  sessionEvent(b.session, SCOPED)
  sessionEvent(b.session, editCall(1, 2, 'D:/elsewhere/extra.py', 'c2'))
  sessionEvent(b.session, editOk(1, 2, 'c2'))
  sessionEvent(b.session, { type: 'turn/end', data: { turn: 1 } })
  const rowB = await summaryOf('sb-boundary')
  check('⑦ 边界：turn/end 先挂标记（via=turn-end）', rowB.scopeBreachMirror && rowB.scopeBreachMirror.via === 'turn-end' && rowB.scopeBreachMirror.served === false, JSON.stringify(rowB.scopeBreachMirror))
  const outB = await assemble('sb-boundary')
  check('⑦ 边界：下一次组装回放', breachSection(outB) !== undefined, JSON.stringify((outB.sections || []).map((s) => s.name)))
}

console.log(`\n${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
