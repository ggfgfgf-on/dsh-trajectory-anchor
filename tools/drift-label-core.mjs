/**
 * drift-label-core.mjs —— 事后确认的**自动延迟标注**与检测指标（零依赖，只读）
 *
 * 要解决的问题：召回侧一直是 UNMEASURED——语料里没有"离题"的金标准。人工标注（T3）贵，
 * 分数分层（T2）给不出召回/延迟。这里走第三条路（T4）：
 *
 *   把"**事后确认的劣化**"当作锚点，把锚点之前 lead 步标为正样本，
 *   再问检测器"这些正样本你有没有在锚点之前/当场报出来"。
 *
 * 为什么这叫"延迟标注"：确认发生时（工具报错、unknown tool、用户纠偏、回合被弃置）
 * 漂移早已在进行中，因此确认点只能给出**滞后的**正样本——用它测出来的召回与延迟，
 * 正是我们缺的那两个数（延迟 = 锚点 - 首次触发步，正数表示**提前**发现）。
 *
 * ── 方法论红线：**禁止循环标注** ────────────────────────────────────────────
 * 若用"被评估通道自己的信号"当锚点，召回必然接近 100%，那是同义反复。
 * 例如用 `failure-marker`（工具结果里的失败标记）去评估 `failure` 通道，
 * 就是拿信号验证它自己。这里用 `assertIndependent()` 硬拦：把某通道的**自有信号**
 * 列进锚点即抛错，测试里对这一点有专门的负向用例。
 *
 * 锚点种类（按"与哪个通道无关"分组）：
 *   · tool-error      —— 工具结果的 isError 标志（运行时自带的错误位，**不是**文本标记表）
 *   · unknown-tool    —— 结果文本里出现 unknown tool（旧版工具面塌陷的确认症状）
 *   · user-correction —— 人类消息里出现纠偏/重述线索（最接近"人认为它跑偏了"）
 *   · abandoned-turn  —— 某步之后该回合再没有 turn/end（回合被弃置/中断）
 *   · failure-marker  —— 工具结果里的失败文本标记（**failure 通道的自有信号**，
 *                        只允许用于评估其它通道）
 */

/** 锚点种类。 */
export const ANCHOR_KINDS = {
  TOOL_ERROR: 'tool-error',
  UNKNOWN_TOOL: 'unknown-tool',
  USER_CORRECTION: 'user-correction',
  ABANDONED_TURN: 'abandoned-turn',
  FAILURE_MARKER: 'failure-marker',
}

/**
 * 每条通道的**自有信号**：用这些当锚点评估该通道即为循环标注。
 * （inaction/repetition/lexicon 没有"跨通道独立"的自有信号落地成本文件的锚点，
 *   但它们的判定量本身——无工具步、重复调用、措辞——也不在锚点集合里。）
 */
export const CHANNEL_OWN_KINDS = {
  failure: [ANCHOR_KINDS.FAILURE_MARKER],
  inaction: [],
  repetition: [],
  lexicon: [],
}

/**
 * 独立性守卫：锚点集合与通道自有信号不得有交集。
 * @throws {Error} 交集非空时**响亮失败**（这条错误的代价是"召回 100%、实际零信息"）
 */
export function assertIndependent(channel, kinds) {
  const own = CHANNEL_OWN_KINDS[channel]
  if (!own) throw new Error(`assertIndependent: 未知通道 "${channel}"（已知：${Object.keys(CHANNEL_OWN_KINDS).join(', ')}）`)
  const clash = kinds.filter((k) => own.includes(k))
  if (clash.length) {
    throw new Error(`循环标注：通道 "${channel}" 的评估锚点里含它自己的信号 [${clash.join(', ')}] —— `
      + '用同一信号评估自己会让召回恒等于 100%，测出来的数是同义反复，不是证据')
  }
  return true
}

/** 失败文本标记（与 index.js 的 FAILURE_MARKERS 同源；由断言 C8 对齐）。 */
export const FAILURE_MARKERS = [
  /\[exit code:\s*[1-9]\d*\]/,
  /\[sandbox: file access denied/,
  /Traceback \(most recent call last\)/,
  /AssertionError/,
  /\bFAILED\b/,
  /Command failed/,
]

/** 纠偏/重述线索（中英）。这是**启发式**：精度在 measure-recall.mjs 里单独报告。 */
export const CORRECTION_CUES = [
  /(不对|错了|不是这样|不是这个|你没有|别再|又错|回退|撤销|重新做|我是说|我说的是|我的意思)/,
  /(revert|undo|roll ?back|that'?s wrong|not what i|i said|i meant|you didn'?t|stop doing)/i,
]

const toolResultText = (event) => {
  const blocks = event && event.data && event.data.message && event.data.message.content
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const b of blocks) {
    if (b && b.type === 'tool-result' && Array.isArray(b.content)) {
      for (const c of b.content) if (c && c.type === 'text' && typeof c.text === 'string') parts.push(c.text)
    }
  }
  return parts.join('\n')
}
const toolResultError = (event) => {
  const blocks = event && event.data && event.data.message && event.data.message.content
  if (!Array.isArray(blocks)) return false
  return blocks.some((b) => b && b.type === 'tool-result' && b.isError === true)
}
const humanText = (event) => {
  const d = event && event.data
  if (!d || !d.source || d.source.kind !== 'user') return ''
  const blocks = Array.isArray(d.content) ? d.content : []
  return blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n')
}

/**
 * 从事件流抽取确认性锚点（按 turn#step 定位，供与通道序列对齐）。
 *
 * @param {Array<object>} events 会话事件
 * @param {object} [opts]
 * @param {string[]} [opts.kinds] 要抽取的锚点种类（默认全部）
 * @param {number}   [opts.skipFirstHumanMessages=1] 前 N 条人类消息不算纠偏（那是原始任务陈述）
 * @returns {Array<{kind:string, turn:number, step:number, detail:string}>}
 */
export function anchorsFromEvents(events, opts = {}) {
  const kinds = new Set(opts.kinds || Object.values(ANCHOR_KINDS))
  const skipHumans = opts.skipFirstHumanMessages ?? 1
  const list = Array.isArray(events) ? events : Array.from(events || [])
  const out = []
  const anchors = []
  const seenHuman = []
  const turnsWithEnd = new Set()
  for (let eventIndex = 0; eventIndex < list.length; eventIndex++) {
    const ev = list[eventIndex]
    if (!ev || typeof ev.type !== 'string') continue
    const d = ev.data || {}
    const turn = typeof d.turn === 'number' ? d.turn : null
    const step = typeof d.step === 'number' ? d.step : null
    if (ev.type === 'turn/end') { if (turn !== null) turnsWithEnd.add(turn); continue }
    if (ev.type === 'tool/result' && turn !== null && step !== null) {
      if (kinds.has(ANCHOR_KINDS.TOOL_ERROR) && toolResultError(ev)) {
        anchors.push({ kind: ANCHOR_KINDS.TOOL_ERROR, turn, step, detail: 'tool/result isError' })
      }
      const text = toolResultText(ev)
      if (text) {
        if (kinds.has(ANCHOR_KINDS.UNKNOWN_TOOL) && /\bunknown tool\b|not a known tool/i.test(text)) {
          anchors.push({ kind: ANCHOR_KINDS.UNKNOWN_TOOL, turn, step, detail: text.slice(0, 80) })
        }
        if (kinds.has(ANCHOR_KINDS.FAILURE_MARKER) && FAILURE_MARKERS.some((re) => re.test(text))) {
          anchors.push({ kind: ANCHOR_KINDS.FAILURE_MARKER, turn, step, detail: text.slice(0, 80) })
        }
      }
      continue
    }
    if (ev.type === 'user/message') {
      const t = humanText(ev)
      if (!t) continue
      seenHuman.push(t)
      if (seenHuman.length <= skipHumans) continue
      if (!kinds.has(ANCHOR_KINDS.USER_CORRECTION)) continue
      if (CORRECTION_CUES.some((re) => re.test(t))) {
        // 人类消息**不携带 turn/step**（且它确认的是"之前"那一段），因此这里记事件下标
        // `eventIndex`，由调用方用台账轨迹把它映到"此刻最后一个已定稿步"的下标上。
        anchors.push({
          kind: ANCHOR_KINDS.USER_CORRECTION,
          turn: -1,
          step: seenHuman.length,
          eventIndex,
          detail: t.replace(/\s+/g, ' ').slice(0, 80),
        })
      }
    }
  }
  // 回合弃置：某回合的最后一个被观测步之后没有 turn/end，且**后面还有别的回合**
  // （否则可能只是"会话断在这里"，那属于截断而非弃置——截断不构成确认性劣置）。
  if (kinds.has(ANCHOR_KINDS.ABANDONED_TURN)) {
    const maxStepOfTurn = new Map()
    const observedTurns = []
    for (const ev of list) {      const d = ev && ev.data
      if (!d) continue
      const turn = typeof d.turn === 'number' ? d.turn : null
      const step = typeof d.step === 'number' ? d.step : null
      if (turn === null || step === null) continue
      if (ev.type !== 'tool/call' && ev.type !== 'assistant/message' && ev.type !== 'tool/result') continue
      if (!observedTurns.includes(turn)) observedTurns.push(turn)
      maxStepOfTurn.set(turn, Math.max(maxStepOfTurn.get(turn) ?? -1, step))
    }
    const maxTurn = observedTurns.length ? observedTurns[observedTurns.length - 1] : null
    for (const t of observedTurns) {
      if (turnsWithEnd.has(t)) continue
      if (t === maxTurn) continue   // 会话断在这里 = 截断，不是弃置
      anchors.push({ kind: ANCHOR_KINDS.ABANDONED_TURN, turn: t, step: maxStepOfTurn.get(t), detail: `turn ${t} 无 turn/end 且后面还有回合` })
    }
  }
  // 有序输出（按事件顺序出现的先后；user-correction 用 turn=-1 表示"会话级"，
  // 排序时按它在事件流里的位置——这里用插入序即可，故不再排序）。
  return anchors.filter((a) => a.step !== undefined && a.step !== null)
}

/**
 * 把锚点对齐到通道序列下标（序列由 buildLedgerFromEvents 产出，带 turn#step 键）。
 *
 * @param {Array<{turn:number,step:number}>} steps 已定稿步（顺序 = 序列下标）
 * @param {Array<object>} anchors
 * @param {object} [opts]
 * @param {number} [opts.userAnchorIndex] user-correction 锚点落到哪个下标（会话级锚点需要外部定位）
 * @returns {{aligned:Array<{idx:number,kind:string}>, dropped:number}}
 */
export function alignAnchors(steps, anchors, opts = {}) {
  const byKey = new Map()
  for (let i = 0; i < steps.length; i++) byKey.set(`${steps[i].turn}#${steps[i].step}`, i)
  const aligned = []
  let dropped = 0
  for (const a of anchors) {
    if (a.kind === ANCHOR_KINDS.USER_CORRECTION) {
      const idx = Number.isFinite(opts.userAnchorIndex) ? opts.userAnchorIndex : -1
      if (idx >= 0 && idx < steps.length) aligned.push({ idx, kind: a.kind, detail: a.detail })
      else dropped++
      continue
    }
    const idx = byKey.get(`${a.turn}#${a.step}`)
    if (idx === undefined) { dropped++; continue }
    aligned.push({ idx, kind: a.kind, detail: a.detail })
  }
  aligned.sort((x, y) => x.idx - y.idx)
  return { aligned, dropped }
}

/**
 * 检测指标：给定"触发步下标序列"与"锚点下标序列"，算召回、精度与延迟分布。
 *
 * 判定口径（写死在这里，避免各处自定义导致数字不可比）：
 *   · **命中**：存在某触发步 f，满足 anchorIdx - lead ≤ f ≤ anchorIdx
 *     （即"锚点之前 lead 步之内、或锚点当步"报出来过 → 这是**提前**发现）。
 *   · **延迟**：anchorIdx - min(命中触发步)；正数 = 提前多少步，0 = 当步，负数不存在（按上界定义）。
 *   · **未解释触发**：不落在任何 [anchorIdx-lead, anchorIdx+1] 窗口内的触发步数。
 *   · **精度**：命中锚点数 / (命中锚点数 + 未解释触发数)。
 *   · **精度基线**：若触发数相同但位置随机，期望精度 ≈ 正样本步占比
 *     （`positiveSteps / totalSteps`）——精度必须显著高于它才有意义。
 *
 * @param {object} input
 * @param {number[]} input.fires 触发步下标（升序）
 * @param {Array<{idx:number}>} input.anchors 锚点下标（升序）
 * @param {number} input.totalSteps 序列长度
 * @param {number} [input.lead=3] 允许提前的步数
 * @param {number} [input.tolerance=1] 锚点之后仍算"解释"的步数（同一事件的余波）
 */
export function detectionMetrics(input) {
  const fires = (input.fires || []).slice().sort((a, b) => a - b)
  const anchors = (input.anchors || []).slice().sort((a, b) => a.idx - b.idx)
  const lead = input.lead ?? 3
  const tol = input.tolerance ?? 1
  const totalSteps = input.totalSteps ?? 0
  const used = new Set()
  const delays = []
  let hits = 0
  for (const a of anchors) {
    let best = null
    for (let i = 0; i < fires.length; i++) {
      const f = fires[i]
      if (f < a.idx - lead) continue
      if (f > a.idx + tol) break
      if (used.has(i)) continue
      best = { i, f }
      break
    }
    if (best) {
      used.add(best.i)
      hits++
      delays.push(a.idx - best.f)
    }
  }
  const unexplained = fires.filter((_, i) => !used.has(i)).length
  const precision = hits + unexplained > 0 ? hits / (hits + unexplained) : null
  // 正样本步占比（精度基线）：lead+tol+1 宽的窗口 × 锚点数，与总步数之比
  const positiveSteps = Math.min(totalSteps, anchors.length * (lead + tol + 1))
  const chancePrecision = totalSteps > 0 ? positiveSteps / totalSteps : null
  delays.sort((a, b) => a - b)
  const median = delays.length === 0 ? null : delays[Math.floor((delays.length - 1) / 2)]
  return {
    anchors: anchors.length,
    hits,
    recall: anchors.length ? hits / anchors.length : null,
    fires: fires.length,
    unexplainedFires: unexplained,
    precision,
    chancePrecision,
    medianDelay: median,
    delays,
  }
}

/**
 * 多锚点/多会话聚合：把每会话的 (fires, anchors, totalSteps) 收集起来统一算，
 * 并给出**池化**（micro）与**按会话平均**（macro）两种口径——两者差异大说明会话间不齐。
 */
export function aggregateDetection(perSession, opts = {}) {
  const fires = []
  const anchors = []
  let totalSteps = 0
  const perSessionRecall = []
  for (const s of perSession) {
    const m = detectionMetrics({ fires: s.fires, anchors: s.anchors, totalSteps: s.steps, lead: opts.lead, tolerance: opts.tolerance })
    perSessionRecall.push({ sid: s.sid, anchors: m.anchors, hits: m.hits, recall: m.recall })
    // 池化：把各会话下标平移到同一坐标系（避免跨会话下标碰撞）
    const base = totalSteps
    for (const f of s.fires) fires.push(base + f)
    for (const a of s.anchors) anchors.push({ idx: base + a.idx })
    totalSteps += s.steps
  }
  const pooled = detectionMetrics({ fires, anchors, totalSteps, lead: opts.lead, tolerance: opts.tolerance })
  const withAnchors = perSessionRecall.filter((s) => s.anchors > 0)
  const macroRecall = withAnchors.length ? withAnchors.reduce((a, s) => a + s.recall, 0) / withAnchors.length : null
  return { pooled, macroRecall, sessionsWithAnchors: withAnchors.length, perSessionRecall }
}
