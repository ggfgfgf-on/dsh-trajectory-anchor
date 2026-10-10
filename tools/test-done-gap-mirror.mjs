/**
 * test-done-gap-mirror.mjs -- the read-only "delivery gap mirror" intervention.
 *
 * Theory (ablation-log §28): the weak model's measured failure mode on the real task is NOT
 * "doesn't verify" (it verifies constantly, so L1 barely fires) and NOT "forgot its persona"
 * (L2' re-anchors that). It is "declares done while its OWN last verification still shows N
 * failures". The intervention that should therefore bite: at claim time, mirror that evidence back.
 *
 * Both directions, the one-shot guarantee, and the two "must not fire" controls.
 * Usage: node tools/test-done-gap-mirror.mjs [path/to/index.js]
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
    on: (name, fn) => { handlers[name] = fn; return () => {} },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  }
  await mod.apply(ctx, { adaptiveStateEnabled: false, ...config })
}
const dispatch = (name, ...args) => handlers['internal/dispatch']('x', name, args, null)
const sessionEvent = (session, event) => dispatch('session/event', session, event)
const summaryOf = async (sid) => (await registered.anchor_status.execute({})).rows.find((r) => r.sessionId === sid)

const FAIL_TEXT = '[hidden] failed=21 errors=0 passed=24/45\nFAIL: test_voice_bridge\nFAIL: test_context_policy\n'
const PASS_TEXT = '[hidden] failed=0 errors=0 passed=45/45\n'
const verifyCall = (turn, step) => ({ type: 'tool/call', data: { turn, step, name: 'pwsh', arguments: 'python tests/run_hidden_tests.py' } })
const verifyResult = (turn, step, out) => ({ type: 'tool/result', data: { turn, step, message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: out }] }] } } })
const doneEvent = (turn, step) => ({ type: 'assistant/message', data: { turn, step, message: { content: [{ type: 'text', text: 'The task is done, all checks pass.' }] } } })

function makeAgent(sid) {
  const agent = { id: sid, session: { id: sid, events: [] }, ctx: { tools: { schemas: () => [], restrict: () => () => {} } } }
  agentsById.set(sid, agent)
  dispatch('agent/created', { agent })
  return { agent, session: { id: sid } }
}
const assemble = async (sid) => (await handlers['system-prompt/assemble']({ sections: [], contexts: [], tools: [], variables: {} }, { agent: { id: sid } }, async (o) => o))
const gapSection = (out) => (out.sections || []).find((s) => s.name === 'trajectory-anchor:done-gap')

// ── ① 默认关 ──────────────────────────────────────────────────────────────
await boot({})
{
  const { session } = makeAgent('gap-off')
  sessionEvent(session, verifyCall(1, 1))
  sessionEvent(session, verifyResult(1, 1, FAIL_TEXT))
  sessionEvent(session, doneEvent(1, 2))
  const out = await assemble('gap-off')
  const row = await summaryOf('gap-off')
  check('① 默认关：宣告完成后没有缺口段', gapSection(out) === undefined, JSON.stringify((out.sections || []).map((s) => s.name)))
  check('① 默认关：也没有 done-gap-mirror 审计', !(row.auditKinds || []).includes('done-gap-mirror'), JSON.stringify(row.auditKinds))
}

// ── ② 开：验证仍有失败 + 宣告完成 ⇒ 一次性回放 ─────────────────────────────
await boot({ doneGapMirror: true })
{
  const { session } = makeAgent('gap-on')
  sessionEvent(session, verifyCall(1, 1))
  sessionEvent(session, verifyResult(1, 1, FAIL_TEXT))
  sessionEvent(session, doneEvent(1, 2))
  const out = await assemble('gap-on')
  const sec = gapSection(out)
  const row = await summaryOf('gap-on')
  check('② 开：组装里有缺口段', sec !== undefined, JSON.stringify((out.sections || []).map((s) => s.name)))
  check('② 开：段里回放的是**失败条数**与证据尾段（不是 persona）',
    sec && /21 failures/.test(sec.text) && /test_voice_bridge/.test(sec.text), sec && sec.text.slice(0, 150))
  check('② 开：留 done-gap-mirror 审计且状态可见（failCount=21）',
    Array.isArray(row.auditKinds) && row.auditKinds.includes('done-gap-mirror') && row.doneGapMirror && row.doneGapMirror.failCount === 21,
    JSON.stringify(row.doneGapMirror))
  const out2 = await assemble('gap-on')
  check('② 开：**只注入一次**', gapSection(out2) === undefined, JSON.stringify((out2.sections || []).map((s) => s.name)))
}

// ── ③ 反向：最近一次验证**通过** + 宣告 ⇒ 不注入 ───────────────────────────
await boot({ doneGapMirror: true })
{
  const { session } = makeAgent('gap-pass')
  sessionEvent(session, verifyCall(1, 1))
  sessionEvent(session, verifyResult(1, 1, PASS_TEXT))
  sessionEvent(session, doneEvent(1, 2))
  const out = await assemble('gap-pass')
  check('③ 反向：验证已全绿就不注入', gapSection(out) === undefined, JSON.stringify((out.sections || []).map((s) => s.name)))
}

// ── ④ 反向：有失败证据但**没宣告完成** ⇒ 不注入 ────────────────────────────
await boot({ doneGapMirror: true })
{
  const { session } = makeAgent('gap-noclaim')
  sessionEvent(session, verifyCall(1, 1))
  sessionEvent(session, verifyResult(1, 1, FAIL_TEXT))
  const out = await assemble('gap-noclaim')
  check('④ 反向：没宣告完成就不注入', gapSection(out) === undefined, JSON.stringify((out.sections || []).map((s) => s.name)))
}

console.log(`\n${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
