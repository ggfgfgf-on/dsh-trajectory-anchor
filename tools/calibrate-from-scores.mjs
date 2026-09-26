#!/usr/bin/env node
/**
 * calibrate-from-scores.mjs — 基准分数监督标定（高级用户）
 *
 * 把 Project2 类基准的真实分数当监督标签：高分会话（ability ≥ --high）的推理语料
 * 作为「锚定风」正样本，低分会话（ability ≤ --low）作为「漂移风」负样本，
 * 对比统计直接定极性出词典；同数据顺带网格拟合 ratioWeights（评分器参数），
 * 让高分语料的块比率与低分语料最大化分离。
 *
 * 与 Layer-4 衔接：这些会话导出的 layer4 训练样本从此携带真实质量标签。
 *
 * 用法:
 *   node tools/calibrate-from-scores.mjs
 *     --results DIR        评测结果根目录（含每轮 score_draft.json 的子目录，必填）
 *     --sessions DIR       DSH 会话日志根目录（递归找 session.jsonl.zstd，必填）
 *     [--model NAME]       只标定该模型（按会话日志里的 request/header model 过滤）
 *     [--high N]           高分线（默认 95）
 *     [--low N]            低分线（默认 90）
 *     [--min-freq N]       contrast 硬下限（默认 5；低于该值走 Fisher 显著检验）
 *     [--top N]            词典词条上限（默认 60）
 *     [--out PREFIX]       输出前缀（默认 ./lexicon-score）
 *
 * 输出:
 *   <out>.json         监督词典 { positive, negative, neutral } + 拟合的 ratioWeights
 *   <out>-report.md     逐轮证据（哪轮什么分、匹配哪个会话、多少语料）+ 诚实边界
 *
 * 诚实边界：基准分数是会话级标签——同一会话里所有块共享一个分数，粒度粗；
 * 且同一个基准任务的语料里任务词汇会与风格词汇竞争。多任务多轮跑得越多，
 * 风格层越干净。
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { contrastPolarity, fisherExact } from './lexicon-core.mjs'
import { decodeSessionLog, walk, textFromRecord } from './session-log-core.mjs'

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

// ---------- 评测结果扫描 ----------
function scanRuns(resultsDir) {
  const runs = []
  for (const dir of walk(resultsDir, [])) {
    if (!dir.endsWith('score_draft.json')) continue
    let o
    try { o = JSON.parse(readFileSync(dir, 'utf8')) } catch { continue }
    const ability = typeof o.ability_draft === 'number' ? o.ability_draft : (typeof o.ability === 'number' ? o.ability : null)
    if (ability === null) continue
    const meta = o.meta || {}
    let mtimeMs = 0
    try { mtimeMs = statSync(join(dir, '..')).mtimeMs } catch { /* ignore */ }
    runs.push({
      dir: join(dir, '..'),
      mtimeMs,
      ability,
      model: meta.model || '',
      provider: meta.provider || '',
      runGroup: meta.run_group_id || '',
      runIndex: meta.run_index ?? null,
      blockers: Array.isArray(o.blockers) ? o.blockers : [],
    })
  }
  return runs
}

// ---------- 会话日志扫描 ----------
function scanSessions(sessionsDir, modelFilter) {
  const sessions = []
  const files = walk(sessionsDir, []).filter((f) => f.endsWith('session.jsonl.zstd'))
  for (const f of files) {
    let text
    try { text = decodeSessionLog(f) } catch { continue }
    let startMs = 0
    let endMs = 0
    let model = ''
    let provider = ''
    const texts = []
    let matched = !modelFilter
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let o
      try { o = JSON.parse(line) } catch { continue }
      if (typeof o.time === 'number') {
        if (!startMs || o.time < startMs) startMs = o.time
        if (o.time > endMs) endMs = o.time
      }
      if ((o.type === 'request/header' || o.type === 'request/context') && o.data) {
        const m = o.data.model || (o.data.header && o.data.header.config && o.data.header.config.model) || ''
        const p = o.data.provider || (o.data.header && o.data.header.config && o.data.header.config.provider) || ''
        if (m) model = m
        if (p) provider = p
        if (modelFilter && (m === modelFilter || p === modelFilter)) matched = true
      }
      const t = textFromRecord(o)
      if (t && t.length >= 40) texts.push(t)
    }
    if (!matched || texts.length === 0 || endMs === 0) continue
    sessions.push({ sid: basename(join(f, '..')), startMs, endMs, model, provider, texts })
  }
  return sessions
}

// ---------- 会话 ↔ 评测轮匹配（同模型 + 会话结束于评测完成前 3 小时内，
//            贪心一对一：按时间间隔升序认领，会话与轮次各只用一次） ----------
function matchRuns(sessions, runs) {
  const cands = []
  for (const r of runs) {
    for (const s of sessions) {
      if (r.model && s.model && s.model !== r.model) continue
      const gap = r.mtimeMs - s.endMs
      if (gap < 0 || gap > 3 * 3600 * 1000) continue
      cands.push({ run: r, session: s, gap })
    }
  }
  cands.sort((a, b) => a.gap - b.gap)
  const usedRuns = new Set()
  const usedSessions = new Set()
  const pairs = []
  for (const c of cands) {
    if (usedRuns.has(c.run.dir)) continue
    if (usedSessions.has(c.session.sid)) continue
    usedRuns.add(c.run.dir)
    usedSessions.add(c.session.sid)
    pairs.push({ run: c.run, session: c.session, gapMs: c.gap })
  }
  return pairs
}

// ---------- 评分器参数拟合（网格搜索） ----------
function measureBlock(text, lexicon) {
  const lower = text.toLowerCase()
  const pick = (map) => {
    let sum = 0
    for (const t of Object.keys(map || {})) {
      const m = lower.match(new RegExp('\\b' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+') + '\\b', 'g'))
      sum += (m ? m.length : 0) * map[t]
    }
    return sum
  }
  return { pos: pick(lexicon.positive), neg: pick(lexicon.negative), neu: pick(lexicon.neutral) }
}

function fitRatioWeights(lexicon, posTexts, negTexts) {
  const posFlags = posTexts.map((t) => measureBlock(t, lexicon))
  const negFlags = negTexts.map((t) => measureBlock(t, lexicon))
  let best = null
  for (const alpha of [1, 2, 3]) {
    for (const beta of [0.25, 0.5, 1]) {
      for (const gamma of [1, 1.5, 3]) {
        for (const eps of [0.5, 1]) {
          const ratio = (f) => (alpha * f.pos + beta * f.neu) / (gamma * f.neg + eps)
          const pv = posFlags.map(ratio)
          const nv = negFlags.map(ratio)
          const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length
          const std = (xs, m) => Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / Math.max(1, xs.length))
          const mp = mean(pv)
          const mn = mean(nv)
          const separation = (mp - mn) / Math.max(0.0001, Math.sqrt((std(pv, mp) ** 2 + std(nv, mn) ** 2) / 2))
          if (!best || separation > best.separation) {
            best = { weights: { alpha, beta, gamma, epsilon: eps }, separation: Math.round(separation * 100) / 100, posMean: Math.round(mp * 100) / 100, negMean: Math.round(mn * 100) / 100 }
          }
        }
      }
    }
  }
  return best
}

// ---------- 主流程 ----------
const resultsDir = resolve(arg('--results', ''))
const sessionsDir = resolve(arg('--sessions', ''))
if (!resultsDir || !sessionsDir) {
  console.error('用法: node tools/calibrate-from-scores.mjs --results <评测结果目录> --sessions <会话日志目录> [--model NAME] [--high 95] [--low 90] [--out PREFIX]')
  process.exit(1)
}
const modelFilter = arg('--model', '')
const runGroupFilter = arg('--run-group', '')
const highScore = Number(arg('--high', '95'))
const lowScore = Number(arg('--low', '90'))
const minFreq = Number(arg('--min-freq', '5'))
const top = Number(arg('--top', '60'))
const outPrefix = resolve(arg('--out', './lexicon-score'))

let runs = scanRuns(resultsDir)
if (runGroupFilter) {
  const before = runs.length
  runs = runs.filter((r) => r.runGroup === runGroupFilter)
  console.log(`[scores] run-group 过滤: ${before} -> ${runs.length} (${runGroupFilter})`)
}
console.log(`[scores] 评测轮: ${runs.length}`)
const sessions = scanSessions(sessionsDir, modelFilter)
console.log(`[scores] 会话日志: ${sessions.length}${modelFilter ? ` (model=${modelFilter})` : ''}`)
const pairs = matchRuns(sessions, runs)
console.log(`[scores] 匹配成功: ${pairs.length}`)

const posTexts = []
const negTexts = []
const evidence = []
for (const { run, session, gapMs } of pairs) {
  const cls = run.ability >= highScore ? 'positive' : run.ability <= lowScore ? 'negative' : 'ignored'
  const rec = {
    runDir: basename(run.dir),
    ability: run.ability,
    runIndex: run.runIndex,
    blockers: run.blockers,
    session: session.sid,
    model: session.model,
    texts: session.texts.length,
    gapMin: Math.round(gapMs / 60000 * 10) / 10,
    cls,
  }
  if (cls === 'positive') posTexts.push(...session.texts)
  else if (cls === 'negative') negTexts.push(...session.texts)
  evidence.push(rec)
}

const posChars = posTexts.reduce((n, s) => n + s.length, 0)
const negChars = negTexts.reduce((n, s) => n + s.length, 0)
console.log(`[scores] 正语料（≥${highScore} 分）: ${posTexts.length} 块 / ${posChars} 字符`)
console.log(`[scores] 负语料（≤${lowScore} 分）: ${negTexts.length} 块 / ${negChars} 字符`)

const lexicon = { positive: {}, negative: {}, neutral: {} }
let ratioFit = null
if (posTexts.length >= 10 && negTexts.length >= 10) {
  const rows = contrastPolarity(posTexts, negTexts, minFreq, top)
  for (const r of rows) {
    const bucket = r.polarity === 'positive' ? lexicon.positive : lexicon.negative
    bucket[r.term] = Math.round(Math.min(3, Math.max(0.5, Math.abs(r.odds))) * 10) / 10
  }
  ratioFit = fitRatioWeights(lexicon, posTexts, negTexts)
} else {
  console.warn('[scores] 正/负语料不足（各需 ≥10 块），无法标定——多跑几轮基准再来')
}

const output = {
  generated_utc: new Date().toISOString(),
  mode: 'score-supervised (基准分数监督标定)',
  highScore,
  lowScore,
  positive_texts: posTexts.length,
  positive_chars: posChars,
  negative_texts: negTexts.length,
  negative_chars: negChars,
  lexicon,
  ratioWeights: ratioFit ? ratioFit.weights : null,
  ratioSeparation: ratioFit ? ratioFit.separation : null,
  evidence,
}

const lines = []
lines.push('# 基准分数监督标定报告')
lines.push('')
lines.push(`- 高分线 ≥${highScore}，低分线 ≤${lowScore}；中间分数忽略`)
lines.push(`- 正语料：${posTexts.length} 块 / ${posChars} 字符；负语料：${negTexts.length} 块 / ${negChars} 字符`)
lines.push('')
lines.push('## 逐轮证据')
lines.push('')
lines.push('| 结果目录 | 分数 | runIndex | 会话 | 模型 | 文本块 | 归类 |')
lines.push('|---|---|---|---|---|---|---|')
for (const e of evidence) {
  lines.push(`| ${e.runDir} | ${e.ability} | ${e.runIndex ?? '—'} | ${e.session} | ${e.model} | ${e.texts} | ${e.cls} |`)
}
lines.push('')
lines.push('## 监督词典（直接可用）')
lines.push('')
lines.push('```yaml')
lines.push('# cordis.patch.yml 中 trajectory-anchor 行内加入（或写入 lexiconProfiles.<model>）：')
lines.push('#   lexicon:')
lines.push(`#     positive: ${JSON.stringify(lexicon.positive)}`)
lines.push(`#     negative: ${JSON.stringify(lexicon.negative)}`)
lines.push(`#     neutral: ${JSON.stringify(lexicon.neutral)}`)
if (ratioFit) lines.push(`#   ratioWeights: ${JSON.stringify(ratioFit.weights)}   # 拟合分离度 ${ratioFit.separation}（高分均值 ${ratioFit.posMean} vs 低分均值 ${ratioFit.negMean}）`)
lines.push('```')
lines.push('')
lines.push('> 诚实边界：基准分数是会话级标签（会话内所有块共享一个分数），粒度粗；')
lines.push('> 同一任务语料里任务词汇与风格词汇竞争。跨多个不同任务多跑几轮，风格层才干净。')
lines.push('> 输出与 Layer-4 衔接：这些会话经 export-layer4 导出的训练样本携带真实质量标签。')

writeFileSync(`${outPrefix}.json`, JSON.stringify(output, null, 2), 'utf8')
writeFileSync(`${outPrefix}-report.md`, lines.join('\n'), 'utf8')
console.log(`[scores] 词典文件: ${outPrefix}.json`)
console.log(`[scores] 证据报告: ${outPrefix}-report.md`)
if (ratioFit) {
  console.log(`[scores] 拟合 ratioWeights: ${JSON.stringify(ratioFit.weights)}（分离度 ${ratioFit.separation}）`)
  console.log(`[scores] 词典词条: positive=${Object.keys(lexicon.positive).length} negative=${Object.keys(lexicon.negative).length}`)
  console.log('[scores] Top 10:')
  const rows = contrastPolarity(posTexts, negTexts, minFreq, top)
  for (const r of rows.slice(0, 10)) console.log(`  ${r.term}  ${r.polarity}  ${r.odds.toFixed(1)}`)
}
