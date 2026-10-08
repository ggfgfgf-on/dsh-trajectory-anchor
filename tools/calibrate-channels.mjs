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
import { walk } from './session-log-core.mjs'

const args = process.argv.slice(2)
// 带值选项（--out/--budget）的**值**不属于位置参数：否则 `--out <前缀>` 的值会被当成
// 会话目录，于是"测了 0 个会话"——实测踩到（脚本正确地 fail-loud 退出，但根因是这里）。
const FLAGS_WITH_VALUE = new Set(['--out', '--budget'])
const positional = []
for (let i = 0; i < args.length; i++) {
  if (FLAGS_WITH_VALUE.has(args[i])) { i += 1; continue }
  if (args[i].startsWith('--')) continue
  positional.push(args[i])
}
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
    // 预算内的全部候选（α 宽→严），供"召回已知后在同预算下挑最灵敏者"使用。
    withinBudget: KS.flatMap((k) => ALPHAS.filter((a) => grid[`${k}:${a}`] <= budget).map((a) => ({ consecutive: k, alpha: a, rate: grid[`${k}:${a}`] })))
      .sort((x, y) => (y.alpha - x.alpha) || (x.consecutive - y.consecutive)),
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
// 语料指纹：目录的 stat.size 在 Windows 上恒为 0（于是只剩 mtime，任何触碰都"换指纹"，
// 而内容变化若不触碰目录 mtime 反而测不到）。改成"会话文件数 + 总字节 + 最新 mtime"。
const fingerprint = (dir) => {
  try {
    const files = walk(dir, []).filter((f) => f.endsWith('session.jsonl.zstd'))
    let bytes = 0
    let newest = 0
    for (const f of files) {
      const st = statSync(f)
      bytes += st.size
      if (st.mtimeMs > newest) newest = st.mtimeMs
    }
    return `sessions:${files.length}:${bytes}:${Math.round(newest)}`
  } catch { return 'unknown' }
}
const eligible = results.filter((r) => r.capabilityEligible).map((r) => r.key)
// 版本号从 package.json 读（单一来源；硬编码曾在提交文案与 package.json 之间漂移）。
let pluginVersion = 'unknown'
try {
  pluginVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
} catch { /* 保底 unknown，不因此中断标定 */ }
const artifact = {
  generatedAtUtc: new Date().toISOString(),
  scope: { pluginVersion, release: 'B3-calibration', taskFamily: 'dsh-sessions' },
  corpusFingerprint: fingerprint(sessionsDir),
  budget: { targetFprPerSession: budget },
  channels: Object.fromEntries(results.map((r) => [r.key, {
    testWindow: r.testWindow,
    refMinSteps: r.refMinSteps,
    nullSessionRateAtAlpha01: r.rate01,
    nullSessionRateAtAlpha05: r.rate05,
    capabilityEligible: r.capabilityEligible,
    verdict: r.verdict,
    // derived 是**运行时真正会用的东西**（index.js 装载标定件时读
    // art.channels[name].derived.{consecutive,alpha} 并写进该通道的生效配置）。
    // 之前这里只写了 testWindow/refMinSteps 与几个读数，于是"反解出来的 (k,α)"
    // 永远上不了线——标定产物与可用参数之间断了一截。
    derived: (!r.notifyOnly && r.derived) ? { consecutive: r.derived.consecutive, alpha: r.derived.alpha, sessionHitRate: r.derived.rate } : null,
    // 预算内的**全部**候选，按 α 从宽到严排序（越宽越灵敏 ⇒ 召回越高、误报越贴着预算）。
    // 现在选的是最保守的那个（召回侧还没测，不能拿灵敏度换风险）；等 B4/T4 测出召回，
    // 这份候选表就是"在同预算下选召回最高者"的直接依据——不用重新扫。
    withinBudgetCandidates: r.withinBudget.map((c) => ({ consecutive: c.consecutive, alpha: c.alpha, sessionHitRate: c.rate })),
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
    note: '语料里没有漂移标签（会话日志里只有"确认性劣化"事件，没有"离题"的金标准），'
      + '因此召回与延迟仍未测。B4/T4 方案：用事后确认信号做**自动延迟标注**，'
      + '把确认点之前 k 步标为正样本，从而算出召回/延迟与误报的联合曲线（工具：tools/drift-label-core.mjs）。',
  },
  // 注意（设计陷阱，实测踩到）：`measurementSafe: true` 会让装载它的**运行实例强制只观察**
  // （index.js 的标定件加载器会把它写进 CONFIG.measurementSafe ⇒ 能力层与通知层全关）。
  // 所以标定产物**绝不能**默认带上它——那样"标定件授权能力层"这条路永远走不通，
  // 而现象是"明明 verdict=PASS、明明有资格，却永远不动手"，且原因看起来很像自洽的评测保护。
  // 它的正确语义是"我要在评测/影子模式下装载这个标定件"：由**评测方**在需要时改写成 true。
  measurementSafe: false,
  verdict: eligible.length > 0 ? 'PARTIAL-PASS' : 'FAIL',
  capabilityEligibleChannels: eligible,
}
writeFileSync(`${outPrefix}.json`, JSON.stringify(artifact, null, 2), 'utf8')

console.log('')
console.log(`判定：${artifact.verdict}；有资格驱动能力层的通道：[${eligible.join(', ') || '（无）'}]`)
console.log(`  产物：${outPrefix}.json`)
const ok = eligible.length > 0 && legacyUnfit
process.exit(ok ? 0 : 2)
