/**
 * test-anchor-contract.mjs —— P2 契约回归（fail-open + 配置可见）
 *
 * 用假 ctx 驱动真实 apply()，验证：
 *   1) 未知配置键：响亮告警（console.warn 捕获）+ 出现在 anchor_status 输出里 + 不阻断挂载
 *   2) 已知配置键照常合并（rollbackEnabled:false 生效）
 *   3) 未装配 agents 服务时降级为 listAtApply.error，而不是抛错
 *
 * 用法：node tools/test-anchor-contract.mjs [index.js 路径]
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

// ---- 假 ctx：登记工具与事件处理器、忽略其余 ----
const registeredTools = {}
const handlers = {}
const warnings = []
const origWarn = console.warn
console.warn = (...args) => { warnings.push(args.join(' ')) }
let ctx
try {
  ctx = {
    get: (n) => (n === 'tools'
      ? { register: (t) => { registeredTools[t.name] = t; return () => {} } }
      : undefined),
    on: (name, fn) => { handlers[name] = fn; return () => {} },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  }
  await mod.apply(ctx, { rollbackEnabled: false, notARealKey: 123 })
} finally {
  console.warn = origWarn
}

check('apply() 在未知配置键下仍完成挂载（未抛错）', typeof mod.apply === 'function')
check('anchor_status 工具已注册', typeof registeredTools.anchor_status === 'object')
const summary = await registeredTools.anchor_status.execute({})

check('已知键照常合并：rollbackEnabled=false 生效', summary.config.rollbackEnabled === false, String(summary.config.rollbackEnabled))
check('未知键被响亮告警（console.warn 捕获）',
  warnings.some((w) => w.includes('unknown config key "notARealKey"')),
  JSON.stringify(warnings.slice(0, 2)))
check('告警里列出允许的键名（便于当场改对）',
  warnings.some((w) => w.includes('rollbackEnabled') && w.includes('allowed:')))
check('未知键出现在 anchor_status.configWarnings 中',
  Array.isArray(summary.configWarnings) && summary.configWarnings.some((w) => w.includes('notARealKey')),
  JSON.stringify(summary.configWarnings))
check('未装配 agents 服务 → 降级为 listAtApply.error，而不是抛错',
  summary.listAtApply && summary.listAtApply.error === 'agents service unavailable',
  JSON.stringify(summary.listAtApply))
check('P0 默认值仍在（rollbackEnabled 是 DEFAULTS 成员）', 'rollbackEnabled' in summary.config)

// ---- P1：组装期派生工具面（surfaceForPhase 纯函数 + assemble 处理器姿态）----
const TOOLS = ['pwsh', 'read', 'edit', 'browser_open', 'browser_type', 'vision_crop', 'todo_write'].map((n) => ({ name: n }))
const PATTERNS = ['browser_*', 'vision_*', 'todo_write']
const names = (arr) => arr.map((t) => t.name).join(',')
check('surface: stable → 原样返回（同一引用）', mod.surfaceForPhase('stable', TOOLS, PATTERNS) === TOOLS)
check('surface: watch → 原样返回', mod.surfaceForPhase('watch', TOOLS, PATTERNS) === TOOLS)
check('surface: narrowed → 收窄到核心工作集',
  names(mod.surfaceForPhase('narrowed', TOOLS, PATTERNS)) === 'pwsh,read,edit')
check('surface: 入参不被修改（纯函数）', TOOLS.length === 7 && names(TOOLS).includes('browser_open'))
check('surface: 空模式表 → 不收窄（fail-open）', mod.surfaceForPhase('narrowed', TOOLS, []) === TOOLS)
check('surface: tools 非数组 → 原样返回', mod.surfaceForPhase('narrowed', undefined, PATTERNS) === undefined)
check('surface: 无 name 的条目不抛错，且按 fail-open 保留（不误删）',
  mod.surfaceForPhase('narrowed', [{ name: 'pwsh' }, {}], PATTERNS).length === 2)

{
  const assemble = handlers['system-prompt/assemble']
  check('assemble 处理器已注册', typeof assemble === 'function')
  const asm = { sections: [], contexts: [], tools: TOOLS, variables: {} }
  const passthrough = await assemble(asm, { agent: { id: 'not-tracked' } }, async () => asm)
  check('assemble: 未跟踪的 agent → 原样返回（不做任何收窄）', passthrough === asm)
  let out
  try {
    out = await assemble(asm, { get agent() { throw new Error('boom') } }, async () => asm)
  } catch (e) {
    out = { threw: e.message }
  }
  check('assemble: 处理器内部抛错 → fail-open 返回原 assembly（本插件的 bug 不吃能力）',
    out === asm, JSON.stringify(out && out.threw ? out : 'ok'))
}

console.log(`\n${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
