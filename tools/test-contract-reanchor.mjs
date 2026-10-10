/**
 * test-contract-reanchor.mjs -- the read-only "contract re-anchoring" feature.
 *
 * Gap it closes (ablation-log §23): the plugin locks the first-round tool surface and persona, but
 * NOT the first-round contract itself. When a later instruction conflicts with that contract, the
 * agent's behaviour is driven entirely by "which instruction is newest", and the plugin stays
 * silent. This feature re-injects the first instruction's summary (once, read-only, informational)
 * into the next assembled prompt after the agent claims completion, so it must re-check its work
 * against the original contract before finishing.
 *
 * Both directions, plus the one-shot guarantee and the two "must not fire" controls.
 * Usage: node tools/test-contract-reanchor.mjs [path/to/index.js]
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

const CONTRACT = 'Work ONLY inside `D:\\anchor-bench\\runs\\cf-x`.\nFix mod_core.py, mod_stats.py and mod_report.py so that ALL FOUR groups pass: A/B/C behaviour and D documentation (docstrings).\nDo not edit anything under tests/.'

const userEvent = (s) => ({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: s }] } })
const doneEvent = (turn, step) => ({ type: 'assistant/message', data: { turn, step, message: { content: [{ type: 'text', text: 'The task is done, all checks pass.' }] } } })

function makeAgent(sid) {
  const agent = { id: sid, session: { id: sid, events: [] }, ctx: { tools: { schemas: () => [], restrict: () => () => {} } } }
  agentsById.set(sid, agent)
  dispatch('agent/created', { agent })
  return { agent, session: { id: sid } }
}
const assemble = async (sid) => (await handlers['system-prompt/assemble']({ sections: [], contexts: [], tools: [], variables: {} }, { agent: { id: sid } }, async (o) => o))
const contractSection = (out) => (out.sections || []).find((s) => s.name === 'trajectory-anchor:contract')

// ── ① 默认关：宣告完成也不注入（与既有执行器同一纪律：先有验收证据再开）──────────
await boot({})
{
  const { session } = makeAgent('cr-off')
  sessionEvent(session, userEvent(CONTRACT))
  sessionEvent(session, doneEvent(1, 3))
  const out = await assemble('cr-off')
  const row = await summaryOf('cr-off')
  check('① 默认关：宣告完成后组装**没有**契约段', contractSection(out) === undefined, JSON.stringify((out.sections || []).map((s) => s.name)))
  check('① 默认关：也没有 contract-reanchor 审计', !(row.auditKinds || []).includes('contract-reanchor'), JSON.stringify(row.auditKinds))
}

// ── ② 开：宣告完成 ⇒ 一次性注入契约摘要 + 留痕 + 状态可见 ────────────────────────
await boot({ contractReanchor: true })
{
  const { session } = makeAgent('cr-on')
  sessionEvent(session, userEvent(CONTRACT))
  sessionEvent(session, doneEvent(1, 3))
  const out = await assemble('cr-on')
  const sec = contractSection(out)
  const row = await summaryOf('cr-on')
  check('② 开：组装里有契约段', sec !== undefined, JSON.stringify((out.sections || []).map((s) => s.name)))
  check('② 开：段文本包含原契约的内容（work-only 子句 + D 组要求）',
    sec && /ALL FOUR groups/.test(sec.text) && /documentation/.test(sec.text), sec && sec.text.slice(0, 120))
  check('② 开：留 contract-reanchor 审计', Array.isArray(row.auditKinds) && row.auditKinds.includes('contract-reanchor'), JSON.stringify(row.auditKinds))
  check('② 开：状态可见（served=true、位置可见）', row.contractReanchor && row.contractReanchor.served === true && row.contractReanchor.atTurn === 1,
    JSON.stringify(row.contractReanchor))
  const out2 = await assemble('cr-on')
  check('② 开：**只注入一次**（第二次组装没有契约段）', contractSection(out2) === undefined, JSON.stringify((out2.sections || []).map((s) => s.name)))
}

// ── ③ 反向：开，但**没有宣告完成** ⇒ 不注入 ─────────────────────────────────────
await boot({ contractReanchor: true })
{
  const { session } = makeAgent('cr-noclaim')
  sessionEvent(session, userEvent(CONTRACT))
  const out = await assemble('cr-noclaim')
  check('③ 反向：没宣告完成就没有契约段', contractSection(out) === undefined, JSON.stringify((out.sections || []).map((s) => s.name)))
}

// ── ④ 反向：开，但**没有首条人类消息**（契约缺失）⇒ 不注入（不猜、不编）──────────
await boot({ contractReanchor: true })
{
  const { session } = makeAgent('cr-nocontract')
  sessionEvent(session, doneEvent(1, 2))
  const out = await assemble('cr-nocontract')
  check('④ 反向：无契约文本就不注入', contractSection(out) === undefined, JSON.stringify((out.sections || []).map((s) => s.name)))
}

console.log(`\n${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
