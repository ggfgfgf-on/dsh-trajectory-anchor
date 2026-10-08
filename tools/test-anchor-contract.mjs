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
  await mod.apply(ctx, { adaptiveStateEnabled: false, rollbackEnabled: false, notARealKey: 123 })
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

// ---- 安装即用：完全不给配置（新装用户的真实情形）----
// 说明：CONFIG 是模块级状态，本文件前面那次 apply 只覆盖了 rollbackEnabled=false
// （与 DEFAULTS 相同）并忽略了一个未知键，所以此处 apply(undefined) 之后的生效值
// 与"全新 import + 零配置"一致——这正是 bundle patch 不声明任何 config 所对应的情形。
{
  const tools2 = {}
  const warns2 = []
  const orig2 = console.warn
  console.warn = (...a) => { warns2.push(a.join(' ')) }
  try {
    const ctx2 = {
      get: (n) => (n === 'tools' ? { register: (t) => { tools2[t.name] = t; return () => {} } } : undefined),
      on: () => () => {},
      effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    }
    await mod.apply(ctx2)                     // ← 无 config 参数
    const s2 = await tools2.anchor_status.execute({})

    // 平台契约：工具输出必须是**无损 JSON**——不能有 undefined / NaN / Infinity / 函数。
    // 本轮踩过：channels 里短参考通道的 observed 是 undefined，anchor_status 直接报
    // "value is not lossless JSON"（测试没抓到，因为校验发生在 DSH 工具层）。
    const badPaths = []
    const walk = (v, path) => {
      if (v === undefined) { badPaths.push(`${path}=undefined`); return }
      if (typeof v === 'number' && !Number.isFinite(v)) { badPaths.push(`${path}=${v}`); return }
      if (typeof v === 'function') { badPaths.push(`${path}=function`); return }
      if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return }
      if (v && typeof v === 'object') { for (const k of Object.keys(v)) walk(v[k], `${path}.${k}`) }
    }
    walk(s2, 'summary')
    check('工具输出可无损 JSON 序列化（无 undefined/NaN/function）', badPaths.length === 0, badPaths.slice(0, 5).join(', '))
    let roundTrip = null
    try { roundTrip = JSON.parse(JSON.stringify(s2)) } catch (e) { roundTrip = null }
    check('工具输出 JSON round-trip 成功', roundTrip !== null && typeof roundTrip === 'object')

    check('安装即用: apply() 不带 config 也能挂载', typeof tools2.anchor_status === 'object')
    // 精确化：这里要守的是"bundle patch 不声明任何键 ⇒ 没有**配置类**告警"。
    // 运行期告警（累积状态装载、自动降档）是**合法信息**——一个装了本插件、近 20 个会话大量收窄
    // 的真实环境本来就该在挂载时报出来。把"零告警"当成契约会误伤正确行为（实测踩到）。
    const configWarns2 = warns2.filter((w) => /config key|unknown config|invalid .*config/i.test(w))
    check('安装即用: 无配置类告警（bundle patch 不声明任何键）', configWarns2.length === 0, JSON.stringify(configWarns2))
    check('安装即用: configWarnings 为空', Array.isArray(s2.configWarnings) && s2.configWarnings.length === 0, JSON.stringify(s2.configWarnings))
    check('安装即用: 出厂即安全（双关 + 有界上限 + 锚定默认开）',
      s2.config.rollbackEnabled === false && s2.config.notifyEnabled === false
      && s2.config.maxDriftSteps > 0 && s2.config.gateEnabled === true
      && s2.config.suppressContextOnBootstrap === true,
      JSON.stringify({ r: s2.config.rollbackEnabled, n: s2.config.notifyEnabled, m: s2.config.maxDriftSteps, g: s2.config.gateEnabled }))
    check('安装即用: 策略键全部有出厂默认',
      ['refMinSteps', 'testWindow', 'notifyAlpha', 'actAlpha'].every((k) => typeof s2.config[k] === 'number'))
  } finally {
    console.warn = orig2
  }
}

console.log(`\n${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
