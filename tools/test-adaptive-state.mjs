/**
 * test-adaptive-state.mjs —— 累积状态（记忆）的持久化测试
 *
 * 这一层要证明的是**记忆真的跨挂载活着**，同时**不与派生状态混为一谈**：
 *   ① 默认全关时**不产生任何文件**（负向：不许凭空写盘）；
 *   ② 有自适应事件 ⇒ 落盘一条/会话；**重新挂载**（模拟重启）⇒ 计数与降档窗口恢复；
 *   ③ 装载后**立即重算降档**：窗口内已超标 ⇒ 挂载即只观察（而不是等下一个会话）；
 *   ④ **工作点变了就作废倍率**（基准 α 不匹配）：计数保留、倍率丢弃 + 响亮告警；
 *   ⑤ 坏/空/不存在 ⇒ fail-safe（空记忆 + 告警，不阻断挂载）；
 *   ⑥ 有界：只装载最后 adaptiveStateWindow 条；
 *   ⑦ 反向守：**派生状态必须仍然每次重算**（标定件/先验/证据件不能靠装载"粘"下来）。
 *
 * 用法：node tools/test-adaptive-state.mjs [index.js 路径]
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
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

const dir = mkdtempSync(join(tmpdir(), 'adaptive-state-'))
const statePath = join(dir, 'adaptive-state.jsonl')
const TOOLS = ['pwsh', 'read', 'edit'].map((n) => ({ name: n }))
const warnings = []
const origWarn = console.warn

let handlers = {}
let registered = {}
const agents = new Map()
async function boot(config) {
  handlers = {}
  registered = {}
  agents.clear()
  warnings.length = 0
  console.warn = (...a) => warnings.push(a.join(' '))
  const ctx = {
    get: (n) => {
      if (n === 'tools') return { register: (t) => { registered[t.name] = t; return () => {} } }
      if (n === 'agents') return { get: (id) => agents.get(id), list: () => [...agents.values()] }
      return undefined
    },
    on: (n, fn) => { handlers[n] = fn; return () => {} },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  }
  await mod.apply(ctx, config)
}
const dispatch = (name, ...args) => handlers['internal/dispatch']('x', name, args, null)
const sessionEvent = (s, e) => dispatch('session/event', s, e)
const say = (turn, step) => ({ type: 'assistant/message', data: { turn, step, message: { content: [{ type: 'reasoning', text: 'We will inspect the repository and run the tests.' }] } } })
const statusOf = async () => registered.anchor_status.execute({})

/** 造一个会触发 repetition 通道并收窄的会话（参考段干净 + 窗内 2 次重复调用）。 */
function narrowedSession(sid) {
  const agent = { id: sid, session: { id: sid, events: [] }, ctx: { tools: { schemas: () => TOOLS.map((t) => ({ ...t })), restrict: () => () => {} } } }
  agents.set(sid, agent)
  dispatch('agent/created', { agent })
  const session = { id: sid }
  sessionEvent(session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Work only inside bugfix-a4. Run the tests (python test_calc.py).' }] } })
  let step = 0
  const rep = (s) => {
    sessionEvent(session, { type: 'tool/call', data: { turn: 1, step: s, name: 'pwsh', arguments: JSON.stringify({ command: 'same' }) } })
    sessionEvent(session, { type: 'tool/call', data: { turn: 1, step: s, name: 'pwsh', arguments: JSON.stringify({ command: 'same' }) } })
  }
  for (let i = 0; i < 25; i++) { step++; sessionEvent(session, say(1, step)) }
  for (let i = 0; i < 3; i++) { step++; sessionEvent(session, say(1, step)); if (i < 2) rep(step) }
  dispatch('agent/disposed', { agent })
}
/** 造一个"什么都没发生"的会话（不落盘）。 */
function quietSession(sid) {
  const agent = { id: sid, session: { id: sid, events: [] }, ctx: { tools: { schemas: () => TOOLS.map((t) => ({ ...t })), restrict: () => () => {} } } }
  agents.set(sid, agent)
  dispatch('agent/created', { agent })
  const session = { id: sid }
  sessionEvent(session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '随便聊聊' }] } })
  for (let s = 1; s <= 3; s++) sessionEvent(session, say(1, s))
  dispatch('agent/disposed', { agent })
}
const BASE = {
  rollbackEnabled: true,
  notifyEnabled: false,
  autoDemoteWindow: 0,          // 隔离：这一批用例只测持久化，不测降档（降档另有 ③）
  adaptiveStateEnabled: true,
  adaptiveStatePath: statePath,
  responseChannels: { lexicon: { enabled: false }, repetition: { enabled: true, refMinSteps: 20, testWindow: 3, actAlpha: 0.01, notifyAlpha: 0.5, capabilityEligible: true } },
}

// ── ① 默认全关：不产生文件（负向）────────────────────────────────────────────
await boot({ adaptiveStatePath: statePath })     // 全部自适应开关默认关
{
  quietSession('as-off-1')
  check('① 全关时不写任何文件（不许凭空写盘）', !existsSync(statePath), existsSync(statePath) ? 'file exists' : 'no file')
  const s = await statusOf()
  check('① 报告里 adaptiveState 存在且 records=0', s.adaptiveState && s.adaptiveState.records === 0, JSON.stringify(s.adaptiveState))
}

// ── ② 有事件 ⇒ 落盘；重新挂载 ⇒ 计数恢复 ─────────────────────────────────────
await boot({ ...BASE })
{
  narrowedSession('as-1')
  narrowedSession('as-2')
  const lines = readFileSync(statePath, 'utf8').trim().split('\n').filter(Boolean)
  check('② 两次收窄会话 ⇒ 落盘两条记录', lines.length === 2, `lines=${lines.length}`)
  const rec = JSON.parse(lines[0])
  check('② 记录里有 didNarrow / fires / baseAlpha / pluginVersion',
    rec.didNarrow === true && rec.fires && rec.fires.repetition >= 1 && Number.isFinite(rec.baseAlpha.repetition) && typeof rec.pluginVersion === 'string',
    JSON.stringify({ d: rec.didNarrow, f: rec.fires, b: rec.baseAlpha, v: rec.pluginVersion }))
}
await boot({ ...BASE })                          // ← 模拟重启：新的挂载
{
  const s = await statusOf()
  check('② 重新挂载后记忆被装载（records=2）', s.adaptiveState && s.adaptiveState.records === 2, JSON.stringify(s.adaptiveState))
  check('② 通道计数恢复（sessions=2）', s.channelFeedback?.repetition?.sessions === 2, JSON.stringify(s.channelFeedback))
  check('② 纪元恢复', s.feedbackEpoch === 2, String(s.feedbackEpoch))
  check('② 装载来源路径可见', s.adaptiveState.source === statePath, String(s.adaptiveState.source))
}

// ── ③ 装载后立即重算降档 ────────────────────────────────────────────────────
await boot({ ...BASE, autoDemoteWindow: 2, autoDemoteBudget: 0.05 })   // 窗口 2、预算 5%
{
  const s = await statusOf()
  check('③ 挂载即按恢复的窗口降档（不等下一个会话）',
    typeof s.autoDemote?.reason === 'string' && s.autoDemote.restored === true, JSON.stringify(s.autoDemote))
  check('③ 降档原因与预算可见', s.autoDemote.window === 2 && s.autoDemote.budget === 0.05, JSON.stringify(s.autoDemote))
  check('③ 卡口随之关闭', s.capabilityGate === 'auto-demoted:session-rate-over-budget', String(s.capabilityGate))
}

// ── ④ 工作点变了 ⇒ 作废倍率、保留计数（关键纪律）────────────────────────────
{
  // 先写一条"带倍率"的记录（α=0.01 下学的）
  await boot({ ...BASE })
  narrowedSession('as-mult')
  const s1 = await statusOf()
  const multiplier = s1.channelFeedback?.repetition?.multiplier ?? 1
  check('④ 前置：该通道有倍率记录（默认 1 也算记录）', typeof multiplier === 'number', String(multiplier))
  // 换工作点：把 repetition 的基准 α 改掉 ⇒ 装载时必须丢弃倍率
  await boot({
    ...BASE,
    responseChannels: { lexicon: { enabled: false }, repetition: { enabled: true, refMinSteps: 20, testWindow: 3, actAlpha: 0.002, notifyAlpha: 0.5, capabilityEligible: true } },
  })
  const s2 = await statusOf()
  check('④ 基准 α 变了 ⇒ 倍率被丢弃（multipliersDropped ≥ 1）', (s2.adaptiveState?.multipliersDropped ?? 0) >= 1, JSON.stringify(s2.adaptiveState))
  check('④ 但计数保留（sessions 不丢）', s2.channelFeedback?.repetition?.sessions >= 1, JSON.stringify(s2.channelFeedback))
  check('④ 丢弃有响亮告警（不许静默）', warnings.some((w) => /operating point changed/.test(w)), JSON.stringify(warnings.slice(0, 1)))
}

// ── ⑤ 坏文件 / 空文件 ⇒ fail-safe ───────────────────────────────────────────
{
  const bad = join(dir, 'bad.jsonl')
  writeFileSync(bad, 'not json\n{"didNarrow":true,"fires":{"repetition":1},"productive":true,"baseAlpha":{"repetition":0.01}}\n', 'utf8')
  await boot({ ...BASE, adaptiveStatePath: bad })
  const s = await statusOf()
  check('⑤ 坏行被跳过但好行仍装载', s.adaptiveState.records === 1 && s.adaptiveState.badLines === 1, JSON.stringify(s.adaptiveState))
  check('⑤ 坏行有告警', warnings.some((w) => /unreadable line/.test(w)), JSON.stringify(warnings.slice(0, 1)))
  const empty = join(dir, 'empty.jsonl')
  writeFileSync(empty, '', 'utf8')
  await boot({ ...BASE, adaptiveStatePath: empty })
  const s2 = await statusOf()
  check('⑤ 空文件 ⇒ 空记忆且不抛', s2.adaptiveState.records === 0, JSON.stringify(s2.adaptiveState))
}

// ── ⑥ 有界：只装载最后 window 条 ────────────────────────────────────────────
{
  const many = join(dir, 'many.jsonl')
  const rows = []
  for (let i = 0; i < 30; i++) rows.push(JSON.stringify({ storeVersion: 1, at: Date.now(), sessionId: `s${i}`, didNarrow: true, fires: { repetition: 1 }, productive: false, baseAlpha: { repetition: 0.01 } }))
  writeFileSync(many, rows.join('\n') + '\n', 'utf8')
  await boot({ ...BASE, adaptiveStatePath: many, adaptiveStateWindow: 10 })
  const s = await statusOf()
  check('⑥ 只装载最后 10 条（有界）', s.adaptiveState.records === 10, JSON.stringify(s.adaptiveState))
  check('⑥ 计数相应有界（sessions=10）', s.channelFeedback?.repetition?.sessions === 10, JSON.stringify(s.channelFeedback?.repetition))
}

// ── ⑧ 记账口径：只有"真的干预过"的会话才计入回灌 ─────────────────────────────
// 由来（自查发现的错配）：能力层关着时通道即便触发也什么都没发生，productive 必然 false；
// 若把这些会话计入回灌，门限会被无故一路收紧、最终撤销通道。两个口径必须分开：
//   · 降档窗口：**所有**会话（"动过手的比例"才有意义）
//   · 通道回灌：只有干预过的会话（"我的干预有没有帮助"才有意义）
{
  const mixed = join(dir, 'mixed.jsonl')
  const rows = []
  for (let i = 0; i < 6; i++) {
    rows.push(JSON.stringify({
      storeVersion: 1, at: Date.now(), sessionId: `m${i}`,
      didNarrow: i % 2 === 0,                 // 只有一半会话真的干预过
      fires: { repetition: 1 }, productive: true, baseAlpha: { repetition: 0.01 },
    }))
  }
  writeFileSync(mixed, rows.join('\n') + '\n', 'utf8')
  await boot({ ...BASE, adaptiveStatePath: mixed, autoDemoteWindow: 20 })
  const s = await statusOf()
  check('⑧ 只有"干预过"的 3 个会话计入回灌（不是 6 个）', s.channelFeedback?.repetition?.sessions === 3,
    JSON.stringify(s.channelFeedback?.repetition))
  check('⑧ 降档窗口仍看全部 6 个会话（两个口径各自正确）', s.sessionOutcomes.window === 6, JSON.stringify(s.sessionOutcomes))
}

// ── ⑦ 反向守：派生状态仍然每次重算（不许靠装载"粘"下来）────────────────────
{
  const policy = join(dir, 'policy.json')
  writeFileSync(policy, JSON.stringify({ verdict: 'FAIL', capabilityEligibleChannels: [] }), 'utf8')
  await boot({ ...BASE, responsePolicyPath: policy })
  const s1 = await statusOf()
  check('⑦ 标定件 FAIL ⇒ 派生状态为空（gate 拒绝）', s1.capabilityGate === 'policy-REJECTED', String(s1.capabilityGate))
  // 重新挂载但**不给**标定件 ⇒ 不许"记住"上一轮的 REJECTED（派生状态必须重算成 null）
  await boot({ ...BASE })
  const s2 = await statusOf()
  check('⑦ 去掉标定件后派生状态不再残留（policyArtifact 归 null）', s2.policyArtifact === null, JSON.stringify(s2.policyArtifact))
  check('⑦ 先验/证据件同理不残留', s2.familyPriors === null && s2.reanchorEvidence === null,
    JSON.stringify({ f: s2.familyPriors, e: s2.reanchorEvidence }))
}

console.warn = origWarn
try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略清理失败 */ }
console.log(`\n${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
