/**
 * family-priors.mjs —— 从真实会话日志导出**任务/模型族先验**（L3 第二层的输入）
 *
 * 族键 = provider/model + agentPreset（会话事件里有）+ 任务指纹（提示里写明的范围名，没有则 'none'）。
 * 先验内容 = 每族的：会话数、步数、行为通道命中率（基频）、会话长度分布。
 *
 * 为什么先做这个：L3 的"模型/任务族先验收缩"只有在**族之间确实不同**时才有意义。
 * 如果语料里只有一个模型、一个预设，那收缩就是空操作——这一点必须先测出来再谈实现，
 * 不能因为"设计上很合理"就去写代码（本项目反复的教训）。
 *
 * 用法：node tools/family-priors.mjs [会话目录] [--out 前缀]
 */
import { writeFileSync } from 'node:fs'
import { resolve, basename, join } from 'node:path'
import { decodeSessionLog, walk } from './session-log-core.mjs'
import { buildLedgerFromEvents } from '../index.js'
import { parseTaskAnchors } from './task-anchor-core.mjs'

const args = process.argv.slice(2)
const FLAGS_WITH_VALUE = new Set(['--out'])
const positional = []
for (let i = 0; i < args.length; i++) {
  if (FLAGS_WITH_VALUE.has(args[i])) { i += 1; continue }
  if (args[i].startsWith('--')) continue
  positional.push(args[i])
}
const sessionsDir = resolve(positional[0] || (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.dsh\\sessions` : '.'))
const outPrefix = resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : './familyPriors')

const files = walk(sessionsDir, []).filter((f) => f.endsWith('session.jsonl.zstd'))
const families = new Map()
const modelSeen = new Map()
const presetSeen = new Map()
/** 会话 → 族键（评估阶段把先验按族套回每个会话）。 */
const sidToKey = new Map()
let sessionsUsed = 0

for (const f of files) {
  let text
  try { text = decodeSessionLog(f) } catch { continue }
  const events = []
  let provider = null
  let model = null
  let preset = null
  let prompt = ''
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    events.push(o)
    const d = o.data || {}
    if (o.type === 'request/header' && d.header && d.header.config) {
      if (!provider && typeof d.header.config.provider === 'string') provider = d.header.config.provider
      if (!model && typeof d.header.config.model === 'string') model = d.header.config.model
    }
    if (o.type === 'session' && typeof d.agentPreset === 'string' && !preset) preset = d.agentPreset
    if (o.type === 'user/message' && d.source && d.source.kind === 'user' && !prompt) {
      const blocks = Array.isArray(d.content) ? d.content : []
      prompt = blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('')
    }
  }
  const built = buildLedgerFromEvents(events, { repetitionWindow: 5, minRepeats: 2 })
  const steps = built.series.inaction.length
  if (steps < 10) continue
  sessionsUsed++
  const anchors = parseTaskAnchors(prompt)
  const scope = anchors.parsed ? (anchors.scopeNames[0] || (anchors.scopeDirs[0] || '').split('/').pop() || 'scope') : 'none'
  const fam = `${provider || 'unknown'}/${model || 'unknown'}`
  modelSeen.set(fam, (modelSeen.get(fam) || 0) + 1)
  presetSeen.set(preset || '(none)', (presetSeen.get(preset || '(none)') || 0) + 1)
  const key = `${fam} @ ${preset || 'no-preset'} @ ${scope}`
  sidToKey.set(basename(join(f, '..')).slice(0, 12), key)
  const cur = families.get(key) || { key, provider, model, preset, scope, sessions: 0, steps: 0, inactionHits: 0, repetitionHits: 0, failureHits: 0, lengthSum: 0 }
  cur.sessions += 1
  cur.steps += steps
  cur.inactionHits += built.series.inaction.reduce((a, b) => a + b, 0)
  cur.repetitionHits += built.series.repetition.reduce((a, b) => a + b, 0)
  cur.failureHits += built.series.failure.reduce((a, b) => a + b, 0)
  cur.lengthSum += steps
  families.set(key, cur)
}

const rows = [...families.values()].map((c) => ({
  key: c.key, provider: c.provider, model: c.model, preset: c.preset, scope: c.scope,
  sessions: c.sessions, steps: c.steps, meanSteps: Math.round(c.lengthSum / c.sessions),
  baseRates: {
    inaction: c.steps ? Number((c.inactionHits / c.steps).toFixed(4)) : null,
    repetition: c.steps ? Number((c.repetitionHits / c.steps).toFixed(4)) : null,
    failure: c.steps ? Number((c.failureHits / c.steps).toFixed(4)) : null,
  },
})).sort((a, b) => b.sessions - a.sessions)

console.log(`会话 ${files.length} 个日志 / 计入 ${sessionsUsed} 个（≥10 定稿步）`)
console.log('\n=== 模型族（provider/model）===')
for (const [k, v] of [...modelSeen.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`)
console.log('\n=== 预设族（agentPreset）===')
for (const [k, v] of [...presetSeen.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`)
console.log(`\n=== 完整族（provider/model @ preset @ scope）共 ${rows.length} 个 ===`)
console.log('族（截断 58 字）                                      会话   步数  均长   A′基频   C基频   B基频')
for (const r of rows.slice(0, 20)) {
  console.log(`  ${r.key.slice(0, 56).padEnd(56)} ${String(r.sessions).padStart(4)} ${String(r.steps).padStart(6)} ${String(r.meanSteps).padStart(5)}   `
    + `${String(r.baseRates.inaction).padStart(6)} ${String(r.baseRates.repetition).padStart(6)} ${String(r.baseRates.failure).padStart(6)}`)
}
const artifact = {
  generatedAtUtc: new Date().toISOString(),
  corpus: { sessionsScanned: files.length, sessionsUsed },
  axes: { modelFamilies: [...modelSeen.entries()].map(([k, v]) => ({ key: k, sessions: v })), presets: [...presetSeen.entries()].map(([k, v]) => ({ key: k, sessions: v })) },
  families: rows,
  // 逐会话的族键（供标定器把先验 join 回每个会话；否则标定器无法按族收缩）
  sessionKeys: Object.fromEntries(sidToKey),
  note: '族键 = provider/model @ agentPreset @ 任务范围名。baseRates 是各行为通道在该族的**每步命中率**（收缩先验用）。',
}

// ── 真实语料上的效果评估：同一 α 下，"无先验" vs "族先验" 的会话命中率 ────────────
// 这一步回答的是"收缩到底改了什么"，而不是"公式对不对"（后者由单测负责）。
if (args.includes('--eval')) {
  const { channelSeriesFromSessions, walkChannel } = await import('./behaviour-channel-core.mjs')
  const sessions = channelSeriesFromSessions(sessionsDir)
  const byKey = new Map(rows.map((r) => [r.key, r]))
  const priorOf = (sid, ch) => {
    const fam = byKey.get(sidToKey.get(sid))
    const v = fam && fam.baseRates ? fam.baseRates[ch] : null
    return Number.isFinite(v) ? { rate: v, strength: 20 } : null
  }
  const evalRows = []
  for (const ch of ['repetition', 'failure', 'inaction']) {
    const noPrior = walkChannel(sessions, ch, { testWindow: 3, refMinSteps: 20, alpha: 0.01, consecutive: 1 }).rate
    const hitsWith = sessions.filter((s) => walkChannel([s], ch, { testWindow: 3, refMinSteps: 20, alpha: 0.01, consecutive: 1, prior: priorOf(s.sid, ch) }).sessionsHit > 0).length
    const withPrior = sessions.length ? hitsWith / sessions.length : null
    const withFamilies = sessions.filter((s) => priorOf(s.sid, ch) !== null).length
    evalRows.push({ channel: ch, alpha: 0.01, sessions: sessions.length, sessionsWithFamilyPrior: withFamilies, noPrior, familyPrior: withPrior })
  }
  console.log('\n=== 真实语料：同一 α=0.01 下"无先验" vs "族先验"的会话命中率 ===')
  console.log('通道        无先验    族先验    变化     有族先验的会话')
  for (const r of evalRows) {
    const d = r.familyPrior - r.noPrior
    console.log(`  ${r.channel.padEnd(11)} ${(r.noPrior * 100).toFixed(1).padStart(6)}%  ${(r.familyPrior * 100).toFixed(1).padStart(6)}%  `
      + `${(d * 100 >= 0 ? '+' : '')}${(d * 100).toFixed(1)}pp  ${String(r.sessionsWithFamilyPrior).padStart(4)}/${r.sessions}`)
  }
  artifact.evalAtAlpha01 = evalRows
}

writeFileSync(`${outPrefix}.json`, JSON.stringify(artifact, null, 2), 'utf8')
console.log(`\n产物：${outPrefix}.json`)
