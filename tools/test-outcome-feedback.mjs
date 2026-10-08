/**
 * test-outcome-feedback.mjs —— L3 第三层（结局回灌）的机制测试
 *
 * 这一层要证明的是**非对称**：
 *   · 默认关 ⇒ 门限与标定值逐位相同（负向）；
 *   · 不产出 ⇒ 收紧（且只收紧到下限，不越界）；
 *   · 产出很好 ⇒ 也只是"逐步放宽回标定值"，绝不比标定值更松；
 *   · 产出极差 ⇒ 撤销**该通道**资格（只影响它自己，别的通道照常）；
 *   · 没有触发过的通道 ⇒ 不因别人的坏结果被连坐。
 * 每条都用**行为**判定（触发/不触发），不依赖显示精度。
 *
 * 用法：node tools/test-outcome-feedback.mjs [index.js 路径]
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

const TOOLS = ['pwsh', 'read', 'edit'].map((n) => ({ name: n }))
let handlers = {}
let registered = {}
const agents = new Map()
const warnings = []
const origWarn = console.warn
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
const statusOf = async (sid) => (await registered.anchor_status.execute({})).rows.find((r) => r.sessionId === sid)

/** α=0.01：**参考段必须干净**（refEvery=0）+ 窗内 2~3 次重复命中 ⇒ p≈1.4e-5 ⇒ 触发。
 *  踩过的坑：参考段自己带命中（refEvery=5）会把 pHat 抬到 ~0.2，窗内 2 次命中 p≈0.1，
 *  于是"坏结局"的会话从未触发过，回灌记账全空——测试看起来在跑，其实什么都没测到。 */
function runSession(sid, { refLen = 25, windowHits = 2, refEvery = 0, unknownTool = false, endNarrowed = false, close = true }) {
  const agent = { id: sid, session: { id: sid, events: [] }, ctx: { tools: { schemas: () => TOOLS.map((t) => ({ ...t })), restrict: () => () => {} } } }
  agents.set(sid, agent)
  dispatch('agent/created', { agent })
  const session = { id: sid }
  sessionEvent(session, { type: 'request/header', data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } } } })
  sessionEvent(session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Work only inside bugfix-a4. Run the tests (python test_calc.py).' }] } })
  let step = 0
  const rep = (s) => {
    sessionEvent(session, { type: 'tool/call', data: { turn: 1, step: s, name: 'pwsh', arguments: JSON.stringify({ command: 'same' }) } })
    sessionEvent(session, { type: 'tool/call', data: { turn: 1, step: s, name: 'pwsh', arguments: JSON.stringify({ command: 'same' }) } })
  }
  for (let i = 0; i < refLen; i++) {
    step += 1
    sessionEvent(session, say(1, step))
    if (refEvery > 0 && i % refEvery === 0) rep(step)
  }
  for (let i = 0; i < 3; i++) {
    step += 1
    sessionEvent(session, say(1, step))
    if (i < windowHits) rep(step)
  }
  if (unknownTool) {
    step += 1
    sessionEvent(session, say(1, step))
    sessionEvent(session, { type: 'tool/result', data: { turn: 1, step, message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: 'unknown tool: vision_crop' }] }] } } })
  }
  if (close) {
    // 结束会话：若 endNarrowed=false，先让轨迹回到 stable（模拟"片段自然结束"）
    if (!endNarrowed) {
      for (let i = 0; i < 4; i++) {
        step += 1
        sessionEvent(session, say(1, step))
      }
    }
    dispatch('agent/disposed', { agent })
  }
  return { agent, session }
}

const BASE = {
  rollbackEnabled: true,
  notifyEnabled: false,
  // 隔离 L3.3：把**全局** autoDemote 关掉（autoDemoteWindow=0 ⇒ 不记账）。
  // 否则跑够 20 个会话就会被它拦下（收窄比例远超 5% 预算），现象是 action=none/observe-only，
  // 看起来像"回灌没生效"——实测踩到。它的优先级另有专门用例（⑤）验证。
  autoDemoteWindow: 0,
  responseChannels: {
    lexicon: { enabled: false },
    repetition: { enabled: true, refMinSteps: 20, testWindow: 3, actAlpha: 0.01, notifyAlpha: 0.5, capabilityEligible: true },
  },
}

// ── ① 默认关：多轮坏结局也不改门限（负向）──────────────────────────────────
await boot({ ...BASE })
{
  for (let i = 0; i < 8; i++) runSession(`of-off-${i}`, { unknownTool: true, endNarrowed: true })
  const s = await registered.anchor_status.execute({})
  check('① 默认关 ⇒ 没有任何回灌记账', Object.keys(s.channelFeedback || {}).length === 0, JSON.stringify(s.channelFeedback))
  check('① 默认关 ⇒ 报错字段为 false', s.config.outcomeFeedbackEnabled === false, String(s.config.outcomeFeedbackEnabled))
}

// ── ② 打开：坏结局累计 ⇒ 先收紧；更坏 ⇒ 撤销资格（只影响该通道）─────────────
const CFG_TIGHTEN = {
  ...BASE,
  outcomeFeedbackEnabled: true,
  feedbackMinSessions: 4,
  feedbackMinProductiveRate: 0.6,
  feedbackRevokeEligibilityRate: 0.2,     // 0.25 的产出率 ⇒ 不撤销，只收紧
  responseChannels: {
    lexicon: { enabled: false },
    repetition: { enabled: true, refMinSteps: 20, testWindow: 3, actAlpha: 0.01, notifyAlpha: 0.5, capabilityEligible: true },
    failure: { enabled: true, refMinSteps: 20, testWindow: 3, actAlpha: 0.01, notifyAlpha: 0.5, capabilityEligible: true },
  },
}
await boot(CFG_TIGHTEN)
{
  // 4 轮里 1 轮好结局（其余 unknown tool + 结束时仍收窄）⇒ 产出率 0.25
  for (let i = 0; i < 3; i++) runSession(`of-t-${i}`, { unknownTool: true, endNarrowed: true })
  runSession('of-t-good', {})
  const s = await registered.anchor_status.execute({})
  const fb = (s.channelFeedback || {}).repetition || {}
  check('② 该通道被记账（sessions/fires/productive）', fb.sessions === 4 && fb.fires >= 4 && fb.productive === 1, JSON.stringify(fb))
  check('② 产出率 0.25（≥撤销线、<收紧线）⇒ 只收紧不撤销', fb.multiplier < 1 && fb.revoked === false, JSON.stringify({ m: fb.multiplier, r: fb.revoked }))
  check('② 未触发过的通道不被连坐（没有 failure 记账）', !(s.channelFeedback || {}).failure, JSON.stringify((s.channelFeedback || {}).failure))
  // 行为级（未关闭的会话才能读到行）：收紧后仍按**有效门限**判定
  runSession('of-t-after', { close: false })
  const row = await statusOf('of-t-after')
  const rep = (row.channels || []).find((c) => c.name === 'repetition')
  check('② 有效门限可见且不超过标定值', rep.actAlphaEffective !== null && rep.actAlphaEffective <= 0.01,
    JSON.stringify({ eff: rep.actAlphaEffective, base: rep.actAlpha }))
}
// 更坏 ⇒ 撤销（0 产出率 < 0.2 撤销线）
await boot({ ...CFG_TIGHTEN, feedbackMinSessions: 3 })
{
  for (let i = 0; i < 6; i++) runSession(`of-revoke-${i}`, { unknownTool: true, endNarrowed: true })
  const s = await registered.anchor_status.execute({})
  const fb = (s.channelFeedback || {}).repetition || {}
  check('② 产出率低于撤销线 ⇒ 撤销该通道资格', fb.revoked === true, JSON.stringify(fb))
  check('② 撤销有响亮告警', warnings.some((w) => /lost capability eligibility/.test(w)), JSON.stringify(warnings.slice(0, 1)))
  // 行为级：撤销后同一序列不再收窄（**不关闭**会话才能读到行）
  runSession('of-after-revoke', { close: false })
  const row = await statusOf('of-after-revoke')
  check('② 撤销后不再收窄（行为级，不是只看字段）', row && row.narrowedNow === false,
    row ? `${row.surfacePhase}/${row.policyAction}/${row.policyReason}` : 'row missing')
  check('② 撤销后有效门限为 null（永不命中）',
    row && (row.channels || []).find((c) => c.name === 'repetition').actAlphaEffective === null,
    row ? JSON.stringify((row.channels || []).find((c) => c.name === 'repetition')) : 'row missing')
}

// ── ③ 好结局：放宽**绝不**超过标定值；且"收紧到不再触发"不许变成单向棘轮 ────────
await boot({
  ...BASE,
  outcomeFeedbackEnabled: true,
  feedbackMinSessions: 4,
  feedbackMinProductiveRate: 0.6,
  feedbackRevokeEligibilityRate: 0.2,
  feedbackExploreAfterSessions: 3,          // 探索周期调小，便于验证（默认 30）
  responseChannels: { lexicon: { enabled: false }, repetition: { enabled: true, refMinSteps: 20, testWindow: 3, actAlpha: 0.01, notifyAlpha: 0.5, capabilityEligible: true } },
})
{
  // 4 轮里 1 轮好结局 ⇒ 产出率 0.25 ⇒ 只收紧（不撤销）
  for (let i = 0; i < 3; i++) runSession(`of-mix-bad-${i}`, { unknownTool: true, endNarrowed: true })
  runSession('of-mix-good0', {})
  const s1 = await registered.anchor_status.execute({})
  const m1 = ((s1.channelFeedback || {}).repetition || {}).multiplier
  check('③ 先收紧到 0.5（前置条件）', m1 === 0.5, String(m1))

  // 继续按 [坏,好] 交替：**累计产出率收敛到 0.5**（≥撤销线 0.2 ⇒ 不撤销；<收紧线 0.6 ⇒ 每次都收紧）。
  // 注意产出率是**累计**的：三坏一好会让它掉到 0.14 ⇒ 触发撤销，就测不到棘轮了（实测踩到）。
  let idx = 0
  for (let cycle = 0; cycle < 8; cycle++) {
    runSession(`of-ratchet-bad-${idx++}`, { unknownTool: true, endNarrowed: true })
    runSession(`of-ratchet-good-${cycle}`, {})
  }
  const s2 = await registered.anchor_status.execute({})
  const fb2 = (s2.channelFeedback || {}).repetition || {}
  check('③ 反复"坏好交替" ⇒ 门限被压到不再触发（棘轮压力）', fb2.multiplier <= 0.12 && fb2.revoked === false,
    JSON.stringify({ m: fb2.multiplier, revoked: fb2.revoked, rate: fb2.rate, sessions: fb2.sessions }))
  const firesNow = fb2.fires
  runSession('of-ratchet-probe', { close: true })
  const s2b = await registered.anchor_status.execute({})
  const fb2b = (s2b.channelFeedback || {}).repetition || {}
  check('③ 门限压低后**不再触发**（这正是棘轮风险的现场）', fb2b.fires === firesNow,
    JSON.stringify({ before: firesNow, after: fb2b.fires }))

  // 关键断言：无触发时仍有**探索步**把门限回升（否则永久锁死）。
  // 探索期必须用**不可能触发**的序列（windowHits=0 ⇒ observed=0 ⇒ p=1）保持确定性——
  // 踩过的坑：用普通序列时，参考段变长会让 pHat 变小，已收紧的门限又被跨过而触发，
  // 于是"探索期"里混进了收紧，倍率看起来在下降（实测：0.076 → 0.060）。
  const before = fb2b.multiplier
  for (let i = 0; i < 9; i++) runSession(`of-explore-${i}`, { windowHits: 0, close: true })
  const s3 = await registered.anchor_status.execute({})
  const fb3 = (s3.channelFeedback || {}).repetition || {}
  check('③ 长期无变化 ⇒ 探索步回升门限（不是单向棘轮）',
    fb3.multiplier > before && fb3.explores >= 3, JSON.stringify({ before, after: fb3.multiplier, explores: fb3.explores }))
  check('③ 探索期没有触发（确保回升只来自探索步，不是别的路径）', fb3.fires === fb2b.fires,
    JSON.stringify({ before: fb2b.fires, after: fb3.fires }))
  check('③ 探索回升也**绝不**超过 1.0', fb3.multiplier <= 1, String(fb3.multiplier))
  check('③ 探索有审计留痕', fb3.explores >= 1, String(fb3.explores))

  // 反方向对照：把门限放松后，同一序列能再次触发（棘轮真的解开了）
  runSession('of-after-explore', { close: false })
  const row = await statusOf('of-after-explore')
  const rep = row && (row.channels || []).find((c) => c.name === 'repetition')
  check('③ 探索之后该通道能重新触发（门限确实回来了）',
    rep && Number.isFinite(rep.p) && rep.p <= rep.actAlphaEffective && row.narrowedNow === true,
    JSON.stringify(rep && { p: rep.pRaw ?? rep.p, eff: rep.actAlphaEffective, narrowed: row.narrowedNow, action: row.policyAction, reason: row.policyReason, channel: row.policyChannel, anchored: row.anchored, lifted: row.lifted }))
  check('③ 有效门限不超过标定值', rep && rep.actAlphaEffective <= 0.01, JSON.stringify(rep && { eff: rep.actAlphaEffective, base: rep.actAlpha }))
}

// ── ④ 无损 JSON + 可见性 ────────────────────────────────────────────────────
{
  const s = await registered.anchor_status.execute({})
  const bad = []
  const walk = (v, path) => {
    if (v === undefined) { bad.push(path); return }
    if (typeof v === 'number' && !Number.isFinite(v)) { bad.push(path); return }
    if (typeof v === 'function') { bad.push(path); return }
    if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], `${path}.${k}`)
  }
  walk(s, 'summary')
  check('④ anchor_status 可无损 JSON 序列化（含回灌状态）', bad.length === 0, bad.slice(0, 3).join(','))
  const row = s.rows[0]
  check('④ 通道行暴露有效门限字段', row && row.channels && row.channels.every((c) => 'actAlphaEffective' in c))
  check('④ config 暴露回灌开关与阈值',
    s.config.outcomeFeedbackEnabled === true && Number.isFinite(s.config.feedbackMinSessions) && Number.isFinite(s.config.feedbackMinProductiveRate),
    JSON.stringify({ e: s.config.outcomeFeedbackEnabled, n: s.config.feedbackMinSessions }))
}

// ── ⑤ 跨层：全局 autoDemote 必须压得住回灌层（谁更保守谁说了算）────────────────
await boot({
  ...BASE,
  autoDemoteWindow: 2, autoDemoteBudget: 0,       // 2 个会话、任何收窄即超标 ⇒ 必定降档
  outcomeFeedbackEnabled: true,
  feedbackMinSessions: 2,
})
{
  runSession('of-x1', { close: true })
  runSession('of-x2', { close: true })
  const s = await registered.anchor_status.execute({})
  check('⑤ 全局 autoDemote 触发', typeof s.autoDemote?.reason === 'string',
    JSON.stringify({ demote: s.autoDemote, sessionOutcomes: s.sessionOutcomes, gate: s.capabilityGate, eff: s.config.effectiveRollback }))
  runSession('of-x3', { close: false })
  const row = await statusOf('of-x3')
  check('⑤ 降档后回灌层也拦得住（证据再足也不动手）',
    row && row.narrowedNow === false && row.policyReason === 'observe-only',
    row ? `${row.policyAction}/${row.policyReason}` : 'row missing')
  check('⑤ 卡口原因写明自动降档', String(s.capabilityGate).startsWith('auto-demoted:'), String(s.capabilityGate))
}

console.warn = origWarn
console.log(`\n${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
