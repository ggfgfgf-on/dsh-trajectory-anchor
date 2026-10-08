/**
 * test-pullback.mjs —— L1 任务锚定拉回的机制测试（驱动真实 apply()）
 *
 * 断言口径：**每条正向都必须有反向对照**——能触发，也要能在"不该触发"时**不**触发；
 * 措辞按社区实测纪律（dsh-anchored-monitor 实验 E1/E1.5：命令式会把轨迹打回 let me），
 * 因此专门断言文本里**不出现**命令式措辞，并断言它带明确豁免。
 *
 * 用法：node tools/test-pullback.mjs [index.js 路径]
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

const TOOLS = ['pwsh', 'read', 'edit', 'write', 'grep'].map((n) => ({ name: n }))
const PROMPT = 'The directory bugfix-a4 in the current workspace contains calc.py with several planted bugs and test_calc.py. '
  + 'Run the tests (python test_calc.py), find and fix ALL bugs in calc.py, and rerun until every test passes. '
  + 'Work only inside bugfix-a4. Report ONE line: PASS=<n>/7'

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
const sessionEvent = (session, event) => dispatch('session/event', session, event)

function adopt(sid) {
  const agent = { id: sid, session: { id: sid, events: [] }, ctx: { tools: { schemas: () => TOOLS.map((t) => ({ ...t })), restrict: () => () => {} } } }
  agents.set(sid, agent)
  dispatch('agent/created', { agent })
  return { agent, session: { id: sid } }
}
const human = (text) => ({ type: 'user/message', data: { source: { kind: 'user' }, role: 'user', content: [{ type: 'text', text }] } })
const call = (name, args, turn, step) => ({ type: 'tool/call', data: { name, arguments: JSON.stringify(args), turn, step } })
const msg = (turn, step) => ({ type: 'assistant/message', data: { turn, step, message: { content: [{ type: 'reasoning', text: 'x' }] } } })

/** 跑一次 pre-step，返回处理器给出的 decision。 */
async function preStep(agent, turn, step, messages = []) {
  const next = async () => ({ kind: 'continue', messages: [...messages] })
  return handlers['agent/pre-step']({ agent, turn, step, messages: [] }, next)
}
const pullbacks = (decision) => (decision && Array.isArray(decision.messages) ? decision.messages : [])
  .filter((m) => m && m.source && m.source.kind === 'trajectory-anchor-pullback')
const textOf = (m) => (m && Array.isArray(m.content) ? m.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('') : '')
const statusOf = async (sid) => (await registered.anchor_status.execute({})).rows.find((r) => r.sessionId === sid)

const VERIFY = { command: 'python test_calc.py', workdir: 'D:\\DSHwork\\bugfix-a4' }
const EDIT_OK = { file_path: 'D:\\DSHwork\\bugfix-a4\\calc.py', old_string: 'a', new_string: 'b' }
const EDIT_OUT = { file_path: 'D:\\DSHwork\\bugfix-a1\\calc.py', old_string: 'a', new_string: 'b' }
const EDIT_DOC = { file_path: 'D:\\DSHwork\\bugfix-a4\\NOTES.md', content: 'x' }
const READ_OUT = { file_path: 'D:\\DSHwork\\other\\secret.txt' }

// ── ① 默认关：即使越界写也不说话（负向）─────────────────────────────────────
await boot({ pullbackEnabled: false })
{
  const { agent, session } = adopt('pb-off')
  sessionEvent(session, human(PROMPT))
  sessionEvent(session, call('edit', EDIT_OUT, 1, 1))
  sessionEvent(session, msg(1, 2))
  const d = await preStep(agent, 1, 3)
  check('① 默认关：越界写后不注入任何消息', pullbacks(d).length === 0, JSON.stringify(pullbacks(d).map(textOf)))
  const row = await statusOf('pb-off')
  check('① 仍然留痕：越界被记为 scopeViolation（只是不说）', row.pullback.scopeViolations === 1, JSON.stringify(row.pullback))
  check('① taskAnchors 解析结果可见', row.taskAnchors && row.taskAnchors.parsed === true && row.taskAnchors.scopeNames.includes('bugfix-a4'),
    JSON.stringify(row.taskAnchors && { p: row.taskAnchors.parsed, n: row.taskAnchors.scopeNames }))
}

// ── ② 打开：越界写 → 近因注入一条，"建议式 + 带证据 + 带豁免" ─────────────────
await boot({ pullbackEnabled: true })
{
  const { agent, session } = adopt('pb-scope')
  sessionEvent(session, human(PROMPT))
  sessionEvent(session, call('edit', EDIT_OUT, 1, 1))
  const d = await preStep(agent, 1, 2)
  const items = pullbacks(d)
  check('② 越界写 ⇒ 注入一条拉回消息', items.length === 1, `n=${items.length}`)
  const t = textOf(items[0])
  check('② 文本带证据（范围外的路径）', t.includes('bugfix-a1'), t.slice(0, 120))
  check('② 文本带**明确豁免**（临时/venv/缓存不算越界）', /临时目录|虚拟环境|包缓存/.test(t), t.slice(-90))
  check('② 文本是**建议式**，不含命令式措辞',
    !/\b(must|shall|you have to|do not|don't|never|first,|follow)\b/i.test(t) && !/(必须|不得|禁止|务必)/.test(t), t.slice(0, 160))
  check('② 决策其余字段不被改动（只在 messages 上追加）', d.kind === 'continue' && d.messages.length === 1, JSON.stringify({ k: d.kind, n: d.messages.length }))
}

// ── ③ 节流：同一 turn 至多一次 ──────────────────────────────────────────────
{
  const { agent, session } = adopt('pb-throttle')
  sessionEvent(session, human(PROMPT))
  sessionEvent(session, call('edit', EDIT_OUT, 1, 1))
  const first = await preStep(agent, 1, 2)
  sessionEvent(session, call('edit', EDIT_OUT, 1, 3))
  const second = await preStep(agent, 1, 4)
  check('③ 同一 turn 内第二次不再注入', pullbacks(first).length === 1 && pullbacks(second).length === 0,
    JSON.stringify({ first: pullbacks(first).length, second: pullbacks(second).length }))
  const row = await statusOf('pb-throttle')
  check('③ 被节流这件事本身留痕（throttled 计数）', row.pullback.suppressed.throttled >= 1, JSON.stringify(row.pullback.suppressed))
  check('③ 计数只加了 1 次', row.pullback.count === 1, String(row.pullback.count))
}

// ── ④ 每会话上限 ────────────────────────────────────────────────────────────
{
  const { agent, session } = adopt('pb-cap')
  sessionEvent(session, human(PROMPT))
  let injected = 0
  for (let turn = 1; turn <= 6; turn++) {
    sessionEvent(session, call('edit', EDIT_OUT, turn, 1))
    const d = await preStep(agent, turn, 2)
    injected += pullbacks(d).length
  }
  const row = await statusOf('pb-cap')
  check('④ 每会话不超过 pullbackMaxPerSession(3)', injected === 3 && row.pullback.count === 3, `injected=${injected} count=${row.pullback.count}`)
  check('④ 到顶后留痕（cap 计数）', row.pullback.suppressed.cap >= 1, JSON.stringify(row.pullback.suppressed))
}

// ── ⑤ 未验证提醒：验证之后再改代码 ⇒ 提醒重跑 ────────────────────────────────
await boot({ pullbackEnabled: true })
{
  const { agent, session } = adopt('pb-unverified')
  sessionEvent(session, human(PROMPT))
  sessionEvent(session, call('pwsh', VERIFY, 1, 1))
  sessionEvent(session, call('edit', EDIT_OK, 1, 2))
  const d = await preStep(agent, 1, 3)
  const items = pullbacks(d)
  check('⑤ 验证后改代码 ⇒ 注入验证提醒', items.length === 1, `n=${items.length}`)
  const t = textOf(items[0])
  check('⑤ 文本指出上次验证的位置（turn/step 证据）', /turn 1 step 1/.test(t), t.slice(0, 140))
  check('⑤ 文本带豁免（只改文档不算）', /文档|注释|说明文件/.test(t), t.slice(-80))
  check('⑤ 建议式措辞', !/\b(must|shall|do not|never)\b/i.test(t) && !/(必须|不得|务必)/.test(t), t.slice(0, 140))
}

// ── ⑥ 文档改动不作废验证（人工审计抓出的假阳，绝不能变成 nag）───────────────
{
  const { agent, session } = adopt('pb-doc')
  sessionEvent(session, human(PROMPT))
  sessionEvent(session, call('pwsh', VERIFY, 1, 1))
  sessionEvent(session, call('write', EDIT_DOC, 1, 2))
  const d = await preStep(agent, 1, 3)
  check('⑥ 只改文档 ⇒ 不注入（假阳不得重现）', pullbacks(d).length === 0, JSON.stringify(pullbacks(d).map(textOf)))
}
{
  // 但代码改动**必须**仍然提醒（反向对照：不能把信号修成静音）
  const { agent, session } = adopt('pb-code')
  sessionEvent(session, human(PROMPT))
  sessionEvent(session, call('pwsh', VERIFY, 1, 1))
  sessionEvent(session, call('edit', EDIT_OK, 1, 2))
  const d = await preStep(agent, 1, 3)
  check('⑥ 代码改动 ⇒ 仍然提醒（反向对照）', pullbacks(d).length === 1, `n=${pullbacks(d).length}`)
}
{
  // 再次验证后清空 ⇒ 不再提醒
  const { agent, session } = adopt('pb-reverify')
  sessionEvent(session, human(PROMPT))
  sessionEvent(session, call('pwsh', VERIFY, 1, 1))
  sessionEvent(session, call('edit', EDIT_OK, 1, 2))
  sessionEvent(session, call('pwsh', VERIFY, 1, 3))
  const d = await preStep(agent, 1, 4)
  check('⑥ 改完又验证过 ⇒ 不再提醒', pullbacks(d).length === 0, `n=${pullbacks(d).length}`)
}

// ── ⑦ 不该触发的几种情况（负向）────────────────────────────────────────────
await boot({ pullbackEnabled: true })
{
  const { agent, session } = adopt('pb-inscope')
  sessionEvent(session, human(PROMPT))
  sessionEvent(session, call('edit', EDIT_OK, 1, 1))
  const d = await preStep(agent, 1, 2)
  check('⑦ 范围内代码改动（此前没验证过）⇒ 不注入', pullbacks(d).length === 0, JSON.stringify(pullbacks(d).map(textOf)))
}
{
  const { agent, session } = adopt('pb-readout')
  sessionEvent(session, human(PROMPT))
  sessionEvent(session, call('read', READ_OUT, 1, 1))
  const d = await preStep(agent, 1, 2)
  check('⑦ 越界**读**不触发（本研究只把越界写当信号；提示也未禁止）', pullbacks(d).length === 0)
}
{
  const { agent, session } = adopt('pb-noparse')
  sessionEvent(session, human('帮我看看这个项目，随便改改'))
  sessionEvent(session, call('edit', EDIT_OUT, 1, 1))
  const d = await preStep(agent, 1, 2)
  const row = await statusOf('pb-noparse')
  check('⑦ 提示里没有范围 ⇒ 不注入（不猜）', pullbacks(d).length === 0)
  check('⑦ 且留痕 parsed=false 与原因', row.taskAnchors && row.taskAnchors.parsed === false && typeof row.taskAnchors.reason === 'string',
    JSON.stringify(row.taskAnchors && { p: row.taskAnchors.parsed }))
}
{
  const { agent, session } = adopt('pb-ignore')
  sessionEvent(session, human(PROMPT))
  sessionEvent(session, call('write', { file_path: 'C:\\Users\\x\\AppData\\Local\\Temp\\p2.py', content: 'x' }, 1, 1))
  const d = await preStep(agent, 1, 2)
  check('⑦ 临时目录写入不触发（审计抓出的假阳类别）', pullbacks(d).length === 0)
}

// ── ⑧ 无损 JSON + 审计留痕 ──────────────────────────────────────────────────
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
  check('⑧ anchor_status 输出可无损 JSON 序列化', bad.length === 0, bad.slice(0, 3).join(','))
  const row = s.rows.find((r) => r.sessionId === 'pb-cap')
  check('⑧ 拉回状态与配置在报告里可见',
    row && row.pullback && row.pullback.enabled === true && s.config.pullbackEnabled === true,
    JSON.stringify({ r: row && row.pullback, c: s.config.pullbackEnabled }))
  const audit = row && Array.isArray(row.auditTail) ? row.auditTail : []
  check('⑧ 拉回写入审计尾部（可回溯"说过什么"）', audit.includes('pullback'), JSON.stringify(audit))
}

// ── ⑬ 自由会话（提示里没有范围/验证子句）也必须能触发"未验证"信号 ──────────────
// 由来：原先"未验证"依赖提示里的范围子句 ⇒ 自由形态的长会话（这个项目自己的会话就是）
// 永远沉默，L1 停在"存在但从不运行"，观察期也攒不到数据。
// 现在验证命令可从**会话自身行为**识别（verifyCommandKind），不要求提示声明；
// 反方向同样要守：会话里从未跑过验证 ⇒ 一句都不说（不许凭空提醒）。
await boot({ pullbackEnabled: true })
{
  const { agent, session } = adopt('pb-obs-verify')
  sessionEvent(session, human('帮我修一下这个 bug（提示里没有范围与验证命令）'))
  sessionEvent(session, call('pwsh', { command: 'pnpm test', workdir: 'D:\\proj' }, 1, 1))
  sessionEvent(session, call('edit', EDIT_OK, 1, 2))
  const d = await preStep(agent, 1, 3)
  const items = pullbacks(d)
  check('⑬ 无提示子句但会话里跑过测试 ⇒ 改码后仍提醒', items.length === 1, `n=${items.length}`)
  check('⑬ 文本仍带证据与豁免',
    items.length === 1 && /turn 1 step 1/.test(textOf(items[0])) && /不算/.test(textOf(items[0])),
    items.length === 1 ? textOf(items[0]).slice(0, 110) : '')
  const row = await statusOf('pb-obs-verify')
  check('⑬ 记录来源为 observed-verify', row.pullback.anchorsMode === 'observed-verify',
    JSON.stringify({ m: row.pullback.anchorsMode, k: row.pullback.verifyKinds }))
  check('⑬ 识别出的验证形态被留痕', (row.pullback.verifyKinds || []).includes('pnpm-test'), JSON.stringify(row.pullback.verifyKinds))
}
{
  const { agent, session } = adopt('pb-no-verify')
  sessionEvent(session, human('随便改改'))
  sessionEvent(session, call('pwsh', { command: 'Get-ChildItem', workdir: 'D:\\proj' }, 1, 1))
  sessionEvent(session, call('edit', EDIT_OK, 1, 2))
  const d = await preStep(agent, 1, 3)
  check('⑬ 从未跑过验证 ⇒ 一句都不说（不许凭空提醒）', pullbacks(d).length === 0, JSON.stringify(pullbacks(d).map(textOf)))
  const row = await statusOf('pb-no-verify')
  check('⑬ 来源记为 none', row.pullback.anchorsMode === 'none' && (row.pullback.verifyKinds || []).length === 0,
    JSON.stringify({ m: row.pullback.anchorsMode, k: row.pullback.verifyKinds }))
}
{
  const { agent, session } = adopt('pb-no-scope-nowrite')
  sessionEvent(session, human('随便改改'))
  sessionEvent(session, call('pwsh', { command: 'pnpm test' }, 1, 1))
  sessionEvent(session, call('edit', EDIT_OUT, 1, 2))
  const row = await statusOf('pb-no-scope-nowrite')
  check('⑬ 无范围子句 ⇒ 越界写不记为违规（范围只能来自提示）', row.pullback.scopeViolations === 0, String(row.pullback.scopeViolations))
}

{
  // 实测踩到的形态：命令是**多行 PowerShell 脚本**且含转义引号 ⇒ 旧的"正则截取 command"
  // 只能拿到片段，于是真实会话里明明跑了 node tools/test-*.mjs，verifyKinds 却一直是空的、
  // anchorsMode 停在 none、拉回一次都不触发（这次是在**真实进程**里核对时才发现的）。
  const { agent, session } = adopt('pb-multiline-cmd')
  const script = 'cd D:\\proj\n"=== run tests ==="\nnode tools/test-pullback.mjs 2>&1 | Select-Object -Last 2\nnode tools/check-invariants.mjs | Select-Object -Last 2'
  sessionEvent(session, human('随便改改'))
  sessionEvent(session, { type: 'tool/call', data: { name: 'pwsh', arguments: JSON.stringify({ command: script }), turn: 1, step: 1 } })
  sessionEvent(session, call('edit', EDIT_OK, 1, 2))
  const d = await preStep(agent, 1, 3)
  check('⑬ 多行脚本 + 转义引号里的验证命令仍被识别', pullbacks(d).length === 1, `n=${pullbacks(d).length}`)
  const row = await statusOf('pb-multiline-cmd')
  check('⑬ 形态与来源都被留痕',
    (row.pullback.verifyKinds || []).includes('node-test-file') && row.pullback.anchorsMode === 'observed-verify',
    JSON.stringify({ k: row.pullback.verifyKinds, m: row.pullback.anchorsMode }))
}

console.warn = origWarn
console.log(`\n${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
