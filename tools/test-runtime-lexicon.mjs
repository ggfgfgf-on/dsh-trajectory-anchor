// 运行时词典补丁回归测试：termRegex（CJK-safe）+ parseLexiconJson。
// 用法：node tools/test-runtime-lexicon.mjs [index.js 路径]（默认 ../index.js）
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const here = fileURLToPath(new URL('.', import.meta.url))
const target = resolve(here, process.argv[2] || '../index.js')
const mod = await import(pathToFileURL(target).href)

let pass = 0
let fail = 0
const eq = (name, got, want) => {
  const ok = got === want
  if (ok) pass++; else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)
}
const hits = (term, text) => (text.toLowerCase().match(mod.termRegex(term, 'g')) || []).length

// 拉丁/西里尔：字母环视边界（与提取器词切分一致）
eq('café in "café"', hits('café', 'café'), 1)
eq('café not in "cafés"（提取器视为一个词）', hits('café', 'cafés'), 0)
eq('café not in "xcafé"', hits('café', 'xcafé'), 0)
eq('we in "we"', hits('we', 'we'), 1)
eq('we not in "sweden"', hits('we', 'sweden'), 0)
eq('we in "we1"（数字不算词内字母）', hits('we', 'we1'), 1)
eq('let me in "let me"', hits('let me', 'let me'), 1)
eq('let me not in "let\'s"', hits('let me', "let's"), 0)
eq('our not in "hour"', hits('our', 'hour'), 0)
eq('our not in "ours"', hits('our', 'ours'), 0)
// CJK：字面子串
eq('终验 in "最终验证"', hits('终验', '最终验证'), 1)
eq('最终验证 not in "终验"', hits('最终验证', '终验'), 0)
eq('待填写 in "本报告不含待填写"（正则陷阱词照样命中，语义由词典极性决定）', hits('待填写', '本报告不含待填写'), 1)
// 元字符转义
eq('a+b literal', hits('a+b', 'a+b'), 1)
eq('a+b not matching "acb"', hits('a+b', 'acb'), 0)

// parseLexiconJson：直体 + 校准输出 + 坏形状
const direct = mod.parseLexiconJson(JSON.stringify({ positive: { 协作: 2 }, negative: { 漂移: 3 }, neutral: {} }))
eq('direct: positive 桶大小', Object.keys(direct.positive).length, 1)
eq('direct: 协作 权重', direct.positive['协作'], 2)
eq('direct: 无 ratioWeights', direct.ratioWeights === undefined, true)
const calib = mod.parseLexiconJson(JSON.stringify({
  lexicon: { positive: { 协同: 2 }, negative: { 待填写: 3 }, neutral: {} },
  ratioWeights: { alpha: 3, beta: 1, gamma: 3, epsilon: 1 },
}))
eq('calib: ratioWeights.alpha', calib.ratioWeights && calib.ratioWeights.alpha, 3)
eq('calib: negative 桶', Object.keys(calib.negative).length, 1)
let threw = 0
for (const bad of ['{"positive":1}', '{"lexicon":{"positive":{}}}', 'not json']) {
  try { mod.parseLexiconJson(bad) } catch (e) { threw++ }
}
eq('坏形状/坏 JSON 全抛错', threw, 3)

// gateEarlyLift：空负桶不得提前放行（0 负词典 gate 语义修正）
eq('gate: 负桶空→不放行（即使正命中）', mod.gateEarlyLift([{ hasPositive: true, hasNegative: false }], false), false)
eq('gate: 负桶空+无正→不放行', mod.gateEarlyLift([{ hasPositive: false, hasNegative: false }], false), false)
eq('gate: 有负桶+正命中无负→放行', mod.gateEarlyLift([{ hasPositive: true, hasNegative: false }], true), true)
eq('gate: 有负桶+正负都命中→不放行', mod.gateEarlyLift([{ hasPositive: true, hasNegative: true }], true), false)
eq('gate: 有负桶+仅负命中→不放行', mod.gateEarlyLift([{ hasPositive: false, hasNegative: true }], true), false)

// ── P3 策略纯函数（取代已删除的 dynamicRecoveryLen）────────────────────────
// mannWhitneyLowerP：单侧"检验窗是否异常偏低"的 p 值（正态近似 + 并列修正）
const mw = (t, r) => mod.mannWhitneyLowerP(t, r)
eq('mw: 两窗同分布 → p 接近 0.5', Math.abs(mw([1, 2, 3, 4], [1, 2, 3, 4]) - 0.5) < 0.3, true)
eq('mw: 检验窗显著更低 → p 很小', mw([0, 0, 0, 0], [5, 6, 7, 8, 9, 10, 11, 12]) < 0.01, true)
eq('mw: 检验窗显著更高 → p 接近 1', mw([9, 10, 11, 12], [1, 2, 3, 4]) > 0.99, true)
eq('mw: 空参考 → p=1（无证据）', mw([1, 2], []), 1)
eq('mw: 全并列 → p=1（σ=0 时不误报）', mw([3, 3, 3], [3, 3, 3]), 1)
eq('mw: 非数值输入被忽略', mw([0, 0, 0, 0, 'x'], [5, 6, 7, 8]) < 0.05, true)

// policyDecision：行动分档（证据不足 / 词典退化 / 预算耗尽 / 总开关关 各自动降档）
const pd = (o) => mod.policyDecision(Object.assign({
  p: 0.001, refLen: 20, refMinSteps: 12, notifyAlpha: 0.05, actAlpha: 0.01,
  degenerate: false, budgetExhausted: false, rollbackEnabled: true, notifyEnabled: true,
}, o))
eq('pd: 偏离强+闸门全过 → 收窄', pd({}).level + '/' + pd({}).action + '/' + pd({}).reason, 'narrowed/narrow/deviation')
eq('pd: 参考不足 → 不动手', pd({ refLen: 3 }).level + '/' + pd({ refLen: 3 }).action + '/' + pd({ refLen: 3 }).reason, 'stable/none/insufficient-reference')
eq('pd: 词典退化 → 状态 narrowed 但只通知', pd({ degenerate: true }).level + '/' + pd({ degenerate: true }).action + '/' + pd({ degenerate: true }).reason, 'narrowed/notice/lexicon-degenerate')
eq('pd: 能力预算耗尽 → 只通知', pd({ budgetExhausted: true }).level + '/' + pd({ budgetExhausted: true }).action + '/' + pd({ budgetExhausted: true }).reason, 'narrowed/notice/capability-budget-exhausted')
eq('pd: 能力层关 → 只通知', pd({ rollbackEnabled: false }).level + '/' + pd({ rollbackEnabled: false }).action + '/' + pd({ rollbackEnabled: false }).reason, 'narrowed/notice/capability-disabled')
eq('pd: 双关（默认）→ 只观察不动手', pd({ rollbackEnabled: false, notifyEnabled: false }).action + '/' + pd({ rollbackEnabled: false, notifyEnabled: false }).reason, 'none/observe-only')
eq('pd: 弱偏离（act<p≤notify）→ watch+通知', pd({ p: 0.03 }).level + '/' + pd({ p: 0.03 }).action, 'watch/notice')
eq('pd: 无偏离 → stable', pd({ p: 0.6 }).level + '/' + pd({ p: 0.6 }).reason, 'stable/within-reference')
eq('pd: 无观测 → stable', pd({ p: null }).level + '/' + pd({ p: null }).action + '/' + pd({ p: null }).reason, 'stable/none/no-observation')

// lexiconDegenerate：正桶一次都没命中 = 该会话的词典退化（能力层闸门）
eq('deg: 观测够且正桶 0 命中 → 退化', mod.lexiconDegenerate(0, 20, 12), 'positive-bucket-never-hit')
eq('deg: 正桶命中过 → 不退化', mod.lexiconDegenerate(1, 20, 12), false)
eq('deg: 观测不足 → 不下结论', mod.lexiconDegenerate(0, 5, 12), false)

// surfaceForPhase：派生工具面（P1）
const TT = (...names) => names.map((n) => ({ name: n }))
eq('surface: narrowed 摘掉命中模式的工具', mod.surfaceForPhase('narrowed', TT('pwsh', 'browser_x', 'todo_write'), ['browser_*', 'todo_write']).length, 1)
eq('surface: stable 原样返回', mod.surfaceForPhase('stable', TT('pwsh', 'browser_x'), ['browser_*']).length, 2)
eq('surface: 空模式表不动手', mod.surfaceForPhase('narrowed', TT('pwsh'), []).length, 1)

console.log(`\n${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
