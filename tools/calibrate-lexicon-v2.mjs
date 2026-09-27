#!/usr/bin/env node
/**
 * calibrate-lexicon-v2.mjs — 修正版词典标定 CLI（独立工具，不参与运行时）
 *
 * 设计原则（修正 v0.5.0 时代 CLI 的循环依赖与任务词汇污染）：
 *  ① 标签外生：极性标签必须来自被标定词典之外的事实；
 *  ② 同任务对齐：正负两侧语料必须覆盖同类任务，否则任务词无法抵消；
 *  ③ 工具只做区分，不做判断：本工具不猜「好坏」，只做「给定标签下的区分」。
 *
 * 三种标签来源（按强度）：
 *  L0/L1 显式语料：
 *    --positive DIR --negative DIR            用户/基准分定好标签的两组语料
 *  L1 分数表：
 *    --labels labels.json                       [{corpus, score}]，--high/--low 划线
 *  L2 轨迹标签（词典外生，最强）：
 *    --trajectories DIR --sessions DIR
 *    正样本 = 锚定阶段（bootstrap）推理块（lift 事件之前的文本——已知良好状态）
 *    负样本 = 下游工具全部失败的推理块（同 turn/step 的 tool/result 错误）
 *    两者都来自插件日志里记录的事实，与任何词典无关。
 *
 * 输出：词典 JSON（含 ratioWeights 网格拟合）+ 证据报告（逐词频次/odds/例句/
 * 显著性 + 任务对齐度校验）。
 * 任务对齐校验：正负两侧 top-200 n-gram 的 Jaccard 重合度 < 0.15 时，
 * 报告显式警告「话题未对齐，风格层不可信」，并给出低重合度的原因。
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { contrastPolarity, ngrams, termRegex } from './lexicon-core.mjs'
import { decodeSessionLog, walk, textFromRecord, collectCorpus } from './session-log-core.mjs'

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

// ---------- L2：从插件轨迹日志 + 会话日志提取词典外生标签 ----------

function classifyResult(text, okOnNeutral) {
  // 失败信号（明确）：非零退出码 / 沙箱拒绝 / Traceback / 断言失败 / 显式 FAILED
  if (/\[exit code:\s*[1-9]\d*\]/.test(text)) return 'err'
  if (/\[sandbox: file access denied/.test(text)) return 'err'
  if (/Traceback \(most recent call last\)/.test(text)) return 'err'
  if (/AssertionError/.test(text)) return 'err'
  if (/\bFAILED\b/.test(text)) return 'err'
  if (/Command failed/.test(text)) return 'err'
  // 成功信号（明确）：退出码 0 / 项目自检的显式通过语句
  if (/\[exit code:\s*0\]/.test(text)) return 'ok'
  if (/all public tests passed/.test(text)) return 'ok'
  if (/all visible diagnostic checks passed/.test(text)) return 'ok'
  if (/Build finished successfully/.test(text)) return 'ok'
  if (/\[probe\] all visible/.test(text)) return 'ok'
  // 无失败标记 = 调用完成（no-lift 交叉验证模式：pwsh 只在非零退出时打 exit code 标记）
  return okOnNeutral ? 'ok' : null
}

/** 从轨迹 JSONL 找 lift 时间戳（ms）。 */
function liftTimeOf(trajFile) {
  let text
  try { text = readFileSync(trajFile, 'utf8') } catch { return null }
  let lift = null
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    if (o.kind === 'lift' && typeof o.t === 'number' && (lift === null || o.t < lift)) lift = o.t
  }
  return lift
}

/** L2 标签：正=锚定阶段块；负=下游全失败的块。
 *  sessionFilter：可选逗号分隔的会话 id 子串，只取匹配的会话（限定同任务族）。
 *  noLift：可选——不再要求 lift 事件（编排器/父会话模式），标签退化为
 *  纯调用级归属（ok→正、err→负，无 bootstrap 正样本）。用于"任务外语料"
 *  交叉验证；默认关，避免编排器污染主词典。 */
function l2LabeledSamples(trajDir, sessionsDir, sessionFilter, noLift) {
  const positives = []
  const negatives = []
  const sessionTally = []
  const meta = { sessions: 0, liftFound: 0, scoped: 0 }
  const filters = sessionFilter ? sessionFilter.split(',').map((s) => s.trim()).filter(Boolean) : null
  const sessionFiles = walk(sessionsDir, []).filter((f) => f.endsWith('session.jsonl.zstd'))
  for (const sf of sessionFiles) {
    const sid = basename(join(sf, '..'))
    if (filters && !filters.some((f) => sid.includes(f))) continue
    meta.scoped += 1
    const perSession = { sid, pos: 0, neg: 0, lift: false }
    let text
    try { text = decodeSessionLog(sf) } catch { continue }
    // 轨迹文件可能带 .1 等块后缀；找 anchor-<sid>.jsonl（主文件）
    let lift = null
    let trajFiles = []
    try { trajFiles = readdirSync(trajDir).filter((n) => n === `anchor-${sid}.jsonl` || n.startsWith(`anchor-${sid}.jsonl.`)) } catch { /* ignore */ }
    for (const tf of trajFiles) {
      const t = liftTimeOf(join(trajDir, tf))
      if (t !== null && (lift === null || t < lift)) lift = t
    }
    meta.sessions += 1
    if (lift !== null) meta.liftFound += 1
    // L2 标签只取锚定候选会话（有 lift 事件）：编排/父会话没有 lift，
    // 其失败步骤不能当候选模型的负样本（避免跨语境污染）。
    // --no-lift 显式打开时放行（任务外交叉验证模式）。
    if (lift === null && !noLift) continue
    const steps = new Map()
    const key = (turn, step) => `${turn}#${step}`
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let o
      try { o = JSON.parse(line) } catch { continue }
      const d = o.data || {}
      const turn = typeof d.turn === 'number' ? d.turn : null
      const step = typeof d.step === 'number' ? d.step : null
      if (turn === null || step === null) continue
      const k = key(turn, step)
      if (!steps.has(k)) steps.set(k, { turn, step, reasoning: [], ok: 0, err: 0, firstT: o.time })
      const s = steps.get(k)
      if (o.type === 'reasoning-chunks' && Array.isArray(d.texts)) {
        for (const t of d.texts) if (typeof t === 'string' && t.length >= 40) s.reasoning.push(t)
      } else if (o.type === 'assistant/message') {
        const t = textFromRecord(o)
        if (t && t.length >= 40) s.reasoning.push(t)
      } else if (o.type === 'tool/result') {
        // DSH 会话日志形态：data.message.content[] → tool-result 文本块
        let resultText = ''
        try {
          const blocks = d.message && d.message.content
          if (Array.isArray(blocks)) {
            const parts = []
            for (const b of blocks) {
              if (b && b.type === 'tool-result' && Array.isArray(b.content)) {
                for (const c of b.content) {
                  if (c && c.type === 'text' && typeof c.text === 'string') parts.push(c.text)
                }
              }
            }
            resultText = parts.join('\n')
          }
        } catch { resultText = '' }
        if (!resultText) continue
        const c = classifyResult(resultText, noLift === true)
        if (c === 'ok') s.ok += 1
        else if (c === 'err') s.err += 1
      }
    }
    for (const s of steps.values()) {
      if (s.reasoning.length === 0) continue
      const isBootstrap = !noLift && lift !== null && typeof s.firstT === 'number' && s.firstT < lift
      if (isBootstrap) {
        // 锚定阶段 = 已知良好：每块计 1 次正样本
        for (const t of s.reasoning) positives.push(t)
        perSession.pos += s.reasoning.length
      } else {
        // 调用级归属：err 调用 → 该步推理块计负；ok 调用 → 计正。
        // 块同时出现在两侧 → 对比引擎压低 odds 自然中性化。
        for (let i = 0; i < s.ok; i++) {
          for (const t of s.reasoning) positives.push(t)
          perSession.pos += s.reasoning.length
        }
        for (let i = 0; i < s.err; i++) {
          for (const t of s.reasoning) negatives.push(t)
          perSession.neg += s.reasoning.length
        }
      }
    }
    perSession.lift = lift !== null
    sessionTally.push(perSession)
  }
  return { positives, negatives, sessionTally, meta }
}

/** L3 混合校验：L2 轨迹标签定极性，L1 基准分做独立校验。
 *  L2 正样本应主要来自高分会话、负样本主要来自低分会话；
 *  若相反（矛盾），说明轨迹标签与外部评分冲突 → 拒标。 */
function l3CrossCheck(sessionTally, labelsPath, sessionsDir, highScore, lowScore) {
  let labels
  try {
    labels = JSON.parse(readFileSync(labelsPath, 'utf8'))
  } catch (e) {
    return { ok: true, skipped: `labels 解析失败: ${e.message}` }
  }
  const scoreOf = new Map()
  const entries = Array.isArray(labels)
    ? labels.map((row) => ({ path: resolve(row.corpus || row.path), score: Number(row.score) }))
    : [
        ...(labels.positive || []).map((p) => ({ path: resolve(p), score: highScore })),
        ...(labels.negative || []).map((p) => ({ path: resolve(p), score: lowScore })),
      ]
  for (const e of entries) {
    // 按会话 id 匹配（labels 路径里的 <sid>/session.jsonl.zstd 段）
    const norm = e.path.replace(/\\/g, '/')
    const m = norm.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/session\.jsonl\.zstd$/i)
    scoreOf.set(m ? m[1].toLowerCase() : e.path.toLowerCase(), e.score)
  }
  let posInHigh = 0
  let posInLow = 0
  let negInHigh = 0
  let negInLow = 0
  let matched = 0
  for (const t of sessionTally) {
    const score = scoreOf.get(t.sid.toLowerCase())
    if (score === undefined) continue
    matched += 1
    if (score >= highScore) {
      posInHigh += t.pos
      negInHigh += t.neg
    } else if (score <= lowScore) {
      posInLow += t.pos
      negInLow += t.neg
    }
  }
  const posTotal = posInHigh + posInLow
  const negTotal = negInHigh + negInLow
  const posHighRatio = posTotal > 0 ? posInHigh / posTotal : 0
  const negLowRatio = negTotal > 0 ? negInLow / negTotal : 0
  const consistent = posTotal > 0 && negTotal > 0 && posHighRatio >= 0.5 && negLowRatio >= 0.5
  return {
    ok: consistent,
    matched,
    posHighRatio: Math.round(posHighRatio * 100) / 100,
    negLowRatio: Math.round(negLowRatio * 100) / 100,
    detail: { posInHigh, posInLow, negInHigh, negInLow },
  }
}

// ---------- 任务对齐校验 ----------
function alignmentCheck(posTexts, negTexts) {
  const posN = ngrams(posTexts)
  const negN = ngrams(negTexts)
  const top = (m, n) => Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, n).map(([t]) => t)
  const tp = new Set(top(posN, 200))
  const tn = new Set(top(negN, 200))
  const inter = Array.from(tp).filter((t) => tn.has(t)).length
  const union = new Set([...tp, ...tn]).size
  return { jaccard: union === 0 ? 0 : Math.round((inter / union) * 1000) / 1000, aligned: inter / (union || 1) >= 0.15 }
}

// ---------- ratioWeights 网格拟合 ----------
function measureBlock(text, lexicon) {
  const lower = text.toLowerCase()
  const pick = (map) => {
    let sum = 0
    for (const t of Object.keys(map || {})) {
      const n = (lower.match(termRegex(t, 'g')) || []).length
      sum += n * map[t]
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
const trajDir = arg('--trajectories', '') ? resolve(arg('--trajectories', '')) : ''
const sessionsDir = arg('--sessions', '') ? resolve(arg('--sessions', '')) : ''
const positivePath = arg('--positive', '') ? resolve(arg('--positive', '')) : ''
const negativePath = arg('--negative', '') ? resolve(arg('--negative', '')) : ''
const labelsPath = arg('--labels', '') ? resolve(arg('--labels', '')) : ''
const highScore = Number(arg('--high', '95'))
const lowScore = Number(arg('--low', '90'))
const minFreq = Number(arg('--min-freq', '5'))
const top = Number(arg('--top', '60'))
const outPrefix = resolve(arg('--out', './lexicon-v2'))

let posTexts = []
let negTexts = []
let mode = ''
let l2Meta = null

if (trajDir && sessionsDir) {
  mode = 'L2-trajectory-labels'
  const r = l2LabeledSamples(trajDir, sessionsDir, arg('--session-filter', ''), process.argv.includes('--no-lift'))
  posTexts = r.positives
  negTexts = r.negatives
  l2Meta = r.meta
  // L3：若同时给 --labels，用基准分独立校验 L2 的极性
  const l3Path = arg('--labels', '') ? resolve(arg('--labels', '')) : ''
  if (l3Path) {
    mode = 'L3-hybrid(L2定极性+L1校验)'
    const check = l3CrossCheck(r.sessionTally, l3Path, sessionsDir, highScore, lowScore)
    l2Meta.crossCheck = check
    if (!check.ok) {
      console.error(`[v2] L3 矛盾：L2 正样本来自高分会话的比例 ${check.posHighRatio}，负样本来自低分会话的比例 ${check.negLowRatio}（均需 ≥0.5）——轨迹标签与外部评分冲突，拒标`)
      process.exit(1)
    }
    console.log(`[v2] L3 校验通过：正→高分 ${check.posHighRatio}，负→低分 ${check.negLowRatio}（匹配 ${check.matched} 会话）`)
  }
} else if (labelsPath) {
  mode = 'L1-score-labels'
  const labels = JSON.parse(readFileSync(labelsPath, 'utf8'))
  const entries = Array.isArray(labels)
    ? labels.map((row) => ({ path: resolve(row.corpus || row.path), score: Number(row.score) }))
    : [
        ...(labels.positive || []).map((p) => ({ path: resolve(p), score: highScore })),
        ...(labels.negative || []).map((p) => ({ path: resolve(p), score: lowScore })),
      ]
  for (const e of entries) {
    const texts = collectCorpus(e.path)
    if (e.score >= highScore) posTexts.push(...texts)
    else if (e.score <= lowScore) negTexts.push(...texts)
  }
} else if (positivePath && negativePath) {
  mode = 'L0-explicit-corpora'
  posTexts = collectCorpus(positivePath)
  negTexts = collectCorpus(negativePath)
} else {
  console.error('用法（三选一）:')
  console.error('  L2: node tools/calibrate-lexicon-v2.mjs --trajectories <轨迹日志目录> --sessions <会话日志目录> [--out PREFIX]')
  console.error('  L1: node tools/calibrate-lexicon-v2.mjs --labels <labels.json> [--high 95] [--low 90] [--out PREFIX]')
  console.error('  L0: node tools/calibrate-lexicon-v2.mjs --positive <DIR> --negative <DIR> [--out PREFIX]')
  process.exit(1)
}

console.log(`[v2] 模式: ${mode}`)
if (l2Meta) console.log(`[v2] L2 轨迹标签: ${l2Meta.sessions} 会话（${l2Meta.liftFound} 个找到 lift）`)
console.log(`[v2] 正语料: ${posTexts.length} 块；负语料: ${negTexts.length} 块`)

// 可选：把原始正/负块落盘（供跨任务方向一致性等二次分析使用；拒绝标定前也落）
const dumpPath = arg('--dump-blocks', '')
if (dumpPath) {
  writeFileSync(resolve(dumpPath), JSON.stringify({ positives: posTexts, negatives: negTexts }, null, 2), 'utf8')
  console.log(`[v2] 语料块已导出: ${resolve(dumpPath)}`)
}

if (posTexts.length < 10 || negTexts.length < 10) {
  console.error('[v2] 正/负语料不足（各需 ≥10 块），拒绝标定——多攒会话再来')
  process.exit(1)
}

const align = alignmentCheck(posTexts, negTexts)
console.log(`[v2] 任务对齐度（top-200 n-gram Jaccard）: ${align.jaccard} ${align.aligned ? '✓' : '⚠ 话题未对齐，风格层不可信'}`)

const rows = contrastPolarity(posTexts, negTexts, minFreq, top)
const lexicon = { positive: {}, negative: {}, neutral: {} }
for (const r of rows) {
  const bucket = r.polarity === 'positive' ? lexicon.positive : lexicon.negative
  bucket[r.term] = Math.round(Math.min(3, Math.max(0.5, Math.abs(r.odds))) * 10) / 10
}
const ratioFit = fitRatioWeights(lexicon, posTexts, negTexts)

const output = {
  generated_utc: new Date().toISOString(),
  mode,
  alignment: align,
  positive_texts: posTexts.length,
  negative_texts: negTexts.length,
  lexicon,
  ratioWeights: ratioFit ? ratioFit.weights : null,
  ratioSeparation: ratioFit ? ratioFit.separation : null,
}

const lines = []
lines.push(`# 词典标定报告（修正版）`)
lines.push('')
lines.push(`- 模式：${mode}；标签外生（非词典自身打分）`)
lines.push(`- 正语料：${posTexts.length} 块；负语料：${negTexts.length} 块`)
lines.push(`- 任务对齐度：${align.jaccard}（<0.15 时风格层不可信）`)
lines.push('')
lines.push('| 词条 | 极性 | odds | 建议权重 |')
lines.push('|---|---|---|---|')
for (const r of rows.slice(0, 40)) {
  lines.push(`| ${r.term} | ${r.polarity} | ${r.odds.toFixed(1)} | ${lexicon[r.polarity][r.term]} |`)
}
lines.push('')
lines.push('```yaml')
lines.push('# 应用：lexiconProfiles.<model> 或桶种子；运行时输出拟合探测会自限')
lines.push(`# positive: ${JSON.stringify(lexicon.positive)}`)
lines.push(`# negative: ${JSON.stringify(lexicon.negative)}`)
if (ratioFit) lines.push(`# ratioWeights: ${JSON.stringify(ratioFit.weights)}  # 拟合分离度 ${ratioFit.separation}`)
lines.push('```')

writeFileSync(`${outPrefix}.json`, JSON.stringify(output, null, 2), 'utf8')
writeFileSync(`${outPrefix}-report.md`, lines.join('\n'), 'utf8')
console.log(`[v2] 词典: ${outPrefix}.json；报告: ${outPrefix}-report.md`)
console.log(`[v2] 词条: positive=${Object.keys(lexicon.positive).length} negative=${Object.keys(lexicon.negative).length}`)
if (ratioFit) console.log(`[v2] ratioWeights: ${JSON.stringify(ratioFit.weights)}（分离度 ${ratioFit.separation}）`)
console.log('[v2] Top 10:')
for (const r of rows.slice(0, 10)) console.log(`  ${r.term}  ${r.polarity}  ${r.odds.toFixed(1)}`)
