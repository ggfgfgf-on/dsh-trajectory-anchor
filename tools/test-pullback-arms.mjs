/**
 * test-pullback-arms.mjs —— L4 观测单元测试：**两臂对称 + 按触发点记账**
 *
 * 这个套件守的是一个被真实数据打出来的**测量口径缺陷**（2026-10-08 在线数据）：
 *   · 旧实现把"说过之后"的计数器挂在 `rec.pullback.count > 0` 上 ⇒ 对照臂（触发但
 *     故意不说）永远拿不到窗口，它的 verifiesAfterPullback 恒为 0；
 *   · 而分析器的 good() 要求 verifiesAfterPullback > 0 ⇒ 对照臂**恒为"未改善"**，
 *     两臂 Fisher 比较变成"有窗口 vs 没窗口"，会**假阳性**地开 L2 的门；
 *   · 同时一行一条记录，arm = count>0 ? intervened : control ⇒ 同会话里出现的对照
 *     触发被静默并入 intervened（真数据里就有一条 `pullbacks:1, controls:1` 的行）。
 *
 * 断言口径（每条正向都配反向对照）：
 *   · 同样的事件序列，**只换臂** ⇒ 指标必须完全相同（对称性 = 本套件的核心）；
 *   · 没有触发点 ⇒ 一行都不许写（不许拿"会话里说过话"当兜底）；
 *   · 同会话两臂各自一行，各自一个窗口（不是会话级窗口）。
 *
 * 用法：node tools/test-pullback-arms.mjs [index.js 路径]
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
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

const TOOLS = ['pwsh', 'read', 'edit', 'write', 'grep'].map((n) => ({ name: n }))
const PROMPT = 'The directory bugfix-a4 in the current workspace contains calc.py with several planted bugs and test_calc.py. '
  + 'Run the tests (python test_calc.py), find and fix ALL bugs in calc.py, and rerun until every test passes. '
  + 'Work only inside bugfix-a4. Report ONE line: PASS=<n>/7'

const dir = mkdtempSync(join(tmpdir(), 'pb-arms-'))
const OUT = join(dir, 'outcomes.jsonl')

let handlers = {}
let registered = {}
const agents = new Map()
const origWarn = console.warn

async function boot(config) {
  handlers = {}
  registered = {}
  agents.clear()
  console.warn = () => {}
  const ctx = {
    get: (n) => {
      if (n === 'tools') return { register: (t) => { registered[t.name] = t; return () => {} } }
      if (n === 'agents') return { get: (id) => agents.get(id), list: () => [...agents.values()] }
      return undefined
    },
    on: (n, fn) => { handlers[n] = fn; return () => {} },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  }
  // adaptiveStateEnabled: false —— 各套件互不继承记忆（C21 守这条）
  await mod.apply(ctx, { adaptiveStateEnabled: false, ...config })
}
const dispatch = (name, ...args) => handlers['internal/dispatch']('x', name, args, null)
const sessionEvent = (session, event) => dispatch('session/event', session, event)

function adopt(sid) {
  const agent = { id: sid, session: { id: sid, events: [] }, ctx: { tools: { schemas: () => TOOLS.map((t) => ({ ...t })), restrict: () => () => {} } } }
  agents.set(sid, agent)
  dispatch('agent/created', { agent })
  return { agent, session: { id: sid } }
}
const human = (text) => ({ type: 'user/message', data: { source: { kind: 'user' }, role: 'user', content: [{ type: 'text', text }] } })
const call = (name, args, turn, step) => ({ type: 'tool/call', data: { name, arguments: JSON.stringify(args), turn, step } })
const preStep = async (agent, turn, step) => handlers['agent/pre-step']({ agent, turn, step, messages: [] }, async () => ({ kind: 'continue', messages: [] }))
const statusOf = async (sid) => (await registered.anchor_status.execute({})).rows.find((r) => r.sessionId === sid)

const VERIFY = { command: 'python test_calc.py', workdir: 'D:\\DSHwork\\bugfix-a4' }
const EDIT_OK = { file_path: 'D:\\DSHwork\\bugfix-a4\\calc.py', old_string: 'a', new_string: 'b' }
const EDIT_OUT = { file_path: 'D:\\DSHwork\\bugfix-a1\\calc.py', old_string: 'a', new_string: 'b' }

/** 以固定随机数跑一次 pre-step：0 ⇒ 必进对照臂；0.99 ⇒ 必进干预臂（rate<0.99 时）。 */
async function preStepWithRandom(agent, turn, step, r) {
  const orig = Math.random
  Math.random = () => r
  try { return await preStep(agent, turn, step) } finally { Math.random = orig }
}

function rowsFor(sid) {
  if (!existsSync(OUT)) return []
  return readFileSync(OUT, 'utf8').split('\n').filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    .filter((r) => r.sessionId === sid)
}

/**
 * 一个最小会话：越界写（置位待发提醒）→ 一次触发（臂由 random 决定）→ 可选验证 → 关闭。
 * 返回落盘行。**臂由 boot 的 pullbackControlRate + 这里的 r 共同决定**：
 *   rate=1 + r=0 ⇒ 必进对照臂；rate=0 ⇒ 必进干预臂；rate=0.5 则 r=0 / r=0.99 分开两臂。
 */
async function session(sid, { r, verifyAfter = false, dispose = true }) {
  const { agent, session: s } = adopt(sid)
  sessionEvent(s, human(PROMPT))
  sessionEvent(s, call('edit', EDIT_OUT, 1, 1))
  await preStepWithRandom(agent, 1, 2, r)
  if (verifyAfter) sessionEvent(s, call('pwsh', VERIFY, 1, 3))
  if (dispose) dispatch('agent/disposed', { agent })
  return rowsFor(sid)
}

// ── ① 对照臂也被测量（旧实现在这里恒为 0）────────────────────────────────────
await boot({ pullbackEnabled: true, pullbackControlRate: 1, pullbackOutcomePath: OUT })
{
  const rows = await session('arms-control', { rate: 1, r: 0, verifyAfter: true })
  check('① 对照臂触发 ⇒ 落一行', rows.length === 1, `rows=${rows.length}`)
  const r0 = rows[0] || {}
  check('① 该行 arm=control 且 intervened=false', r0.arm === 'control' && r0.intervened === false, JSON.stringify({ arm: r0.arm, i: r0.intervened }))
  check('① **对照臂的观测窗口被真的计数**（verifiesAfterPullback ≥ 1）', r0.verifiesAfterPullback >= 1, String(r0.verifiesAfterPullback))
  check('① 行是 v2 口径（schemaVersion=2 + triggersInSession）', r0.schemaVersion === 2 && r0.triggersInSession === 1, JSON.stringify({ v: r0.schemaVersion, t: r0.triggersInSession }))
  check('① 行带该触发点的位置与原因', r0.triggerIndex === 1 && r0.triggerTurn === 1 && r0.triggerStep === 2 && r0.reason === 'scope',
    JSON.stringify({ i: r0.triggerIndex, t: r0.triggerTurn, s: r0.triggerStep, why: r0.reason }))
}

// ── ② 对称性：同样事件、只换臂 ⇒ 指标必须相同 ──────────────────────────────
{
  // 对照臂那次用 rate=1（必不说）；干预臂那次用 rate=0（必说）。其余事件序列逐字相同。
  const ctrl = (await session('arms-sym-control', { r: 0, verifyAfter: true }))[0] || {}
  await boot({ pullbackEnabled: true, pullbackControlRate: 0, pullbackOutcomePath: OUT })
  const intr = (await session('arms-sym-intervened', { r: 0.99, verifyAfter: true }))[0] || {}
  check('② 前置：两次会话各落一行、臂相反', ctrl.arm === 'control' && intr.arm === 'intervened', JSON.stringify({ c: ctrl.arm, i: intr.arm }))
  check('② **两臂窗口计数完全相同**（对称性是本套件的核心断言）',
    ctrl.verifiesAfterPullback === intr.verifiesAfterPullback && ctrl.scopeViolationsAfter === intr.scopeViolationsAfter,
    JSON.stringify({ control: [ctrl.verifiesAfterPullback, ctrl.scopeViolationsAfter], intervened: [intr.verifiesAfterPullback, intr.scopeViolationsAfter] }))
  check('② 反向对照：干预臂那条确实是"说过话"的', intr.intervened === true && ctrl.intervened === false)
}

// ── ③ 同会话两臂 ⇒ 两行，各归各臂（旧实现只写一行并标成 intervened）─────────
await boot({ pullbackEnabled: true, pullbackControlRate: 0.5, pullbackOutcomePath: OUT })
{
  const sid = 'arms-both'
  const { agent, session: s } = adopt(sid)
  sessionEvent(s, human(PROMPT))
  sessionEvent(s, call('edit', EDIT_OUT, 1, 1))
  await preStepWithRandom(agent, 1, 2, 0)      // 0 < 0.5 ⇒ 对照臂（故意不说）
  sessionEvent(s, call('pwsh', VERIFY, 1, 3))  // 触发点 1 之后的一次验证
  sessionEvent(s, call('edit', EDIT_OUT, 2, 1))
  await preStepWithRandom(agent, 2, 2, 0.99)   // 0.99 ≥ 0.5 ⇒ 干预臂（真的说）
  // 状态要在关闭**之前**读：closeRec 会把 rec 从 recs 里删掉（关闭后 anchor_status 不再有这一行）
  const row = await statusOf(sid)
  dispatch('agent/disposed', { agent })
  const rows = rowsFor(sid)
  check('③ 同会话两条臂 ⇒ 落两行（不是一行）', rows.length === 2, `rows=${rows.length}`)
  check('③ 两行各归各臂（对照不再被并入 intervened）',
    rows.length === 2 && rows[0].arm === 'control' && rows[1].arm === 'intervened',
    JSON.stringify(rows.map((r) => r.arm)))
  check('③ 每行都标同一会话的触发点数与自身序号',
    rows.length === 2 && rows.every((r) => r.triggersInSession === 2) && rows[0].triggerIndex === 1 && rows[1].triggerIndex === 2,
    JSON.stringify(rows.map((r) => [r.triggerIndex, r.triggersInSession])))
  check('③ **窗口按触发点算**（触发点 1 之后有验证、触发点 2 之后没有）',
    rows.length === 2 && rows[0].verifiesAfterPullback === 1 && rows[1].verifiesAfterPullback === 0,
    JSON.stringify(rows.map((r) => r.verifiesAfterPullback)))
  check('③ 会话级字段显式标注且两行一致',
    rows.length === 2 && Array.isArray(rows[0].sessionLevelFields)
    && rows[0].sessionLevelFields.includes('claimedUnverifiedAfter')
    && rows[0].claimedUnverifiedAfter === rows[1].claimedUnverifiedAfter
    && rows[0].endedNarrowed === rows[1].endedNarrowed,
    JSON.stringify(rows[0].sessionLevelFields))
  check('③ 关闭前状态里两臂与 mark 都在位（落盘发生在关闭时，故 outcomeRows 仍为 0）',
    row && row.pullback.triggers === 2 && row.pullback.triggersByArm.control === 1 && row.pullback.triggersByArm.intervened === 1
    && row.pullback.verifyMarks === 1 && row.pullback.violationMarks === 2 && row.pullback.outcomeRows === 0,
    JSON.stringify(row && { t: row.pullback.triggers, by: row.pullback.triggersByArm, vm: row.pullback.verifyMarks, xm: row.pullback.violationMarks, o: row.pullback.outcomeRows }))
}

// ── ④ 越界写窗口同样两臂对称 ───────────────────────────────────────────────
await boot({ pullbackEnabled: true, pullbackControlRate: 1, pullbackOutcomePath: OUT })
{
  const sid = 'arms-violation'
  const { agent, session: s } = adopt(sid)
  sessionEvent(s, human(PROMPT))
  sessionEvent(s, call('edit', EDIT_OUT, 1, 1))
  await preStepWithRandom(agent, 1, 2, 0)        // 对照臂触发
  sessionEvent(s, call('edit', EDIT_OUT, 1, 3))  // 触发点之后又越界一次
  dispatch('agent/disposed', { agent })
  const rows = rowsFor(sid)
  check('④ 对照臂之后的越界写被计入 scopeViolationsAfter（旧实现恒为 0）',
    rows.length === 1 && rows[0].arm === 'control' && rows[0].scopeViolationsAfter === 1,
    JSON.stringify(rows.map((r) => [r.arm, r.scopeViolationsAfter])))
  check('④ 反向对照：同一行的 verifiesAfterPullback 保持 0（没跑验证就是 0）',
    rows.length === 1 && rows[0].verifiesAfterPullback === 0, String(rows[0] && rows[0].verifiesAfterPullback))
}

// ── ⑤ 没有触发点 ⇒ 一行都不许写（负向：不许拿"说过话"当兜底）────────────────
{
  const sid = 'arms-no-trigger'
  const { agent, session: s } = adopt(sid)
  sessionEvent(s, human(PROMPT))
  sessionEvent(s, call('pwsh', VERIFY, 1, 1))
  sessionEvent(s, call('edit', EDIT_OUT, 1, 2))  // 置位了待发提醒，但**没有** pre-step ⇒ 没触发
  dispatch('agent/disposed', { agent })
  check('⑤ 有待发提醒但从未触发 ⇒ 不落行', rowsFor(sid).length === 0, `rows=${rowsFor(sid).length}`)
}

// ── ⑥ 拉回总开关关 ⇒ 不落行（负向 + 与采集开关解耦）────────────────────────
await boot({ pullbackEnabled: false, pullbackControlRate: 1, pullbackOutcomePath: OUT })
{
  const sid = 'arms-off'
  const { agent, session: s } = adopt(sid)
  sessionEvent(s, human(PROMPT))
  sessionEvent(s, call('edit', EDIT_OUT, 1, 1))
  await preStepWithRandom(agent, 1, 2, 0)
  sessionEvent(s, call('pwsh', VERIFY, 1, 3))
  dispatch('agent/disposed', { agent })
  check('⑥ 总开关关 ⇒ 既不说话也不落效果行', rowsFor(sid).length === 0, `rows=${rowsFor(sid).length}`)
}

// ── ⑦ 落盘行可无损 JSON 序列化（无 undefined / NaN）────────────────────────
{
  const all = rowsFor('arms-both')
  const round = all.map((r) => JSON.parse(JSON.stringify(r)))
  check('⑦ 行可无损 JSON 往返', JSON.stringify(round) === JSON.stringify(all), `${all.length} 行`)
}

console.warn = origWarn
try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响判定 */ }
console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
