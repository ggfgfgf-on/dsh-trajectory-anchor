/**
 * calibrate-response-policy.mjs —— P5b 标定：当前信号能不能撑起"能力层干预"？
 *
 * 只读。回答三件事：
 *   ① 是非题：在预算 α 下，历史（正常）会话有多少会被误收窄？——这是"信号有没有
 *      判别力"的判定，不达标就不许开能力层，只能通知；
 *   ② 结构常量：α / testWindow / refMinSteps 的敏感度（不是拍脑袋，是可查的表）；
 *   ③ 会话级验收基线：逐会话的收窄步占比分布（P7 用同一口径验收）。
 *
 * 说明：语料里的会话**没有漂移真值**（唯一的旧 drift 标签正是被替换掉的东西），
 * 所以这里只标定"空转侧"（正常会话被误触发多少），检出延迟用 maxDriftSteps 上限约束。
 *
 * 用法：node tools/calibrate-response-policy.mjs [轨迹日志目录] [--out 前缀]
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { replaySeries, seriesFromTrajectoryLogs, DEFAULT_POLICY } from './policy-replay-core.mjs'

const args = process.argv.slice(2)
const dir = resolve(args.find(a => !a.startsWith('--')) || 'D:/deepseek-harness-dsh-v0.1.1-rc.2/.dsh-trajectory-logs')
const outPrefix = resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : './response-policy')

const corpus = seriesFromTrajectoryLogs(readdirSync, readFileSync, join, dir)
console.log(`语料：${corpus.length} 个会话（score 记录 ≥8 条）`)
if (corpus.length === 0) {
  console.error('没有可用语料，退出')
  process.exit(1)
}

const pct = (x) => `${(x * 100).toFixed(1)}%`
const quantile = (arr, q) => { const a = [...arr].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(q * a.length))] : NaN }

// ① α 扫描：会话级误收窄率
const alphas = [0.001, 0.005, 0.01, 0.02, 0.05]
const rows = []
for (const actAlpha of alphas) {
  const policy = { ...DEFAULT_POLICY, actAlpha, notifyAlpha: Math.max(0.05, actAlpha) }
  let hit = 0
  const fractions = []
  let episodes = 0
  for (const s of corpus) {
    const r = replaySeries(s.series, policy)
    if (r.episodes.length > 0) hit += 1
    episodes += r.episodes.length
    fractions.push(r.narrowedSteps / s.series.length)
  }
  rows.push({
    actAlpha,
    sessionsTriggered: hit,
    sessionRate: hit / corpus.length,
    episodes,
    narrowedStepMedian: quantile(fractions, 0.5),
    narrowedStepWorst: quantile(fractions, 0.999),
  })
}
console.log('\n① α 扫描（正常会话被误收窄的比例；语料里没有真漂移标签，故全部视为空转侧）')
console.log('actAlpha   会话误触发   误触发率   片段数   收窄步占比中位   最差会话')
for (const r of rows) {
  console.log(`${String(r.actAlpha).padEnd(10)} ${String(r.sessionsTriggered).padStart(9)}/${corpus.length}  ${pct(r.sessionRate).padStart(8)}  ${String(r.episodes).padStart(6)}  ${pct(r.narrowedStepMedian).padStart(14)}  ${pct(r.narrowedStepWorst).padStart(8)}`)
}

// ② 结构常量敏感度：testWindow × refMinSteps（用默认 α）
console.log('\n② 结构常量敏感度（actAlpha=0.01）')
console.log('testWindow  refMinSteps  会话误触发率')
const structure = []
for (const testWindow of [3, 4, 6, 8]) {
  for (const refMinSteps of [12, 20, 30]) {
    const policy = { ...DEFAULT_POLICY, testWindow, refMinSteps, actAlpha: 0.01 }
    let hit = 0
    for (const s of corpus) if (replaySeries(s.series, policy).episodes.length > 0) hit += 1
    const rate = hit / corpus.length
    structure.push({ testWindow, refMinSteps, sessionRate: rate })
    console.log(`${String(testWindow).padStart(10)}  ${String(refMinSteps).padStart(10)}  ${pct(rate).padStart(12)}`)
  }
}

// ③ 会话级基线（默认策略）
const base = rows.find(r => r.actAlpha === DEFAULT_POLICY.actAlpha) || rows[0]
const verdict = base.sessionRate <= 0.05
  ? `PASS：默认 α=${DEFAULT_POLICY.actAlpha} 下误触发率 ${pct(base.sessionRate)} ≤ 5% —— 允许触发能力层（仍建议先只通知观察一轮）`
  : `FAIL：默认 α=${DEFAULT_POLICY.actAlpha} 下误触发率 ${pct(base.sessionRate)} > 5% —— 当前信号不足以支撑能力层干预；` +
    '应保持 rollbackEnabled=false（只通知），直到换用有判别力的信号（P5 行为轴）'

const artifact = {
  generatedAtUtc: new Date().toISOString(),
  corpus: { dir, sessions: corpus.length },
  policy: {
    testWindow: DEFAULT_POLICY.testWindow,
    refMinSteps: DEFAULT_POLICY.refMinSteps,
    actAlpha: DEFAULT_POLICY.actAlpha,
    notifyAlpha: DEFAULT_POLICY.notifyAlpha,
    maxDriftSteps: DEFAULT_POLICY.maxDriftSteps,
  },
  nullSide: {
    note: '语料无漂移真值，全部按空转侧统计；检出延迟未标定，用 maxDriftSteps 约束',
    sessionFalseTriggerRate: base.sessionRate,
    sessionsTriggered: base.sessionsTriggered,
    narrowedStepMedian: base.narrowedStepMedian,
    narrowedStepWorst: base.narrowedStepWorst,
  },
  alphaSweep: rows,
  structureSweep: structure,
  verdict,
}
writeFileSync(`${outPrefix}.json`, JSON.stringify(artifact, null, 2), 'utf8')
console.log(`\n③ 判定：${verdict}`)
console.log(`  产物：${outPrefix}.json`)
process.exit(verdict.startsWith('PASS') ? 0 : 2)
