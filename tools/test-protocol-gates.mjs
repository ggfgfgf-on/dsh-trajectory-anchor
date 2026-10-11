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
import { resolve, join } from 'node:path'
import { writeFileSync, rmSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

const here = fileURLToPath(new URL('.', import.meta.url))
const mod = await import(pathToFileURL(resolve(here, process.argv[2] || '../index.js')).href)
const { deliveryGate, claimFormatOk, artifactStateFacts } = await import(pathToFileURL(resolve(here, 'task-anchor-core.mjs')).href)

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

// ── Q4 会话内编辑预算（process-front-loaded）───────────────────────────────
await boot({ editBudgetCap: 3 })
{
  const { session } = makeAgent('pg-q4')
  sessionEvent(session, verifyCall(1, 1, 'python -X utf8 evaluator/run_hidden_tests.py'))
  sessionEvent(session, verifyResult(1, 1, PASS_TEXT))
  sessionEvent(session, editCall(1, 2, 'gateway/auth.py', 'q1'))
  sessionEvent(session, editOk(1, 2, 'q1'))
  sessionEvent(session, editCall(1, 3, 'gateway/gateway.py', 'q2'))
  sessionEvent(session, editOk(1, 3, 'q2'))
  const out1 = await assemble('pg-q4')
  check('Q4 反向：2 次改动（预算 3）⇒ 不注入', section(out1, 'trajectory-anchor:edit-budget') === undefined, JSON.stringify((out1.sections || []).map((s) => s.name)))
  sessionEvent(session, editCall(1, 4, 'gateway/db.py', 'q3'))
  sessionEvent(session, editOk(1, 4, 'q3'))
  const out2 = await assemble('pg-q4')
  const sec = section(out2, 'trajectory-anchor:edit-budget')
  const row = await summaryOf('pg-q4')
  check('Q4 开：第 3 次改动 ⇒ 注入"评分并交付"', sec !== undefined && /Stop editing/.test(sec.text), sec && sec.text.slice(0, 150))
  check('Q4 开：状态可见（exhausted、count=3）', row.editBudget && row.editBudget.exhausted === true && row.editBudget.count === 3, JSON.stringify(row.editBudget))
  const out3 = await assemble('pg-q4')
  check('Q4 开：**只注一次**', section(out3, 'trajectory-anchor:edit-budget') === undefined, JSON.stringify((out3.sections || []).map((s) => s.name)))
}
await boot({ editBudgetCap: 3 })
{
  const { session } = makeAgent('pg-q4-retract')
  sessionEvent(session, verifyCall(1, 1, 'python -X utf8 evaluator/run_hidden_tests.py'))
  sessionEvent(session, verifyResult(1, 1, PASS_TEXT))
  sessionEvent(session, editCall(1, 2, 'gateway/auth.py', 'r1'))
  sessionEvent(session, editFail(1, 2, 'r1'))   // 被拒 ⇒ 不占预算
  sessionEvent(session, editCall(1, 3, 'gateway/gateway.py', 'r2'))
  sessionEvent(session, editFail(1, 3, 'r2'))   // 被拒 ⇒ 不占预算
  sessionEvent(session, editCall(1, 4, 'gateway/db.py', 'r3'))
  sessionEvent(session, editOk(1, 4, 'r3'))
  const out = await assemble('pg-q4-retract')
  const row = await summaryOf('pg-q4-retract')
  check('Q4 反向：2 次被拒 + 1 次落地 ⇒ count=1、不注入',
    section(out, 'trajectory-anchor:edit-budget') === undefined && row.editBudget.count === 1, JSON.stringify(row.editBudget))
}

// ── Q2 带保持的编辑预算（process-front-loaded）─────────────────────────────
const preStep = async (sid, turn, step) => {
  const h = handlers['agent/pre-step']
  if (!h) return null
  const payload = { agent: { id: sid }, messages: [], turn, step }
  return h(payload, async () => ({ messages: [] }))
}
await boot({ editHoldEvery: 3 })
{
  const { session } = makeAgent('pg-q2')
  sessionEvent(session, verifyCall(1, 1, 'python -X utf8 evaluator/run_hidden_tests.py'))
  sessionEvent(session, verifyResult(1, 1, PASS_TEXT))
  sessionEvent(session, editCall(1, 2, 'gateway/auth.py', 'h1'))
  sessionEvent(session, editOk(1, 2, 'h1'))
  sessionEvent(session, editCall(1, 3, 'gateway/gateway.py', 'h2'))
  sessionEvent(session, editOk(1, 3, 'h2'))
  const out1 = await preStep('pg-q2', 1, 4)
  const held1 = (out1 && out1.messages || []).some((m) => m.source && m.source.kind === 'trajectory-anchor-edit-hold')
  check('Q2 反向：2 次改动（K=3）⇒ pre-step 不注保持', held1 === false, JSON.stringify((out1 && out1.messages || []).map((m) => m.source && m.source.kind)))
  sessionEvent(session, editCall(1, 4, 'gateway/db.py', 'h3'))
  sessionEvent(session, editOk(1, 4, 'h3'))
  const row = await summaryOf('pg-q2')
  check('Q2 开：第 3 次改动 ⇒ holding=true', row.editHold && row.editHold.holding === true, JSON.stringify(row.editHold))
  const out2 = await preStep('pg-q2', 1, 5)
  const held2 = (out2 && out2.messages || []).some((m) => m.source && m.source.kind === 'trajectory-anchor-edit-hold')
  check('Q2 开：保持态 pre-step 注入"不许再改，先重验"', held2 === true, JSON.stringify((out2 && out2.messages || []).map((m) => m.source && m.source.kind)))
  const out2b = await preStep('pg-q2', 1, 6)
  const held2b = (out2b && out2b.messages || []).some((m) => m.source && m.source.kind === 'trajectory-anchor-edit-hold')
  check('Q2 开：**每次保持期只注一次**', held2b === false, JSON.stringify((out2b && out2b.messages || []).map((m) => m.source && m.source.kind)))
  sessionEvent(session, editCall(1, 6, 'gateway/db.py', 'h4'))
  sessionEvent(session, editOk(1, 6, 'h4'))
  const row2 = await summaryOf('pg-q2')
  check('Q2 开：保持态下再编辑 ⇒ violations=1（允许但计数）', row2.editHold.violations === 1, JSON.stringify(row2.editHold))
  sessionEvent(session, verifyCall(1, 7, 'python -X utf8 evaluator/run_hidden_tests.py'))
  sessionEvent(session, verifyResult(1, 7, PASS_TEXT))
  const row3 = await summaryOf('pg-q2')
  check('Q2 开：验证证据落地 ⇒ 解除（holding=false、editsSinceVerify=0、released=1）',
    row3.editHold.holding === false && row3.editHold.editsSinceVerify === 0 && row3.editHold.released === 1, JSON.stringify(row3.editHold))
}
await boot({ editHoldEvery: 3 })
{
  const { session } = makeAgent('pg-q2-retract')
  sessionEvent(session, verifyCall(1, 1, 'python -X utf8 evaluator/run_hidden_tests.py'))
  sessionEvent(session, verifyResult(1, 1, PASS_TEXT))
  sessionEvent(session, editCall(1, 2, 'gateway/auth.py', 'r1'))
  sessionEvent(session, editFail(1, 2, 'r1'))
  sessionEvent(session, editCall(1, 3, 'gateway/gateway.py', 'r2'))
  sessionEvent(session, editFail(1, 3, 'r2'))
  sessionEvent(session, editCall(1, 4, 'gateway/db.py', 'r3'))
  sessionEvent(session, editOk(1, 4, 'r3'))
  const row = await summaryOf('pg-q2-retract')
  check('Q2 反向：2 次被拒 + 1 次落地 ⇒ editsSinceVerify=1、不保持',
    row.editHold.editsSinceVerify === 1 && row.editHold.holding === false, JSON.stringify(row.editHold))
}

// ── Q1 交付工件门（process-front-loaded）───────────────────────────────────
await boot({ deliveryArtifactGate: true })
{
  const { session } = makeAgent('pg-q1')
  sessionEvent(session, verifyCall(1, 1, 'python -X utf8 evaluator/run_hidden_tests.py'))
  sessionEvent(session, verifyResult(1, 1, FAIL_TEXT))
  sessionEvent(session, editCall(1, 2, 'workspace/project2_task/PULL_REQUEST_TEMPLATE.md', 'a1'))
  sessionEvent(session, editOk(1, 2, 'a1'))
  const out = await assemble('pg-q1')
  const sec = section(out, 'trajectory-anchor:delivery-artifact-gate')
  const row = await summaryOf('pg-q1')
  check('Q1 开：隐藏评测失败 + 写交付工件 ⇒ 拒绝接收（工件措辞）',
    sec !== undefined && /DELIVERY ARTIFACT NOT ACCEPTED/.test(sec.text) && /test_voice_bridge/.test(sec.text), sec && sec.text.slice(0, 160))
  check('Q1 开：留审计且状态可见', row.deliveryArtifactGate && row.deliveryArtifactGate.served === true && row.deliveryArtifactGate.reason === 'hidden-verify-failed', JSON.stringify(row.deliveryArtifactGate))
  const out2 = await assemble('pg-q1')
  check('Q1 开：**每次武装只拒一次**', section(out2, 'trajectory-anchor:delivery-artifact-gate') === undefined, JSON.stringify((out2.sections || []).map((s) => s.name)))
  // 重写工件 ⇒ 重新武装
  sessionEvent(session, editCall(1, 3, 'workspace/project2_task/PULL_REQUEST_TEMPLATE.md', 'a2'))
  sessionEvent(session, editOk(1, 3, 'a2'))
  const out3 = await assemble('pg-q1')
  check('Q1 开：工件**重写 ⇒ 重新武装**（重跑评分前每次重写都会被拒）', section(out3, 'trajectory-anchor:delivery-artifact-gate') !== undefined, JSON.stringify((out3.sections || []).map((s) => s.name)))
}
await boot({ deliveryArtifactGate: true })
{
  const { session } = makeAgent('pg-q1-green')
  sessionEvent(session, verifyCall(1, 1, 'python -X utf8 evaluator/run_hidden_tests.py'))
  sessionEvent(session, verifyResult(1, 1, PASS_TEXT))
  sessionEvent(session, editCall(1, 2, 'workspace/project2_task/PULL_REQUEST_TEMPLATE.md', 'a1'))
  sessionEvent(session, editOk(1, 2, 'a1'))
  const out = await assemble('pg-q1-green')
  check('Q1 反向：全绿且新鲜 ⇒ 不拒', section(out, 'trajectory-anchor:delivery-artifact-gate') === undefined, JSON.stringify((out.sections || []).map((s) => s.name)))
}
await boot({ deliveryArtifactGate: true })
{
  const { session } = makeAgent('pg-q1-nohidden')
  sessionEvent(session, editCall(1, 1, 'workspace/project2_task/PULL_REQUEST_TEMPLATE.md', 'a1'))
  sessionEvent(session, editOk(1, 1, 'a1'))
  const out = await assemble('pg-q1-nohidden')
  check('Q1 反向：无隐藏评测证据 ⇒ 不拒（不猜）', section(out, 'trajectory-anchor:delivery-artifact-gate') === undefined, JSON.stringify((out.sections || []).map((s) => s.name)))
}
await boot({ deliveryArtifactGate: true })
{
  const { session } = makeAgent('pg-q1-other')
  sessionEvent(session, verifyCall(1, 1, 'python -X utf8 evaluator/run_hidden_tests.py'))
  sessionEvent(session, verifyResult(1, 1, FAIL_TEXT))
  sessionEvent(session, editCall(1, 2, 'workspace/project2_task/README.md', 'a1'))
  sessionEvent(session, editOk(1, 2, 'a1'))
  const out = await assemble('pg-q1-other')
  check('Q1 反向：非交付工件（README）⇒ 不拒', section(out, 'trajectory-anchor:delivery-artifact-gate') === undefined, JSON.stringify((out.sections || []).map((s) => s.name)))
}

// ── Q1' 工件状态绑定门（process-gate §6）────────────────────────────────────
await boot({ deliveryArtifactStateGate: true })
{
  // 真实临时工件文件：绑定与比对都走磁盘文件状态（脚本通道写入也可见）。
  const fixDir = mkdtempSync(join(tmpdir(), 'pg-q1p-'))
  const artPath = join(fixDir, 'PULL_REQUEST_TEMPLATE.md')
  writeFileSync(artPath, '# seed template\n')
  const { session } = makeAgent('pg-q1p')
  sessionEvent(session, verifyCall(1, 1, `cd '${fixDir}'; python -X utf8 evaluator/run_public_tests.py`))
  sessionEvent(session, verifyResult(1, 1, FAIL_TEXT))
  const row0 = await summaryOf('pg-q1p')
  check('Q1p 开：任意 grader 验证落地 ⇒ 绑定工件状态（public 也武装，且带失败证据）',
    row0.artifactBinding && row0.artifactBinding.path === artPath && row0.artifactBinding.verifyFailed === true,
    JSON.stringify(row0.artifactBinding))
  const out0 = await preStep('pg-q1p', 1, 2)
  const held0 = (out0 && out0.messages || []).some((m) => m.source && m.source.kind === 'trajectory-anchor-artifact-gate')
  check('Q1p 反向：工件未动 ⇒ 不保持（红色验证本身不是交付）', held0 === false,
    JSON.stringify((out0 && out0.messages || []).map((m) => m.source && m.source.kind)))
  // 脚本通道写入：**没有**工具事件，直接改磁盘文件——Q1 的工具层观测看不见，Q1' 必须看见。
  writeFileSync(artPath, '# modified by a script, no tool event\n')
  const out1 = await preStep('pg-q1p', 1, 3)
  const held1 = (out1 && out1.messages || []).some((m) => m.source && m.source.kind === 'trajectory-anchor-artifact-gate')
  check('Q1p 开：脚本通道改工件 ⇒ pre-step 注入保持（§48 m1-5 盲区的修法）', held1 === true,
    JSON.stringify((out1 && out1.messages || []).map((m) => m.source && m.source.kind)))
  const row1 = await summaryOf('pg-q1p')
  check('Q1p 开：留审计且状态可见（served=true）',
    row1.artifactBinding && row1.artifactBinding.served === true, JSON.stringify(row1.artifactBinding))
  const out1b = await preStep('pg-q1p', 1, 4)
  const held1b = (out1b && out1b.messages || []).some((m) => m.source && m.source.kind === 'trajectory-anchor-artifact-gate')
  check('Q1p 开：**每次绑定期只注一次**', held1b === false,
    JSON.stringify((out1b && out1b.messages || []).map((m) => m.source && m.source.kind)))
  // 重验 ⇒ 重新绑定 ⇒ 解除；工件未再动 ⇒ 不再保持。
  sessionEvent(session, verifyCall(1, 5, `cd '${fixDir}'; python -X utf8 evaluator/run_public_tests.py`))
  sessionEvent(session, verifyResult(1, 5, FAIL_TEXT))
  const row2 = await summaryOf('pg-q1p')
  check('Q1p 开：重验 ⇒ 重新绑定（解除保持，served=false、绑定步进到 5）',
    row2.artifactBinding && row2.artifactBinding.served === false && row2.artifactBinding.boundStep === 5,
    JSON.stringify(row2.artifactBinding))
  const out2 = await preStep('pg-q1p', 1, 6)
  const held2 = (out2 && out2.messages || []).some((m) => m.source && m.source.kind === 'trajectory-anchor-artifact-gate')
  check('Q1p 反向：重验后工件未动 ⇒ 不保持', held2 === false,
    JSON.stringify((out2 && out2.messages || []).map((m) => m.source && m.source.kind)))
  // 工件被删 ⇒ 下一次边界注入保持。
  rmSync(artPath)
  const out3 = await preStep('pg-q1p', 1, 7)
  const held3 = (out3 && out3.messages || []).some((m) => m.source && m.source.kind === 'trajectory-anchor-artifact-gate')
  check('Q1p 开：工件被删 ⇒ 注入保持', held3 === true,
    JSON.stringify((out3 && out3.messages || []).map((m) => m.source && m.source.kind)))
}
await boot({ deliveryArtifactStateGate: false })
{
  const fixDir2 = mkdtempSync(join(tmpdir(), 'pg-q1p-off-'))
  const artPath2 = join(fixDir2, 'PULL_REQUEST_TEMPLATE.md')
  writeFileSync(artPath2, '# seed\n')
  const { session } = makeAgent('pg-q1p-off')
  sessionEvent(session, verifyCall(1, 1, `cd '${fixDir2}'; python -X utf8 evaluator/run_public_tests.py`))
  sessionEvent(session, verifyResult(1, 1, FAIL_TEXT))
  writeFileSync(artPath2, '# changed while gate off\n')
  const out = await preStep('pg-q1p-off', 1, 2)
  const held = (out && out.messages || []).some((m) => m.source && m.source.kind === 'trajectory-anchor-artifact-gate')
  const row = await summaryOf('pg-q1p-off')
  check('Q1p 反向：默认关 ⇒ 不绑定、不注入', held === false && (!row.artifactBinding),
    JSON.stringify(row.artifactBinding))
}
// ── Q1'' 递归绑定增面（§49.5 探针前置的自查修法）────────────────────────────
await boot({ deliveryArtifactStateGate: true })
{
  // grader 从运行根跑（模板埋在 workspace\project2_task 下两层）⇒ 递归找到并绑定（m1-2 场景）
  const fix = mkdtempSync(join(tmpdir(), 'pg-q1p2-'))
  const ws = join(fix, 'workspace', 'project2_task')
  mkdirSync(ws, { recursive: true })
  const art = join(ws, 'PULL_REQUEST_TEMPLATE.md')
  writeFileSync(art, '# seed\n')
  const { session } = makeAgent('pg-q1p2')
  sessionEvent(session, verifyCall(1, 1, `cd '${fix}'; python -X utf8 evaluator/run_public_tests.py workspace/project2_task`))
  sessionEvent(session, verifyResult(1, 1, FAIL_TEXT))
  const row = await summaryOf('pg-q1p2')
  check('Q1p2 开：cd 运行根 ⇒ 递归找到深层模板并绑定（m1-2 场景）',
    row.artifactBinding && row.artifactBinding.path === art, JSON.stringify(row.artifactBinding))
}
await boot({ deliveryArtifactStateGate: true })
{
  // 文件 artifact 的祖父目录：Test-Path 只给 grader 脚本路径 ⇒ 从运行根找到模板（m1-7 场景）
  const fix = mkdtempSync(join(tmpdir(), 'pg-q1p2b-'))
  const ev = join(fix, 'evaluator')
  mkdirSync(ev, { recursive: true })
  writeFileSync(join(ev, 'run_hidden_tests.py'), 'print(1)\n')
  const ws = join(fix, 'workspace', 'project2_task')
  mkdirSync(ws, { recursive: true })
  const art = join(ws, 'PULL_REQUEST_TEMPLATE.md')
  writeFileSync(art, '# seed\n')
  const { session } = makeAgent('pg-q1p2b')
  sessionEvent(session, verifyCall(1, 1, `Test-Path '${join(ev, 'run_hidden_tests.py')}'`))
  sessionEvent(session, verifyResult(1, 1, 'True'))
  const row = await summaryOf('pg-q1p2b')
  check('Q1p2 开：文件 artifact 的祖父目录 ⇒ 找到模板（m1-7 Test-Path 场景）',
    row.artifactBinding && row.artifactBinding.path === art, JSON.stringify(row.artifactBinding))
}
await boot({ deliveryArtifactStateGate: true })
{
  // 深度超限 ⇒ 不绑（fail-open 不猜）
  const fix = mkdtempSync(join(tmpdir(), 'pg-q1p2c-'))
  const deep = join(fix, 'a', 'b', 'c', 'd', 'e', 'f')
  mkdirSync(deep, { recursive: true })
  writeFileSync(join(deep, 'PULL_REQUEST_TEMPLATE.md'), '# too deep\n')
  const { session } = makeAgent('pg-q1p2c')
  sessionEvent(session, verifyCall(1, 1, `cd '${fix}'; python -X utf8 evaluator/run_public_tests.py`))
  sessionEvent(session, verifyResult(1, 1, FAIL_TEXT))
  const row = await summaryOf('pg-q1p2c')
  check('Q1p2 反向：模板埋过深（>4 层）⇒ 不绑', (!row.artifactBinding), JSON.stringify(row.artifactBinding))
}
await boot({ deliveryArtifactStateGate: true })
{
  // 跳过目录：node_modules 里的模板不算
  const fix = mkdtempSync(join(tmpdir(), 'pg-q1p2d-'))
  const nm = join(fix, 'node_modules', 'x')
  mkdirSync(nm, { recursive: true })
  writeFileSync(join(nm, 'PULL_REQUEST_TEMPLATE.md'), '# vendored\n')
  const { session } = makeAgent('pg-q1p2d')
  sessionEvent(session, verifyCall(1, 1, `cd '${fix}'; python -X utf8 evaluator/run_public_tests.py`))
  sessionEvent(session, verifyResult(1, 1, FAIL_TEXT))
  const row = await summaryOf('pg-q1p2d')
  check('Q1p2 反向：node_modules 里的模板 ⇒ 不绑', (!row.artifactBinding), JSON.stringify(row.artifactBinding))
}
await boot({ deliveryArtifactStateGate: true })
{
  // 最浅命中优先：根有模板、深层也有 ⇒ 绑根的
  const fix = mkdtempSync(join(tmpdir(), 'pg-q1p2e-'))
  const rootArt = join(fix, 'PULL_REQUEST_TEMPLATE.md')
  writeFileSync(rootArt, '# root\n')
  const sub = join(fix, 'workspace', 'project2_task')
  mkdirSync(sub, { recursive: true })
  writeFileSync(join(sub, 'PULL_REQUEST_TEMPLATE.md'), '# sub\n')
  const { session } = makeAgent('pg-q1p2e')
  sessionEvent(session, verifyCall(1, 1, `cd '${fix}'; python -X utf8 evaluator/run_public_tests.py`))
  sessionEvent(session, verifyResult(1, 1, FAIL_TEXT))
  const row = await summaryOf('pg-q1p2e')
  check('Q1p2 开：多个候选时最浅命中优先', row.artifactBinding && row.artifactBinding.path === rootArt, JSON.stringify(row.artifactBinding))
}
// ── Q1''' 会话 cwd 捕获 + workdir 定位（§49.5 探针结论的修法）────────────────
await boot({ deliveryArtifactStateGate: true })
{
  // 探针 m1q-1 场景：子代理的会话 cwd = 其 run workspace，验证命令纯相对路径
  // （artifacts 为空）——捕获 session.header.cwd 后，相对路径与 cwd 都能指认工件。
  const fix = mkdtempSync(join(tmpdir(), 'pg-q1p3-'))
  const ws = join(fix, 'workspace')
  const pt = join(ws, 'project2_task')
  mkdirSync(pt, { recursive: true })
  const art = join(pt, 'PULL_REQUEST_TEMPLATE.md')
  writeFileSync(art, '# seed\n')
  const sid = 'pg-q1p3'
  const agent = { id: sid, session: { id: sid, events: [], header: { cwd: ws } }, ctx: { tools: { schemas: () => [], restrict: () => () => {} } } }
  agentsById.set(sid, agent)
  dispatch('agent/created', { agent })
  const session = { id: sid }
  sessionEvent(session, verifyCall(1, 1, 'python tests/run_public_tests.py project2_task'))
  sessionEvent(session, verifyResult(1, 1, FAIL_TEXT))
  const row = await summaryOf(sid)
  check('Q1p3 开：会话 cwd 捕获 + 纯相对路径验证 ⇒ 绑定（探针 m1q-1 场景）',
    row.artifactBinding && row.artifactBinding.path === art, JSON.stringify(row.artifactBinding))
}
await boot({ deliveryArtifactStateGate: true })
{
  // workdir 参数是比 cwd 更精确的定位线索：直接指认工件目录。
  const fix = mkdtempSync(join(tmpdir(), 'pg-q1p3b-'))
  const pt = join(fix, 'project2_task')
  mkdirSync(pt, { recursive: true })
  const art = join(pt, 'PULL_REQUEST_TEMPLATE.md')
  writeFileSync(art, '# seed\n')
  const { session } = makeAgent('pg-q1p3b')
  sessionEvent(session, { type: 'tool/call', data: { turn: 1, step: 1, name: 'pwsh', arguments: JSON.stringify({ command: 'python tests/run_public_tests.py project2_task', workdir: fix }) } })
  sessionEvent(session, verifyResult(1, 1, FAIL_TEXT))
  const row = await summaryOf('pg-q1p3b')
  check('Q1p3 开：验证调用的 workdir 参数 ⇒ 绑定', row.artifactBinding && row.artifactBinding.path === art, JSON.stringify(row.artifactBinding))
}
// ── Q2' 文件状态编辑计数（process-gate §6b）────────────────────────────────
await boot({ fileStateHoldEvery: 2 })
{
  // 脚本通道改动（无工具事件）也会让文件状态变化 ⇒ 差分可见——Q2 盲区的修法。
  const fix = mkdtempSync(join(tmpdir(), 'pg-q2p-'))
  const a = join(fix, 'a.py')
  const b = join(fix, 'b.py')
  writeFileSync(a, '# a v1\n')
  writeFileSync(b, '# b v1\n')
  const { session } = makeAgent('pg-q2p')
  sessionEvent(session, verifyCall(1, 1, `cd '${fix}'; python -X utf8 evaluator/run_public_tests.py`))
  sessionEvent(session, verifyResult(1, 1, FAIL_TEXT))
  const row0 = await summaryOf('pg-q2p')
  check('Q2p 开：验证落地 ⇒ 代码文件快照绑定（≥2 文件）',
    row0.fileStateBinding && row0.fileStateBinding.boundFiles >= 2, JSON.stringify(row0.fileStateBinding))
  // 脚本通道改 1 个文件：1 < K=2 ⇒ 不注
  writeFileSync(a, '# a v2 changed\n')
  const out1 = await preStep('pg-q2p', 1, 2)
  const held1 = (out1 && out1.messages || []).some((m) => m.source && m.source.kind === 'trajectory-anchor-file-state-hold')
  check('Q2p 反向：改动 1 个 < K=2 ⇒ 不注', held1 === false,
    JSON.stringify((out1 && out1.messages || []).map((m) => m.source && m.source.kind)))
  // 再改 1 个：2 ≥ K ⇒ 注保持
  writeFileSync(b, '# b v2 changed\n')
  const out2 = await preStep('pg-q2p', 1, 3)
  const held2 = (out2 && out2.messages || []).some((m) => m.source && m.source.kind === 'trajectory-anchor-file-state-hold')
  check('Q2p 开：脚本通道改 2 个 ≥ K ⇒ 注入保持（Q2 盲区修法）', held2 === true,
    JSON.stringify((out2 && out2.messages || []).map((m) => m.source && m.source.kind)))
  const row1 = await summaryOf('pg-q2p')
  check('Q2p 开：审计与状态可见（served=true）',
    row1.fileStateBinding && row1.fileStateBinding.served === true, JSON.stringify(row1.fileStateBinding))
  const out2b = await preStep('pg-q2p', 1, 4)
  const held2b = (out2b && out2b.messages || []).some((m) => m.source && m.source.kind === 'trajectory-anchor-file-state-hold')
  check('Q2p 开：**每次快照期只注一次**', held2b === false,
    JSON.stringify((out2b && out2b.messages || []).map((m) => m.source && m.source.kind)))
  // 重验 ⇒ 重新快照 ⇒ 解除；此后改动从零再计。
  sessionEvent(session, verifyCall(1, 5, `cd '${fix}'; python -X utf8 evaluator/run_public_tests.py`))
  sessionEvent(session, verifyResult(1, 5, FAIL_TEXT))
  const row2 = await summaryOf('pg-q2p')
  check('Q2p 开：重验 ⇒ 重新快照（解除，served=false、绑定步进到 5）',
    row2.fileStateBinding && row2.fileStateBinding.served === false && row2.fileStateBinding.boundStep === 5,
    JSON.stringify(row2.fileStateBinding))
  const out3 = await preStep('pg-q2p', 1, 6)
  const held3 = (out3 && out3.messages || []).some((m) => m.source && m.source.kind === 'trajectory-anchor-file-state-hold')
  check('Q2p 反向：重验后未再改 ⇒ 不注', held3 === false,
    JSON.stringify((out3 && out3.messages || []).map((m) => m.source && m.source.kind)))
}
await boot({ fileStateHoldEvery: 0 })
{
  const fix = mkdtempSync(join(tmpdir(), 'pg-q2p-off-'))
  writeFileSync(join(fix, 'a.py'), '# a\n')
  const { session } = makeAgent('pg-q2p-off')
  sessionEvent(session, verifyCall(1, 1, `cd '${fix}'; python -X utf8 evaluator/run_public_tests.py`))
  sessionEvent(session, verifyResult(1, 1, FAIL_TEXT))
  const row = await summaryOf('pg-q2p-off')
  check('Q2p 反向：默认关 ⇒ 不绑不注', (!row.fileStateBinding), JSON.stringify(row.fileStateBinding))
}
await boot({ fileStateHoldEvery: 1 })
{
  // 会话 cwd 不做走查根：绑定只来自验证命令目录（cwd=父工作区会把别的项目文件收进快照）。
  const fix = mkdtempSync(join(tmpdir(), 'pg-q2p-cwd-'))
  const other = mkdtempSync(join(tmpdir(), 'pg-q2p-other-'))
  writeFileSync(join(fix, 'a.py'), '# a\n')
  writeFileSync(join(other, 'unrelated.py'), '# x\n')
  const sid = 'pg-q2p-cwd'
  const agent = { id: sid, session: { id: sid, events: [], header: { cwd: other } }, ctx: { tools: { schemas: () => [], restrict: () => () => {} } } }
  agentsById.set(sid, agent)
  dispatch('agent/created', { agent })
  const session = { id: sid }
  sessionEvent(session, verifyCall(1, 1, `cd '${fix}'; python -X utf8 evaluator/run_public_tests.py`))
  sessionEvent(session, verifyResult(1, 1, FAIL_TEXT))
  const row = await summaryOf(sid)
  const files = row.fileStateBinding ? row.fileStateBinding.boundFiles : 0
  check('Q2p 开：快照不含会话 cwd 树（只含验证命令目录）', row.fileStateBinding && files === 1, JSON.stringify(row.fileStateBinding))
}
{
  // 纯函数负向对照：状态变化三轴（sha/size/mtime）各自触发、fail-open、删除 vs 读失败。
  const b = { path: '/x/PULL_REQUEST_TEMPLATE.md', sha: 'a'.repeat(64), size: 10, mtimeMs: 1000, turn: 1, step: 1, failed: false, failCount: null, verifyCmd: 'python evaluator/run_public_tests.py' }
  const same = { exists: true, sha: 'a'.repeat(64), size: 10, mtimeMs: 1000 }
  check('Q1p 纯：无绑定 ⇒ 不拒', artifactStateFacts({}).refuse === false && artifactStateFacts({}).reason === 'no-binding')
  check('Q1p 纯：状态快照缺失 ⇒ fail-open', artifactStateFacts({ binding: b, current: null }).refuse === false && artifactStateFacts({ binding: b, current: null }).reason === 'state-unavailable')
  check('Q1p 纯：sha 变 ⇒ 拒', artifactStateFacts({ binding: b, current: { ...same, sha: 'b'.repeat(64) } }).refuse === true)
  check('Q1p 纯：size 变 ⇒ 拒', artifactStateFacts({ binding: b, current: { ...same, size: 11 } }).refuse === true)
  check('Q1p 纯：mtime 变 ⇒ 拒', artifactStateFacts({ binding: b, current: { ...same, mtimeMs: 2000 } }).refuse === true)
  check('Q1p 纯：三轴全同 ⇒ 不拒', artifactStateFacts({ binding: b, current: same }).refuse === false && artifactStateFacts({ binding: b, current: same }).reason === 'fresh-and-green')
  check('Q1p 纯：ENOENT（被删）⇒ 拒', artifactStateFacts({ binding: b, current: { exists: false, missing: true } }).refuse === true && artifactStateFacts({ binding: b, current: { exists: false, missing: true } }).reason === 'artifact-removed')
  check('Q1p 纯：非 ENOENT 读失败 ⇒ fail-open', artifactStateFacts({ binding: b, current: { exists: false, missing: false } }).refuse === false && artifactStateFacts({ binding: b, current: { exists: false, missing: false } }).reason === 'state-unavailable')
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
