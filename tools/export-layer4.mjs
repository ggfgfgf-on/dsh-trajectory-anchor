#!/usr/bin/env node
/**
 * export-layer4.mjs — dsh-trajectory-anchor Layer-4 训练数据批量聚合导出器
 *
 * 把 .dsh-trajectory-logs/*.jsonl（轨迹事件流 + 过程奖励标注）与
 * ~/.dsh/sessions/<cwd>/<sessionId>/session.jsonl.zstd（会话文本日志）
 * join 成 step 级训练样本，输出训练框架可直接消费的 JSONL 数据集。
 *
 * 四步流水线：
 *   1. 聚合   —— 扫描轨迹 JSONL；request 上下文化自会话日志；
 *                assistant-message(turn,step) 对齐会话文本，score 词典分就近贴附
 *   2. 清洗   —— 剔除生命周期 marker 行；排除主会话轨迹（anchor-session-* 或 summary.self）；
 *                只收 closed 代理；按会话分组
 *   3. schema —— {sessionId, model, turn, step, kind, messages, response,
 *                toolName, toolResult, reward{lexicon,sessionScore,scoreNorm,planner},
 *                trajectory_features{band,ratio,ewma,percentile,personaRatio,
 *                liftReason,machineState}, textComplete}
 *   4. 归一化 —— reward.sessionScore 跨会话 min-max 归一；正/负样本统计；band/liftReason 分桶
 *
 * 用法:
 *   node tools/export-layer4.mjs
 *     [--logs-dir DIR]     轨迹日志目录（默认 $env:DSH_TRAJECTORY_LOGS 或 <cwd>/.dsh-trajectory-logs）
 *     [--sessions-dir DIR] 会话日志根（默认 %USERPROFILE%/.dsh/sessions）
 *     [--out DIR]          输出目录（默认 <cwd>/layer4-export-<时间戳>）
 *     [--no-text]          跳过会话文本 join（只出元数据级样本）
 *     [--max-context N]    messages 上下文最大条数（默认 12）
 *     [--cap-text N]       单条文本截断字符数（默认 1500）
 *
 * 零依赖：仅 node:fs/path/os/zlib（Node ≥ 22，zstd 由 node:zlib 提供）。
 * 输出兼容 PRM（逐 step 过程奖励）与 DPO/RLVR（成对偏好，按 session 分组取样）。
 */
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, basename, resolve } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528

// ---------- zstd 帧扫描（与 dsh-session-persistence-jsonl scanZstdFrames 同布局） ----------
function scanZstdFrames(buf) {
  const frames = []
  let offset = 0
  while (offset < buf.length) {
    const start = offset
    if (buf.length - offset < 4) break
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid zstd frame magic at byte ${offset}`)
    }
    offset += 4
    const descriptor = buf.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`)
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
      if (blockType === 0x03) throw new Error(`reserved block type at byte ${offset - 3}`)
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
  const text = frames.map(({ start, end }) => zstdDecompressSync(buf.subarray(start, end)).toString('utf8')).join('\n')
  return text.split('\n').filter((l) => l.trim().length > 0)
}

// ---------- 参数 ----------
function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const logsDir = resolve(arg('--logs-dir', process.env.DSH_TRAJECTORY_LOGS || join(process.cwd(), '.dsh-trajectory-logs')))
const sessionsDir = resolve(arg('--sessions-dir', join(homedir(), '.dsh', 'sessions')))
const outDir = resolve(arg('--out', join(process.cwd(), `layer4-export-${Date.now()}`)))
const noText = process.argv.includes('--no-text')
const maxContext = Number(arg('--max-context', '12'))
const capText = Number(arg('--cap-text', '1500'))

// ---------- 文本提取工具 ----------
function textOf(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}
function cap(s, n) {
  const t = String(s ?? '')
  return t.length > n ? t.slice(0, n) + ` …[截断,原长${t.length}]` : t
}

// ---------- 会话日志索引 ----------
function indexSessionLog(sessionId) {
  // 递归找 <sessionsDir>/**/<sessionId>/session.jsonl.zstd
  const found = []
  const walk = (dir, depth) => {
    if (depth > 2) return
    let entries
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      const p = join(dir, name)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) {
        if (name === sessionId) {
          const f = join(p, 'session.jsonl.zstd')
          if (existsSync(f)) found.push(f)
        }
        walk(p, depth + 1)
      }
    }
  }
  walk(sessionsDir, 0)
  if (found.length === 0) return null
  const lines = decodeSessionLog(found[0])
  const idx = {
    descriptor: null,
    assistantByKey: new Map(), // "turn:step" -> {text}
    toolResultByKey: new Map(), // "turn:step" -> string
    userTexts: [], // 时间序 user 文本
    history: [], // 时间序 {role,text} 用于 messages 上下文
    requestModels: [],
  }
  for (const line of lines) {
    let o
    try { o = JSON.parse(line) } catch { continue }
    if (o.type === 'subagent/descriptor' && o.data) idx.descriptor = o.data
    if (o.type === 'user/message') {
      const t = textOf(o.data?.content)
      if (t) { idx.userTexts.push(t); idx.history.push({ role: 'user', text: cap(t, capText) }) }
    }
    if (o.type === 'assistant/message') {
      const turn = o.data?.turn, step = o.data?.step
      const content = o.data?.message?.content ?? []
      const texts = []
      for (const b of content) {
        if (b?.type === 'reasoning' || b?.type === 'text') texts.push(b.text ?? '')
      }
      const t = texts.join('\n').trim()
      if (t) {
        const key = `${turn}:${step}`
        const cur = idx.assistantByKey.get(key)
        // DSH 会话日志会把一条消息拆成多个 assistant/message 片段落盘
        //（第 1 片 reasoning+tool-call、第 2 片 tool-result …），同 key 多记录是正常形态，
        // 必须合并而不是当作歧义。
        if (cur) { cur.count++; if (t) cur.text = cur.text ? cur.text + '\n' + t : t }
        else idx.assistantByKey.set(key, { text: t, count: 1 })
        idx.history.push({ role: 'assistant', text: cap(t, capText) })
      }
    }
    if (o.type === 'tool/result') {
      const turn = o.data?.turn, step = o.data?.step
      const t = textOf(o.data?.message?.content?.[0]?.content ?? o.data?.message?.content)
      if (t) {
        const key = `${turn}:${step}`
        const cur = idx.toolResultByKey.get(key)
        if (cur) { cur.count++; cur.text = cur.text ? cur.text + '\n' + t : t }
        else idx.toolResultByKey.set(key, { text: t, count: 1 })
      }
    }
    if (o.type === 'request/header' && o.data) {
      const m = o.data.model ?? o.data.provider ?? null
      if (m && !idx.requestModels.includes(m)) idx.requestModels.push(m)
    }
  }
  return idx
}

// ---------- 主流程 ----------
function main() {
  const files = readdirSync(logsDir).filter((f) => f.startsWith('anchor-') && f.endsWith('.jsonl'))
  mkdirSync(outDir, { recursive: true })
  const included = []
  const excluded = []
  const samples = []

  for (const file of files) {
    const path = join(logsDir, file)
    const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim())
    const events = []
    let record = null
    for (const l of lines) {
      let o
      try { o = JSON.parse(l) } catch { continue }
      if (o.kind === 'record') record = o.summary
      else events.push(o)
    }
    const selfByName = file.startsWith('anchor-session-')
    const self = selfByName || (record?.self === true)
    if (!record || record.closed !== true) { excluded.push({ file, reason: '未封闭（无 closed record）' }); continue }
    if (self) { excluded.push({ file, reason: '主会话/self 轨迹' }); continue }
    const sessionId = record.sessionId ?? basename(file).replace(/^anchor-/, '').replace(/\.jsonl$/, '')
    included.push({ file, sessionId, reward: record.reward ?? null })

    // 会话文本索引
    const sessIdx = noText ? null : indexSessionLog(sessionId)
    const model = sessIdx?.descriptor?.agentModel ?? sessIdx?.requestModels?.[0] ?? null

    // 时间序 step 组装（先数跨面 key 出现次数，防「同一执行键两次出现」导致的静默错配）
    const trajCounts = new Map()
    for (const ev of events) {
      if (ev.kind === 'assistant-message' || ev.kind === 'tool-call') {
        const k = `${ev.turn}:${ev.step}`
        trajCounts.set(k, (trajCounts.get(k) ?? 0) + 1)
      }
    }
    let lastScore = null
    for (const ev of events) {
      if (ev.kind === 'score') { lastScore = ev; continue }
      if (ev.kind !== 'assistant-message' && ev.kind !== 'tool-call') continue
      const key = `${ev.turn}:${ev.step}`
      const lexicon = lastScore
        ? { pos: lastScore.pos ?? 0, neg: lastScore.neg ?? 0, neu: lastScore.neu ?? 0, we: lastScore.we ?? 0, letMe: lastScore.letMe ?? 0, ratio: lastScore.ratio ?? null, personaRatio: lastScore.personaRatio ?? null, band: lastScore.band ?? null }
        : null
      const ctx = sessIdx ? sessIdx.history.slice(-maxContext) : []
      const sample = {
        sessionId,
        model,
        turn: ev.turn ?? null,
        step: ev.step ?? null,
        kind: ev.kind,
        messages: ctx,
        response: null,
        toolName: null,
        toolResult: null,
        reward: {
          lexicon,
          sessionScore: record.reward?.score ?? null,
          scoreNorm: null, // 归一化在统计阶段回填
          planner: record.reward?.planner ?? null,
          planningMessages: record.reward?.planningMessages ?? null,
          shallowMessages: record.reward?.shallowMessages ?? null,
        },
        trajectory_features: {
          band: record.band ?? null,
          ratio: record.ratio ?? null,
          ewma: record.ewma ?? null,
          percentile: record.percentile ?? null,
          personaRatio: record.personaRatio ?? null,
          liftReason: record.liftReason ?? null,
          machineState: record.machineState ?? null,
        },
        textComplete: false,
      }
      // 执行标识与跨面证据：id = <sessionId>#<turn>:<step>；
      // 会话侧同 key 多记录是消息片段（已合并），仅作信息性计数。
      // 唯一「拒绝配对」的真实信号是两侧对同一 key 的文本相互矛盾——当前数据形态
      // 下无法可判定检测，故不再设 ambiguous 拒绝，改为如实记录两侧证据。
      const tCount = trajCounts.get(key) ?? 0
      const sCount = ev.kind === 'assistant-message'
        ? (sessIdx?.assistantByKey.get(key)?.count ?? 0)
        : (sessIdx?.toolResultByKey.get(key)?.count ?? 0)
      sample.execution = {
        id: `${sessionId}#${ev.turn}:${ev.step}`,
        kind: ev.kind,
        trajectory_occurrences: tCount,
        session_occurrences: sCount,
        cross_plane: tCount > 0 && sCount > 0,
        ambiguous: false,
      }
      if (ev.kind === 'assistant-message') {
        const e = sessIdx?.assistantByKey.get(key)
        if (e?.text) { sample.response = cap(e.text, capText); sample.textComplete = true }
      } else {
        sample.toolName = ev.name ?? null
        const e = sessIdx?.toolResultByKey.get(key)
        if (e?.text) { sample.toolResult = cap(e.text, capText); sample.textComplete = true }
      }
      samples.push(sample)
    }
  }

  // ---------- 归一化 + 统计 ----------
  const sessionScores = included.map((s) => s.reward?.score).filter((v) => typeof v === 'number')
  const sMin = sessionScores.length ? Math.min(...sessionScores) : 0
  const sMax = sessionScores.length ? Math.max(...sessionScores) : 1
  const mean = sessionScores.length ? sessionScores.reduce((a, b) => a + b, 0) / sessionScores.length : 0
  const std = sessionScores.length > 1
    ? Math.sqrt(sessionScores.reduce((a, b) => a + (b - mean) ** 2, 0) / (sessionScores.length - 1))
    : 0
  for (const s of samples) {
    if (typeof s.reward.sessionScore === 'number') {
      s.reward.scoreNorm = sMax === sMin ? 0.5 : Number(((s.reward.sessionScore - sMin) / (sMax - sMin)).toFixed(4))
    }
  }

  const buckets = (key) => {
    const m = new Map()
    for (const s of samples) {
      const v = s.trajectory_features[key] ?? 'null'
      m.set(String(v), (m.get(String(v)) ?? 0) + 1)
    }
    return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]))
  }
  let posCount = 0, negCount = 0, neuCount = 0
  for (const s of samples) {
    const lx = s.reward.lexicon
    if (!lx) continue
    if (lx.pos > lx.neg) posCount++
    else if (lx.neg > lx.pos) negCount++
    else neuCount++
  }
  const textSteps = samples.filter((s) => s.textComplete).length
  const oneSided = samples.filter((s) => s.execution && !s.execution.cross_plane).length
  const crossVerified = samples.length - oneSided
  const stats = {
    generated_utc: new Date().toISOString(),
    logs_dir: logsDir,
    sessions_dir: sessionsDir,
    sessions_included: included.length,
    sessions_excluded: excluded,
    total_samples: samples.length,
    by_kind: {
      'assistant-message': samples.filter((s) => s.kind === 'assistant-message').length,
      'tool-call': samples.filter((s) => s.kind === 'tool-call').length,
    },
    text_coverage: totalSamplesPct(samples, textSteps),
    execution_stats: { cross_plane_verified: crossVerified, one_sided: oneSided },
    lexicon_polarity: { pos_dominant: posCount, neg_dominant: negCount, neutral: neuCount },
    session_reward: { n: sessionScores.length, min: sMin, max: sMax, mean: Number(mean.toFixed(3)), std: Number(std.toFixed(3)) },
    band_buckets: buckets('band'),
    liftReason_buckets: buckets('liftReason'),
    machineState_buckets: buckets('machineState'),
    models: Object.fromEntries([...new Set(samples.map((s) => s.model).filter(Boolean))].map((m) => [m, samples.filter((s) => s.model === m).length])),
  }
  function totalSamplesPct(all, n) { return all.length ? `${n}/${all.length} (${((n / all.length) * 100).toFixed(1)}%)` : '0' }

  const manifest = {
    tool: 'export-layer4.mjs (dsh-trajectory-anchor)',
    schema: 'PRM 兼容 step 样本；DPO/RLVR 可按 sessionId 成对取样',
    out_dir: outDir,
    stats,
  }
  writeFileSync(join(outDir, 'dataset.jsonl'), samples.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8')
  writeFileSync(join(outDir, 'stats.json'), JSON.stringify(stats, null, 2), 'utf8')
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

  console.log(`[layer4] 轨迹目录   : ${logsDir}`)
  console.log(`[layer4] 纳入会话   : ${included.length} 个（排除 ${excluded.length} 个，见 stats.json）`)
  console.log(`[layer4] 样本总数   : ${samples.length}（assistant ${stats.by_kind['assistant-message']} / tool-call ${stats.by_kind['tool-call']}）`)
  console.log(`[layer4] 文本覆盖   : ${stats.text_coverage}`)
  console.log(`[layer4] 会话奖励   : n=${stats.session_reward.n} min=${stats.session_reward.min} max=${stats.session_reward.max} mean=${stats.session_reward.mean} std=${stats.session_reward.std}`)
  console.log(`[layer4] 词典极性   : ${JSON.stringify(stats.lexicon_polarity)}`)
  console.log(`[layer4] 输出       : ${join(outDir, 'dataset.jsonl')}`)
  console.log(`[layer4] 统计       : ${join(outDir, 'stats.json')}`)
}

main()
