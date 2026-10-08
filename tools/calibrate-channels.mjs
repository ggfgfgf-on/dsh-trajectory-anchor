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
const FLAGS_WITH_VALUE = new Set(['--out', '--budget', '--recall', '--min-recall', '--priors', '--prior-strength'])
const positional = []
for (let i = 0; i < args.length; i++) {
  if (FLAGS_WITH_VALUE.has(args[i])) { i += 1; continue }
  if (args[i].startsWith('--')) continue
  positional.push(args[i])
}
const sessionsDir = resolve(positional[0] || (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.dsh\\sessions` : '.'))
const outPrefix = resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : './response-policy')
const budget = Number(args.includes('--budget') ? args[args.indexOf('--budget') + 1] : 0.05)
// 召回侧报告（tools/measure-recall.mjs 的产物）。给了它，资格判定就必须**同时**过两关：
//   ① 空转侧：会话级误触发率 ≤ budget（下面反解）；
//   ② 召回侧：在"空转侧可行"的工作点里，最好召回 ≥ --min-recall。
// 为什么必须有第二关：只有空转侧时，把 α 压到 1e-5 就能"合格"——因为那时它**从不触发**。
// 一个从不触发的检测器空转率当然是 0，但那不是合格，是没有检测能力。
// 实测（59 会话 / 41k 步）：行为通道在**最宽**的 α=0.05 下召回也只有 4.3%，
// 且精度（6.2%）**低于随机基线**（19.2%）——即触发放置得比随便放还差。据此判定 FAIL。
const recallPath = args.includes('--recall') ? resolve(args[args.indexOf('--recall') + 1]) : null
const minRecall = Number(args.includes('--min-recall') ? args[args.indexOf('--min-recall') + 1] : 0.5)
let recallReport = null
if (recallPath) {
  try { recallReport = JSON.parse(readFileSync(recallPath, 'utf8')) } catch (e) {
    console.error(`读不到召回报告 ${recallPath}：${e && e.message}`)
    process.exit(1)
  }
}
// 族先验（L3 第二层）：给了就**带着先验**重新反解 α。
// 为什么必须能带先验标定：收缩把 null 率往族基频拉，实测让判定更敏感（α=0.01 时会话命中率
// +2.6 ~ +3.9pp）；若仍按"无先验"的 α 上线，等于**悄悄放宽了预算**——"离线合格、线上超标"
// 只是换了个入口。先验生效后 α 必须重解，这不是可选项。
const priorsPath = args.includes('--priors') ? resolve(args[args.indexOf('--priors') + 1]) : null
let priorArtifact = null
const priorStrength = Number(args.includes('--prior-strength') ? args[args.indexOf('--prior-strength') + 1] : 20)
if (priorsPath) {
  try { priorArtifact = JSON.parse(readFileSync(priorsPath, 'utf8')) } catch (e) {
    console.error(`读不到族先验 ${priorsPath}：${e && e.message}`)
    process.exit(1)
  }
}
/** 该会话在某通道上的先验（族基频 + 强度）。没有族信息 ⇒ null（退回固定 Jeffreys）。 */
const priorOf = (sid, ch) => {
  if (!priorArtifact) return null
  const key = priorArtifact.sessionKeys ? priorArtifact.sessionKeys[sid] : null
  const fam = key && Array.isArray(priorArtifact.families) ? priorArtifact.families.find((f) => f.key === key) : null
  const v = fam && fam.baseRates ? fam.baseRates[ch] : null
  return Number.isFinite(v) ? { rate: v, strength: priorStrength } : null
}

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
  console.log(`\n${ch.theme}${priorsPath ? '（带族先验）' : ''}`)
  console.log('  k\\α     ' + ALPHAS.map((a) => String(a).padStart(8)).join(''))
  const grid = {}
  // 带先验时：逐会话按其族取先验（walkChannel 支持每会话不同先验），必须**单个会话**走查。
  const walkOne = (s, alpha, k) => walkChannel([s], ch.key, {
    testWindow: ch.testWindow, refMinSteps: ch.refMinSteps, alpha, consecutive: k, prior: priorOf(s.sid, ch.key),
  }).sessionsHit
  for (const k of KS) {
    const cells = []
    for (const alpha of ALPHAS) {
      const rate = priorArtifact
        ? sessions.filter((s) => walkOne(s, alpha, k) > 0).length / Math.max(1, sessions.length)
        : walkChannel(sessions, ch.key, { testWindow: ch.testWindow, refMinSteps: ch.refMinSteps, alpha, consecutive: k }).rate
      grid[`${k}:${alpha}`] = rate
      cells.push((rate * 100).toFixed(1).padStart(7) + '%')
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
  // ── 召回侧：在"空转侧可行"的工作点里取最好召回 ──────────────────────────────
  // feasible = 该 (α,k) 的会话级空转率 ≤ budget
  let recallSide = null
  if (recallReport) {
    const sweepRows = (recallReport.sweep && recallReport.sweep[ch.key]) || []
    const feasible = sweepRows.filter((r) => r.firedSessions <= budget && r.recall !== null)
    const bestRow = feasible.slice().sort((a, b) => b.recall - a.recall)[0] || null
    const anyRow = sweepRows.slice().sort((a, b) => (b.recall ?? -1) - (a.recall ?? -1))[0] || null
    recallSide = {
      feasibleOperatingPoints: feasible.length,
      bestRecallWithinBudget: bestRow ? bestRow.recall : null,
      bestRecallPoint: bestRow ? { alpha: bestRow.alpha, k: bestRow.k, precision: bestRow.precision, chancePrecision: bestRow.chancePrecision } : null,
      // 即便放宽到预算外，也最好不过这个数——用来区分"阈值选错了"与"信号没有判别力"
      bestRecallAnyAlpha: anyRow ? anyRow.recall : null,
      bestRecallAnyAlphaPoint: anyRow ? { alpha: anyRow.alpha, k: anyRow.k, firedSessions: anyRow.firedSessions, precision: anyRow.precision, chancePrecision: anyRow.chancePrecision } : null,
      minRecallToAct: minRecall,
    }
  }
  // **没有召回证据就不许授予资格**（硬性规定，不是靠事后不变量兜底）。
  // 实测教训：自动闭环某次跑时忘了传召回报告，标定器就产出了一个**更松**的产物
  // （verdict=PARTIAL-PASS + 授予两个通道资格）——"只在空转侧合格"正是我们反复要防的那种
  // 静默放宽。当时被 C16 与门禁用例 ⑪ 拦下了，但源头就该拦：证据不足 ⇒ 不予资格。
  const recallOk = Boolean(recallSide) && (recallSide.bestRecallAnyAlpha ?? 0) >= minRecall
  // ── 无先验基线（对照）：无论是否带先验，都算一份，写进产物供运行时按"先验是否在用"选 ──
  // 为什么必须两套都给：出厂 `familyPriorPath` 是 null（不装先验），而**带先验**反解出的 α
  // 要严得多（实测 A′ 从 0.001 → 0.0001，10 倍）。若只写一套，那么"装先验的人拿到无先验的 α"
  // 或反之，都等于**悄悄改了预算**——正是我们反复要防的那种静默错配。
  const gridBase = {}
  if (priorArtifact) {
    for (const k of KS) {
      for (const alpha of ALPHAS) {
        gridBase[`${k}:${alpha}`] = walkChannel(sessions, ch.key, { testWindow: ch.testWindow, refMinSteps: ch.refMinSteps, alpha, consecutive: k }).rate
      }
    }
  }
  const gridToUse = priorArtifact ? gridBase : grid
  let chosenBase = null
  for (const k of KS) {
    for (const alpha of ALPHAS) {
      if (gridToUse[`${k}:${alpha}`] <= budget) { chosenBase = { consecutive: k, alpha, rate: gridToUse[`${k}:${alpha}`] }; break }
    }
    if (chosenBase) break
  }
  results.push({
    ...ch,
    grid,
    gridNoPrior: priorArtifact ? gridBase : null,
    derived: priorArtifact ? chosenBase : chosen,
    derivedWithFamilyPrior: priorArtifact ? chosen : null,
    // 预算内的全部候选（α 宽→严），供"召回已知后在同预算下挑最灵敏者"使用。
    withinBudget: KS.flatMap((k) => ALPHAS.filter((a) => grid[`${k}:${a}`] <= budget).map((a) => ({ consecutive: k, alpha: a, rate: grid[`${k}:${a}`] })))
      .sort((x, y) => (y.alpha - x.alpha) || (x.consecutive - y.consecutive)),
    floor: best,
    recallSide,
    capabilityEligible: !ch.notifyOnly && Boolean(chosenBase) && recallOk,
    verdict: ch.notifyOnly ? 'notify-only(设计)'
      : !chosenBase ? `FAIL(无解：最低仍 ${(best.rate * 100).toFixed(1)}%)`
        : !recallOk ? `FAIL(${recallSide ? '召回不足' : '召回未测（未提供 --recall）'}：全 α 范围内最好 ${(((recallSide && recallSide.bestRecallAnyAlpha) ?? 0) * 100).toFixed(1)}% < ${(minRecall * 100).toFixed(0)}%)`
          : `PASS(k=${chosen.consecutive}, α=${chosen.alpha})`,
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
  calibration: { withFamilyPrior: Boolean(priorArtifact), priorStrength: priorArtifact ? priorStrength : null, priorsSource: priorsPath || null },
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
    // 带族先验反解出的 α（更严）。运行时只有在**先验真的装载**时才用它——见 index.js 的装载器。
    derivedWithFamilyPrior: (!r.notifyOnly && r.derivedWithFamilyPrior) ? { consecutive: r.derivedWithFamilyPrior.consecutive, alpha: r.derivedWithFamilyPrior.alpha, sessionHitRate: r.derivedWithFamilyPrior.rate } : null,
    recallSide: r.recallSide,
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
  recallSide: recallReport
    ? {
        status: 'MEASURED',
        method: 'T4 事后确认的延迟标注（tools/measure-recall.mjs）：tool-error / unknown-tool / user-correction / abandoned-turn 作锚点，锚点前 lead 步内报出即命中',
        sessions: recallReport.sessionsUsed,
        anchors: recallReport.anchorStats,
        lead: recallReport.lead,
        perChannel: Object.fromEntries(results.map((r) => [r.key, r.recallSide])),
        conclusion: results.every((r) => !r.capabilityEligible || r.notifyOnly)
          ? '两条通道在**任何** α 下召回都远低于可用阈值，且精度低于随机基线 ⇒ 该信号不能驱动能力层（不是阈值问题，是信号没有判别力）'
          : '至少一条通道在预算内达到了召回阈值',
      }
    : {
        status: 'UNMEASURED',
        note: '未提供召回报告（--recall <measure-recall 产物>）。只测空转侧的判定**不足以**授予资格：'
          + '把 α 压到 1e-5 时"从不触发"也能满足预算，那不是合格而是没有检测能力。',
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
