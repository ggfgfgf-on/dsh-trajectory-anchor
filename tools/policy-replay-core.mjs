/**
 * policy-replay-core.mjs —— 策略离线回放核心（零依赖，只读）
 *
 * 关键约束：**判定必须用运行时同一套纯函数**（index.js 导出的 mannWhitneyLowerP /
 * policyDecision），否则脚本与实现会漂移——那样"回放验收"就失去意义。
 * 本文件只负责"喂历史序列 + 复刻状态机的时间线"，不重新实现任何判定逻辑。
 */
import { mannWhitneyLowerP, policyDecision } from '../index.js'

/** 默认策略参数（与 index.js DEFAULTS 对齐；回放时显式传入，便于做 α 扫描）。
 *  注意：回放默认把**两个开关都打开**，因为回放要验证的是"开了之后会不会卡住"；
 *  运行时默认是双关（只观察），两者的差别由 calibrate-response-policy.mjs 的结论决定。 */
export const DEFAULT_POLICY = {
  testWindow: 4,
  refMinSteps: 12,
  notifyAlpha: 0.05,
  actAlpha: 0.01,
  maxDriftSteps: 12,
  historyCap: 200,
  rollbackEnabled: true,
  notifyEnabled: true,
}

/**
 * 走查一条会话的观测序列（逐点预测，只用"当步之前"的历史——无未来信息）。
 * @returns {{steps: Array, episodes: Array, endedNarrowed: boolean, narrowedSteps: number}}
 */
export function replaySeries(series, policy = DEFAULT_POLICY) {
  const cfg = { ...DEFAULT_POLICY, ...policy }
  const cap = cfg.historyCap
  const steps = []
  const episodes = []
  let surface = 'stable'
  let narrowedSteps = 0
  let budgetExhausted = false
  let machineState = 'stable'
  let ep = null

  for (let i = 0; i < series.length; i++) {
    const hist = series.slice(Math.max(0, i - cap + 1), i + 1)
    const refLen = hist.length - cfg.testWindow
    let p = null
    if (refLen >= 1) p = mannWhitneyLowerP(hist.slice(-cfg.testWindow), hist.slice(0, hist.length - cfg.testWindow))
    const d = policyDecision({
      p,
      refLen,
      refMinSteps: cfg.refMinSteps,
      notifyAlpha: cfg.notifyAlpha,
      actAlpha: cfg.actAlpha,
      degenerate: false,
      budgetExhausted,
      rollbackEnabled: cfg.rollbackEnabled,
      notifyEnabled: cfg.notifyEnabled,
    })
    let narrowedThisStep = false
    if (d.level === 'stable') {
      if (budgetExhausted) budgetExhausted = false
      if (surface === 'narrowed') {
        episodes.push({ ...ep, end: i, endReason: d.reason })
        ep = null
        surface = 'stable'
      }
      narrowedSteps = 0
      machineState = 'stable'
    } else if (d.action !== 'narrow') {
      machineState = 'watch'
    } else if (surface !== 'narrowed') {
      surface = 'narrowed'
      narrowedSteps = 0
      ep = { start: i, steps: 0 }
      narrowedThisStep = true
    } else {
      narrowedThisStep = true
    }
    // 有界性按"面处于收窄态的步数"计时（与本步动作无关）——与运行时同一语义。
    // 历史教训：只统计"本步动作为 narrow"会漏计被闸门降级成 notice 的步，
    // 实测出现过 15 步 > maxDriftSteps=12 的越界片段。
    if (d.level !== 'stable' && surface === 'narrowed') {
      narrowedSteps += 1
      if (cfg.maxDriftSteps > 0 && narrowedSteps >= cfg.maxDriftSteps) {
        budgetExhausted = true
        episodes.push({ ...ep, steps: narrowedSteps, end: i, endReason: 'capability-budget-exhausted' })
        ep = null
        surface = 'stable'
        narrowedSteps = 0
      }
    }
    steps.push({ i, p, level: d.level, action: d.action, reason: d.reason, surface, narrowedThisStep })
  }
  if (ep) episodes.push({ ...ep, steps: narrowedSteps, end: series.length - 1, endReason: 'session-end' })
  return {
    steps,
    episodes: episodes.map(e => ({ ...e, steps: e.steps || (e.end - e.start + 1) })),
    endedNarrowed: surface === 'narrowed',
    narrowedSteps: steps.filter(s => s.surface === 'narrowed').length,
  }
}

/** 从标定语料里取每条会话的加权比序列（score 记录的 ratio 字段，按时间排序）。 */
export function seriesFromTrajectoryLogs(readdirSync, readFileSync, join, dir) {
  const bySid = new Map()
  for (const f of readdirSync(dir).filter((n) => /^anchor-.*\.jsonl(\.\d+)?$/.test(n))) {
    const sid = f.match(/^anchor-(.+?)\.jsonl(\.\d+)?$/)[1]
    if (!bySid.has(sid)) bySid.set(sid, [])
    bySid.get(sid).push(f)
  }
  const out = []
  for (const [sid, files] of bySid) {
    const recs = []
    for (const f of files) {
      for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue
        let o
        try { o = JSON.parse(line) } catch { continue }
        if (o.kind === 'score' && typeof o.ratio === 'number' && typeof o.t === 'number') recs.push(o)
      }
    }
    recs.sort((a, b) => a.t - b.t)
    if (recs.length < 8) continue
    out.push({ sid: sid.slice(0, 12), series: recs.map(r => r.ratio) })
  }
  return out
}
