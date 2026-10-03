/**
 * test-response-policy.mjs —— P1+P3+P4+P5+P6 的端到端契约回归（合成会话驱动真实 apply）
 *
 * 覆盖：
 *   1) 参考段不足 → insufficient-reference（不动手）
 *   2) 检验触发 + rollbackEnabled=true → 收窄；组装期工具面变窄且注入可见 notice（P4）
 *   3) rollbackEnabled=false → 同一偏离只通知、不动能力（P0 保守档语义）
 *   4) 词典退化（正桶从未命中）→ 只通知，禁止能力层（P5 闸门）
 *   5) maxDriftSteps 到顶 → 能力预算耗尽、工具面自动恢复、片段内不再收窄（P6 必然退出）
 *   6) 轨迹恢复 → 回到 stable（"归还"无调用）
 *
 * 用法：node tools/test-response-policy.mjs [index.js 路径]
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

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

const TOOLS = ['pwsh', 'read', 'edit', 'grep', 'browser_open', 'browser_type', 'vision_crop', 'todo_write'].map((n) => ({ name: n }))
const asm = () => ({ sections: [], contexts: [], tools: TOOLS.map((t) => ({ ...t })), variables: {} })
const text = (s) => ({ type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: s }] } } })

let handlers = {}
let registeredTools = {}
const agentsById = new Map()
let ctx
async function boot(config) {
  handlers = {}
  registeredTools = {}
  agentsById.clear()
  ctx = {
    get: (n) => {
      if (n === 'tools') return { register: (t) => { registeredTools[t.name] = t; return () => {} } }
      // stateMachine 只在 agent 可解析时推进（与真实运行时一致）——测试必须提供 agents 服务
      if (n === 'agents') return { get: (id) => agentsById.get(id), list: () => [...agentsById.values()] }
      return undefined
    },
    on: (name, fn) => { handlers[name] = fn; return () => {} },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  }
  await mod.apply(ctx, config)
}
const dispatch = (name, ...args) => handlers['internal/dispatch']('x', name, args, null)
const sessionEvent = (session, event) => dispatch('session/event', session, event)

/** 建一个被锚定 + 晋级的合成 agent；返回它的 session 与 agent。 */
async function adoptAndLift(sid) {
  const agent = {
    id: sid,
    session: { id: sid, events: [] },
    ctx: { tools: { schemas: () => TOOLS.map((t) => ({ name: t.name })), restrict: () => () => {} } },
  }
  agentsById.set(sid, agent)
  dispatch('agent/created', { agent })
  const session = { id: sid }
  // 第一次工具调用 → gate-armed
  sessionEvent(session, { type: 'tool/call', data: { name: 'pwsh', turn: 1, step: 1 } })
  // 一条 minimal-like 推理（含 we、无 let me）→ 提前放行
  sessionEvent(session, text('We will inspect the repository first, then we will run the tests.'))
  return { agent, session }
}

/** 不走"正词"路径的晋级：靠 maxBootstrapSteps 触发 max-steps 放行（用于词典退化场景）。 */
async function adoptAndLiftByRequests(sid, requests = 5) {
  const agent = {
    id: sid,
    session: { id: sid, events: [] },
    ctx: { tools: { schemas: () => TOOLS.map((t) => ({ name: t.name })), restrict: () => () => {} } },
  }
  agentsById.set(sid, agent)
  dispatch('agent/created', { agent })
  const session = { id: sid }
  for (let i = 0; i < requests; i++) dispatch('agent/request', { agent, turn: 1, step: i + 1 })
  return { agent, session }
}
const summaryOf = async (sid) => (await registeredTools.anchor_status.execute({})).rows.find((r) => r.sessionId === sid)

// ── 场景 A：参考段不足 ───────────────────────────────────────────────────
await boot({ rollbackEnabled: true })
{
  const { session } = await adoptAndLift('sess-A')
  for (let i = 0; i < 6; i++) sessionEvent(session, text('let me check the failing assertion once more'))
  const row = await summaryOf('sess-A')
  check('A: 参考段不足 → policy=stable / insufficient-reference',
    row.policy === 'stable' && row.policyReason === 'insufficient-reference', `${row.policy}/${row.policyReason}`)
  check('A: 未收窄', row.surfacePhase === 'stable' && row.narrowedNow === false)
}

// ── 场景 B：偏离触发 → 收窄 + 组装期派生 + notice ─────────────────────────
await boot({ rollbackEnabled: true, notifyEnabled: true, maxDriftSteps: 3 })
{
  const { session } = await adoptAndLift('sess-B')
  for (let i = 0; i < 16; i++) sessionEvent(session, text('We will run the full build and verify each artifact carefully.'))
  const before = await summaryOf('sess-B')
  check('B: 参考段已就绪（不再 insufficient-reference）',
    before.policyReason !== 'insufficient-reference' && before.policy === 'stable', `${before.policy}/${before.policyReason}`)
  for (let i = 0; i < 4; i++) sessionEvent(session, text('let me just try something quick here'))
  const row = await summaryOf('sess-B')
  check('B: 4 步持续偏低 → 判定收窄', row.narrowedNow === true && row.surfacePhase === 'narrowed', `${row.policy}/${row.policyReason}`)
  check('B: p 值被记录且很小', typeof row.policyP === 'number' && row.policyP <= 0.01, String(row.policyP))
  const out = await handlers['system-prompt/assemble'](asm(), { agent: { id: 'sess-B' } }, async () => asm())
  const names = out.tools.map((t) => t.name)
  check('B: 组装期工具面被派生收窄（browser/vision/todo 被摘）',
    names.join(',') === 'pwsh,read,edit,grep', names.join(','))
  check('B: 注入了模型可见的 notice（P4）',
    Array.isArray(out.sections) && out.sections.some((s) => s.name === 'trajectory-anchor:notice' && /narrowed to 4 tools/.test(s.text)),
    JSON.stringify((out.sections || []).map((s) => s.name)))
  // 收窄态下继续偏低：maxDriftSteps=3 → 到顶即耗尽能力预算
  for (let i = 0; i < 3; i++) sessionEvent(session, text('let me just try something quick here'))
  const after = await summaryOf('sess-B')
  check('B: 到 maxDriftSteps 后能力预算耗尽且工具面自动恢复',
    after.capabilityBudgetExhausted === true && after.surfacePhase === 'stable', JSON.stringify({ b: after.capabilityBudgetExhausted, s: after.surfacePhase }))
  const out2 = await handlers['system-prompt/assemble'](asm(), { agent: { id: 'sess-B' } }, async () => asm())
  check('B: 预算耗尽后组装期回到全量（无需任何归还调用）', out2.tools.length === TOOLS.length, String(out2.tools.length))
}

// ── 场景 C：能力层关、通知层开（P0 保守档语义）────────────────────────────
await boot({ rollbackEnabled: false, notifyEnabled: true })
{
  const { session } = await adoptAndLift('sess-C')
  for (let i = 0; i < 16; i++) sessionEvent(session, text('We will run the full build and verify each artifact carefully.'))
  for (let i = 0; i < 4; i++) sessionEvent(session, text('let me just try something quick here'))
  const row = await summaryOf('sess-C')
  check('C: 关闭能力层 → 同一偏离只通知（capability-disabled）',
    row.policy === 'narrowed' && row.policyAction === 'notice' && row.policyReason === 'capability-disabled' && row.surfacePhase === 'stable',
    `${row.policy}/${row.policyAction}/${row.policyReason}`)
}

// ── 场景 F：双关（出厂默认 + 当前 profile 配置）→ 只观察，什么都不做 ──────
await boot({ rollbackEnabled: false, notifyEnabled: false })
{
  const { session } = await adoptAndLift('sess-F')
  for (let i = 0; i < 16; i++) sessionEvent(session, text('We will run the full build and verify each artifact carefully.'))
  for (let i = 0; i < 4; i++) sessionEvent(session, text('let me just try something quick here'))
  const row = await summaryOf('sess-F')
  check('F: 双关 → 偏离存在但 action=none / observe-only',
    row.policy === 'narrowed' && row.policyAction === 'none' && row.policyReason === 'observe-only',
    `${row.policy}/${row.policyAction}/${row.policyReason}`)
  check('F: 工具面保持全量', row.surfacePhase === 'stable' && row.narrowedNow === false)
}

// ── 场景 D：词典退化闸门（正桶 0 命中，但偏离真实存在）────────────────────
await boot({ rollbackEnabled: true, notifyEnabled: true })
{
  const { session } = await adoptAndLiftByRequests('sess-D')
  // 参考段：只有负词/中性词命中（正桶 0 命中），ratio ≈ 0.07
  for (let i = 0; i < 14; i++) sessionEvent(session, text('let me check the output and verify the result once more'))
  // 检验窗：只剩负词、无中性词 → ratio 降到 0，真实偏离
  for (let i = 0; i < 4; i++) sessionEvent(session, text('let me let me let me'))
  const row = await summaryOf('sess-D')
  check('D: 正桶 0 命中 → 判定词典退化', row.lexiconDegenerate === 'positive-bucket-never-hit', String(row.lexiconDegenerate))
  check('D: 偏离真实存在（p≈0）却被闸门拦下 → 只通知、不动能力面',
    row.policy === 'narrowed' && row.policyAction === 'notice' && row.policyReason === 'lexicon-degenerate' && row.surfacePhase === 'stable',
    `${row.policy}/${row.policyAction}/${row.policyReason}/p=${row.policyP}`)
  check('D: 命中计数被记录', row.positiveHitSteps === 0 && row.stepsScored > 0, JSON.stringify({ p: row.positiveHitSteps, n: row.stepsScored }))
}

// ── 场景 E：轨迹恢复 → 回到 stable ───────────────────────────────────────
await boot({ rollbackEnabled: true, notifyEnabled: true, maxDriftSteps: 50 })
{
  const { session } = await adoptAndLift('sess-E')
  for (let i = 0; i < 16; i++) sessionEvent(session, text('We will run the full build and verify each artifact carefully.'))
  for (let i = 0; i < 4; i++) sessionEvent(session, text('let me just try something quick here'))
  const narrowed = await summaryOf('sess-E')
  check('E: 先进入收窄', narrowed.narrowedNow === true, String(narrowed.surfacePhase))
  for (let i = 0; i < 4; i++) sessionEvent(session, text('We will run the full build and verify each artifact carefully.'))
  const recovered = await summaryOf('sess-E')
  check('E: 轨迹恢复 → 自动回到 stable（"归还"无调用）',
    recovered.surfacePhase === 'stable' && recovered.narrowedNow === false, `${recovered.surfacePhase}/${recovered.policy}`)
}

console.log(`\n${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
