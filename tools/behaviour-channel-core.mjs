/**
 * behaviour-channel-core.mjs —— 行为通道的离线核心（只读，零依赖）
 *
 * 台账**不再在本文件里复制规则**，而是调用运行时导出的 `buildLedgerFromEvents`
 * （index.js），再按同一个 `binomialLowerP` 做会话内自参考检验。
 *
 * 为什么改成共用（实测教训）：本文件曾自带一套 `done` 规则
 *     done = step < maxStepOfTurn(turn) || turnsWithEnd.has(turn)
 * 它与运行时的定稿规则不一致——所在回合有 `turn/end` 时它把**末步**也收进序列，
 * 而"末步无工具调用"正是**合法收尾**（运行时定稿为 false）。后果（128 个真实会话实测）：
 *     A′ 命中率  运行时 65/41,735 = 0.16%   离线 3,410/42,104 = 8.10%   ← 差 51 倍
 *     128 个会话里 123 个序列不同
 * 也就是说 B2 反解出来的 α 是给一条**运行时不存在**的通道算的；而当时 G3 的"反向对照"
 * （不分回合末步，26.0%）与"真通道"（27.3%）几乎一样，本该早就暴露这件事。
 * 现在由 tools/test-ledger-parity.mjs 拿真实会话**逐步入对拍**（解码后的真实事件喂进
 * apply()，逐步比对通道快照 observed/window/refLen/refHits）。
 *
 * 关键口径（与运行时一致，见 index.js「行为通道台账」一节）：
 *   · 一步有工具调用 ⇒ 它不是"中途停手"；
 *   · 一步没有工具调用，但**同回合后面还有步** ⇒ 中途停手（命中）；
 *   · 一步没有工具调用，且它就是本回合最后一步 ⇒ 合法收尾（不命中）；
 *   · 既没有后续步、也没有 turn/end（会话断在这里）⇒ 永不定稿，不进序列。
 * 另有 legacyNoTool：**不分回合末步**的旧口径，只用于反向对照门（必须被判不合格）。
 */
import { decodeSessionLog, walk } from './session-log-core.mjs'
import { basename, join } from 'node:path'
import { binomialLowerP, buildLedgerFromEvents } from '../index.js'

/**
 * 逐会话重建通道序列（台账来自运行时导出的同一实现）。
 * @returns [{ sid, steps, inaction: number[], repetition: number[], failure: number[], stepKeys: string[] }]
 */
export function channelSeriesFromSessions(sessionsDir, opts = {}) {
  const minSteps = opts.minSteps ?? 10
  const out = []
  for (const sf of walk(sessionsDir, []).filter((f) => f.endsWith('session.jsonl.zstd'))) {
    let text
    try { text = decodeSessionLog(sf) } catch { continue }
    const events = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try { events.push(JSON.parse(line)) } catch { /* 坏行忽略 */ }
    }
    const { series } = buildLedgerFromEvents(events, opts)
    if (series.inaction.length < minSteps) continue
    out.push({
      sid: basename(join(sf, '..')).slice(0, 12),
      steps: series.inaction.length,
      inaction: series.inaction,
      repetition: series.repetition,
      failure: series.failure,
      stepKeys: series.steps.map((s) => `${s.turn}#${s.step}`),
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
 * 返回里带上**触发步下标**（`fires`，0-based，落在序列上）：标注/召回评估要问"这一触发落在
 * 哪个步"，只有会话级命中率是答不了的（那是 B2 空转侧的粒度）。
 *
 * ⚠ 约定：`firstFireStep` 是 **1-based**，且指的是**确认游程的第一步**（不是触发的下标）——
 *   即 `fires[0] + 1 - (consecutive - 1)`。k=1 时两者重合（都等于 fires[0]+1），k>1 时
 *   firstFireStep 会**早于** fires[0]。这个字段是历史遗留的"第几步开始有证据"口径，
 *   做召回/延迟请一律用 `fires`（0-based、与序列下标一致），别混用两套编号。
 *
 * @returns { sessionsHit, total, rate, perSession: [{sid, steps, fired, firstFireStep, firedSteps, fires}] }
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
    const fires = []
    for (let i = 0; i < series.length; i++) {
      const hist = series.slice(0, i + 1)
      const refLen = hist.length - testWindow
      if (refLen < refMinSteps) { run = 0; continue }
      const test = hist.slice(hist.length - testWindow)
      const reference = hist.slice(0, hist.length - testWindow)
      const observed = test.reduce((a, b) => a + b, 0)
      const refHits = reference.reduce((a, b) => a + b, 0)
      const p = observed === 0 ? 1 : binomialLowerP(observed, testWindow, refHits, reference.length, cfg.prior || 0.5)
      if (p <= alpha) {
        run += 1
        if (run >= consecutive) {
          fired = true
          firedSteps += 1
          fires.push(i)
          if (firstFireStep === null) firstFireStep = i - consecutive + 2
        }
      } else {
        run = 0
      }
    }
    if (fired) sessionsHit += 1
    perSession.push({ sid: s.sid, steps: series.length, fired, firstFireStep, firedSteps, fires })
  }
  return { sessionsHit, total: sessions.length, rate: sessions.length ? sessionsHit / sessions.length : 0, perSession }
}
