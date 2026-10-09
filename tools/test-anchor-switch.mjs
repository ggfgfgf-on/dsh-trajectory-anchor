/**
 * test-anchor-switch.mjs -- the A/B experiment's own validity check.
 *
 * `anchorEnabled` is the switch the intervention experiment flips to build its control arm, and it
 * had **no regression coverage at all** before this file: if the switch silently did nothing, an A/B
 * would quietly be an A/A and any "no difference" conclusion would be an artifact of the harness.
 * So both directions are asserted here, and each direction also checks that the plugin still
 * observes (scores, audits) when anchoring is off -- the control arm must be a *pure observer*, not
 * a dead plugin.
 *
 * Usage: node tools/test-anchor-switch.mjs [path/to/index.js]
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const here = fileURLToPath(new URL('.', import.meta.url))
const mod = await import(pathToFileURL(resolve(here, process.argv[2] || '../index.js')).href)

let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ': ' + detail}`)
}

const TOOLS = ['pwsh', 'read', 'edit', 'grep', 'browser_open', 'vision_crop', 'todo_write'].map((n) => ({ name: n }))

let handlers = {}
let restricted = []
let registered = {}
const agentsById = new Map()
async function boot(config) {
  handlers = {}
  restricted = []
  registered = {}
  agentsById.clear()
  const ctx = {
    get: (n) => {
      if (n === 'tools') return { register: (t) => { registered[t.name] = t; return () => {} } }
      if (n === 'agents') return { get: (id) => agentsById.get(id), list: () => [...agentsById.values()] }
      return undefined
    },
    on: (name, fn) => { handlers[name] = fn; return () => {} },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  }
  await mod.apply(ctx, { adaptiveStateEnabled: false, ...config })
}
const dispatch = (name, ...args) => handlers['internal/dispatch']('x', name, args, null)
const sessionEvent = (session, event) => dispatch('session/event', session, event)
const summaryOf = async (sid) => (await registered.anchor_status.execute({})).rows.find((r) => r.sessionId === sid)

/** One synthetic agent that calls a tool once, i.e. exactly what triggers adoption + anchoring. */
function makeAgent(sid) {
  const agent = {
    id: sid,
    session: { id: sid, events: [] },
    ctx: { tools: { schemas: () => TOOLS.map((t) => ({ ...t })), restrict: (deny) => { restricted.push({ sid, deny }); return () => {} } } },
  }
  agentsById.set(sid, agent)
  dispatch('agent/created', { agent })
  return { agent, session: { id: sid } }
}
const text = (s) => ({ type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: s }] } } })

// ── direction 1: the shipped default actually anchors ────────────────────────────────────────────
await boot({})
{
  const { session } = makeAgent('sw-on')
  sessionEvent(session, { type: 'tool/call', data: { name: 'pwsh', turn: 1, step: 1 } })
  const row = await summaryOf('sw-on')
  check('默认：会话被锚定（anchored=true）', row.anchored === true, String(row.anchorChannel))
  check('默认：锚定通道就是 adopt 来源（无 anchor-disabled 后缀）',
    typeof row.anchorChannel === 'string' && row.anchorChannel.endsWith('dispatch:agent/created'), String(row.anchorChannel))
  check('默认：首轮工具面被真的收窄（restrict 被调用）', restricted.length === 1, JSON.stringify(restricted.map((r) => r.deny)))
  // 上下文抑制在这套 harness 里观察不到（它需要一个本文件没有的 session/context 服务）；
  // 那一条由专门的 tools/test-context-suppression.mjs 覆盖，这里不去重造一个假服务。
  check('默认：晋升门待定（pendingPromote=true）', row.pendingPromote === true, String(row.pendingPromote))
  sessionEvent(session, text('We will inspect the repository first, then we will run the tests.'))
  const after = await summaryOf('sw-on')
  check('默认：一条 minimal-like 推理后拿到晋升（lifted=true 且工具面恢复）',
    after.lifted === true && after.contextSuppressed === false, `${after.liftReason}/${after.contextSuppressed}`)
}

// ── direction 2: the switch really turns the treatment off (this is the control arm) ─────────────
await boot({ anchorEnabled: false })
{
  const { session } = makeAgent('sw-off')
  sessionEvent(session, { type: 'tool/call', data: { name: 'pwsh', turn: 1, step: 1 } })
  const row = await summaryOf('sw-off')
  check('关卡：会话没有被锚定（anchored=false）', row.anchored === false, String(row.anchored))
  // 实测缺口（记下来，不粉饰）：`anchorChannel` 只在**真的锚定**时被赋值，所以关卡会话在
  // status 行里与"从未 adopted"不可区分 —— 原因串只在 `adopted` 审计事件里。
  // 这里因此只断言"没有锚定通道"，并把"原因必须可从某处读到"交给审计面。
  check('关卡：status 行里没有锚定通道（原因串在 adopted 审计里，见上方注释）',
    row.anchorChannel === null, String(row.anchorChannel))
  check('关卡：工具面没有被收窄（restrict 从未调用）', restricted.length === 0, JSON.stringify(restricted.length))
  check('关卡：上下文没有被抑制（contextSuppressed=false）', row.contextSuppressed === false, String(row.contextSuppressed))
  check('关卡：没有晋升门待定（pendingPromote=false）', row.pendingPromote === false, String(row.pendingPromote))
  // 反向对照里同样重要的一条：控制臂必须是**纯观察者**，不是"插件死了"
  sessionEvent(session, text('We will inspect the repository first, then we will run the tests.'))
  const after = await summaryOf('sw-off')
  check('关卡：仍然评分（stepsScored 增长、band/ratio 有值）',
    after.stepsScored >= 1 && typeof after.ratio === 'number', JSON.stringify({ steps: after.stepsScored, ratio: after.ratio }))
  check('关卡：仍然写审计（auditKinds 有 adopted 与 score）',
    Array.isArray(after.auditKinds) && after.auditKinds.includes('adopted') && after.auditKinds.includes('score'),
    JSON.stringify(after.auditKinds))
  // **本轮实测到的、影响实验解读的事实**：关掉锚定之后连任务锚点解析也不跑了
  // （`taskAnchors` 保持 null）。也就是说控制臂失去的不只是首轮三件套，还有 L1 的判据来源
  // —— "锚定关"因此是"首轮锚定 + L1 任务锚定"一起关，B 臂的解读必须这么写。
  check('关卡：任务锚点解析也停（B 臂失去的不只是首轮三件套，还有 L1 的判据来源）',
    after.taskAnchors === null, JSON.stringify(after.taskAnchors && after.taskAnchors.parsed))
}

console.log(`\n${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
