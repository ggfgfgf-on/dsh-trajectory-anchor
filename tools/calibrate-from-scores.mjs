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
 * 用法（二选一）:
 *   通用标签模式（高级用户：自带语料、自选任务、自给总分）:
 *     node tools/calibrate-from-scores.mjs --labels <labels.json> [--high 95] [--low 90] [--out PREFIX]
 *       labels.json 形式 A: [{ "corpus": "路径", "score": 100, "label": "可选注释" }, ...]
 *       labels.json 形式 B: { "positive": ["路径", ...], "negative": ["路径", ...] }
 *       corpus 路径支持：目录（.txt/.md/.jsonl/.zstd 递归）或单文件（含 DSH session.jsonl.zstd）
 *   Project2 自动模式:
 *     node tools/calibrate-from-scores.mjs
 *       --results DIR        评测结果根目录（含每轮 score_draft.json 的子目录，必填）
 *       --sessions DIR       DSH 会话日志根目录（递归找 session.jsonl.zstd，必填）
 *       [--model NAME]       只标定该模型（按会话日志里的 request/header model 过滤）
 *       [--run-group ID]     只取该 run_group_id 的评测轮
 *       [--high N]           高分线（默认 95）
 *       [--low N]            低分线（默认 90）
 *       [--min-freq N]       contrast 硬下限（默认 5；低于该值走 Fisher 显著检验）
 *       [--top N]            词典词条上限（默认 60）
 *       [--out PREFIX]       输出前缀（默认 ./lexicon-score）
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
import { decodeSessionLog, walk, textFromRecord, collectCorpus } from './session-log-core.mjs'

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
    // behavior_blockers 在兄弟文件 blockers.json（顶层 behavior_blockers/final）；
    // 部分旧结果只在 score_draft.json 顶层有 blockers 字段。
    let blockers = Array.isArray(o.blockers) ? o.blockers : []
    try {
      const bj = JSON.parse(readFileSync(join(dir, '..', 'blockers.json'), 'utf8'))
      const cand = bj.behavior_blockers || bj.final || bj.blockers || bj.auto
      if (Array.isArray(cand)) blockers = cand
    } catch { /* no blockers.json */ }
    runs.push({
      dir: join(dir, '..'),
      mtimeMs,
      ability,
      model: meta.model || '',
      provider: meta.provider || '',
      runGroup: meta.run_group_id || '',
      runIndex: meta.run_index ?? null,
      blockers,
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
    // 防混料：编排/父会话会调用 subagent 工具；候选会话的提示词禁止这些工具。
    // 长于 4 小时的会话（用户日常聊天等）也不是候选会话。
    let usedSubagentTool = false
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
      if (o.type === 'tool/call' && o.data && typeof o.data.name === 'string') {
        if (/^(subagent|subagent_fork|workflow|ralph|send_message|interrupt_agent|list_agents)$/.test(o.data.name)) usedSubagentTool = true
      }
      const t = textFromRecord(o)
      if (t && t.length >= 40) texts.push(t)
    }
    if (!matched || texts.length === 0 || endMs === 0) continue
    if (usedSubagentTool) continue
    if (endMs - startMs > 4 * 3600 * 1000) continue
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
const labelsPath = arg('--labels', '') ? resolve(arg('--labels', '')) : ''
const resultsDir = resolve(arg('--results', ''))
const sessionsDir = resolve(arg('--sessions', ''))
if (!labelsPath && (!resultsDir || !sessionsDir)) {
  console.error('用法（二选一）:')
  console.error('  通用标签模式: node tools/calibrate-from-scores.mjs --labels <labels.json> [--high 95] [--low 90] [--out PREFIX]')
  console.error('     labels.json 形式 A: [{ "corpus": "路径", "score": 100 }, ...]（自选任务自评分）')
  console.error('     labels.json 形式 B: { "positive": ["路径", ...], "negative": ["路径", ...] }')
  console.error('     corpus 路径支持：目录（.txt/.md/.jsonl/.zstd 递归）或单文件（含 DSH session.jsonl.zstd）')
  console.error('  Project2 自动模式: node tools/calibrate-from-scores.mjs --results <评测结果目录> --sessions <会话日志目录> [--model NAME] [--run-group ID] [--high 95] [--low 90] [--out PREFIX]')
  process.exit(1)
}
const modelFilter = arg('--model', '')
// --run-group 可给逗号分隔的多个组（同模型同基准的多个轮次组一起用）
const runGroupFilter = process.argv.filter((a, i) => i > 0 && process.argv[i - 1] === '--run-group').join(',')
const runGroupSet = runGroupFilter ? new Set(runGroupFilter.split(',').map((s) => s.trim()).filter(Boolean)) : null
// --use-blockers：按评测的 behavior_blockers 定标签（零缺陷=正，有缺陷=负），
// 比纯分数更本质——分数是代理，blocker 是实质。分数仍记录进证据表。
const useBlockers = process.argv.includes('--use-blockers')
const highScore = Number(arg('--high', '95'))
const lowScore = Number(arg('--low', '90'))
const minFreq = Number(arg('--min-freq', '5'))
const top = Number(arg('--top', '60'))
const outPrefix = resolve(arg('--out', './lexicon-score'))

let posTexts = []
let negTexts = []
const evidence = []
let labelMode = false

if (labelsPath) {
  // 通用标签模式：用户自带语料、自选任务、自给总分
  labelMode = true
  let labels
  try {
    labels = JSON.parse(readFileSync(labelsPath, 'utf8'))
  } catch (e) {
    console.error(`[scores] labels 解析失败: ${e.message}`)
    process.exit(1)
  }
  const entries = []
  if (Array.isArray(labels)) {
    for (const row of labels) {
      const path = row.corpus || row.path
      const score = Number(row.score)
      if (!path || !Number.isFinite(score)) continue
      entries.push({ path: resolve(path), score, label: row.label || '' })
    }
  } else {
    for (const p of labels.positive || []) entries.push({ path: resolve(p), score: highScore, label: 'positive' })
    for (const p of labels.negative || []) entries.push({ path: resolve(p), score: lowScore, label: 'negative' })
  }
  for (const e of entries) {
    let texts = []
    try { texts = collectCorpus(e.path) } catch (err) { console.warn(`[scores] 语料读取失败 ${e.path}: ${err.message}`) }
    const cls = e.label === 'negative' ? 'negative' : e.score >= highScore ? 'positive' : e.score <= lowScore ? 'negative' : 'ignored'
    const chars = texts.reduce((n, s) => n + s.length, 0)
    if (cls === 'positive') for (const t of texts) posTexts.push(t)
    else if (cls === 'negative') for (const t of texts) negTexts.push(t)
    evidence.push({ corpus: basename(e.path), path: e.path, score: e.score, texts: texts.length, chars, cls })
  }
  console.log(`[scores] 标签条目: ${entries.length}`)
} else {
  let runs = scanRuns(resultsDir)
  if (runGroupSet) {
    const before = runs.length
    runs = runs.filter((r) => runGroupSet.has(r.runGroup))
    console.log(`[scores] run-group 过滤: ${before} -> ${runs.length} (${runGroupFilter})`)
  }
  console.log(`[scores] 评测轮: ${runs.length}`)
  const sessions = scanSessions(sessionsDir, modelFilter)
  console.log(`[scores] 会话日志: ${sessions.length}${modelFilter ? ` (model=${modelFilter})` : ''}`)
  const pairs = matchRuns(sessions, runs)
  console.log(`[scores] 匹配成功: ${pairs.length}`)
  for (const { run, session, gapMs } of pairs) {
    const cls = useBlockers
      ? (run.blockers.length === 0 ? 'positive' : 'negative')
      : run.ability >= highScore ? 'positive' : run.ability <= lowScore ? 'negative' : 'ignored'
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
    if (cls === 'positive') for (const t of session.texts) posTexts.push(t)
    else if (cls === 'negative') for (const t of session.texts) negTexts.push(t)
    evidence.push(rec)
  }
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
  mode: labelMode ? 'score-supervised (用户标签模式：自选语料/任务/总分)' : 'score-supervised (Project2 评测结果自动模式)',
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
if (labelMode) {
  lines.push('| 语料 | 分数 | 文本块 | 字符 | 归类 |')
  lines.push('|---|---|---|---|---|')
  for (const e of evidence) lines.push(`| ${e.corpus} | ${e.score} | ${e.texts} | ${e.chars} | ${e.cls} |`)
} else {
  lines.push('| 结果目录 | 分数 | runIndex | 会话 | 模型 | 文本块 | 归类 |')
  lines.push('|---|---|---|---|---|---|---|')
  for (const e of evidence) lines.push(`| ${e.runDir} | ${e.ability} | ${e.runIndex ?? '—'} | ${e.session} | ${e.model} | ${e.texts} | ${e.cls} |`)
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
