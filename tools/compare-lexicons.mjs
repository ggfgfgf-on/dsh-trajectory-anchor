#!/usr/bin/env node
/**
 * compare-lexicons.mjs — 词典效果对比（新旧词典在同一语料上的分离度）
 *
 * 用法:
 *   node tools/compare-lexicons.mjs
 *     --corpus-high DIR_OR_FILE     高分语料（目录递归 .txt/.md/.jsonl/.zstd 或单文件）
 *     --corpus-low  DIR_OR_FILE     低分语料
 *     --lexicon-a   JSON 文件        旧词典 { positive, negative, neutral }
 *     --lexicon-b   JSON 文件        新词典 { positive, negative, neutral }
 *     [--labels-a NAME] [--labels-b NAME]
 *
 * 输出：每个词典在高低分语料上的块比率均值/标准差、分离度 d'、
 *       命中率、personaRatio（负标记占比）分布，以及谁分离得更好的结论。
 */
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { collectCorpus } from './session-log-core.mjs'

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

function measure(text, lexicon) {
  const lower = text.toLowerCase()
  const pick = (map) => {
    let sum = 0
    let words = 0
    for (const t of Object.keys(map || {})) {
      const m = lower.match(new RegExp('\\b' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+') + '\\b', 'g'))
      const n = m ? m.length : 0
      sum += n * map[t]
      words += n
    }
    return { sum, words }
  }
  const p = pick(lexicon.positive)
  const n = pick(lexicon.negative)
  const u = pick(lexicon.neutral)
  return { pos: p.sum, neg: n.sum, neu: u.sum, posWords: p.words, negWords: n.words }
}

function stats(lexicon, ratioWeights, highTexts, lowTexts) {
  const w = ratioWeights || { alpha: 2, beta: 0.5, gamma: 1.5, epsilon: 1 }
  const ratio = (f) => (w.alpha * f.pos + w.beta * f.neu) / (w.gamma * f.neg + w.epsilon)
  const evalSet = (texts) => {
    const ratios = []
    let hit = 0
    for (const t of texts) {
      const f = measure(t, lexicon)
      if (f.pos + f.neg + f.neu > 0) hit += 1
      ratios.push(ratio(f))
    }
    const mean = ratios.reduce((a, b) => a + b, 0) / Math.max(1, ratios.length)
    const std = Math.sqrt(ratios.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, ratios.length))
    return { blocks: texts.length, hitRate: Math.round((hit / Math.max(1, texts.length)) * 1000) / 1000, mean: Math.round(mean * 100) / 100, std: Math.round(std * 100) / 100 }
  }
  const hi = evalSet(highTexts)
  const lo = evalSet(lowTexts)
  const sep = (hi.mean - lo.mean) / Math.max(0.0001, Math.sqrt((hi.std ** 2 + lo.std ** 2) / 2))
  return { hi, lo, separation: Math.round(sep * 100) / 100 }
}

const highPath = resolve(arg('--corpus-high', ''))
const lowPath = resolve(arg('--corpus-low', ''))
const lexAPath = resolve(arg('--lexicon-a', ''))
const lexBPath = resolve(arg('--lexicon-b', ''))
if (!highPath || !lowPath || !lexAPath || !lexBPath) {
  console.error('用法: node tools/compare-lexicons.mjs --corpus-high <路径> --corpus-low <路径> --lexicon-a <json> --lexicon-b <json> [--weights-a <json>] [--weights-b <json>] [--labels-a A] [--labels-b B]')
  process.exit(1)
}
const highTexts = collectCorpus(highPath)
const lowTexts = collectCorpus(lowPath)
console.log(`[compare] 高分语料: ${highTexts.length} 块；低分语料: ${lowTexts.length} 块`)

const load = (p) => {
  const o = JSON.parse(readFileSync(p, 'utf8'))
  return { lexicon: o.lexicon || o, weights: o.ratioWeights || null, labels: [arg('--labels-a', 'A'), arg('--labels-b', 'B')] }
}
const lexA = JSON.parse(readFileSync(lexAPath, 'utf8'))
const lexB = JSON.parse(readFileSync(lexBPath, 'utf8'))
const lexAObj = lexA.lexicon || lexA
const lexBObj = lexB.lexicon || lexB
const wA = arg('--weights-a', '') ? JSON.parse(readFileSync(resolve(arg('--weights-a', '')), 'utf8')) : (lexA.ratioWeights || null)
const wB = arg('--weights-b', '') ? JSON.parse(readFileSync(resolve(arg('--weights-b', '')), 'utf8')) : (lexB.ratioWeights || null)

const sA = stats(lexAObj, wA, highTexts, lowTexts)
const sB = stats(lexBObj, wB, highTexts, lowTexts)
const nameA = arg('--labels-a', '词典 A')
const nameB = arg('--labels-b', '词典 B')
console.log(`[compare] ${nameA}: 高分均值 ${sA.hi.mean} 低分均值 ${sA.lo.mean} 分离度 ${sA.separation} 命中率 ${sA.hi.hitRate}/${sA.lo.hitRate}`)
console.log(`[compare] ${nameB}: 高分均值 ${sB.hi.mean} 低分均值 ${sB.lo.mean} 分离度 ${sB.separation} 命中率 ${sB.hi.hitRate}/${sB.lo.hitRate}`)
const verdict = sB.separation > sA.separation ? `${nameB} 分离更好（+${Math.round((sB.separation - sA.separation) * 100) / 100}）` : sA.separation > sB.separation ? `${nameA} 分离更好（+${Math.round((sA.separation - sB.separation) * 100) / 100}）` : '两者分离度相当'
console.log(`[compare] 结论: ${verdict}`)
console.log(`[compare] 注意: 分离度是必要不充分指标——还需探测兼容性（正负标记命中）与极性与结果一致性验证。`)
