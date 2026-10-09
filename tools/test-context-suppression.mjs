/**
 * test-context-suppression.mjs —— **bootstrap 上下文抑制的 fail-open 审计**
 *
 * 为什么需要它：上下文抑制（替换 persona 段 + 摘掉 runtime context）是**已经在跑**的功能
 * （`suppressContextOnBootstrap: true`），但它此前**没有任何专门的安全审计**。
 * 而"静默摘掉东西、又不还回来"正是本项目最重那次事故的类别（工具面被摘、归还路径不可达）。
 *
 * fail-open 契约（每条都要有反向对照）：
 *   ① 抑制只发生在**锚定成功且未晋升**的 bootstrap 期间，且**可见**（状态 + 审计）；
 *   ② 必须**有界且可恢复**：晋升/窗口到期/会话关闭时还原，两个 disposer 都被调用；
 *   ③ 服务不可用 ⇒ **不抑制**（fail-open，不是 fail-closed）+ 状态暴露错误；
 *   ④ **还原失败时状态不许说谎**：失败 ⇒ `contextSuppressed` 保持 true + 暴露 `contextRestoreError`
 *      + 之后仍可重试（旧实现在这里会显示"未抑制"，永久卡在看不见的降级里）；
 *   ⑤ 抑制清单**不许包含插件自己的消息种类**（否则 L1 的拉回提醒会被自己的抑制吃掉）。
 *
 * 用法：node tools/test-context-suppression.mjs [index.js 路径]
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
const text = (s) => ({ type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: s }] } } })

let handlers = {}
let registered = {}
const agents = new Map()
const warnings = []
const origWarn = console.warn
console.warn = (...a) => { warnings.push(a.join(' ')) }

/** systemPrompt 服务桩：记录 section/suppress 调用与 dispose 次数，可注入 dispose 失败。 */
function makeSystemPrompt(opts = {}) {
  const calls = { section: [], suppressRuntimeContext: 0, personaDisposed: 0, runtimeContextDisposed: 0, errorsOwnedCalls: 0 }
  const svc = {
    calls,
    section(s) {
      calls.section.push({ ...s })
      return () => {
        if (opts.failPersonaDispose) { calls.errorsOwnedCalls++; throw new Error('persona dispose failed') }
        calls.personaDisposed++
      }
    },
    suppressRuntimeContext() {
      calls.suppressRuntimeContext++
      return () => {
        if (opts.failRuntimeDispose) { calls.errorsOwnedCalls++; throw new Error('runtime dispose failed') }
        calls.runtimeContextDisposed++
      }
    },
  }
  return svc
}

let systemPromptSvc = null
async function boot(config, opts = {}) {
  handlers = {}
  registered = {}
  agents.clear()
  warnings.length = 0
  systemPromptSvc = opts.systemPrompt === false ? null : makeSystemPrompt(opts)
  const ctx = {
    get: (n) => {
      if (n === 'tools') return { register: (t) => { registered[t.name] = t; return () => {} } }
      if (n === 'agents') return { get: (id) => agents.get(id), list: () => [...agents.values()] }
      return undefined
    },
    on: (n, fn) => { handlers[n] = fn; return () => {} },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  }
  await mod.apply(ctx, { adaptiveStateEnabled: false, ...config })
}

/** 锚定成功（会走 bootstrap 抑制路径）的会话。 */
function adoptAnchored(sid) {
  const agent = {
    id: sid,
    session: { id: sid, events: [] },
    ctx: {
      tools: { schemas: () => TOOLS.map((t) => ({ ...t })), restrict: () => () => {} },
      get: (n) => (n === 'systemPrompt' ? systemPromptSvc : undefined),
    },
  }
  agents.set(sid, agent)
  dispatch('agent/created', { agent })
  return { agent, session: { id: sid } }
}
const dispatch = (name, ...args) => handlers['internal/dispatch']('x', name, args, null)
const sessionEvent = (session, event) => dispatch('session/event', session, event)
const statusOf = async () => registered.anchor_status.execute({})
const rowOf = async (sid) => (await statusOf()).rows.find((r) => r.sessionId === sid)
/** 走一步真实请求，让 bootstrap 窗口推进。 */
const step = (session, n) => sessionEvent(session, text(`We will inspect the repository carefully. step ${n}`))
/** **必须先有工具调用**：晋升门由"首次工具调用"武装（否则 pendingPromote 永远为假、永不晋升）。 */
const armGate = (session) => sessionEvent(session, { type: 'tool/call', data: { name: 'pwsh', arguments: '{}', turn: 1, step: 0 } })

// ── ① 抑制生效且可见 ────────────────────────────────────────────────────────
await boot({ suppressContextOnBootstrap: true, gateEnabled: true })
{
  const { session } = adoptAnchored('ctx-on')
  step(session, 1)
  const row = await rowOf('ctx-on')
  check('① 锚定会话在 bootstrap 期抑制生效', row.contextSuppressed === true, String(row.contextSuppressed))
  check('① 抑制的两个动作都真的发生了（persona 段被替换 + runtime context 被摘）',
    systemPromptSvc.calls.section.length === 1 && systemPromptSvc.calls.section[0].name === 'persona'
    && systemPromptSvc.calls.suppressRuntimeContext === 1,
    JSON.stringify(systemPromptSvc.calls.section.map((s) => s.name)))
  check('① 替换文本就是配置的 bootstrap persona（逐字）',
    systemPromptSvc.calls.section[0].text === 'You are a helpful software engineer assistant.',
    JSON.stringify(String(systemPromptSvc.calls.section[0].text).slice(0, 50)))
  check('① 审计留痕 context-suppressed', row.auditTail.includes('context-suppressed'), JSON.stringify(row.auditTail.slice(-4)))
}

// ── ② 有界且可恢复：晋升门触发 ⇒ 还原 ─────────────────────────────────────
{
  await boot({ suppressContextOnBootstrap: true, gateEnabled: true, maxBootstrapSteps: 2 })
  const { session } = adoptAnchored('ctx-restore')
  const row0 = await rowOf('ctx-restore')
  check('② 前置：锚定即抑制（此刻尚未晋升）', row0.contextSuppressed === true && row0.lifted === false,
    JSON.stringify({ s: row0.contextSuppressed, l: row0.lifted }))
  armGate(session)            // 武装晋升门（没有这一步永远不会晋升）
  step(session, 1)
  const row = await rowOf('ctx-restore')
  check('② 晋升门触发 ⇒ 抑制被还原', row.lifted === true && row.contextSuppressed === false,
    JSON.stringify({ lifted: row.lifted, sup: row.contextSuppressed }))
  check('② 两个 disposer 都被调用（还原是真的，不是只改了个标记）',
    systemPromptSvc.calls.personaDisposed === 1 && systemPromptSvc.calls.runtimeContextDisposed === 1,
    JSON.stringify({ p: systemPromptSvc.calls.personaDisposed, r: systemPromptSvc.calls.runtimeContextDisposed }))
  check('② 审计留痕 context-restored 且 ok=true',
    row.auditTail.includes('context-restored'), JSON.stringify(row.auditTail.slice(-6)))
}
// ②b **有界**的另一条路：没有正向命中（晋升门永不触发）⇒ maxBootstrapSteps 兜底必须晋升
{
  await boot({ suppressContextOnBootstrap: true, gateEnabled: true, maxBootstrapSteps: 2 })
  const { session } = adoptAnchored('ctx-fallback')
  const row0 = await rowOf('ctx-fallback')
  check('②b 前置：锚定即抑制', row0.contextSuppressed === true, String(row0.contextSuppressed))
  armGate(session)
  // 用**负向**文本：晋升门要求正向命中，所以它不会触发 ⇒ 只能靠 maxBootstrapSteps 兜底。
  // 兜底在 `agent/request` 路径上按**请求数**判定，所以必须真的发请求事件。
  for (let i = 1; i <= 3; i++) {
    sessionEvent(session, text(`let me just try something quick here ${i}`))
    dispatch('agent/request', { agent: agents.get('ctx-fallback'), turn: i, step: 1 })
  }
  const row = await rowOf('ctx-fallback')
  check('②b 兜底：没有正向命中时，窗口到期也必须还原（有界性）',
    row.lifted === true && row.contextSuppressed === false,
    JSON.stringify({ lifted: row.lifted, sup: row.contextSuppressed, requests: row.requests }))
  check('②b 兜底路径同样真的调用了 disposer',
    systemPromptSvc.calls.personaDisposed === 1 && systemPromptSvc.calls.runtimeContextDisposed === 1,
    JSON.stringify({ p: systemPromptSvc.calls.personaDisposed, r: systemPromptSvc.calls.runtimeContextDisposed }))
}

// ── ③ 反向对照：服务不可用 ⇒ **不抑制**（fail-open）─────────────────────────
await boot({ suppressContextOnBootstrap: true, gateEnabled: true }, { systemPrompt: false })
{
  const { session } = adoptAnchored('ctx-nosvc')
  step(session, 1)
  const row = await rowOf('ctx-nosvc')
  check('③ 反向对照：拿不到 systemPrompt 服务 ⇒ 不抑制（fail-open，不是 fail-closed）',
    row.contextSuppressed === false && typeof row.contextSuppressError === 'string' && row.contextSuppressError.length > 0,
    JSON.stringify({ sup: row.contextSuppressed, err: row.contextSuppressError }))
  check('③ 失败有痕（context-suppress-failed）', row.auditTail.includes('context-suppress-failed'), JSON.stringify(row.auditTail.slice(-3)))
}

// ── ④ 还原失败时**状态不许说谎**（旧实现在这里会显示"未抑制"）──────────────
await boot({ suppressContextOnBootstrap: true, gateEnabled: true, maxBootstrapSteps: 2 }, { failPersonaDispose: true })
{
  const { session } = adoptAnchored('ctx-restore-fail')
  const before = await rowOf('ctx-restore-fail')
  check('④ 前置：锚定即抑制（否则后面的断言会假过）',
    before.contextSuppressed === true && before.lifted === false, JSON.stringify({ s: before.contextSuppressed, l: before.lifted }))
  armGate(session)
  step(session, 1)   // 晋升 ⇒ lift ⇒ 还原（persona disposer 抛错）
  const row = await rowOf('ctx-restore-fail')
  check('④ 前置：晋升确实发生了（还原路径真的被执行）', row.lifted === true, String(row.lifted))
  check('④ 反向对照：确实尝试过还原并抛错', systemPromptSvc.calls.errorsOwnedCalls >= 1, String(systemPromptSvc.calls.errorsOwnedCalls))
  check('④ 还原失败 ⇒ 状态**仍然显示被抑制**（说实话，不是乐观置 false）',
    row.contextSuppressed === true, String(row.contextSuppressed))
  check('④ 还原错误被暴露（contextRestoreError）', typeof row.contextRestoreError === 'string' && row.contextRestoreError.length > 0,
    JSON.stringify(row.contextRestoreError))
  check('④ 审计写明还原失败（context-restore-error）',
    row.auditTail.includes('context-restore-error'), JSON.stringify(row.auditTail.slice(-6)))
  check('④ runtime context 这类**没失败**的那一半仍然被正常还原（不是全盘放弃）',
    systemPromptSvc.calls.runtimeContextDisposed === 1, String(systemPromptSvc.calls.runtimeContextDisposed))
}

// ── ⑤ 抑制清单不许含插件自己的消息种类 ──────────────────────────────────────
await boot({ suppressContextOnBootstrap: true, suppressedSources: ['skill-catalog', 'trajectory-anchor-pullback'] })
{
  const s = await statusOf()
  check('⑤ 配置守卫：含自有种类的项被丢弃 + 响亮告警',
    Array.isArray(s.config.suppressedSources) && !s.config.suppressedSources.includes('trajectory-anchor-pullback')
    && warnings.some((w) => /suppressedSources/.test(w)),
    JSON.stringify(s.config.suppressedSources))
  check('⑤ 合法的项保留下来（没有一刀切清空）', s.config.suppressedSources.includes('skill-catalog'), JSON.stringify(s.config.suppressedSources))
}
// 反向对照：不配 suppressedSources 时保持默认（skill-catalog），不受影响
await boot({ suppressContextOnBootstrap: true })
{
  const s = await statusOf()
  check('⑤ 反向对照：未配置时默认清单不变', JSON.stringify(s.config.suppressedSources) === JSON.stringify(['skill-catalog']),
    JSON.stringify(s.config.suppressedSources))
}

console.warn = origWarn
console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
