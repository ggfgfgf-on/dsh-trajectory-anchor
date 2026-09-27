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

// dynamicRecoveryLen：p=P(spec|spec) 取自会话自身真实 band 历史（personaRatio 导出的 band）
eq('dyn: 全 react 历史 → p=0 → k=下限1', mod.dynamicRecoveryLen(['react', 'react', 'react', 'react'], 1, 0.98), 1)
eq('dyn: 单 spec 闪烁 → p=0 → k=1', mod.dynamicRecoveryLen(['react', 'spec', 'react'], 1, 0.98), 1)
eq('dyn: 空历史 → k=下限1', mod.dynamicRecoveryLen([], 1, 0.98), 1)
eq('dyn: 下限 3 生效（防闪烁配置）', mod.dynamicRecoveryLen(['react', 'spec', 'react'], 3, 0.98), 3)
eq('dyn: 全 spec 10 段 → p=0.9 → k=10', mod.dynamicRecoveryLen(Array(10).fill('spec'), 1, 0.98), 10)
eq('dyn: p≥0.98（spec 常态）→ k=下限直接恢复（无上限）', mod.dynamicRecoveryLen(Array(51).fill('spec'), 1, 0.98), 1)
eq('dyn: p≥0.98 且下限 3 → k=3（不是 50）', mod.dynamicRecoveryLen(Array(51).fill('spec'), 3, 0.98), 3)
{
  // 复刻 75cbc07e 的 band 形态：spec 段 2,3,4,5,9,18,43 共 84 个 spec，段间夹 react
  const runs = [2, 3, 4, 5, 9, 18, 43]
  const seq = []
  for (let i = 0; i < runs.length; i++) {
    for (let j = 0; j < runs[i]; j++) seq.push('spec')
    if (i < runs.length - 1) seq.push('react')
  }
  eq('dyn: 75cbc07e 形态 → p≈0.92 → k=12', mod.dynamicRecoveryLen(seq, 1, 0.98), 12)
}

console.log(`\n${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
