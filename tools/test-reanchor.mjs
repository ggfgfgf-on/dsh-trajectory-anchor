/**
 * test-reanchor.mjs —— L2 重锚定的**门禁 + 机制 + 效果采集**测试（驱动真实 apply()）
 *
 * L2 是本插件最强的干预（改模型上下文内容），所以测试的重点不是"它能注入"，
 * 而是**门是关得住的**：没有在线证据、证据过期、verdict 不对、评测保护期、自动降档期，
 * 一律不许动手；只有"L1 已经说过话且仍无改善"才允许重锚定，且每会话只做一次。
 *
 * 用法：node tools/test-reanchor.mjs [index.js 路径]
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
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

const dir = mkdtempSync(join(tmpdir(), 'reanchor-'))
const writeEvidence = (name, obj) => {
  const p = join(dir, name)
  writeFileSync(p, obj === null ? 'not json' : JSON.stringify(obj, null, 2), 'utf8')
  return p
}
const PASS_EV = { verdict: 'PASS-online', pullbacksObserved: 12, effectiveness: { verifyWithin3: 0.5 }, generatedAtUtc: new Date().toISOString() }

const TOOLS = ['pwsh', 'read', 'edit', 'write'].map((n) => ({ name: n }))
const PROMPT = 'The directory bugfix-a4 contains calc.py and test_calc.py. Run the tests (python test_calc.py), '
  + 'find and fix ALL bugs in calc.py. Work only inside bugfix-a4. Report ONE line: PASS=<n>/7'
const PERSONA = 'You are a helpful software engineer assistant.'

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
const human = (text) => ({ type: 'user/message', data: { source: { kind: 'user' }, role: 'user', content: [{ type: 'text', text }] } })
const call = (name, args, turn, step) => ({ type: 'tool/call', data: { name, arguments: JSON.stringify(args), turn, step } })
const msg = (turn, step) => ({ type: 'assistant/message', data: { turn, step, message: { content: [{ type: 'reasoning', text: 'x' }] } } })
const VERIFY = { command: 'python test_calc.py', workdir: 'D:\\DSHwork\\bugfix-a4' }
const EDIT_OUT = { file_path: 'D:\\DSHwork\\bugfix-a1\\calc.py', old_string: 'a', new_string: 'b' }

function adopt(sid) {
  const agent = { id: sid, session: { id: sid, events: [] }, ctx: { tools: { schemas: () => TOOLS.map((t) => ({ ...t })), restrict: () => () => {} } } }
  agents.set(sid, agent)
  dispatch('agent/created', { agent })
  return { agent, session: { id: sid } }
}
async function preStep(agent, turn, step) {
  return handlers['agent/pre-step']({ agent, turn, step, messages: [] }, async () => ({ kind: 'continue', messages: [] }))
}
const injected = (d, kind) => (d && Array.isArray(d.messages) ? d.messages : []).filter((m) => m && m.source && m.source.kind === kind)
const textOf = (m) => (m && Array.isArray(m.content) ? m.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('') : '')
const statusOf = async (sid) => (await registered.anchor_status.execute({})).rows.find((r) => r.sessionId === sid)

/** 造一个"L1 已说过话"的会话（越界写 → pre-step 说一句），返回 agent/session。 */
async function sessionWithOnePullback(sid) {
  const { agent, session } = adopt(sid)
  sessionEvent(session, human(PROMPT))
  sessionEvent(session, call('edit', EDIT_OUT, 1, 1))
  const d = await preStep(agent, 1, 2)
  return { agent, session, first: d }
}

// ── ① 门禁：默认关 / 无证据 / 证据过期 / verdict 错 / 评测保护（全部不许动手）──
await boot({ pullbackEnabled: true, reanchorEnabled: true })
{
  const { agent } = await sessionWithOnePullback('ra-nogate')
  const d = await preStep(agent, 2, 1)
  const row = await statusOf('ra-nogate')
  check('① 开关打开但没有在线证据 ⇒ 不重锚定', injected(d, 'trajectory-anchor-reanchor').length === 0, `gate=${row.reanchor.gate}`)
  check('① 门的原因写明 no-online-evidence', row.reanchor.gate === 'no-online-evidence', String(row.reanchor.gate))
}
await boot({ pullbackEnabled: true, reanchorEnabled: true, reanchorEvidencePath: writeEvidence('expired.json', { ...PASS_EV, expiresAtUtc: '2020-01-01T00:00:00.000Z' }) })
{
  const { agent } = await sessionWithOnePullback('ra-expired')
  const d = await preStep(agent, 2, 1)
  const row = await statusOf('ra-expired')
  check('① 证据过期 ⇒ 不重锚定', injected(d, 'trajectory-anchor-reanchor').length === 0 && row.reanchor.gate === 'evidence-REJECTED',
    String(row.reanchor.gate))
  check('① 过期有响亮告警', warnings.some((w) => /re-anchor evidence rejected/.test(w)), JSON.stringify(warnings.slice(0, 1)))
}
await boot({ pullbackEnabled: true, reanchorEnabled: true, reanchorEvidencePath: writeEvidence('wrong.json', { verdict: 'PASS', pullbacksObserved: 3 }) })
{
  const { agent } = await sessionWithOnePullback('ra-wrongverdict')
  const d = await preStep(agent, 2, 1)
  const row = await statusOf('ra-wrongverdict')
  check('① verdict 不是 PASS-online ⇒ 不重锚定', injected(d, 'trajectory-anchor-reanchor').length === 0 && row.reanchor.gate === 'evidence-REJECTED', String(row.reanchor.gate))
}
await boot({ pullbackEnabled: true, reanchorEnabled: true, measurementSafe: true, reanchorEvidencePath: writeEvidence('pass.json', PASS_EV) })
{
  const { agent } = await sessionWithOnePullback('ra-measure')
  const d = await preStep(agent, 2, 1)
  const row = await statusOf('ra-measure')
  check('① 评测保护期 ⇒ 不重锚定', injected(d, 'trajectory-anchor-reanchor').length === 0 && row.reanchor.gate === 'measurement-safe', String(row.reanchor.gate))
}
await boot({ pullbackEnabled: true, reanchorEnabled: false, reanchorEvidencePath: writeEvidence('pass2.json', PASS_EV) })
{
  const { agent } = await sessionWithOnePullback('ra-off')
  const d = await preStep(agent, 2, 1)
  const row = await statusOf('ra-off')
  check('① 证据齐但开关关 ⇒ 不重锚定（默认安全）', injected(d, 'trajectory-anchor-reanchor').length === 0 && row.reanchor.gate === 'switch-off', String(row.reanchor.gate))
}
// 合成/演示证据不得开门（实测：第一版链路上合成证据把门打开了）
await boot({ pullbackEnabled: true, reanchorEnabled: true, reanchorEvidencePath: writeEvidence('synth.json', { ...PASS_EV, synthetic: true }) })
{
  const { agent } = await sessionWithOnePullback('ra-synth')
  const d = await preStep(agent, 2, 1)
  const row = await statusOf('ra-synth')
  check('① 合成证据 ⇒ 拒绝开门', injected(d, 'trajectory-anchor-reanchor').length === 0 && row.reanchor.gate === 'evidence-REJECTED',
    String(row.reanchor.gate))
  check('① 拒绝原因写明 synthetic-evidence',
    warnings.some((w) => /synthetic-evidence/.test(w)), JSON.stringify(warnings.slice(0, 1)))
}

// ── ② 开门后：先轻后重 + 每会话一次 + 载荷原样 + 留痕 ─────────────────────────
const EVIDENCE_PASS = writeEvidence('pass-main.json', PASS_EV)
const OUTCOMES = join(dir, 'outcomes.jsonl')
await boot({ pullbackEnabled: true, reanchorEnabled: true, reanchorEvidencePath: EVIDENCE_PASS, pullbackOutcomePath: OUTCOMES })
{
  // L1 还没说过话 ⇒ 不许重锚定（先轻后重）
  const { agent, session } = adopt('ra-order')
  sessionEvent(session, human(PROMPT))
  const before = await preStep(agent, 1, 1)
  check('② L1 尚未说话 ⇒ 不重锚定（先轻后重）', injected(before, 'trajectory-anchor-reanchor').length === 0)
  // 触发一次 L1
  sessionEvent(session, call('edit', EDIT_OUT, 1, 1))
  const l1 = await preStep(agent, 1, 2)
  check('② 前置条件：L1 已注入一条', injected(l1, 'trajectory-anchor-pullback').length === 1)
  // 下一个 turn 才允许重锚定
  const d = await preStep(agent, 2, 1)
  const items = injected(d, 'trajectory-anchor-reanchor')
  check('② L1 说过话之后 ⇒ 允许重锚定一次', items.length === 1, `n=${items.length}`)
  const t = textOf(items[0])
  check('② 文本**原样包含**首轮 persona（不发明新指令）', t.includes(PERSONA), t.slice(0, 80))
  check('② 文本说明依据（把已知有效的首轮载荷放回近因位置）', /首轮/.test(t) && /已知有效/.test(t))
  check('② 建议式措辞（无命令式）', !/(必须|不得|务必)/.test(t) && !/\b(must|shall|do not|never)\b/i.test(t))
  const again = await preStep(agent, 3, 1)
  check('② 每会话只重锚定一次', injected(again, 'trajectory-anchor-reanchor').length === 0)
  const row = await statusOf('ra-order')
  check('② 状态与留痕可见', row.reanchor.enabled === true && row.reanchor.count === 1 && row.auditTail.includes('reanchor'),
    JSON.stringify({ e: row.reanchor.enabled, c: row.reanchor.count, s: row.reanchor.suppressed }))
}

// ── ③ 效果采集：会话结束落盘一行，字段齐 ─────────────────────────────────────
{
  const { agent, session } = await sessionWithOnePullback('ra-outcome')
  // 说过之后再跑一次验证（"说过之后行为有变"的正向信号）
  sessionEvent(session, call('pwsh', VERIFY, 1, 5))
  dispatch('agent/disposed', { agent })
  const lines = existsSync(OUTCOMES) ? readFileSync(OUTCOMES, 'utf8').trim().split('\n').filter(Boolean) : []
  check('③ 效果采集落盘一行', lines.length >= 1, `lines=${lines.length}`)
  let last = null
  try { last = JSON.parse(lines[lines.length - 1]) } catch { last = null }
  check('③ 行内有可观测的效果代理字段',
    last && last.sessionId === 'ra-outcome' && typeof last.pullbacks === 'number'
    && typeof last.verifiesAfterPullback === 'number' && typeof last.scopeViolationsAfter === 'number'
    && typeof last.claimedUnverifiedAfter === 'boolean',
    JSON.stringify(last))
  check('③ 拉回之后跑过验证 ⇒ verifiesAfterPullback ≥ 1', last && last.verifiesAfterPullback >= 1, String(last && last.verifiesAfterPullback))
}
{
  // 关着的时候不落盘（否则会污染证据）
  const OUT2 = join(dir, 'outcomes-off.jsonl')
  await boot({ pullbackEnabled: false, reanchorEnabled: false, pullbackOutcomePath: OUT2 })
  const { agent } = adopt('ra-nooutcome')
  dispatch('agent/disposed', { agent })
  check('③ 拉回关闭时**不**落盘（不污染证据）', !existsSync(OUT2), OUT2)
}

// ── ④ 无损 JSON + 顶层报告 ──────────────────────────────────────────────────
await boot({ pullbackEnabled: true, reanchorEnabled: true, reanchorEvidencePath: EVIDENCE_PASS })
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
  check('④ anchor_status 可无损 JSON 序列化', bad.length === 0, bad.slice(0, 3).join(','))
  // 门开时 reanchorGate 就是 null（"没有东西挡着"），所以这里断言的是"门开 + 证据在位"，
  // 而不是"gate 是字符串"——后者会把正确行为判成失败（第一版断言就写错了）。
  const evRow = s.rows.find((r) => r.sessionId === 'ra-outcome') || s.rows[0]
  check('④ 门开（null = 无阻断）且证据在位', s.reanchorGate === null && s.reanchorEvidence && s.reanchorEvidence.verdict === 'PASS-online',
    JSON.stringify({ g: s.reanchorGate, v: s.reanchorEvidence && s.reanchorEvidence.verdict }))
  check('④ 行内 reanchor.enabled 与门一致', s.rows.every((r) => r.reanchor.enabled === true && r.reanchor.gate === null), JSON.stringify(s.rows.map((r) => r.reanchor.gate)))
  check('④ 证据里的观测数被带出来（可判断证据有多厚）', s.reanchorEvidence.pullbacksObserved === 12, String(s.reanchorEvidence.pullbacksObserved))
  check('④ config 报告含 L2 三个键（路径允许为 null = 用默认位置）',
    s.config.reanchorEnabled === true
    && Object.prototype.hasOwnProperty.call(s.config, 'reanchorEvidencePath')
    && Object.prototype.hasOwnProperty.call(s.config, 'pullbackOutcomePath'),
    JSON.stringify({ e: s.config.reanchorEnabled, ep: s.config.reanchorEvidencePath, op: s.config.pullbackOutcomePath }))
  void evRow
}

console.warn = origWarn
try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
console.log(`\n${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
