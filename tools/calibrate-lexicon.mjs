#!/usr/bin/env node
/**
 * calibrate-lexicon.mjs — dsh-trajectory-anchor 词典标定工具（模式 A：全自动候选 + 证据，极性待审）
 *
 * 从目标模型的推理文本语料中，用统计方法挑出「该模型特有、且频率显著异于
 * 参照语风」的判别短语（CJK 字 n-gram + 拉丁词 n-gram），与参照语料（默认
 * DeepSeek 系）做归一化频率比，输出：
 *   - <out>.json    候选词典（pending 极性区 + 建议权重 + 统计）
 *   - <out>-report.md  证据报告（频次/相对比/例句/建议权重 + 一次性人审指南）
 *
 * 用法:
 *   node tools/calibrate-lexicon.mjs
 *     --corpus DIR_OR_FILE              目标模型推理文本（必填；会话日志 .jsonl 自动抽
 *                                       reasoning 文本，.txt/.md 按原文）
 *     [--reference-corpus DIR_OR_FILE]  参照语料（默认缺省时退化为「目标语料内 DS 锚点词
 *                                       平均频次」基线，置信度标注为 baseline）
 *     [--min-freq N]     候选最小绝对频次（默认 20）
 *     [--min-ratio R]    最小相对比（默认 3.0）
 *     [--top K]          输出候选上限（默认 60）
 *     [--name S]         词典名（默认 corpus 目录名）
 *     [--out PREFIX]     输出路径前缀（默认 ./lexicon-<name>）
 *
 * 诚实边界：统计能自动回答「哪些词是标记」，不能回答「标记是好是坏」——
 * 全部候选极性标为 pending，由人对照证据报告一次性归档（划入
 * positive/negative/neutral 或删除），之后该词典即可随 cordis.patch.yml
 * 的 `lexicon:` 配置整体替换默认 DS 词典、长期自动使用。
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528

/** 与 export-layer4.mjs 同源的 zstd 帧扫描（DSH 会话日志格式）。 */
function scanZstdFrames(buf) {
  const frames = []
  let offset = 0
  while (offset < buf.length) {
    const start = offset
    if (buf.length - offset < 4) break
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid zstd frame magic at byte ${offset}`)
    offset += 4
    const descriptor = buf.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) throw new Error('reserved frame-header bit')
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag)
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    for (;;) {
      if (buf.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buf.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error('reserved block type')
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buf.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buf.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

function decodeSessionLog(path) {
  const buf = readFileSync(path)
  const { frames } = scanZstdFrames(buf)
  return frames.map(({ start, end }) => zstdDecompressSync(buf.subarray(start, end)).toString('utf8')).join('\n')
}

const DS_REFERENCE_TERMS = ['we', "let's", "we'll", 'we need', 'our', 'let me', 'i will', "i'll", 'i need', 'check', 'verify']

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

// ---------- 语料加载 ----------
function walk(dir, out) {
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/** 从一条会话日志记录中抽取推理/助手文本。 */
function textFromRecord(o) {
  if (!o) return ''
  if (o.type === 'reasoning-chunks' && Array.isArray(o.data?.texts)) return o.data.texts.join(' ')
  if (o.type === 'assistant/message') {
    const c = o.data?.message?.content
    if (!Array.isArray(c)) return ''
    return c.filter((b) => b?.type === 'reasoning' || b?.type === 'text').map((b) => b.text ?? '').join(' ')
  }
  if (o.type === 'assistant/chunk') {
    const t = o.data?.chunk?.text
    return typeof t === 'string' ? t : ''
  }
  return ''
}

function collectCorpus(path) {
  const chunks = []
  const files = statSync(path).isDirectory() ? walk(path, []) : [path]
  for (const f of files) {
    let text
    try { text = f.endsWith('.zstd') ? decodeSessionLog(f) : readFileSync(f, 'utf8') } catch { continue }
    if (f.endsWith('.jsonl') || f.endsWith('.zstd')) {
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        let o
        try { o = JSON.parse(line) } catch { continue }
        const t = textFromRecord(o)
        if (t) chunks.push(t)
      }
    } else if (/\.(txt|md|log)$/.test(f)) {
      if (text.trim()) chunks.push(text)
    }
  }
  return chunks
}

// ---------- n-gram ----------
function ngrams(chunks) {
  const map = new Map()
  const bump = (k) => { if (k) map.set(k, (map.get(k) ?? 0) + 1) }
  for (const text of chunks) {
    const cjkRuns = text.match(/[\u4e00-\u9fff]{2,}/g) ?? []
    for (const run of cjkRuns) {
      for (let n = 2; n <= 4; n++) {
        for (let i = 0; i + n <= run.length; i++) bump(run.slice(i, i + n))
      }
    }
    const latinRuns = text.match(/[A-Za-z][A-Za-z' -]*/g) ?? []
    for (const run of latinRuns) {
      const words = run.toLowerCase().split(/[\s-]+/).filter((w) => w.length > 1)
      for (let i = 0; i < words.length; i++) {
        bump(words[i])
        if (i + 1 < words.length) bump(`${words[i]} ${words[i + 1]}`)
      }
    }
  }
  return map
}

// ---------- 主流程 ----------
function main() {
  const corpusPath = resolve(arg('--corpus', ''))
  if (!corpusPath) { console.error('需要 --corpus（目标模型推理文本目录或文件）'); process.exit(1) }
  const refPath = arg('--reference-corpus', '') ? resolve(arg('--reference-corpus', '')) : null
  const minFreq = Number(arg('--min-freq', '20'))
  const minRatio = Number(arg('--min-ratio', '3.0'))
  const top = Number(arg('--top', '60'))
  const name = arg('--name', basename(corpusPath).replace(/\.[^.]+$/, '') || 'model')
  const outPrefix = resolve(arg('--out', `./lexicon-${name}`))

  const chunks = collectCorpus(corpusPath)
  if (chunks.length === 0) { console.error('目标语料为空（无推理文本）'); process.exit(1) }
  const totalChars = chunks.reduce((a, c) => a + c.length, 0)
  const model = ngrams(chunks)
  let ref = null
  let refChars = 0
  let refMode = 'baseline'
  if (refPath) {
    const refChunks = collectCorpus(refPath)
    if (refChunks.length > 0) {
      ref = ngrams(refChunks)
      refChars = refChunks.reduce((a, c) => a + c.length, 0)
      refMode = 'cross-corpus'
    }
  }
  // 基线模式：目标语料内 DS 锚点词的平均频次
  let anchor = 0
  if (!ref) {
    let sum = 0, n = 0
    for (const t of DS_REFERENCE_TERMS) {
      const v = model.get(t) ?? 0
      if (v > 0) { sum += v; n++ }
    }
    anchor = n > 0 ? sum / n : 1
  }

  // 候选打分
  const rows = []
  const examples = new Map() // term -> [句子1, 句子2]
  for (const [term, fModel] of model) {
    if (fModel < minFreq) continue
    let ratio
    if (ref) {
      const fRef = ref.get(term) ?? 0
      ratio = refChars > 0 ? (fModel / totalChars) / Math.max(fRef / refChars, 1e-9) : 1e9
    } else {
      ratio = fModel / Math.max(anchor, 1)
    }
    if (ratio < minRatio) continue
    rows.push({ term, fModel, ratio })
  }
  rows.sort((a, b) => b.ratio - a.ratio)
  const picked = rows.slice(0, top)

  // 例句：二次扫描只为候选收集
  for (const chunk of chunks) {
    const sents = chunk.split(/[。！？\n.!?]+/).map((s) => s.trim()).filter((s) => s.length > 8 && s.length < 300)
    for (const s of sents) {
      for (const r of picked) {
        const e = examples.get(r.term)
        if (e && e.length >= 2) continue
        if (s.toLowerCase().includes(r.term.toLowerCase())) {
          if (!e) examples.set(r.term, [s])
          else e.push(s)
        }
      }
    }
  }

  const pending = {}
  for (const r of picked) {
    const w = Math.min(3.0, Math.max(0.5, Math.round(Math.log2(r.ratio) * 10) / 10))
    pending[r.term] = Number(w.toFixed(1))
  }

  const lexicon = {
    provider: name,
    generated_utc: new Date().toISOString(),
    mode: 'candidates-pending (全自动候选；极性待一次性人审)',
    reference_mode: refMode,
    corpus_chars: totalChars,
    reference_chars: refChars,
    baseline_anchor_freq: ref ? null : Number(anchor.toFixed(1)),
    positive: {},
    negative: {},
    neutral: {},
    pending,
  }

  // 报告
  const lines = []
  lines.push(`# 词典标定报告：${name}`)
  lines.push('')
  lines.push(`- 模式：${refMode === 'cross-corpus' ? '双语料频率比（目标 vs 参照）' : '目标语料内 DS 锚点词基线'}`)
  lines.push(`- 目标语料：${corpusPath}（${chunks.length} 个文本块，${totalChars} 字符）`)
  if (refPath) lines.push(`- 参照语料：${refPath}（${refChars} 字符）`)
  lines.push(`- 筛选：min-freq=${minFreq}，min-ratio=${minRatio}，top=${top}`)
  lines.push('')
  lines.push('> 诚实边界：统计回答「哪些词是该模型的标记」，不回答「标记是好是坏」。')
  lines.push('> 请对照下表做**一次性**归档：把词划入 positive（规划风）/ negative（反应风）/ neutral，')
  lines.push('> 或删除噪音；然后把 positive/negative/neutral 三项贴进 profile 的 cordis.patch.yml')
  lines.push('> `trajectory-anchor` 行的 `lexicon:` 配置即可替换默认 DS 词典。')
  lines.push('')
  lines.push('| 候选词 | 模型频次 | 相对比 | 建议权重 | 例句 |')
  lines.push('|---|---|---|---|---|')
  for (const r of picked) {
    const ex = (examples.get(r.term) ?? []).map((s) => s.replace(/\|/g, '\\|').slice(0, 40)).join(' / ')
    lines.push(`| ${r.term} | ${r.fModel} | ${r.ratio.toFixed(1)}x | ${pending[r.term]} | ${ex || '—'} |`)
  }
  lines.push('')
  lines.push('## 归档后使用')
  lines.push('')
  lines.push('```yaml')
  lines.push('# cordis.patch.yml 中 trajectory-anchor 行内加入：')
  lines.push('#   lexicon:')
  lines.push('#     positive: { 我们先: 2.0, ... }')
  lines.push('#     negative: { ... }')
  lines.push('#     neutral:  { ... }')
  lines.push('```')

  writeFileSync(`${outPrefix}.json`, JSON.stringify(lexicon, null, 2), 'utf8')
  writeFileSync(`${outPrefix}-report.md`, lines.join('\n'), 'utf8')

  console.log(`[calibrate] 目标语料 : ${chunks.length} 块 / ${totalChars} 字符`)
  console.log(`[calibrate] 参照模式 : ${refMode}${ref ? `（${refChars} 字符）` : `（锚点均频 ${anchor.toFixed(1)}）`}`)
  console.log(`[calibrate] 候选数量 : ${picked.length}`)
  console.log(`[calibrate] 词典文件 : ${outPrefix}.json`)
  console.log(`[calibrate] 证据报告 : ${outPrefix}-report.md`)
  if (picked.length > 0) {
    console.log('[calibrate] Top 10:')
    for (const r of picked.slice(0, 10)) console.log(`  ${r.term}  ${r.ratio.toFixed(1)}x  (freq ${r.fModel})`)
  }
}

main()
