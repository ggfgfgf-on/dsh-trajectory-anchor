/**
 * test-protocol-gates.mjs -- phase-2 protocol constraints (P1 delivery gate / P2 verify budget /
 * P3 claim-format contract), per docs/design-intervention-upgrade.md.
 *
 * The difference from the mirror suite: these REFUSE the delivery / FORCE a re-verify / DEMAND the
 * format, instead of narrating evidence. Triggers stay on the fact layer (deliveryGate /
 * claimFormatOk are pure functions in task-anchor-core.mjs).
 *
 * Both directions, one-shot/budget semantics, the success gate (retracted edits must not count),
 * and the "must not fire" controls. Usage: node tools/test-protocol-gates.mjs [path/to/index.js]
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const here = fileURLToPath(new URL('.', import.meta.url))
const mod = await import(pathToFileURL(resolve(here, process.argv[2] || '../index.js')).href)
const { deliveryGate, claimFormatOk } = await import(pathToFileURL(resolve(here, 'task-anchor-core.mjs')).href)

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

const FAIL_TEXT = '[hidden] failed=21 errors=0 passed=24/45\nFAIL: test_voice_bridge\n'
const PASS_TEXT = '[hidden] failed=0 errors=0 passed=45/45\n'
const SCOPED = { type: 'user/message', data: { source: { kind: 'user' }, turn: 1, step: 1, content: [{ type: 'text', text: 'Work only inside `bugfix-a1` directory. Report ONE line: PASS=<n>/7' }] } }
const verifyCall = (turn, step, command) => ({ type: 'tool/call', data: { turn, step, name: 'pwsh', arguments: JSON.stringify({ command }) } })
const verifyResult = (turn, step, out) => ({ type: 'tool/result', data: { turn, step, message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: out }] }] } } })
const editCall = (turn, step, path, callId) => ({ type: 'tool/call', data: { turn, step, name: 'edit', callId, arguments: JSON.stringify({ file_path: path }) } })
const editOk = (turn, step, callId) => ({ type: 'tool/result', data: { turn, step, message: { source: { callId }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }] } } })
const editFail = (turn, step, callId) => ({ type: 'tool/result', data: { turn, step, error: { name: 'Denied' }, message: { source: { callId }, content: [{ type: 'tool-result', isError: true, content: [] }] } } })
const doneEvent = (turn, step, text) => ({ type: 'assistant/message', data: { turn, step, message: { content: [{ type: 'text', text: text || 'The task is done, all checks pass.' }] } } })

function makeAgent(sid) {
  const agent = { id: sid, session: { id: sid, events: [] }, ctx: { tools: { schemas: () => [], restrict: () => () => {} } } }
  agentsById.set(sid, agent)
  dispatch('agent/created', { agent })
  return { agent, session: { id: sid } }
}
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
const section = (out, name) => (out.sections || []).find((s) => s.name === name)

// ── P1 ① 默认关 ────────────────────────────────────────────────────────────
await boot({})
{
  const { session } = makeAgent('pg-off')
  sessionEvent(session, verifyCall(1, 1, 'python -X utf8 evaluator/run_hidden_tests.py'))
  sessionEvent(session, verifyResult(1, 1, FAIL_TEXT))
  sessionEvent(session, doneEvent(1, 2))
  const out = await assemble('pg-off')
  check('P1 ① 默认关：没有交付门段', section(out, 'trajectory-anchor:delivery-gate') === undefined, JSON.stringify((out.sections || []).map((s) => s.name)))
}

// ── P1 ② 开：隐藏评测失败 + 宣告 ⇒ 拒绝接收（一次性）────────────────────────
await boot({ deliveryGate: true })
{
  const { session } = makeAgent('pg-refuse')
  sessionEvent(session, verifyCall(1, 1, 'python -X utf8 evaluator/run_hidden_tests.py'))
  sessionEvent(session, verifyResult(1, 1, FAIL_TEXT))
  sessionEvent(session, doneEvent(1, 2))
  const out = await assemble('pg-refuse')
  const sec = section(out, 'trajectory-anchor:delivery-gate')
  const row = await summaryOf('pg-refuse')
  check('P1 ② 开：组装里有拒绝段且措辞是"拒绝接收"',
    sec !== undefined && /DELIVERY NOT ACCEPTED/.test(sec.text) && /test_voice_bridge/.test(sec.text), sec && sec.text.slice(0, 150))
  check('P1 ② 开：留 delivery-gate 审计且状态可见', row.deliveryGate && row.deliveryGate.served === true && row.deliveryGate.reason === 'hidden-verify-failed', JSON.stringify(row.deliveryGate))
  const out2 = await assemble('pg-refuse')
  check('P1 ② 开：**只拒一次**', section(out2, 'trajectory-anchor:delivery-gate') === undefined, JSON.stringify((out2.sections || []).map((s) => s.name)))
}

// ── P1 ③ 反向：隐藏评测全绿且无事后编辑 ⇒ 不拒 ──────────────────────────────
await boot({ deliveryGate: true })
{
  const { session } = makeAgent('pg-green')
  sessionEvent(session, verifyCall(1, 1, 'python -X utf8 evaluator/run_hidden_tests.py'))
  sessionEvent(session, verifyResult(1, 1, PASS_TEXT))
  sessionEvent(session, doneEvent(1, 2))
  const out = await assemble('pg-green')
  check('P1 ③ 反向：全绿且新鲜 ⇒ 不拒', section(out, 'trajectory-anchor:delivery-gate') === undefined, JSON.stringify((out.sections || []).map((s) => s.name)))
}

// ── P1 ④ 开：隐藏评测全绿但之后又改代码 + 宣告 ⇒ 拒（编辑证据）────────────────
await boot({ deliveryGate: true })
{
  const { session } = makeAgent('pg-stale')
  sessionEvent(session, verifyCall(1, 1, 'python -X utf8 evaluator/run_hidden_tests.py'))
  sessionEvent(session, verifyResult(1, 1, PASS_TEXT))
  sessionEvent(session, editCall(1, 2, 'tests/run_hidden_tests.py', 'c1'))
  sessionEvent(session, editOk(1, 2, 'c1'))
  sessionEvent(session, doneEvent(1, 3))
  const out = await assemble('pg-stale')
  const sec = section(out, 'trajectory-anchor:delivery-gate')
  check('P1 ④ 开：验证早于事后编辑 ⇒ 拒，且给出编辑证据',
    sec !== undefined && /predates a later code edit/.test(sec.text) && /run_hidden_tests\.py/.test(sec.text), sec && sec.text.slice(0, 180))
}

// ── P1 ⑤ 反向：只有 public 验证（无隐藏评测形态）⇒ 不设门（保守）──────────────
await boot({ deliveryGate: true })
{
  const { session } = makeAgent('pg-public')
  sessionEvent(session, verifyCall(1, 1, 'python evaluator/tests/run_public_tests.py workspace/project2_task'))
  sessionEvent(session, verifyResult(1, 1, FAIL_TEXT))
  sessionEvent(session, doneEvent(1, 2))
  const out = await assemble('pg-public')
  check('P1 ⑤ 反向：无隐藏评测证据 ⇒ 不拒（不猜）', section(out, 'trajectory-anchor:delivery-gate') === undefined, JSON.stringify((out.sections || []).map((s) => s.name)))
}

// ── P2 ⑥ 开：3 次落地代码改动 ⇒ 注入强制重验；预算可重装 ────────────────────
await boot({ verifyAfterEditBudget: true, verifyBudgetEvery: 3 })
{
  const { session } = makeAgent('pg-budget')
  sessionEvent(session, verifyCall(1, 1, 'python -X utf8 evaluator/run_hidden_tests.py'))
  sessionEvent(session, verifyResult(1, 1, PASS_TEXT))
  sessionEvent(session, editCall(1, 2, 'gateway/auth.py', 'b1'))
  sessionEvent(session, editOk(1, 2, 'b1'))
  sessionEvent(session, editCall(1, 3, 'gateway/gateway.py', 'b2'))
  sessionEvent(session, editOk(1, 3, 'b2'))
  const out1 = await assemble('pg-budget')
  check('P2 ⑥ 反向：2 次改动 ⇒ 不注入', section(out1, 'trajectory-anchor:verify-budget') === undefined, JSON.stringify((out1.sections || []).map((s) => s.name)))
  sessionEvent(session, editCall(1, 4, 'gateway/db.py', 'b3'))
  sessionEvent(session, editOk(1, 4, 'b3'))
  const out2 = await assemble('pg-budget')
  const sec = section(out2, 'trajectory-anchor:verify-budget')
  const row = await summaryOf('pg-budget')
  check('P2 ⑥ 开：第 3 次改动 ⇒ 注入强制重验', sec !== undefined && /re-run the verification/.test(sec.text), sec && sec.text.slice(0, 140))
  check('P2 ⑥ 开：注入后预算清零（count=0、armed=false）', row.verifyBudget && row.verifyBudget.count === 0 && row.verifyBudget.armed === false, JSON.stringify(row.verifyBudget))
  sessionEvent(session, editCall(1, 5, 'gateway/db.py', 'b4'))
  sessionEvent(session, editOk(1, 5, 'b4'))
  sessionEvent(session, editCall(1, 6, 'gateway/db.py', 'b5'))
  sessionEvent(session, editOk(1, 6, 'b5'))
  sessionEvent(session, editCall(1, 7, 'gateway/db.py', 'b6'))
  sessionEvent(session, editOk(1, 7, 'b6'))
  const out3 = await assemble('pg-budget')
  check('P2 ⑥ 开：预算**可重装**（再 3 次改动 ⇒ 再次注入）', section(out3, 'trajectory-anchor:verify-budget') !== undefined, JSON.stringify((out3.sections || []).map((s) => s.name)))
}

// ── P2 ⑦ 反向：被拒的写不算"改过"（成功门撤回预算计数）─────────────────────
await boot({ verifyAfterEditBudget: true, verifyBudgetEvery: 3 })
{
  const { session } = makeAgent('pg-retract')
  sessionEvent(session, verifyCall(1, 1, 'python -X utf8 evaluator/run_hidden_tests.py'))
  sessionEvent(session, verifyResult(1, 1, PASS_TEXT))
  sessionEvent(session, editCall(1, 2, 'gateway/auth.py', 'r1'))
  sessionEvent(session, editFail(1, 2, 'r1'))   // 被拒 ⇒ 撤回
  sessionEvent(session, editCall(1, 3, 'gateway/gateway.py', 'r2'))
  sessionEvent(session, editFail(1, 3, 'r2'))   // 被拒 ⇒ 撤回
  sessionEvent(session, editCall(1, 4, 'gateway/db.py', 'r3'))
  sessionEvent(session, editOk(1, 4, 'r3'))     // 只有这一次落地
  const out = await assemble('pg-retract')
  const row = await summaryOf('pg-retract')
  check('P2 ⑦ 反向：2 次被拒 + 1 次落地 ⇒ 计数 1、不注入',
    section(out, 'trajectory-anchor:verify-budget') === undefined && row.verifyBudget.count === 1, JSON.stringify(row.verifyBudget))
}

// ── P3 ⑧ 开：声明过 PASS=n/7 而交付没带 ⇒ 要求补格式 ─────────────────────────
await boot({ claimFormatContract: true })
{
  const { session } = makeAgent('pg-fmt')
  sessionEvent(session, SCOPED)
  sessionEvent(session, doneEvent(1, 3))
  const out = await assemble('pg-fmt')
  const sec = section(out, 'trajectory-anchor:claim-format')
  const row = await summaryOf('pg-fmt')
  check('P3 ⑧ 开：交付缺 PASS=n/7 行 ⇒ 注入格式要求（一次性）',
    sec !== undefined && /PASS=<n>\/7/.test(sec.text), sec && sec.text.slice(0, 160))
  check('P3 ⑧ 开：留 claim-format 审计', row.claimFormat && row.claimFormat.served === true, JSON.stringify(row.claimFormat))
  const out2 = await assemble('pg-fmt')
  check('P3 ⑧ 开：**只要求一次**', section(out2, 'trajectory-anchor:claim-format') === undefined, JSON.stringify((out2.sections || []).map((s) => s.name)))
}

// ── P3 ⑨ 反向：交付带同分母 PASS 行 ⇒ 不要求 ────────────────────────────────
await boot({ claimFormatContract: true })
{
  const { session } = makeAgent('pg-fmt-ok')
  sessionEvent(session, SCOPED)
  sessionEvent(session, doneEvent(1, 3, 'The task is done. Final: PASS=7/7'))
  const out = await assemble('pg-fmt-ok')
  check('P3 ⑨ 反向：带 PASS=7/7 ⇒ 不要求', section(out, 'trajectory-anchor:claim-format') === undefined, JSON.stringify((out.sections || []).map((s) => s.name)))
}

// ── P3 ⑩ 反向：提示没声明格式 ⇒ 不要求 ──────────────────────────────────────
await boot({ claimFormatContract: true })
{
  const { session } = makeAgent('pg-fmt-none')
  sessionEvent(session, { type: 'user/message', data: { source: { kind: 'user' }, turn: 1, step: 1, content: [{ type: 'text', text: 'Work only inside `bugfix-a1` directory.' }] } })
  sessionEvent(session, doneEvent(1, 2))
  const out = await assemble('pg-fmt-none')
  check('P3 ⑩ 反向：无格式声明 ⇒ 不要求', section(out, 'trajectory-anchor:claim-format') === undefined, JSON.stringify((out.sections || []).map((s) => s.name)))
}

// ── 纯函数负向对照 ──────────────────────────────────────────────────────────
{
  const claim = { turn: 1, step: 3, claimedDone: true, claimedPass: null }
  const hiddenFail = [{ turn: 1, step: 1, cmd: 'python -X utf8 evaluator/run_hidden_tests.py', failed: true, outputTail: 'FAIL: x' }]
  const base = deliveryGate({ claim, verifyEvidence: hiddenFail, edits: [] })
  check('纯函数：隐藏失败 ⇒ 拒', base.refuse === true && base.reason === 'hidden-verify-failed', JSON.stringify(base))
  const fresh = deliveryGate({ claim, verifyEvidence: [{ ...hiddenFail[0], failed: false }], edits: [] })
  check('纯函数：隐藏全绿 ⇒ 不拒', fresh.refuse === false && fresh.reason === 'fresh-and-green', JSON.stringify(fresh))
  const noHidden = deliveryGate({ claim, verifyEvidence: [{ ...hiddenFail[0], cmd: 'python evaluator/tests/run_public_tests.py' }], edits: [] })
  check('纯函数：无隐藏形态 ⇒ 不拒（不猜）', noHidden.refuse === false && noHidden.reason === 'no-hidden-verification', JSON.stringify(noHidden))
  const noClaim = deliveryGate({ claim: { ...claim, claimedDone: false, claimedPass: null }, verifyEvidence: hiddenFail, edits: [] })
  check('纯函数：无宣告 ⇒ 不拒', noClaim.refuse === false && noClaim.reason === 'no-completion-claim', JSON.stringify(noClaim))
  check('纯函数：PASS=5/7 满足分母 7 的格式', claimFormatOk('final PASS=5/7', { kind: 'PASS=n/m', total: 7 }) === true)
  check('纯函数：PASS=5/45 不满足分母 7', claimFormatOk('final PASS=5/45', { kind: 'PASS=n/m', total: 7 }) === false)
  check('纯函数：无格式声明恒 true', claimFormatOk('done', null) === true)
}

console.log(`\n${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
