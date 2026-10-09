/**
 * test-reanchor-confirm.mjs —— L2'「确认即恢复」的机制与闸门测试
 *
 * 这条路径的定位（必须写清，否则后人会以为 L2 的门被放宽了）：
 *   · **原 L2（证据路径）** 回答"拉回**有没有用**"，仍然要求在线效果件 `PASS-online`——**没动**；
 *   · **L2'（确认路径）** 回答"**已经确认出问题了**，把已知有效的首轮载荷放回去"。
 *     它不预测未来，前提是**当场确认**（用户纠正 / 工具不存在 / 验证未通过），
 *     载荷是信息型的（不改工具面、不改系统基线、不删信息）⇒ 与 L1 同一风险类别。
 *
 * 断言口径（每条正向都配反向对照）：
 *   ① 默认关 ⇒ 有确认信号也不重锚定；② 三种确认信号各自都能触发；
 *   ③ 反向对照：没有确认信号 ⇒ 不重锚定；④ measurementSafe / autoDemote 优先；
 *   ⑤ 每会话一次；⑥ **原证据路径的严格性不受影响**（无效果件 ⇒ 证据路径仍不开门）；
 *   ⑦ 随机化对照：故意不恢复时仍记账（action=reanchor）；
 *   ⑧ 留痕与可见性：confirm-signal / reanchor / reanchor-control 审计 + 状态块。
 *
 * 用法：node tools/test-reanchor-confirm.mjs [index.js 路径]
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'

const here = fileURLToPath(new URL('.', import.meta.url))
const target = resolve(here, process.argv[2] || '../index.js')
const mod = await import(pathToFileURL(target).href)

let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ': ' + detail}`)
}

const dir = mkdtempSync(join(tmpdir(), 'reanchor-confirm-'))
const OUT = join(dir, 'outcomes.jsonl')
const TOOLS = ['pwsh', 'read', 'edit'].map((n) => ({ name: n }))
const text = (s) => ({ type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: s }] } } })
const userText = (s, turn = 2, step = 1) => ({ type: 'user/message', data: { source: { kind: 'user' }, turn, step, content: [{ type: 'text', text: s }] } })
const human = (s) => ({ type: 'user/message', data: { source: { kind: 'user' }, role: 'user', content: [{ type: 'text', text: s }] } })
const callOf = (name, args, turn, step, callId) => ({ type: 'tool/call', data: { name, arguments: JSON.stringify(args), turn, step, callId } })
const resultOf = (turn, step, callId, { failed = false, text: t = 'ok' } = {}) => ({
  type: 'tool/result',
  data: {
    turn, step, callId,
    message: {
      source: { kind: 'tool', callId },
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: t }], isError: failed }],
    },
    ...(failed ? { error: { name: 'ToolError', code: 'UNKNOWN_TOOL' } } : {}),
  },
})

let handlers = {}
let registered = {}
const agents = new Map()
const warnings = []
const origWarn = console.warn
console.warn = (...a) => { warnings.push(a.join(' ')) }

async function boot(config) {
  handlers = {}
  registered = {}
  agents.clear()
  warnings.length = 0
  const ctx = {
    get: (n) => {
      if (n === 'tools') return { register: (t) => { registered[t.name] = t; return () => {} } }
      if (n === 'agents') return { get: (id) => agents.get(id), list: () => [...agents.values()] }
      return undefined
    },
    on: (n, fn) => { handlers[n] = fn; return () => {} },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  }
  await mod.apply(ctx, { adaptiveStateEnabled: false, pullbackOutcomePath: OUT, ...config })
}
const dispatch = (name, ...args) => handlers['internal/dispatch']('x', name, args, null)
const sessionEvent = (session, event) => dispatch('session/event', session, event)

function adopt(sid) {
  const agent = { id: sid, session: { id: sid, events: [] }, ctx: { tools: { schemas: () => TOOLS.map((t) => ({ ...t })), restrict: () => () => {} } } }
  agents.set(sid, agent)
  dispatch('agent/created', { agent })
  return { agent, session: { id: sid } }
}
const statusOf = async () => registered.anchor_status.execute({})
const rowOf = async (sid) => (await statusOf()).rows.find((r) => r.sessionId === sid)
const preStep = async (agent, turn, step, messages = []) =>
  handlers['agent/pre-step']({ agent, turn, step, messages: [] }, async () => ({ kind: 'continue', messages: [...messages] }))
const reAnchors = (d) => (d && Array.isArray(d.messages) ? d.messages : []).filter((m) => m && m.source && m.source.kind === 'trajectory-anchor-reanchor')
const textOf = (m) => (m && Array.isArray(m.content) ? m.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('') : '')
const rowsFor = (sid) => (existsSync(OUT) ? readFileSync(OUT, 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean).filter((r) => r.sessionId === sid) : [])

/** 建一个会话：首条人类消息（任务陈述）+ 一次工具调用（武装门）——之后由用例注入确认信号。 */
function base(sid) {
  const { agent, session } = adopt(sid)
  sessionEvent(session, human('Fix the tests in bugfix-a4 and report PASS=<n>/7'))
  sessionEvent(session, callOf('pwsh', { command: 'ls' }, 1, 1, 'c0'))
  return { agent, session }
}

// ── ① 默认关：有确认信号也不重锚定 ─────────────────────────────────────────
await boot({ reanchorOnConfirm: false })
{
  const { agent, session } = base('rc-off')
  sessionEvent(session, userText('不对，你改错文件了'))
  const d = await preStep(agent, 3, 1)
  check('① 默认关 ⇒ 有确认信号也不重锚定（不许默认放行）', reAnchors(d).length === 0, `n=${reAnchors(d).length}`)
  const row = await rowOf('rc-off')
  check('① 确认信号仍然被记录（看得见，只是不动手）', row.reanchor.confirm && row.reanchor.confirm.reason === 'user-correction',
    JSON.stringify(row.reanchor.confirm))
  check('① 状态里 onConfirm=false、confirmAllowed=false',
    row.reanchor.onConfirm === false && row.reanchor.confirmAllowed === false,
    JSON.stringify({ on: row.reanchor.onConfirm, allowed: row.reanchor.confirmAllowed }))
}

// ── ② 三种确认信号各自能触发 ───────────────────────────────────────────────
await boot({ reanchorOnConfirm: true, bootstrapPersona: 'PERSONA-XYZ' })
{
  const { agent, session } = base('rc-user')
  sessionEvent(session, userText('不对，这不是我要的'))
  const d = await preStep(agent, 3, 1)
  const items = reAnchors(d)
  check('② user-correction ⇒ 重锚定一次', items.length === 1, `n=${items.length}`)
  check('② 载荷含首轮 persona（原样带回，不发明新指令）', textOf(items[0] || {}).includes('PERSONA-XYZ'), textOf(items[0] || {}).slice(0, 70))
  check('② 文本写明是哪个确认信号（可追溯为什么恢复）', /确认信号/.test(textOf(items[0] || {})) && /人类指出不对/.test(textOf(items[0] || {})), textOf(items[0] || {}).slice(0, 90))
  const row = await rowOf('rc-user')
  check('② 留痕：confirm-signal + reanchor，且 via=confirm', row.auditTail.includes('reanchor') && row.reanchor.count === 1,
    JSON.stringify({ t: row.auditTail.slice(-5), c: row.reanchor.count }))
}
{
  const { agent, session } = base('rc-unknown')
  sessionEvent(session, callOf('pwsh', { command: 'x' }, 2, 1, 'u1'))
  sessionEvent(session, resultOf(2, 1, 'u1', { failed: true, text: 'Error: unknown tool "anchor_status"' }))
  const d = await preStep(agent, 3, 1)
  check('② unknown-tool ⇒ 重锚定', reAnchors(d).length === 1, `n=${reAnchors(d).length}`)
  const row = await rowOf('rc-unknown')
  check('② 记的是 unknown-tool 这个原因', row.reanchor.confirm.reason === 'unknown-tool', JSON.stringify(row.reanchor.confirm))
}
{
  // verify-failed 的**反向对照**：验证失败但**还没宣告完成** ⇒ 不算确认。
  // 为什么（2026-10-09 线上真实误触发）：红色测试是**正常工作状态**（跑红的 → 改 → 再跑），
  // 第一版把"验证失败"直接当确认 ⇒ 我跑一次**故意红**的基准夹具就把重锚定触发了。
  const { agent, session } = base('rc-verifyred')
  sessionEvent(session, callOf('pwsh', { command: 'node tools/test-x.mjs' }, 2, 1, 'v0'))
  sessionEvent(session, resultOf(2, 1, 'v0', { text: '2 failed\n[exit code: 1]' }))
  const d = await preStep(agent, 3, 1)
  check('② 反向对照：验证失败但**未宣告完成** ⇒ 不算确认（红色测试是正常工作状态）', reAnchors(d).length === 0, `n=${reAnchors(d).length}`)
  const row0 = await rowOf('rc-verifyred')
  check('② 拒绝有痕（confirm-declined）', row0.auditTail.includes('confirm-declined'), JSON.stringify(row0.auditTail.slice(-3)))
}
{
  // verify-failed 的**正向**：先宣告完成，**之后**验证仍失败 ⇒ 才算确认出问题
  const { agent, session } = base('rc-verifyfail')
  sessionEvent(session, { type: 'assistant/message', data: { turn: 2, step: 2, message: { content: [{ type: 'text', text: 'Done — all bugs fixed and all tests pass.' }] } } })
  sessionEvent(session, callOf('pwsh', { command: 'node tools/test-x.mjs' }, 3, 1, 'v1'))
  sessionEvent(session, resultOf(3, 1, 'v1', { text: '2 failed\n[exit code: 1]' }))
  const d = await preStep(agent, 4, 1)
  check('② 宣告完成之后验证仍失败 ⇒ 重锚定（这才叫"确认出问题"）', reAnchors(d).length === 1, `n=${reAnchors(d).length}`)
  const row = await rowOf('rc-verifyfail')
  check('② 记的是 verify-failed，并带上"在哪一步宣告的"',
    row.reanchor.confirm && row.reanchor.confirm.reason === 'verify-failed' && /claimed@/.test(String(row.reanchor.confirm.detail || '')),
    JSON.stringify(row.reanchor.confirm))
}

// ── ③ 反向对照：没有确认信号 ⇒ 不重锚定 ───────────────────────────────────
await boot({ reanchorOnConfirm: true })
{
  const { agent, session } = base('rc-none')
  sessionEvent(session, userText('好的，继续'))       // 不是纠偏
  const d = await preStep(agent, 3, 1)
  check('③ 反向对照：没有确认信号 ⇒ 不重锚定（开关开着也不动）', reAnchors(d).length === 0, `n=${reAnchors(d).length}`)
  const row = await rowOf('rc-none')
  check('③ 抑制计数写明原因是"没有确认信号"', row.reanchor.suppressed.noConfirmation >= 1, JSON.stringify(row.reanchor.suppressed))
}
{
  // 反向对照：**首条人类消息**里的纠偏字样不算确认（那是任务陈述）
  const { agent, session } = adopt('rc-firstmsg')
  sessionEvent(session, human('这个函数写得不对，请修复它：文件 a.py'))
  sessionEvent(session, callOf('pwsh', { command: 'ls' }, 1, 1, 'c0'))
  const d = await preStep(agent, 3, 1)
  check('③ 反向对照：首条消息（任务陈述）里的"不对"不算确认信号', reAnchors(d).length === 0, `n=${reAnchors(d).length}`)
}

// ── ④ measurementSafe / autoDemote 优先 ────────────────────────────────────
await boot({ reanchorOnConfirm: true, measurementSafe: true })
{
  const { agent, session } = base('rc-safe')
  sessionEvent(session, userText('不对，重做'))
  const d = await preStep(agent, 3, 1)
  check('④ 反向对照：measurementSafe ⇒ 确认路径也让位', reAnchors(d).length === 0, `n=${reAnchors(d).length}`)
  const row = await rowOf('rc-safe')
  check('④ 状态写明 confirmAllowed=false', row.reanchor.confirmAllowed === false, JSON.stringify(row.reanchor.confirmAllowed))
}

// ── ⑤ 每会话一次 ───────────────────────────────────────────────────────────
await boot({ reanchorOnConfirm: true })
{
  const { agent, session } = base('rc-once')
  sessionEvent(session, userText('不对，重做'))
  const d1 = await preStep(agent, 3, 1)
  sessionEvent(session, userText('还是不对'))
  const d2 = await preStep(agent, 4, 1)
  check('⑤ 每会话只重锚定一次', reAnchors(d1).length === 1 && reAnchors(d2).length === 0,
    JSON.stringify({ first: reAnchors(d1).length, second: reAnchors(d2).length }))
  const row = await rowOf('rc-once')
  check('⑤ 抑制计数写明 alreadyDone', row.reanchor.suppressed.alreadyDone >= 1, JSON.stringify(row.reanchor.suppressed))
}

// ── ⑥ 原证据路径的严格性不受影响 ───────────────────────────────────────────
await boot({ reanchorOnConfirm: false, reanchorEnabled: true, reanchorEvidencePath: null })
{
  const { agent, session } = base('rc-evidence-strict')
  sessionEvent(session, userText('不对，重做'))
  const d = await preStep(agent, 3, 1)
  check('⑥ 反向对照：**确认路径关着**时，即使有确认信号、开关也开着，缺名义仍不开门（证据路径没被悄悄放宽）',
    reAnchors(d).length === 0, `n=${reAnchors(d).length}`)
  const s = await statusOf()
  check('⑥ 门的理由仍写明缺证据', s.reanchorGate === 'no-online-evidence', String(s.reanchorGate))
}
{
  // 正向对照：同一条会话**确认路径开着**时才开门 ⇒ 差别只来自确认路径的存在
  await boot({ reanchorOnConfirm: true, reanchorEnabled: true, reanchorEvidencePath: null })
  const { agent, session } = base('rc-evidence-vs-confirm')
  sessionEvent(session, userText('不对，重做'))
  const d = await preStep(agent, 3, 1)
  check('⑥ 正向对照：确认路径开着时同一序列才重锚定（差别只来自这条路径）', reAnchors(d).length === 1, `n=${reAnchors(d).length}`)
}

// ── ⑦ 随机化对照：故意不恢复时仍记账 ───────────────────────────────────────
await boot({ reanchorOnConfirm: true, reanchorConfirmControlRate: 1 })
{
  const { agent, session } = base('rc-control')
  sessionEvent(session, userText('不对，重做'))
  const d = await preStep(agent, 3, 1)
  check('⑦ 对照臂：确认成立但按比例故意不恢复（不注入）', reAnchors(d).length === 0, `n=${reAnchors(d).length}`)
  const row = await rowOf('rc-control')
  check('⑦ 审计留痕 reanchor-control', row.auditTail.includes('reanchor-control'), JSON.stringify(row.auditTail.slice(-4)))
  dispatch('agent/disposed', { agent })
  const rows = rowsFor('rc-control')
  check('⑦ 落盘一行 action=reanchor / arm=control（效果照样可估）',
    rows.length === 1 && rows[0].action === 'reanchor' && rows[0].arm === 'control',
    JSON.stringify(rows.map((r) => ({ a: r.action, arm: r.arm, why: r.reason }))))
}
{
  await boot({ reanchorOnConfirm: true, reanchorConfirmControlRate: 0 })
  const { agent, session } = base('rc-intervened')
  sessionEvent(session, userText('不对，重做'))
  await preStep(agent, 3, 1)
  dispatch('agent/disposed', { agent })
  const rows = rowsFor('rc-intervened')
  check('⑦ 干预臂落盘 action=reanchor / arm=intervened，且 reason 带确认原因',
    rows.length === 1 && rows[0].action === 'reanchor' && rows[0].arm === 'intervened' && /confirm-user-correction/.test(String(rows[0].reason)),
    JSON.stringify(rows.map((r) => ({ a: r.action, arm: r.arm, why: r.reason }))))
}
{
  // ⑦c 反向对照：**只开确认路径、L1 关着**时也必须记账（可测性跟着执行器走，而不是跟着 L1 开关）
  await boot({ reanchorOnConfirm: true, pullbackEnabled: false })
  const { agent, session } = base('rc-only-confirm')
  sessionEvent(session, userText('不对，重做'))
  await preStep(agent, 3, 1)
  dispatch('agent/disposed', { agent })
  const rows = rowsFor('rc-only-confirm')
  check('⑦c 只开确认路径（L1 关）⇒ 它的效果照样被记账',
    rows.length === 1 && rows[0].action === 'reanchor', JSON.stringify(rows.map((r) => ({ a: r.action, arm: r.arm }))))
}

console.warn = origWarn
console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
