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
import { resolve, join } from 'node:path'
import { writeFileSync, mkdtempSync } from 'node:fs'
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
  await mod.apply(ctx, { adaptiveStateEnabled: false, ...config })   // 测试隔离：不许继承别的套件写下的累积状态
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
await boot({ rollbackEnabled: true, responseChannels: { lexicon: { enabled: true } } })
{
  const { session } = await adoptAndLift('sess-A')
  for (let i = 0; i < 6; i++) sessionEvent(session, text('let me check the failing assertion once more'))
  const row = await summaryOf('sess-A')
  check('A: 参考段不足 → policy=stable / insufficient-reference',
    row.policy === 'stable' && row.policyReason === 'insufficient-reference', `${row.policy}/${row.policyReason}`)
  check('A: 未收窄', row.surfacePhase === 'stable' && row.narrowedNow === false)
  check('A: 跳过判定也留痕（A 方案：insufficient-reference 写 policy-skipped）',
    Array.isArray(row.auditTail) && row.auditTail.includes('policy-skipped'), JSON.stringify(row.auditTail))
}

// ── 场景 G：会话最开头（连检验窗都没有）也必须留痕 ───────────────────────
await boot({ rollbackEnabled: true, notifyEnabled: true, responseChannels: { lexicon: { enabled: true } } })
{
  const { session } = await adoptAndLift('sess-G')
  // 锚定后只有 1 步：history < testWindow(4) → refLen ≤ 0 → no-observation
  sessionEvent(session, text('let me check the output once'))
  const row = await summaryOf('sess-G')
  check('G: 最开头 → reason=no-observation', row.policyReason === 'no-observation', String(row.policyReason))
  check('G: no-observation 同样写 policy-skipped（日志从第 1 步起可回溯）',
    Array.isArray(row.auditTail) && row.auditTail.includes('policy-skipped'), JSON.stringify(row.auditTail))
}

// ── 场景 B：偏离触发 → 收窄 + 组装期派生 + notice ─────────────────────────
await boot({ rollbackEnabled: true, notifyEnabled: true, maxDriftSteps: 3, responseChannels: { lexicon: { enabled: true, capabilityEligible: true, actAlpha: 0.01, notifyAlpha: 0.05 } } })
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
await boot({ rollbackEnabled: false, notifyEnabled: true, responseChannels: { lexicon: { enabled: true } } })
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
await boot({ rollbackEnabled: false, notifyEnabled: false, responseChannels: { lexicon: { enabled: true } } })
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
await boot({ rollbackEnabled: true, notifyEnabled: true, responseChannels: { lexicon: { enabled: true } } })
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
await boot({ rollbackEnabled: true, notifyEnabled: true, maxDriftSteps: 50, responseChannels: { lexicon: { enabled: true, capabilityEligible: true, actAlpha: 0.01, notifyAlpha: 0.05 } } })
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

// ── B1 行为通道 ──────────────────────────────────────────────────────────
// 事件构造器（带 turn/step）
const msgAt = (turn, step, s) => ({ type: 'assistant/message', data: { turn, step, message: { content: [{ type: 'reasoning', text: s }] } } })
const callAt = (turn, step, name, args) => ({ type: 'tool/call', data: { turn, step, name, arguments: args } })
const resultAt = (turn, step, out) => ({ type: 'tool/result', data: { turn, step, message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: out }] }] } } })
const turnEndAt = (turn) => ({ type: 'turn/end', data: { turn } })
const OK_TEXT = 'We will inspect the repository and verify each artifact carefully.'

/** 造 n 个"有工具调用"的干净步（同回合）。 */
function cleanSteps(session, turn, from, to) {
  for (let i = from; i <= to; i++) {
    sessionEvent(session, callAt(turn, i, 'pwsh', `cmd-${i}`))
    sessionEvent(session, msgAt(turn, i, OK_TEXT))
  }
}

// ── 场景 H：A′ 中途停手（有资格）→ 收窄；且 turn/end 把末步回落为合法收尾 ──
await boot({ rollbackEnabled: true, notifyEnabled: true, responseChannels: { inaction: { capabilityEligible: true } } })
{
  const { session } = await adoptAndLift('sess-H')
  cleanSteps(session, 1, 1, 24)
  for (let i = 25; i <= 28; i++) sessionEvent(session, msgAt(1, i, OK_TEXT))   // 无工具调用，但回合仍在继续
  const row = await summaryOf('sess-H')
  check('H: A′（中途停手）→ 通道 p 很小', typeof row.channels?.find((c) => c.name === 'inaction')?.p === 'number'
    && row.channels.find((c) => c.name === 'inaction').p <= 0.01,
    JSON.stringify(row.channels?.find((c) => c.name === 'inaction')))
  check('H: 命中通道被记录且驱动了收窄',
    row.policyChannel === 'inaction' && row.narrowedNow === true, `${row.policyChannel}/${row.surfacePhase}`)
  // C9：回合结束把"最后一格"回落为合法收尾（不是停手）——检验窗随之后移一格，
  // 停手命中数应从 3 降到 2（末步被排除）。用实时窗口字段（channels 是上次判定的快照）。
  const beforeHits = row.channelWindows.inaction.observed
  sessionEvent(session, turnEndAt(1))
  const after = await summaryOf('sess-H')
  const afterHits = after.channelWindows.inaction.observed
  check('H: turn/end 把末步排除出"停手"（窗口命中 3 → 2）',
    beforeHits === 3 && afterHits === 2, `${beforeHits} → ${afterHits}`)
}

// ── 场景 H2：只有"回合末步"没有工具调用 → 永不判为停手（C9 反向）──────────
await boot({ rollbackEnabled: true, notifyEnabled: true, responseChannels: { inaction: { capabilityEligible: true } } })
{
  const { session } = await adoptAndLift('sess-H2')
  cleanSteps(session, 2, 1, 24)
  sessionEvent(session, msgAt(2, 25, OK_TEXT))   // 无工具调用
  sessionEvent(session, turnEndAt(2))            // 但回合就此结束 ⇒ 合法收尾
  const row = await summaryOf('sess-H2')
  const ch = row.channels?.find((c) => c.name === 'inaction')
  check('H2: 回合末步的"无工具调用"不计入停手命中', ch?.observed === 0, JSON.stringify(ch))
  check('H2: 因此不收窄', row.narrowedNow === false, String(row.surfacePhase))
}

// ── 场景 I：C 重复调用（有资格）→ 收窄 ─────────────────────────────────
await boot({ rollbackEnabled: true, notifyEnabled: true, responseChannels: { repetition: { capabilityEligible: true, actAlpha: 0.01, notifyAlpha: 0.05 } } })
{
  const { session } = await adoptAndLift('sess-I')
  cleanSteps(session, 1, 1, 24)
  for (let i = 25; i <= 27; i++) {
    sessionEvent(session, callAt(1, i, 'pwsh', 'same-command'))
    sessionEvent(session, callAt(1, i, 'pwsh', 'same-command'))   // 同工具同参第二次
    sessionEvent(session, msgAt(1, i, OK_TEXT))
  }
  const row = await summaryOf('sess-I')
  check('I: C（重复调用）被识别', row.channels?.find((c) => c.name === 'repetition')?.observed >= 2,
    JSON.stringify(row.channels?.find((c) => c.name === 'repetition')))
  check('I: 命中通道为 repetition 且驱动收窄',
    row.policyChannel === 'repetition' && row.narrowedNow === true, `${row.policyChannel}/${row.surfacePhase}`)
}

// ── 场景 J：B 工具失败 → 只能通知，不得驱动能力层（D1 分层）─────────────
await boot({ rollbackEnabled: true, notifyEnabled: true, responseChannels: { lexicon: { enabled: true } } })
{
  const { session } = await adoptAndLift('sess-J')
  cleanSteps(session, 1, 1, 24)
  for (let i = 25; i <= 27; i++) {
    sessionEvent(session, callAt(1, i, 'pwsh', `cmd-${i}`))
    sessionEvent(session, resultAt(1, i, '[exit code: 1] Command failed'))
    sessionEvent(session, msgAt(1, i, OK_TEXT))
  }
  const row = await summaryOf('sess-J')
  const ch = row.channels?.find((c) => c.name === 'failure')
  check('J: B（工具失败）被识别且 p 很小', typeof ch?.p === 'number' && ch.p <= 0.01, JSON.stringify(ch))
  check('J: 但该通道无能力层资格 → 只通知，工具面保持全量',
    row.policyAction !== 'narrow' && row.surfacePhase === 'stable', `${row.policyAction}/${row.policyReason}`)
}

// ── 平台契约：被驱动过的会话，其 anchor_status 行必须是无损 JSON ────────────
// 本轮踩过：channels 里短参考通道的 observed 是 undefined → anchor_status 报
// "value is not lossless JSON"。这类错误只有在**会话被驱动过**（stateMachine 跑过、
// rec.channels 被写入）时才会暴露，所以必须在这里测（只 apply() 的契约测试测不到）。
{
  const row = await summaryOf('sess-J')
  const bad = []
  const walk = (v, path) => {
    if (v === undefined) { bad.push(`${path}=undefined`); return }
    if (typeof v === 'number' && !Number.isFinite(v)) { bad.push(`${path}=${v}`); return }
    if (typeof v === 'function') { bad.push(`${path}=function`); return }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return }
    if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], `${path}.${k}`)
  }
  walk(row, 'row')
  check('驱动过的会话行可无损 JSON 序列化（无 undefined/NaN/function）', bad.length === 0, bad.slice(0, 6).join(', '))
}

// ── 场景 K：词典/风格通道出厂关闭后，**任何** grant 都不得把它拉回判据面 ──────
// 由来：它作为漂移判据已被实测否定（60 会话判别力：召回 24.2% 对**同预算随机** 36.8%
// = 0.64×；部署口径节流后 1.06× ≈ 随机；对强锚点精度倍数 < 1），2026-10-09 移出判据面、
// 出厂 enabled=false。这里要钉的**不是默认值是多少**，而是"关闭是结构性的"：
// 判断面上的通道行在 enabled===false 时根本不构造（channelTests 的
// `if (lexCfg.enabled !== false)`），所以"标定件授权"与"人工试运行放行"这两条
// **已有的** grant 通道都碰不到它——不需要在那两处各加一个特判。
// 四路：K1 标定件授权（须无效）/ K2 试运行放行（须无效且**可见地**无效）/
//       K3 反向对照：同一段偏离在显式打开下确实收窄 / K4 正向对照：放行生效时不报"未生效"。
const LEX_DRIFT = (session) => {
  for (let i = 0; i < 16; i++) sessionEvent(session, text('We will run the full build and verify each artifact carefully.'))
  for (let i = 0; i < 4; i++) sessionEvent(session, text('let me just try something quick here'))
}
const kDir = mkdtempSync(join(tmpdir(), 'response-policy-k-'))
const lexGrantPath = join(kDir, 'lex-grant.json')
writeFileSync(lexGrantPath, JSON.stringify({
  verdict: 'PASS',
  capabilityEligibleChannels: ['lexicon'],
  channels: { lexicon: { derived: { consecutive: 1, alpha: 0.01 } } },
}, null, 2), 'utf8')
const TRIAL = (channels, note) => ({ trialRelease: { channels, alpha: 0.01, until: '2099-01-01T00:00:00Z', note } })

// K1：标定件**真的**写入了 lexicon 授权，但判断面上连这一行都没有
await boot({ rollbackEnabled: true, notifyEnabled: true, maxDriftSteps: 3, responsePolicyPath: lexGrantPath })
{
  const { session } = await adoptAndLift('sess-K1')
  LEX_DRIFT(session)
  const st = await registeredTools.anchor_status.execute({})
  const row = await summaryOf('sess-K1')
  const names = (row.channels || []).map((c) => c.name)
  check('K1 前置：标定件确实声明并写入了 lexicon 授权（否则本条空过）',
    JSON.stringify(st.policyArtifact && st.policyArtifact.eligibleChannels) === JSON.stringify(['lexicon']),
    JSON.stringify(st.policyArtifact && { v: st.policyArtifact.verdict, e: st.policyArtifact.eligibleChannels }))
  check('K1 判断面上没有词典行（结构性关闭：行不产出）',
    !names.includes('lexicon') && names.length === 3, JSON.stringify(names))
  check('K1 同一段偏离不产生任何收窄（被否定的信号不得回到判据面）',
    row.policy === 'stable' && row.surfacePhase === 'stable' && row.narrowedNow === false,
    `${row.policy}/${row.policyReason}/${row.surfacePhase}`)
}

// K2：试运行放行名单里写了已关闭的通道 → 无效，且**必须可见**
await boot({ rollbackEnabled: true, notifyEnabled: true, maxDriftSteps: 3, ...TRIAL(['lexicon'], 'K2：放行已关闭的通道') })
{
  const { session } = await adoptAndLift('sess-K2')
  LEX_DRIFT(session)
  const st = await registeredTools.anchor_status.execute({})
  const row = await summaryOf('sess-K2')
  const names = (row.channels || []).map((c) => c.name)
  check('K2 试运行放行不产出该行', !names.includes('lexicon') && names.length === 3, JSON.stringify(names))
  check('K2 放行了却没生效 → 明文审计（L3.3 的样本入口不许静默失效）',
    Array.isArray(row.auditKinds) && row.auditKinds.includes('trial-release-unavailable'), JSON.stringify(row.auditKinds))
  check('K2 原因写明是"通道被配置关掉"而不是别的',
    row.trialReleaseUnavailable === 'lexicon:channel-disabled', String(row.trialReleaseUnavailable))
  check('K2 也进 configWarnings（治理配置失效在 status 里看得见）',
    (st.configWarnings || []).some((w) => /trialRelease/.test(w) && /lexicon/.test(w)), JSON.stringify(st.configWarnings))
  check('K2 不动手', row.policy === 'stable' && row.surfacePhase === 'stable', `${row.policy}/${row.surfacePhase}`)
}

// K3：反向对照——同一段偏离，显式打开词典通道后必须真的收窄
//     （没有这一条，K1/K2 可能只是因为"这段文本本来就检不出偏离"而空过）
await boot({
  rollbackEnabled: true, notifyEnabled: true, maxDriftSteps: 3,
  responseChannels: { lexicon: { enabled: true, capabilityEligible: true, actAlpha: 0.01, notifyAlpha: 0.05 } },
})
{
  const { session } = await adoptAndLift('sess-K3')
  LEX_DRIFT(session)
  const row = await summaryOf('sess-K3')
  check('K3 反向对照：同一段偏离在显式打开下确实收窄',
    row.narrowedNow === true && (row.channels || []).some((c) => c.name === 'lexicon' && c.eligible === true),
    `${row.policy}/${row.surfacePhase}/${JSON.stringify((row.channels || []).map((c) => c.name + ':' + c.eligible))}`)
}

// K4：正向对照——放行**确实生效**时不得报"未生效"（证明 K2 的标记是判别性的，不是常亮）
await boot({
  rollbackEnabled: true, notifyEnabled: true, maxDriftSteps: 3, ...TRIAL(['lexicon'], 'K4：放行一个在线的通道'),
  responseChannels: { lexicon: { enabled: true, capabilityEligible: false } },
})
{
  const { session } = await adoptAndLift('sess-K4')
  LEX_DRIFT(session)
  const row = await summaryOf('sess-K4')
  check('K4 正向对照：放行生效 → trialReleaseArmed=lexicon 且不报未生效',
    row.trialReleaseArmed === 'lexicon' && row.trialReleaseUnavailable === null,
    JSON.stringify({ armed: row.trialReleaseArmed, un: row.trialReleaseUnavailable }))
  check('K4 且留的是 armed 审计（与 unavailable 互斥）',
    Array.isArray(row.auditKinds) && row.auditKinds.includes('trial-release-armed') && !row.auditKinds.includes('trial-release-unavailable'),
    JSON.stringify(row.auditKinds))
  check('K4 试运行工作点写进了行（α 不沿用任何默认）',
    (row.channels || []).some((c) => c.name === 'lexicon' && c.trialRelease === true && c.actAlpha === 0.01),
    JSON.stringify((row.channels || []).map((c) => `${c.name}:${c.actAlpha}:${c.trialRelease}`)))
}

// K5：关掉词典之后，"**默认配置下**唯一还活着的执行路径"必须端到端可用：
//     行为通道（inaction）够强 ⇒ 能力层收窄 ⇒ 组装期**真的摘工具** + 注入可见 notice。
//     为什么必须补：场景 H/I 只断言到 narrowedNow，场景 B 断言了组装面但那条路现在要显式
//     打开词典；不补这一条，"出厂默认下到底还能不能真的动手"就只能靠读代码相信。
await boot({ rollbackEnabled: true, notifyEnabled: true, responseChannels: { inaction: { capabilityEligible: true } } })
{
  const { session } = await adoptAndLift('sess-K5')
  cleanSteps(session, 1, 1, 24)
  for (let i = 25; i <= 28; i++) sessionEvent(session, msgAt(1, i, OK_TEXT))   // 无工具调用但回合继续
  const row = await summaryOf('sess-K5')
  const out = await handlers['system-prompt/assemble'](asm(), { agent: { id: 'sess-K5' } }, async () => asm())
  const names = out.tools.map((t) => t.name).join(',')
  check('K5 出厂默认（词典关）下行为通道照样驱动收窄',
    row.narrowedNow === true && row.policyChannel === 'inaction', `${row.policyChannel}/${row.surfacePhase}`)
  check('K5 且组装期真的摘工具（不是只改了状态）', names === 'pwsh,read,edit,grep', names)
  check('K5 且注入了模型可见 notice',
    (out.sections || []).some((s) => s.name === 'trajectory-anchor:notice'),
    JSON.stringify((out.sections || []).map((s) => s.name)))
}

console.log(`\n${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
