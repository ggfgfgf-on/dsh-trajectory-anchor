// 跨任务方向一致性（语料级）：词典 A 的每个词在语料 B（正/负块）上重算极性。
// 同号 → 保留；翻号 → 剔除（任务词噪声）；缺席/不显著 → 剔除（仅单任务证据）。
// 用法: node tools/cross-task-check.mjs <lexiconA.json> <blocksB.json> [minFreq]
import { readFileSync, writeFileSync } from 'node:fs'
import { contrastPolarity } from './lexicon-core.mjs'

const [aPath, bPath, mfArg] = process.argv.slice(2)
if (!aPath || !bPath) {
  console.error('usage: node tools/cross-task-check.mjs <lexiconA.json> <blocksB.json> [minFreq]')
  process.exit(1)
}
const A = JSON.parse(readFileSync(aPath, 'utf8'))
const B = JSON.parse(readFileSync(bPath, 'utf8'))
const aLex = A.lexicon || A
const minFreq = Number(mfArg || 5)

const rows = contrastPolarity(B.positives, B.negatives, minFreq, 100000)
const byTerm = new Map(rows.map((r) => [r.term, r]))

const kept = { positive: {}, negative: {}, neutral: {} }
const prunedFlip = []
const prunedAbsent = []
const stats = { same: 0, flip: 0, absent: 0 }

for (const bucket of ['positive', 'negative']) {
  const sA = bucket === 'positive' ? 'positive' : 'negative'
  for (const term of Object.keys(aLex[bucket] || {})) {
    const row = byTerm.get(term)
    if (!row) {
      prunedAbsent.push({ term, a: bucket, w: aLex[bucket][term] })
      stats.absent++
    } else if (row.polarity === sA) {
      kept[bucket][term] = aLex[bucket][term]
      stats.same++
    } else {
      prunedFlip.push({ term, a: bucket, b: row.polarity, fa: row.fa, fd: row.fd, odds: +row.odds.toFixed(2), w: aLex[bucket][term] })
      stats.flip++
    }
  }
}

console.log(`A 词条: ${stats.same + stats.flip + stats.absent} → 保留 ${stats.same} / 翻号 ${stats.flip} / 缺席 ${stats.absent}`)
console.log('--- 翻号（跨任务方向翻转 = 任务词/噪声，降噪目标） ---')
for (const p of prunedFlip) console.log(`  ${p.term}: A=${p.a}(w${p.w}) → B=${p.b} (fa=${p.fa}, fd=${p.fd}, odds=${p.odds})`)
console.log('--- 保留（跨任务同号 = 风格词候选） ---')
console.log('  正: ' + Object.keys(kept.positive).join(', '))
console.log('  负: ' + Object.keys(kept.negative).join(', '))
console.log('--- 缺席（父语料中不显著） ---')
console.log('  ' + prunedAbsent.map((p) => p.term).join(', '))

const out = {
  generated_utc: new Date().toISOString(),
  rule: 'term kept iff same polarity on cross-task blocks (contrastPolarity, minFreq=' + minFreq + ')',
  sourceLexicon: aPath,
  sourceBlocks: bPath,
  stats,
  kept: { lexicon: { ...kept }, ratioWeights: A.ratioWeights || null },
  prunedFlip,
  prunedAbsent,
}
const outPath = aPath.replace(/\.json$/, '-xcheck2.json')
writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8')
console.log(`已写出: ${outPath}`)
