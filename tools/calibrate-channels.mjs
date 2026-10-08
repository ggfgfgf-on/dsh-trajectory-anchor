/**
 * calibrate-channels.mjs —— B2：多通道标定 + 产出 responsePolicy.json（只读语料）
 *
 * 回答：**当前信号能不能撑起能力层？** 每条通道各自算"空转侧"（正常会话被误触发
 * 的比例），并与预算比较；任何一条不过 → 该通道 `capabilityEligible: false`。
 *
 * 另含 **G3 反向对照门**：把被否决的旧口径（"无工具调用"**不分回合末步**）也跑一遍，
 * 它**必须**被判不合格——否则说明我们的对照失效（实测该口径 100% 命中回合收尾）。
 *
 * 用法：node tools/calibrate-channels.mjs [会话日志目录] [--out 前缀] [--budget 0.05]
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { channelSeriesFromSessions, legacySeriesFromSessions, walkChannel } from './behaviour-channel-core.mjs'

const args = process.argv.slice(2)
const positional = args.filter((a) => !a.startsWith('--'))
const sessionsDir = resolve(positional[0] || (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.dsh\\sessions` : '.'))
const outPrefix = resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : './response-policy')
const budget = Number(args.includes('--budget') ? args[args.indexOf('--budget') + 1] : 0.05)

// 通道参数（与 index.js DEFAULTS.responseChannels 对齐）
const CHANNELS = [
  { key: 'inaction', theme: 'A′ 中途停手（含回合末步排除）', testWindow: 3, refMinSteps: 20 },
  { key: 'repetition', theme: 'C 重复调用（同工具同参≥2/5步）', testWindow: 3, refMinSteps: 20 },
  { key: 'failure', theme: 'B 工具失败（只允许通知）', testWindow: 3, refMinSteps: 20, notifyOnly: true },
]

const sessions = channelSeriesFromSessions(sessionsDir)
const totalSteps = sessions.reduce((a, s) => a + s.steps, 0)
console.log(`语料：${sessions.length} 个会话 / ${totalSteps} 个锚定后步（与运行时同一台账语义）`)
if (sessions.length === 0) {
  console.error('没有可用语料（需要会话日志目录），退出')
  process.exit(1)
}

// α 是"每次检验"的误报率，预算是"每会话"的：会话长达数百步时族错误率会放大几十倍。
// 所以这里**按预算反解**：扫 α × 连续确认次数 k，取满足预算的最小证据要求。
const ALPHAS = [0.05, 0.01, 0.005, 0.001, 1e-4, 1e-5, 1e-6]
const KS = [1, 2, 3]
const results = []
console.log('')
console.log('① 空转侧扫描：会话命中率（行=连续确认 k，列=每次检验的 α）')
for (const ch of CHANNELS) {
  console.log(`\n${ch.theme}`)
  console.log('  k\\α     ' + ALPHAS.map((a) => String(a).padStart(8)).join(''))
  const grid = {}
  for (const k of KS) {
    const cells = []
    for (const alpha of ALPHAS) {
      const r = walkChannel(sessions, ch.key, { testWindow: ch.testWindow, refMinSteps: ch.refMinSteps, alpha, consecutive: k })
      grid[`${k}:${alpha}`] = r.rate
      cells.push((r.rate * 100).toFixed(1).padStart(7) + '%')
    }
    console.log(`  ${String(k).padStart(2)}      ` + cells.join(''))
  }
  // 反解：满足预算的最小证据要求（先看 k=1 的最小 α，再看 k 递增能否放宽 α）
  let chosen = null
  for (const k of KS) {
    for (const alpha of ALPHAS) {
      if (grid[`${k}:${alpha}`] <= budget) { chosen = { consecutive: k, alpha, rate: grid[`${k}:${alpha}`] }; break }
    }
    if (chosen) break
  }
  const best = { consecutive: null, alpha: null, rate: Infinity }
  for (const k of KS) for (const alpha of ALPHAS) {
    if (grid[`${k}:${alpha}`] < best.rate) { best.consecutive = k; best.alpha = alpha; best.rate = grid[`${k}:${alpha}`] }
  }
  results.push({
    ...ch,
    grid,
    derived: chosen,
    floor: best,
    capabilityEligible: !ch.notifyOnly && Boolean(chosen),
    verdict: ch.notifyOnly ? 'notify-only(设计)' : (chosen ? `PASS(k=${chosen.consecutive}, α=${chosen.alpha})` : `FAIL(无解：最低仍 ${(best.rate * 100).toFixed(1)}%)`),
  })
}
console.log('\n② 反解结果（按预算反推证据要求）')
console.log('通道                                 预算内解        该解下的命中率   若预算内无解：最低可达')
for (const r of results) {
  const d = r.derived
  console.log(`${r.theme.padEnd(34)} ${(d ? `k=${d.consecutive}, α=${d.alpha}` : '（无解）').padEnd(15)} ${(d ? (d.rate * 100).toFixed(1) + '%' : '—').padStart(8)}   ${(r.floor.rate * 100).toFixed(1)}% (k=${r.floor.consecutive}, α=${r.floor.alpha})`)
}

// ── G3 反向对照门：旧口径（不分回合末步）必须被判不合格 ─────────────────────
const legacySessions = legacySeriesFromSessions(sessionsDir)
const legacy = walkChannel(legacySessions, 'legacyNoTool', { testWindow: 3, refMinSteps: 20, alpha: 0.01 })
const legacyUnfit = legacy.rate > budget
console.log('')
console.log('反向对照门 G3（旧口径：无工具调用**不分回合末步**）')
console.log(`  会话命中率 ${(legacy.rate * 100).toFixed(1)}%（${legacy.sessionsHit}/${legacy.total}）  → ${legacyUnfit ? 'PASS（已判不合格，符合预期）' : 'FAIL（该口径竟然“合格”——对照失效，需检查）'}`)

// ── 产物：responsePolicy.json（含指纹/作用域/有效期/verdict）──────────────────
const fingerprint = (dir) => {
  try {
    const st = statSync(dir)
    return `sessions:${st.size}:${Math.round(st.mtimeMs)}`
  } catch { return 'unknown' }
}
const eligible = results.filter((r) => r.capabilityEligible).map((r) => r.key)
const artifact = {
  generatedAtUtc: new Date().toISOString(),
  scope: { pluginVersion: '0.4.9', release: 'B2-calibration', taskFamily: 'dsh-sessions' },
  corpusFingerprint: fingerprint(sessionsDir),
  budget: { targetFprPerSession: budget },
  channels: Object.fromEntries(results.map((r) => [r.key, {
    testWindow: r.testWindow,
    refMinSteps: r.refMinSteps,
    nullSessionRate: r.rate01,
    nullSessionRateAlpha05: r.rate05,
    capabilityEligible: r.capabilityEligible,
    verdict: r.verdict,
  }])),
  negativeControl: {
    channel: 'inaction',
    variant: 'turn-end-exclusion-removed',
    nullSessionRate: legacy.rate,
    expected: 'unfit',
    observed: legacyUnfit ? 'unfit' : 'fit',
  },
  recallSide: {
    status: 'UNMEASURED',
    note: '语料里没有可信的漂移标签（A′/C 各 0 事件），召回与延迟需 T3 人工标段或 T2 分数分层（B4）',
  },
  measurementSafe: true,
  verdict: eligible.length > 0 ? 'PARTIAL-PASS' : 'FAIL',
  capabilityEligibleChannels: eligible,
}
writeFileSync(`${outPrefix}.json`, JSON.stringify(artifact, null, 2), 'utf8')

console.log('')
console.log(`判定：${artifact.verdict}；有资格驱动能力层的通道：[${eligible.join(', ') || '（无）'}]`)
console.log(`  产物：${outPrefix}.json`)
const ok = eligible.length > 0 && legacyUnfit
process.exit(ok ? 0 : 2)
