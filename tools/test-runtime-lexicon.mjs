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

console.log(`\n${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
