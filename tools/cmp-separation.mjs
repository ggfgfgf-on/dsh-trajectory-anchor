// usage: node tools/cmp-separation.mjs <highScoreSession.zstd> <lowScoreSession.zstd> [lexicon.json]
import { termRegex } from './lexicon-core.mjs'
import { collectCorpus } from './session-log-core.mjs'
import { readFileSync } from 'node:fs'

const [highPath, lowPath, lexiconPath] = process.argv.slice(2)
if (!highPath || !lowPath) {
  console.error('usage: node tools/cmp-separation.mjs <highScoreSession.zstd> <lowScoreSession.zstd> [lexicon.json]')
  process.exit(1)
}

const high = collectCorpus(highPath)
const low = collectCorpus(lowPath)
console.log(`high corpus: ${high.length} blocks; low corpus: ${low.length} blocks`)

const measure = (text, lexicon) => {
  const lower = text.toLowerCase()
  const pick = (map) => {
    let s = 0
    for (const t of Object.keys(map || {})) {
      const n = (lower.match(termRegex(t, 'g')) || []).length
      s += n * map[t]
    }
    return s
  }
  return { pos: pick(lexicon.positive), neg: pick(lexicon.negative), neu: pick(lexicon.neutral) }
}

const separation = (lexicon, weights, highTexts, lowTexts) => {
  const w = weights || { alpha: 2, beta: 0.5, gamma: 1.5, epsilon: 1 }
  const ratio = (f) => (w.alpha * f.pos + w.beta * f.neu) / (w.gamma * f.neg + w.epsilon)
  const ev = (texts) => {
    const rs = texts.map((t) => ratio(measure(t, lexicon)))
    const m = rs.reduce((a, b) => a + b, 0) / Math.max(1, rs.length)
    const sd = Math.sqrt(rs.reduce((a, b) => a + (b - m) * (b - m), 0) / Math.max(1, rs.length))
    return { mean: +m.toFixed(3), std: +sd.toFixed(3) }
  }
  const h = ev(highTexts)
  const l = ev(lowTexts)
  return { high: h, low: l, d: +((h.mean - l.mean) / Math.max(0.0001, Math.sqrt((h.std ** 2 + l.std ** 2) / 2))).toFixed(3) }
}

const dsDefault = {
  positive: { we: 2, "let's": 1.5, "we'll": 1.2, 'we need': 1.2, our: 0.8 },
  negative: { 'let me': 3 },
  neutral: { 'i will': 1, "i'll": 1, 'i need': 0.8, check: 0.4, verify: 0.4 },
}

const sDs = separation(dsDefault, { alpha: 2, beta: 0.5, gamma: 1.5, epsilon: 1 }, high, low)
console.log(`DS default: high mean ${sDs.high.mean}  low mean ${sDs.low.mean}  separation ${sDs.d}`)

if (lexiconPath) {
  const l2 = JSON.parse(readFileSync(lexiconPath, 'utf8'))
  const sL2 = separation(l2.lexicon, l2.ratioWeights, high, low)
  console.log(`L2 lexicon: high mean ${sL2.high.mean}  low mean ${sL2.low.mean}  separation ${sL2.d}`)
} else {
  console.log('no lexicon.json given; pass one to compare against DS default')
}
