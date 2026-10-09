/**
 * test-trial-release.mjs —— **人工试运行放行**的机制与闸门测试
 *
 * 为什么需要这条路径（以及为什么它必须被守得这么紧）：
 *   L3.3（结局回灌）只归因于 `didNarrow === true` 的会话——这是修掉"用没干预的会话评价
 *   干预"那条方向不安全缺陷时定下的口径。而 `didNarrow` 只有**能力层真的收窄过**才置位，
 *   能力层又被标定件的 FAIL 关着 ⇒ **L3.3 在能力层打开之前永远攒不到数据**（结构性死锁）。
 *   `trialRelease` 是唯一出口：显式点名的通道 + 显式工作点 α + **必须有到期时间**。
 *
 * 断言口径（每条正向都配反向对照）：
 *   · 默认（不配）⇒ 这条路径根本不存在；
 *   · 配了放行 + 该通道够显著 ⇒ 真的收窄，且卡口原因写明 **trial-release**（不是标定授权）；
 *   · 反向对照：没点名的通道、α 不够显著、已过期、measurementSafe、autoDemote ⇒ **一律不动手**；
 *   · 配置写错（空名单 / 未知通道 / α 非法 / 缺期限 / 期限非法）⇒ 全部作废并响亮告警；
 *   · 可见性：状态里 trialRelease 块 + 通道行 trialRelease 标记 + 审计 trial-release-armed。
 *
 * 用法：node tools/test-trial-release.mjs [index.js 路径]
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

const dir = mkdtempSync(join(tmpdir(), 'trial-release-'))
const write = (name, obj) => {
  const p = join(dir, name)
  writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8')
  return p
}
const FAIL_ARTIFACT = write('fail.json', { verdict: 'FAIL', capabilityEligibleChannels: ['lexicon'] })
const FAR_FUTURE = '2099-01-01T00:00:00.000Z'
const PAST = '2020-01-01T00:00:00.000Z'

const TOOLS = ['pwsh', 'read', 'edit', 'grep', 'browser_open', 'browser_type', 'vision_crop', 'todo_write'].map((n) => ({ name: n }))
const text = (s) => ({ type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: s }] } } })

let handlers = {}
let registeredTools = {}
const agentsById = new Map()
const warnings = []
const origWarn = console.warn
console.warn = (...a) => { warnings.push(a.join(' ')) }

async function boot(config) {
  handlers = {}
  registeredTools = {}
  agentsById.clear()
  warnings.length = 0
  const ctx = {
    get: (n) => {
      if (n === 'tools') return { register: (t) => { registeredTools[t.name] = t; return () => {} } }
      if (n === 'agents') return { get: (id) => agentsById.get(id), list: () => [...agentsById.values()] }
      return undefined
    },
    on: (n, fn) => { handlers[n] = fn; return () => {} },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  }
  await mod.apply(ctx, { adaptiveStateEnabled: false, ...config })
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
/** 与 test-policy-gate 同源：参考段 16 步正词 + 检验窗 4 步负词
 *  ⇒ 在 actAlpha=0.01 下必然触发、在 1e-5 下必然不触发。 */
function deviate(session) {
  for (let i = 0; i < 16; i++) sessionEvent(session, text('We will run the full build and verify each artifact carefully.'))
  for (let i = 0; i < 4; i++) sessionEvent(session, text('let me just try something quick here'))
}
const statusOf = async () => registeredTools.anchor_status.execute({})
const rowOf = async (sid) => (await statusOf()).rows.find((r) => r.sessionId === sid)

/** 试运行块 + 卡口原因 + 是否真的收窄，一次读齐（所有用例共用同一组观测量）。 */
async function probe(sid) {
  const s = await statusOf()
  const row = s.rows.find((r) => r.sessionId === sid)
  return { s, row, narrowed: Boolean(row && row.narrowedNow === true), gate: s.capabilityGate, trial: s.trialRelease }
}

// ── ① 默认：这条路径根本不存在 ─────────────────────────────────────────────
await boot({ rollbackEnabled: false, responsePolicyPath: FAIL_ARTIFACT })
{
  const { session } = adoptAndLift('tr-off')
  deviate(session)
  const p = await probe('tr-off')
  check('① 不配 trialRelease ⇒ 仍然是只观察', p.narrowed === false && p.gate === 'policy-REJECTED', `${p.row.surfacePhase}/${p.gate}`)
  check('① 状态里 trialRelease 为 null（不存在这条路径）', p.trial === null, JSON.stringify(p.trial))
}

// ── ② 点名放行 + 够显著 ⇒ 真的收窄，且写明"这不是标定授权" ─────────────────
const RELEASE_LEX = { channels: ['lexicon'], alpha: 0.01, until: FAR_FUTURE, note: '为 L3.3 挣真实干预样本' }
await boot({ rollbackEnabled: false, responsePolicyPath: FAIL_ARTIFACT, trialRelease: RELEASE_LEX })
{
  const { session } = adoptAndLift('tr-on')
  deviate(session)
  const p = await probe('tr-on')
  check('② 放行的通道够显著 ⇒ 真的收窄', p.narrowed === true && p.row.surfacePhase === 'narrowed', `${p.row.surfacePhase}/${p.row.policyReason}`)
  check('② 卡口原因写明 trial-release（不是 policy-PASS）',
    p.gate === 'trial-release:lexicon', String(p.gate))
  check('② 状态里能看到通道/工作点/到期时间/理由',
    p.trial && p.trial.active === true && p.trial.alpha === 0.01 && p.trial.channels.join() === 'lexicon'
    && p.trial.until === FAR_FUTURE && typeof p.trial.remainingMs === 'number' && p.trial.remainingMs > 0,
    JSON.stringify(p.trial))
  check('② 通道行标出这次资格来自试运行', (p.row.channels || []).some((c) => c.name === 'lexicon' && c.trialRelease === true),
    JSON.stringify((p.row.channels || []).find((c) => c.name === 'lexicon')))
  check('② 审计留痕 trial-release-armed（本会话状态里可见）', p.row.trialReleaseArmed === 'lexicon', String(p.row.trialReleaseArmed))
}

// ── ③ 反向对照：只有"点名"的通道被放行（不许泄漏到别的通道）────────────────
await boot({ rollbackEnabled: false, responsePolicyPath: FAIL_ARTIFACT, trialRelease: { ...RELEASE_LEX, channels: ['repetition'] } })
{
  const { session } = adoptAndLift('tr-other')
  deviate(session)
  const p = await probe('tr-other')
  const lex = (p.row.channels || []).find((c) => c.name === 'lexicon') || {}
  const rep = (p.row.channels || []).find((c) => c.name === 'repetition') || {}
  check('③ 反向对照：点名 repetition ⇒ 同一段偏离（走 lexicon）不动手', p.narrowed === false, `${p.row.surfacePhase}/${p.row.policyReason}`)
  check('③ 反向对照：放行没有泄漏给未点名的通道（lexicon 仍无资格/非试运行）',
    lex.trialRelease === false && lex.eligible === false, JSON.stringify({ tr: lex.trialRelease, el: lex.eligible }))
  check('③ 反向对照：被点名的通道确实拿到了试运行标记', rep.trialRelease === true, JSON.stringify({ tr: rep.trialRelease }))
}

// ── ④ 反向对照：放行**不放宽**统计门槛（α 更严 ⇒ 不触发）────────────────────
await boot({ rollbackEnabled: false, responsePolicyPath: FAIL_ARTIFACT, trialRelease: { ...RELEASE_LEX, alpha: 1e-5 } })
{
  const { session } = adoptAndLift('tr-strict')
  deviate(session)
  const p = await probe('tr-strict')
  check('④ 反向对照：试运行 α=1e-5 ⇒ 同一段偏离够不上，仍不动手',
    p.narrowed === false && p.gate === 'trial-release:lexicon', `${p.row.surfacePhase}/${p.gate}`)
}

// ── ⑤ measurementSafe / 到期 / autoDemote：三道更硬的闸门优先 ───────────────
await boot({ rollbackEnabled: false, responsePolicyPath: FAIL_ARTIFACT, trialRelease: RELEASE_LEX, measurementSafe: true })
{
  const { session } = adoptAndLift('tr-safe')
  deviate(session)
  const p = await probe('tr-safe')
  check('⑤ 反向对照：measurementSafe ⇒ 试运行也让位（gate=measurement-safe）',
    p.narrowed === false && p.gate === 'measurement-safe', `${p.row.surfacePhase}/${p.gate}`)
}
await boot({ rollbackEnabled: false, responsePolicyPath: FAIL_ARTIFACT, trialRelease: RELEASE_LEX, autoDemoteWindow: 1, autoDemoteBudget: 0 })
{
  // 第一个会话按放行收窄 ⇒ 窗口 1/1、比例 1 > 预算 0 ⇒ 立即自动降档
  const a = adoptAndLift('tr-demote-1')
  deviate(a.session)
  dispatch('agent/disposed', { agent: a.agent })
  const b = adoptAndLift('tr-demote-2')
  deviate(b.session)
  const p = await probe('tr-demote-2')
  check('⑤ 反向对照：自动降档生效后 ⇒ 试运行也让位（gate 写明 auto-demoted）',
    p.narrowed === false && /auto-demoted/.test(String(p.gate)), `${p.row.surfacePhase}/${p.gate}`)
  check('⑤ 前一个会话确实收窄过（说明降档是被它触发的）', p.s.sessionOutcomes.narrowed >= 1, JSON.stringify(p.s.sessionOutcomes))
}
{
  await boot({ rollbackEnabled: false, responsePolicyPath: FAIL_ARTIFACT, trialRelease: { ...RELEASE_LEX, until: PAST } })
  const { session } = adoptAndLift('tr-expired')
  deviate(session)
  const p = await probe('tr-expired')
  check('⑤ 反向对照：已到期 ⇒ 自动回到只观察', p.narrowed === false && p.gate === 'policy-REJECTED', `${p.row.surfacePhase}/${p.gate}`)
  check('⑤ 状态里保留"配了但已失效"的事实（不静默消失）',
    p.trial && p.trial.active === false && p.trial.configured === true && /expired/.test(String(p.trial.reason)),
    JSON.stringify(p.trial))
}

// ── ⑥ 配置守卫：写错就整条作废（fail-safe 回到只观察）+ 响亮告警 ────────────
const BAD = [
  ['通道表为空', { channels: [], alpha: 0.01, until: FAR_FUTURE }],
  ['未知通道', { channels: ['no-such-channel'], alpha: 0.01, until: FAR_FUTURE }],
  ['α 非法（0）', { channels: ['lexicon'], alpha: 0, until: FAR_FUTURE }],
  ['α 非法（>1）', { channels: ['lexicon'], alpha: 1.5, until: FAR_FUTURE }],
  ['缺到期时间', { channels: ['lexicon'], alpha: 0.01 }],
  ['到期时间不是时间戳', { channels: ['lexicon'], alpha: 0.01, until: 'someday' }],
]
for (const [label, cfg] of BAD) {
  await boot({ rollbackEnabled: false, responsePolicyPath: FAIL_ARTIFACT, trialRelease: cfg })
  const { session } = adoptAndLift(`tr-bad-${label}`)
  deviate(session)
  const p = await probe(`tr-bad-${label}`)
  check(`⑥ 配置写错（${label}）⇒ 只观察 + 响亮告警`,
    p.narrowed === false && p.gate === 'policy-REJECTED' && warnings.some((w) => /trialRelease/.test(w)),
    `${p.row.surfacePhase}/${p.gate} warn=${warnings.filter((w) => /trialRelease/.test(w)).length}`)
}

console.warn = origWarn
console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
