/**
 * behaviour-channel-core.mjs —— 行为通道的离线核心（只读，零依赖）
 *
 * 与运行时**同一套语义**：从会话日志重建每步台账（与 index.js 的 ledgerCell /
 * ledgerAdvanceStep / ledgerCloseTurn 一致），再按同一个 binomialLowerP 做会话内
 * 自参考检验。数学必须同源，否则"离线标定"与"在线判定"会各说各话。
 *
 * 关键口径（与运行时一致，见 index.js「行为通道台账」一节）：
 *   · 一步有工具调用 ⇒ 它不是"中途停手"；
 *   · 一步没有工具调用，但**同回合后面还有步** ⇒ 中途停手（命中）；
 *   · 一步没有工具调用，且它就是本回合最后一步 ⇒ 合法收尾（不命中）。
 * 另有 legacyNoTool：**不分回合末步**的旧口径，只用于反向对照门（必须被判不合格）。
 */
import { decodeSessionLog, walk } from './session-log-core.mjs'
import { basename, join } from 'node:path'
import { binomialLowerP } from '../index.js'

/** 与 index.js 的 FAILURE_MARKERS 一致（断言 C8 守护）。 */
const FAILURE_MARKERS = [
  /\[exit code:\s*[1-9]\d*\]/,
  /\[sandbox: file access denied/,
  /Traceback \(most recent call last\)/,
  /AssertionError/,
  /\bFAILED\b/,
  /Command failed/,
]

const normalizeArgs = (args) => String(args ?? '').replace(/\s+/g, ' ').replace(/\\/g, '/').trim().slice(0, 300)

function toolResultText(rec) {
  const blocks = rec && rec.message && rec.message.content
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const b of blocks) {
    if (b && b.type === 'tool-result' && Array.isArray(b.content)) {
      for (const c of b.content) if (c && c.type === 'text' && typeof c.text === 'string') parts.push(c.text)
    }
  }
  return parts.join('\n')
}

/**
 * 逐会话重建通道序列。
 * @returns [{ sid, steps, inaction: number[], repetition: number[], failure: number[], legacyNoTool: number[] }]
 */
export function channelSeriesFromSessions(sessionsDir, opts = {}) {
  const minSteps = opts.minSteps ?? 10
  const out = []
  for (const sf of walk(sessionsDir, []).filter((f) => f.endsWith('session.jsonl.zstd'))) {
    let text
    try { text = decodeSessionLog(sf) } catch { continue }
    const cells = new Map()          // key → { turn, step, tools, failures, repeated, lastOfTurn }
    const recentCalls = []
    const turnsWithEnd = new Set()
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let o
      try { o = JSON.parse(line) } catch { continue }
      const d = o.data || {}
      const turn = typeof d.turn === 'number' ? d.turn : null
      const step = typeof d.step === 'number' ? d.step : null
      if (o.type === 'turn/end') {
        if (turn !== null) turnsWithEnd.add(turn)
        continue
      }
      if (turn === null || step === null) continue
      const key = `${turn}#${step}`
      if (!cells.has(key)) cells.set(key, { turn, step, tools: 0, failures: 0, repeated: false })
      const cell = cells.get(key)
      if (o.type === 'tool/call') {
        cell.tools += 1
        const name = typeof d.name === 'string' ? d.name : ''
        if (!name) continue
        const sig = `${name}\u0000${normalizeArgs(d.arguments)}`
        recentCalls.push({ sig, turn, step })
        if (recentCalls.length > 40) recentCalls.shift()
        const window = opts.repetitionWindow ?? 5
        const minRepeats = opts.minRepeats ?? 2
        const distinct = []
        let hits = 0
        for (let i = recentCalls.length - 1; i >= 0; i--) {
          const c = recentCalls[i]
          if (c.turn === turn && c.step === step && c.sig === sig && distinct.length > 0) { hits += 1; continue }
          const k2 = `${c.turn}#${c.step}`
          if (!distinct.includes(k2)) { if (distinct.length >= window) break; distinct.push(k2) }
          if (c.sig === sig) hits += 1
        }
        if (hits >= minRepeats) cell.repeated = true
      } else if (o.type === 'tool/result') {
        const t = toolResultText(d)
        if (t && FAILURE_MARKERS.some((re) => re.test(t))) cell.failures += 1
      }
    }
    const ordered = [...cells.values()].sort((a, b) => (a.turn - b.turn) || (a.step - b.step))
    // 定稿：同回合后面还有步 ⇒ 中途停手；否则若该回合有 turn/end 或它已是最后一个观测 ⇒ 合法收尾
    const maxStepOfTurn = new Map()
    for (const c of ordered) maxStepOfTurn.set(c.turn, Math.max(maxStepOfTurn.get(c.turn) ?? -1, c.step))
    const done = ordered.filter((c) => c.step < (maxStepOfTurn.get(c.turn) ?? c.step) || turnsWithEnd.has(c.turn))
    if (done.length < minSteps) continue
    out.push({
      sid: basename(join(sf, '..')).slice(0, 12),
      steps: done.length,
      inaction: done.map((c) => (c.tools === 0 ? 1 : 0)),
      legacyNoTool: done.map((c) => (c.tools === 0 ? 1 : 0)),
      repetition: done.map((c) => (c.repeated ? 1 : 0)),
      failure: done.map((c) => (c.failures > 0 ? 1 : 0)),
    })
  }
  return out
}

/**
 * legacy 口径（反向对照门用）：**不分回合末步**——把所有"无工具调用"的步都算命中。
 * 这正是我们在实测中否决的口径（67 个无工具步 100% 是回合收尾）。
 */
export function legacySeriesFromSessions(sessionsDir, opts = {}) {
  const minSteps = opts.minSteps ?? 10
  const out = []
  for (const sf of walk(sessionsDir, []).filter((f) => f.endsWith('session.jsonl.zstd'))) {
    let text
    try { text = decodeSessionLog(sf) } catch { continue }
    const cells = new Map()
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let o
      try { o = JSON.parse(line) } catch { continue }
      const d = o.data || {}
      if (o.type !== 'tool/call' && o.type !== 'assistant/message') continue
      const turn = typeof d.turn === 'number' ? d.turn : null
      const step = typeof d.step === 'number' ? d.step : null
      if (turn === null || step === null) continue
      const key = `${turn}#${step}`
      if (!cells.has(key)) cells.set(key, { turn, step, tools: 0 })
      if (o.type === 'tool/call') cells.get(key).tools += 1
    }
    const ordered = [...cells.values()].sort((a, b) => (a.turn - b.turn) || (a.step - b.step))
    if (ordered.length < minSteps) continue
    out.push({ sid: basename(join(sf, '..')).slice(0, 12), steps: ordered.length, legacyNoTool: ordered.map((c) => (c.tools === 0 ? 1 : 0)) })
  }
  return out
}

/**
 * 逐会话走查一条二值通道（只用"当步之前"的历史，无未来信息）。
 *
 * `consecutive`（默认 1）要求**连续 k 次检验都命中**才算一次触发——这是社区
 * （allostasis `trackLoop(..., CONSECUTIVE_STEPS=2)`）用过的"观测单位迟滞"。
 * 为什么需要它：α 是**每次检验**的误报率，而预算是**每会话**的；会话长达数百步时
 * 族错误率 1−(1−α)^N 会把单次检验的 α 放大几十倍。连续确认把独立检验的误报乘起来，
 * 把预算真正压回会话级。
 *
 * @returns { sessionsHit, total, rate, perSession: [{sid, steps, fired, firstFireStep, firedSteps}] }
 */
export function walkChannel(sessions, seriesKey, cfg) {
  const { testWindow, refMinSteps, alpha } = cfg
  const consecutive = Math.max(1, cfg.consecutive ?? 1)
  const perSession = []
  let sessionsHit = 0
  for (const s of sessions) {
    const series = s[seriesKey] || []
    let fired = false
    let firstFireStep = null
    let firedSteps = 0
    let run = 0
    for (let i = 0; i < series.length; i++) {
      const hist = series.slice(0, i + 1)
      const refLen = hist.length - testWindow
      if (refLen < refMinSteps) { run = 0; continue }
      const test = hist.slice(hist.length - testWindow)
      const reference = hist.slice(0, hist.length - testWindow)
      const observed = test.reduce((a, b) => a + b, 0)
      const refHits = reference.reduce((a, b) => a + b, 0)
      const p = observed === 0 ? 1 : binomialLowerP(observed, testWindow, refHits, reference.length)
      if (p <= alpha) {
        run += 1
        if (run >= consecutive) {
          fired = true
          firedSteps += 1
          if (firstFireStep === null) firstFireStep = i - consecutive + 2
        }
      } else {
        run = 0
      }
    }
    if (fired) sessionsHit += 1
    perSession.push({ sid: s.sid, steps: series.length, fired, firstFireStep, firedSteps })
  }
  return { sessionsHit, total: sessions.length, rate: sessions.length ? sessionsHit / sessions.length : 0, perSession }
}
