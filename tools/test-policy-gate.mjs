/**
 * test-policy-gate.mjs —— B3 运行时门禁回归（合成会话驱动真实 apply）
 *
 * 覆盖"必须只观察"的五类情形与"必须放开"的一类情形：
 *   ① 未提供标定件 → 配置即生效（资格只能来自配置，不会被门禁误拦）
 *   ② 标定件 verdict=FAIL → 只观察，原因可见 + 响亮告警
 *   ③ 标定件已过期 → 只观察
 *   ④ 标定件 measurementSafe → 强制只观察（评测保护）
 *   ⑤ 标定件 PASS + 授权 → 通道获资格，且反解参数（consecutive/alpha）写入运行时
 *   ⑥ 在线自动降档：窗口内收窄比例超预算 → 自降为只观察，且后续会话不再收窄
 *
 * 断言全部带方向性：每个"应收窄"的用例都同时断言其对照（不收窄）成立，
 * 否则"从不失败的门禁"等于没有门禁。
 *
 * 用法：node tools/test-policy-gate.mjs [index.js 路径]
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs'
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

const dir = mkdtempSync(join(tmpdir(), 'policy-gate-'))
const write = (name, obj) => {
  const p = join(dir, name)
  writeFileSync(p, obj === null ? 'not json at all' : JSON.stringify(obj, null, 2), 'utf8')
  return p
}
const TOOLS = ['pwsh', 'read', 'edit', 'grep', 'browser_open', 'browser_type', 'vision_crop', 'todo_write'].map((n) => ({ name: n }))
const asm = () => ({ sections: [], contexts: [], tools: TOOLS.map((t) => ({ ...t })), variables: {} })
const text = (s) => ({ type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: s }] } } })

let handlers = {}
let registeredTools = {}
const agentsById = new Map()
const warnings = []
const errors = []
const origWarn = console.warn
const origError = console.error
console.warn = (...a) => { warnings.push(a.join(' ')) }
console.error = (...a) => { errors.push(a.join(' ')) }

async function boot(config) {
  handlers = {}
  registeredTools = {}
  agentsById.clear()
  warnings.length = 0
  errors.length = 0
  const ctx = {
    get: (n) => {
      if (n === 'tools') return { register: (t) => { registeredTools[t.name] = t; return () => {} } }
      if (n === 'agents') return { get: (id) => agentsById.get(id), list: () => [...agentsById.values()] }
      return undefined
    },
    on: (n, fn) => { handlers[n] = fn; return () => {} },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  }
  await mod.apply(ctx, config)
}
const dispatch = (name, ...args) => handlers['internal/dispatch']('x', name, args, null)
const sessionEvent = (session, event) => dispatch('session/event', session, event)

function adoptAndLift(sid) {
  const agent = {
    id: sid,
    session: { id: sid, events: [] },
    ctx: { tools: { schemas: () => TOOLS.map((t) => ({ name: t.name })), restrict: () => () => {} } },
  }
  agentsById.set(sid, agent)
  dispatch('agent/created', { agent })
  const session = { id: sid }
  sessionEvent(session, { type: 'tool/call', data: { name: 'pwsh', turn: 1, step: 1 } })
  sessionEvent(session, text('We will inspect the repository first, then we will run the tests.'))
  return { agent, session }
}
/** 参考段 16 步正词 + 检验窗 4 步负词 —— 与 test-response-policy 场景 B 同源，
 *  在 actAlpha=0.01 下必然触发；在 actAlpha=1e-5 下必然不触发。 */
function deviate(session) {
  for (let i = 0; i < 16; i++) sessionEvent(session, text('We will run the full build and verify each artifact carefully.'))
  for (let i = 0; i < 4; i++) sessionEvent(session, text('let me just try something quick here'))
}
const statusOf = async () => registeredTools.anchor_status.execute({})
const rowOf = async (sid) => (await statusOf()).rows.find((r) => r.sessionId === sid)
const closeSession = (sid) => dispatch('agent/disposed', { agent: agentsById.get(sid) })
const LEX = { lexicon: { capabilityEligible: true, actAlpha: 0.01, notifyAlpha: 0.05 } }
const ARMED = { rollbackEnabled: true, notifyEnabled: true, responseChannels: LEX }

// ── ① 未提供标定件：配置即生效（门禁不得误拦）──────────────────────────────
await boot({ ...ARMED })
{
  const { session } = adoptAndLift('gate-A')
  deviate(session)
  const row = await rowOf('gate-A')
  const s = await statusOf()
  check('① 无标定件 → 该收窄就收窄（门禁不误拦）',
    row.narrowedNow === true && row.surfacePhase === 'narrowed', `${row.policy}/${row.policyReason}`)
  check('① 无标定件时无额外卡口原因', s.capabilityGate === null, String(s.capabilityGate))
  check('① 有效开关 = 配置开关', s.config.effectiveRollback === true && s.config.effectiveNotify === true)
}

// ── ② 标定件 verdict=FAIL ────────────────────────────────────────────────
await boot({ ...ARMED, responsePolicyPath: write('fail.json', { verdict: 'FAIL', capabilityEligibleChannels: ['lexicon'] }) })
{
  const { session } = adoptAndLift('gate-B')
  deviate(session)
  const row = await rowOf('gate-B')
  const s = await statusOf()
  check('② verdict=FAIL → 同一偏离只观察（不收窄）',
    row.narrowedNow === false && row.surfacePhase === 'stable', `${row.surfacePhase}/${row.policyReason}`)
  check('② 卡口原因可见（policy-REJECTED）', s.capabilityGate === 'policy-REJECTED', String(s.capabilityGate))
  check('② 拒绝原因写明真实裁决', /verdict=FAIL/.test(String(s.policyArtifact?.rejectReason)), String(s.policyArtifact?.rejectReason))
  check('② 有响亮告警（不静默降级）', warnings.some((w) => /response policy rejected/.test(w)), JSON.stringify(warnings.slice(0, 1)))
  // 语义说明：标定件管的是**能力层**（动不动手）；通知层只是"把观察到的偏离说出来"，
  // 它不改变工具面、不改上下文，因此不因标定件被拒而关闭（通知仍受 notifyAlpha 预算约束）。
  check('② 能力层被压为关闭、通知层仍按配置工作',
    s.config.effectiveRollback === false && s.config.effectiveNotify === true,
    JSON.stringify({ r: s.config.effectiveRollback, n: s.config.effectiveNotify }))
}

// ── ③ 标定件已过期 ──────────────────────────────────────────────────────
await boot({ ...ARMED, responsePolicyPath: write('expired.json', { verdict: 'PASS', expiresAtUtc: '2020-01-01T00:00:00.000Z', capabilityEligibleChannels: ['lexicon'] }) })
{
  const { session } = adoptAndLift('gate-C')
  deviate(session)
  const row = await rowOf('gate-C')
  const s = await statusOf()
  check('③ 已过期 → 只观察', row.narrowedNow === false && s.capabilityGate === 'policy-REJECTED', String(s.capabilityGate))
  check('③ 拒绝原因写明过期时刻', /expired/.test(String(s.policyArtifact?.rejectReason)), String(s.policyArtifact?.rejectReason))
}

// ── ④ measurementSafe（评测保护）────────────────────────────────────────
await boot({ ...ARMED, responsePolicyPath: write('safe.json', { verdict: 'PASS', measurementSafe: true, capabilityEligibleChannels: ['lexicon'] }) })
{
  const { session } = adoptAndLift('gate-D')
  deviate(session)
  const row = await rowOf('gate-D')
  const s = await statusOf()
  check('④ measurementSafe → 强制只观察（评测保护）',
    row.narrowedNow === false && s.capabilityGate === 'measurement-safe', `${row.surfacePhase}/${s.capabilityGate}`)
  check('④ 即便 verdict=PASS 也不放行', s.config.measurementSafe === true && s.config.effectiveRollback === false)
  check('④ 有评测保护告警', warnings.some((w) => /measurementSafe/.test(w)), JSON.stringify(warnings.slice(0, 1)))
}

// ── ⑤ 标定件 PASS + 授权：资格与反解参数都必须真正生效 ─────────────────────
await boot({
  rollbackEnabled: true, notifyEnabled: true,
  responsePolicyPath: write('pass-wide.json', { verdict: 'PASS', capabilityEligibleChannels: ['lexicon'] }),
  responseChannels: { lexicon: { capabilityEligible: false, actAlpha: 0.01, notifyAlpha: 0.05 } },
})
{
  const s = await statusOf()
  check('⑤ PASS 标定件 → 通道被授予资格', Array.isArray(s.policyArtifact?.eligibleChannels) && s.policyArtifact.eligibleChannels.includes('lexicon'),
    JSON.stringify(s.policyArtifact?.eligibleChannels))
  check('⑤ 卡口不再拦截', s.capabilityGate === null, String(s.capabilityGate))
  const { session } = adoptAndLift('gate-E')
  deviate(session)
  const row = await rowOf('gate-E')
  check('⑤ 资格真的生效：同一偏离此时收窄', row.narrowedNow === true, `${row.surfacePhase}/${row.policyReason}`)
}
// 同一会话形状，但标定件把 actAlpha 反解为 1e-5 → 生效门限必须真的变成 1e-5
await boot({
  rollbackEnabled: true, notifyEnabled: true,
  responsePolicyPath: write('pass-tight.json', {
    verdict: 'PASS', capabilityEligibleChannels: ['lexicon'],
    channels: { lexicon: { derived: { consecutive: 1, alpha: 0.00001 } } },
  }),
  responseChannels: { lexicon: { capabilityEligible: false, actAlpha: 0.01, notifyAlpha: 0.05 } },
})
{
  const { session } = adoptAndLift('gate-E2')
  deviate(session)
  const row = await rowOf('gate-E2')
  const lex = (row.channels || []).find((c) => c.name === 'lexicon') || {}
  check('⑤ 反解参数写入生效配置（可见于通道行）',
    lex.actAlpha === 0.00001 && lex.consecutive === 1, JSON.stringify({ a: lex.actAlpha, k: lex.consecutive }))
  // 该偏离的真 p 约 3e-3：在 actAlpha=0.01（⑤ 宽档，已断言收窄）下够行动级，
  // 在反解出来的 actAlpha=1e-5 下只够通知级 ⇒ 同一形状必须给出不同动作。
  // （这是双向对照：放宽会收窄、收紧不收窄，任一侧失效都会被抓住。）
  check('⑤ 反解 α 真正进门限：同一偏离在 1e-5 下只通知、不动能力面',
    row.narrowedNow === false && row.policyAction === 'notice' && row.policyReason === 'deviation-weak',
    `${row.policyAction}/${row.policyReason}/p=${row.policyP}`)
}

// ── ⑥ consecutive=k 必须真的攒够 k 次（双向：k=3 不能提前动手，也不能永不动作）──
await boot({
  rollbackEnabled: true, notifyEnabled: true,
  responsePolicyPath: write('pass-k.json', {
    verdict: 'PASS', capabilityEligibleChannels: ['lexicon'],
    channels: { lexicon: { derived: { consecutive: 3, alpha: 0.01 } } },
  }),
  responseChannels: { lexicon: { capabilityEligible: false, actAlpha: 0.01, notifyAlpha: 0.05, consecutive: 1 } },
})
{
  const { session } = adoptAndLift('gate-K')
  for (let i = 0; i < 16; i++) sessionEvent(session, text('We will run the full build and verify each artifact carefully.'))
  // 实测 p 序列（tools/scratch 探针）：neg#1 p=null → #2 p≈0.04 → #3..#6 p≈3e-3
  // ⇒ k=3 下第 5 步（#3#4#5 连续三次行动级命中）才该动手；
  // 若 consecutive 被忽略，第 3 步就会动手 → 被抓住。
  sessionEvent(session, text('let me just try something quick here'))
  const r1 = await rowOf('gate-K')
  check('⑥ k=3：第 1 步（p=null）不动手', r1.narrowedNow === false, `${r1.policyAction}/${r1.policyReason}`)
  sessionEvent(session, text('let me just try something quick here'))
  check('⑥ k=3：第 2 步（p≈0.04，未到行动级）不动手', (await rowOf('gate-K')).narrowedNow === false)
  sessionEvent(session, text('let me just try something quick here'))
  const r3 = await rowOf('gate-K')
  const lex3 = (r3.channels || []).find((c) => c.name === 'lexicon') || {}
  check('⑥ k=3：行动级连续命中只记到 1 次，不动手（提前动手会被抓住）',
    r3.narrowedNow === false && lex3.p <= 0.01 && lex3.fireRun === 1,
    `p=${lex3.p} fireRun=${lex3.fireRun} action=${r3.policyAction}`)
  sessionEvent(session, text('let me just try something quick here'))
  const r4 = await rowOf('gate-K')
  const lex4 = (r4.channels || []).find((c) => c.name === 'lexicon') || {}
  check('⑥ k=3：连续 2 次仍不动手', r4.narrowedNow === false && lex4.fireRun === 2, `fireRun=${lex4.fireRun}`)
  sessionEvent(session, text('let me just try something quick here'))
  const r5 = await rowOf('gate-K')
  check('⑥ k=3：连续 3 次 → 收窄（永不动作也会被抓住）',
    r5.narrowedNow === true && r5.surfacePhase === 'narrowed', `${r5.policyAction}/${r5.policyReason}`)
}

// ── ⑩ 连续计数必须与门限**同层**（专抓"用通知级命中凑行动级 k"这种混层）──────
// 构造：actAlpha=3e-4、notifyAlpha=0.05、k=3（都显式给出，不依赖默认）。
// 实测 p 序列：neg#1 p=null → #2 p≈0.04 → #3 起 p≈2.2e-4。
//   · 行动级命中（p≤3e-4）从 #3 才开始 ⇒ 正确语义在第 5 步（#3#4#5）才动手；
//   · 混层语义（旧实现用 notifyAlpha 计数）前两步就攒够，第 4 步即动手。
// 因此第 4 步的"不动手 + notifyRun 已≥3 + fireRun<3"同时把两种语义分开；
// 第 5 步则证明计数器终究会到位（否则"永不动作"也能通过，等于没有断言）。
await boot({
  rollbackEnabled: true, notifyEnabled: true,
  responseChannels: { lexicon: { capabilityEligible: true, actAlpha: 0.0003, notifyAlpha: 0.05, consecutive: 3 } },
})
{
  const { session } = adoptAndLift('gate-tier')
  for (let i = 0; i < 16; i++) sessionEvent(session, text('We will run the full build and verify each artifact carefully.'))
  for (let i = 0; i < 4; i++) sessionEvent(session, text('let me just try something quick here'))
  const before = await rowOf('gate-tier')
  const lex = (before.channels || []).find((c) => c.name === 'lexicon') || {}
  check('⑩ 通知级命中不得计入行动级连续：第 4 步仍不动手',
    before.narrowedNow === false && before.policyAction !== 'narrow', `${before.policyAction}/${before.policyReason}/p=${before.policyP}`)
  check('⑩ 两级计数分别可见（行动级未达 k / 通知级已攒够）',
    lex.fireRun < 3 && lex.notifyRun >= 3 && lex.consecutive === 3, JSON.stringify({ act: lex.fireRun, not: lex.notifyRun, k: lex.consecutive }))
  // 继续驱动直到动手（最多再 4 步）：证明计数器终究会到位。
  // 不写死"第 N 步动手"——那会把测试绑死在某个合成会话的具体 p 序列上，
  // 但也不能只断言"不动手"（那样"永不动作"也能通过）。
  let narrowedAt = null
  for (let k = 5; k <= 8 && narrowedAt === null; k++) {
    sessionEvent(session, text('let me just try something quick here'))
    const row = await rowOf('gate-tier')
    if (row.narrowedNow === true) narrowedAt = k
  }
  const fin = await rowOf('gate-tier')
  const lexFin = (fin.channels || []).find((c) => c.name === 'lexicon') || {}
  check('⑩ 行动级连续计数最终到位 → 动手（计数器不是永不动作）',
    narrowedAt !== null && lexFin.fireRun >= 3, `narrowedAt=${narrowedAt} fireRun=${lexFin.fireRun}`)
}

// ── ⑨ α 门限双向对照：同一偏离在宽/窄 notifyAlpha 下必须给出不同动作 ─────────
// 目的：证明决策路径真的读了通道自己的 actAlpha/notifyAlpha，而不是硬编码。
// 用 p≈0.04 这一步（实测 neg#2）：notifyAlpha=0.05 → notice；notifyAlpha=1e-4 → none。
for (const [label, na, expect] of [['宽档 0.05', 0.05, 'notice'], ['窄档 1e-4', 0.0001, 'none']]) {
  await boot({
    rollbackEnabled: true, notifyEnabled: true,
    responseChannels: { lexicon: { capabilityEligible: true, actAlpha: 0.01, notifyAlpha: na } },
  })
  const { session } = adoptAndLift('gate-alpha-' + na)
  for (let i = 0; i < 16; i++) sessionEvent(session, text('We will run the full build and verify each artifact carefully.'))
  sessionEvent(session, text('let me just try something quick here'))
  sessionEvent(session, text('let me just try something quick here'))
  const row = await rowOf('gate-alpha-' + na)
  const lex = (row.channels || []).find((c) => c.name === 'lexicon') || {}
  check(`⑨ notifyAlpha=${label} → 同一 p=${lex.p} 的动作必须是 ${expect}`,
    row.policyAction === expect && lex.notifyAlpha === na, `action=${row.policyAction} reason=${row.policyReason}`)
}

// ── ⑦ 在线自动降档 ──────────────────────────────────────────────────────
await boot({
  ...ARMED,
  responsePolicyPath: write('pass-demote.json', { verdict: 'PASS', capabilityEligibleChannels: ['lexicon'] }),
  autoDemoteWindow: 3, autoDemoteBudget: 0.05,
})
{
  for (const sid of ['demote-1', 'demote-2', 'demote-3']) {
    const { session } = adoptAndLift(sid)
    deviate(session)
    const row = await rowOf(sid)
    check(`⑦ ${sid} 先收窄（降档的前置条件）`, row.narrowedNow === true, `${row.surfacePhase}/${row.policyReason}`)
    closeSession(sid)
  }
  const after = await statusOf()
  check('⑦ 窗口内连续 3 个会话都收窄 → 自动降档',
    after.autoDemote?.reason === 'session-rate-over-budget', JSON.stringify(after.autoDemote))
  check('⑦ 降档后有效开关变为关闭',
    after.config.effectiveRollback === false && after.config.effectiveNotify === false, String(after.capabilityGate))
  check('⑦ 卡口原因写明自动降档', String(after.capabilityGate).startsWith('auto-demoted:'), String(after.capabilityGate))
  check('⑦ 会话窗口统计可见', after.sessionOutcomes?.window === 3 && after.sessionOutcomes?.narrowed === 3, JSON.stringify(after.sessionOutcomes))
  const { session } = adoptAndLift('demote-4')
  deviate(session)
  const row4 = await rowOf('demote-4')
  check('⑦ 降档后新会话不再收窄（只观察）', row4.narrowedNow === false, `${row4.surfacePhase}/${row4.policyReason}`)
  check('⑦ 降档后仍未收窄的会话不改写窗口结论', (await statusOf()).autoDemote?.reason === 'session-rate-over-budget')
}

// ── ⑧ 负向对照：门禁不可用也必须"响亮"，且不得静默放行 ─────────────────────
await boot({ ...ARMED, responsePolicyPath: write('broken.json', null) })
{
  const { session } = adoptAndLift('gate-F')
  deviate(session)
  const row = await rowOf('gate-F')
  const s = await statusOf()
  check('⑧ 标定件无法解析 → 只观察（fail-safe）', row.narrowedNow === false && s.capabilityGate === 'policy-REJECTED', String(s.capabilityGate))
  check('⑧ 解析失败有响亮告警', warnings.some((w) => /failed to load response policy/.test(w)), JSON.stringify(warnings.slice(0, 1)))
}

// ── ⑪ 出厂标定件必须真的能授权（端到端：标定工具产物 → 运行时加载器 → 生效参数）──
// 守两个实测踩到的断点：
//   · 标定工具以前**不产出** derived(k,α) ⇒ 反解结果永远上不了线（加载器支持但没人写）；
//   · 标定工具以前写 measurementSafe: true ⇒ 装载即强制只观察，"有资格却永远不动手"。
{
  const shipped = resolve(here, '..', 'responsePolicy.json')
  const art = JSON.parse(readFileSync(shipped, 'utf8'))
  check('⑪ 出厂标定件存在且裁决为 PASS/PARTIAL-PASS',
    ['PASS', 'PARTIAL-PASS'].includes(art.verdict), String(art.verdict))
  check('⑪ 出厂标定件不得自带 measurementSafe（否则装载即永久只观察）', art.measurementSafe !== true, String(art.measurementSafe))
  check('⑪ 每个有资格通道都带 derived(k,α)',
    (art.capabilityEligibleChannels || []).every((c) => art.channels?.[c]?.derived
      && Number.isFinite(art.channels[c].derived.alpha) && Number.isFinite(art.channels[c].derived.consecutive)),
    JSON.stringify(art.capabilityEligibleChannels || []))
  await boot({ rollbackEnabled: true, notifyEnabled: true, responsePolicyPath: shipped })
  const s = await statusOf()
  check('⑪ 装载出厂标定件后卡口放行', s.capabilityGate === null, String(s.capabilityGate))
  check('⑪ 授权通道与产物一致', JSON.stringify(s.policyArtifact?.eligibleChannels) === JSON.stringify(art.capabilityEligibleChannels),
    JSON.stringify(s.policyArtifact?.eligibleChannels))
  const { session } = adoptAndLift('gate-shipped')
  deviate(session)
  const row = await rowOf('gate-shipped')
  let ok = true
  const seen = {}
  for (const name of art.capabilityEligibleChannels || []) {
    const ch = (row.channels || []).find((c) => c.name === name)
    const d = art.channels[name].derived
    seen[name] = ch ? { a: ch.actAlpha, k: ch.consecutive } : null
    if (!ch || ch.actAlpha !== d.alpha || ch.consecutive !== d.consecutive) ok = false
  }
  check('⑪ 反解参数真正写进生效配置', ok, JSON.stringify(seen))
  const failCh = (row.channels || []).find((c) => c.name === 'failure')
  check('⑪ notify-only 通道未被授予资格', failCh && failCh.eligible === false, JSON.stringify(failCh && { e: failCh.eligible, a: failCh.actAlpha }))
}

console.warn = origWarn
console.error = origError
console.log(`\n${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
