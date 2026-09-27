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
 * 低频词（总频次 < minFreq）必须额外通过 Fisher 精确检验（p<0.05）才入榜，
 * 否则「正组 1 次、负组 0 次」这类样本量伪影会冒充神谕词。
 * @param anchored - 锚定风文本块数组
 * @param drifted - 漂移风文本块数组
 * @param minFreq - 候选硬下限（达到即免检验；未达到需 Fisher 显著）
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
    const total = fa + fd
    if (total < 2) continue
    const pa = fa / aN
    const pd = fd / dN
    const odds = Math.log((pa + 1e-9) / (pd + 1e-9))
    if (Math.abs(odds) < 0.4) continue
    if (total < minFreq) {
      // 低频词：过显著性检验才算数（Fisher 精确，双侧 p<0.05）
      if (fisherExact(fa, aN, fd, dN) > 0.05) continue
    }
    rows.push({ term, fa, fd, odds, polarity: odds > 0 ? 'positive' : 'negative' })
  }
  rows.sort((x, y) => Math.abs(y.odds) - Math.abs(x.odds))
  return rows.slice(0, top)
}

/** log-gamma（Lanczos 近似），供 Fisher 精确检验的 log 域组合数计算。 */
function logGamma(x) {
  const g = 7
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ]
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x)
  x -= 1
  let a = c[0]
  const t = x + g + 0.5
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i)
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}

function logComb(n, k) {
  if (k < 0 || k > n) return -Infinity
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1)
}

/** 超几何概率 P(X=k) = C(K,k)·C(N−K,n−k)/C(N,n)。 */
function hypergeomP(k, N, K, n) {
  return Math.exp(logComb(K, k) + logComb(N - K, n - k) - logComb(N, n))
}

/** 2×2 双侧 Fisher 精确检验 p 值（表：[fa, aN−fa; fd, dN−fd]）。
 *  字符量作为机会单位——这是筛选统计量，不是严格实验设计。 */
export function fisherExact(fa, aN, fd, dN) {
  const N = aN + dN
  const K = fa + fd
  const n = aN
  const lo = Math.max(0, K - (N - n))
  const hi = Math.min(K, n)
  const pObs = hypergeomP(fa, N, K, n)
  let p = 0
  for (let k = lo; k <= hi; k++) {
    const pk = hypergeomP(k, N, K, n)
    if (pk <= pObs * (1 + 1e-9)) p += pk
  }
  return Math.min(1, p)
}

/** 词条 → 匹配正则（与 ngrams 提取语义一致）：
 *  纯 CJK 词条：字面子串（ngrams 提取的就是子串，匹配必须同语义）；
 *  拉丁/西里尔词条：用「非词内字母」前后环视当边界——\b 是 ASCII 词边界，
 *  对带重音字母（é/ñ 等非 \w）会失效；字母环视与提取器的词切分
 *  （[A-Za-z\u00c0-\u024f\u0400-\u04ff] 起头）一致，且正确处理 "we1"（提取器
 *  切出 "we"）这类数字相邻情形。 */
export function termRegex(term, flags) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')
  const hasLatin = /[A-Za-z\u00c0-\u024f\u0400-\u04ff]/.test(term)
  if (!hasLatin) return new RegExp(escaped, flags)
  const L = '[A-Za-z\u00c0-\u024f\u0400-\u04ff]'
  return new RegExp('(?<!' + L + ')' + escaped + '(?!' + L + ')', flags)
}

/** log-odds → 词典权重（截断到 [0.5, 3.0]，1 位小数）。 */
export function weightOf(odds) {
  return Math.min(3.0, Math.max(0.5, Math.round(Math.abs(odds) * 10) / 10))
}
