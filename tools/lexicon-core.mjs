/**
 * lexicon-core.mjs — 词典标定的共享统计核心（CLI 与插件运行时共用）
 * 零依赖。导出 n-gram 计数与「锚定组 vs 漂移组」对比极性（log-odds）。
 */

export const LATIN_STOPWORDS = new Set([
  'the', 'and', 'of', 'to', 'in', 'is', 'a', 'it', 'for', 'on', 'that', 'this', 'with', 'as', 'are',
  'was', 'be', 'at', 'by', 'or', 'an', 'not', 'but', 'from', 'we', 'i', 'if', 'then', 'so', 'can',
  'will', 'would', 'should', 'could', 'have', 'has', 'do', 'does', 'did', 'all', 'any', 'no', 'yes',
  'also', 'just', 'now', 'here', 'there', 'what', 'which', 'when', 'how', 'why', 'get', 'got',
])

/** 对文本数组计 n-gram：东方文字字 n-gram（2-4：中日韩统一表意含扩展A/兼容、
 *  假名、谚文音节）+ 拉丁/西里尔词 n-gram（1-2，滤停用词，含带重音字母）。
 *  覆盖之外的文字（如纯阿拉伯文）暂不参与对比——诚实边界。 */
export function ngrams(texts) {
  const map = new Map()
  const bump = (k) => { if (k) map.set(k, (map.get(k) ?? 0) + 1) }
  for (const text of texts) {
    if (typeof text !== 'string' || text.length === 0) continue
    const cjkRuns = text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]{2,}/g) ?? []
    for (const run of cjkRuns) {
      for (let n = 2; n <= 4; n++) {
        for (let i = 0; i + n <= run.length; i++) bump(run.slice(i, i + n))
      }
    }
    const latinRuns = text.match(/[A-Za-z\u00c0-\u024f\u0400-\u04ff][A-Za-z\u00c0-\u024f\u0400-\u04ff' -]*/g) ?? []
    for (const run of latinRuns) {
      const words = run.toLowerCase().split(/[\s-]+/).filter((w) => w.length > 1 && !LATIN_STOPWORDS.has(w))
      for (let i = 0; i < words.length; i++) {
        bump(words[i])
        if (i + 1 < words.length) bump(`${words[i]} ${words[i + 1]}`)
      }
    }
  }
  return map
}

/**
 * 锚定组 vs 漂移组对比：每个候选词的 log-odds，正 = 锚定组过度表达（positive），
 * 负 = 漂移组过度表达（negative）。返回按 |odds| 降序的 top 列表。
 * @param anchored - 锚定风文本块数组
 * @param drifted - 漂移风文本块数组
 * @param minFreq - 候选最小总频次
 * @param top - 输出上限
 * @returns [{ term, fa, fd, odds, polarity }]
 */
export function contrastPolarity(anchored, drifted, minFreq, top) {
  const a = ngrams(anchored)
  const d = ngrams(drifted)
  const aN = anchored.reduce((n, s) => n + (typeof s === 'string' ? s.length : 0), 0) || 1
  const dN = drifted.reduce((n, s) => n + (typeof s === 'string' ? s.length : 0), 0) || 1
  const rows = []
  const seen = new Set([...a.keys(), ...d.keys()])
  for (const term of seen) {
    const fa = a.get(term) ?? 0
    const fd = d.get(term) ?? 0
    if (fa + fd < minFreq) continue
    const pa = fa / aN
    const pd = fd / dN
    const odds = Math.log((pa + 1e-9) / (pd + 1e-9))
    if (Math.abs(odds) < 0.4) continue
    rows.push({ term, fa, fd, odds, polarity: odds > 0 ? 'positive' : 'negative' })
  }
  rows.sort((x, y) => Math.abs(y.odds) - Math.abs(x.odds))
  return rows.slice(0, top)
}

/** log-odds → 词典权重（截断到 [0.5, 3.0]，1 位小数）。 */
export function weightOf(odds) {
  return Math.min(3.0, Math.max(0.5, Math.round(Math.abs(odds) * 10) / 10))
}
