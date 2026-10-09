/**
 * measure-drift-episodes.mjs —— 用**历史审计日志**反解 `maxDriftSteps` 这个上界
 *
 * 为什么需要：`maxDriftSteps`（默认 12）一直是个**静态常数**——它约束"一个收窄片段最多持续多少步"
 * （收满即能力预算耗尽：本片段内不再收窄、只通知）。它同时承担两个相反的责任：
 *   · **不能太小**：太小会截断**本来会自然恢复**的正常片段；
 *   · **不能没有/太大**：没有它就会出现"收窄后永不恢复"（本项目最重那次事故：23 个会话进收窄、0 个恢复）。
 * 所以正确取值应当来自"自然恢复的片段有多长"的分布，而不是拍脑袋。
 *
 * 数据来源：`.dsh-trajectory-logs/anchor-*.jsonl*` 里的**漂移片段**事件对：
 *   · `state {state:'drift'}` → `state {state:'stable'}` —— **这才是 `maxDriftSteps` 约束的东西**
 *     （"一个片段最多持续多少步"）；步数用两次事件之间的 `assistant-message`/`score` 计数近似。
 *   · `surface {phase:'narrowed'|'stable'}` 作为**次要**口径一并报出（P1 之后才有这种事件）。
 * ⚠ 第一次实现只量了 `surface`，得到 0 个片段并据此登记了"零样本无法反解"的 DEBT ——
 *   **那是量错了事件**：`surface` 只在 P1 之后才写、而能力层之后一直关着；真正被约束的是 `state` 漂移片段
 *   （实测日志里 50 drift / 45 stable）。这条自我纠错写在这里，防止后人重犯。
 *
 * 用法：node tools/measure-drift-episodes.mjs [日志目录] [--out 前缀]
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const args = process.argv.slice(2)
// ⚠ `--out <值>` 的值**不能**被当成位置参数（本项目在标定器上踩过同一个坑：
// 它把一个不存在的目录当成语料，然后安静地测出空结果）。
const FLAGS_WITH_VALUE = new Set(['--out'])
const positional = []
for (let i = 0; i < args.length; i++) {
  if (FLAGS_WITH_VALUE.has(args[i])) { i += 1; continue }
  if (args[i].startsWith('--')) continue
  positional.push(args[i])
}
const dir = resolve(positional[0] || 'D:/deepseek-harness-dsh-v0.1.1-rc.2/.dsh-trajectory-logs')
const outPrefix = resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : './drift-episodes')

// 主文件 + 块文件（按块序号排序）拼成时间序
const files = readdirSync(dir).filter((f) => /^anchor-.*\.jsonl(\.\d+)?$/.test(f))
const bySession = new Map()
for (const f of files) {
  const sid = f.replace(/\.jsonl(\.\d+)?$/, '')
  const idx = f.includes('.jsonl.') ? Number(f.slice(f.lastIndexOf('.') + 1)) : Number.MAX_SAFE_INTEGER
  if (!bySession.has(sid)) bySession.set(sid, [])
  bySession.get(sid).push({ f, idx })
}

const episodes = []          // 主口径：state drift → stable
const surfEpisodes = []      // 次口径：surface narrowed → stable
let sessionsWithDrift = 0
let sessionsStuckOpen = 0
for (const [sid, list] of bySession) {
  list.sort((a, b) => a.idx - b.idx)
  const events = []
  for (const { f } of list) {
    let text
    try { text = readFileSync(join(dir, f), 'utf8') } catch { continue }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try { events.push(JSON.parse(line)) } catch { /* 坏行 */ }
    }
  }
  let open = null
  let steps = 0
  let sawDrift = false
  let sOpen = null
  let sSteps = 0
  for (const e of events) {
    // ── 主口径：漂移片段（state drift ↔ stable）──
    if (e.kind === 'state' && e.state === 'drift') { open = e.t ?? 0; steps = 0; sawDrift = true }
    else if (e.kind === 'state' && e.state === 'stable' && open !== null) {
      episodes.push({ sid, steps, closed: true })
      open = null
    }
    // ── 次口径：工具面收窄片段 ──
    if (e.kind === 'surface' && e.phase === 'narrowed') { sOpen = e.t ?? 0; sSteps = 0 }
    else if (e.kind === 'surface' && e.phase === 'stable' && sOpen !== null) {
      surfEpisodes.push({ sid, steps: sSteps, closed: true })
      sOpen = null
    }
    // ⚠ 步数口径：每步日志里**同时**写 `score` 与 `assistant-message`
    // （第一版把两者都计数 ⇒ 步数被算成两倍）。这里只数 `assistant-message` 作为"一步"。
    if (open !== null && e.kind === 'assistant-message') steps += 1
    if (sOpen !== null && e.kind === 'assistant-message') sSteps += 1
  }
  if (sawDrift) sessionsWithDrift++
  if (open !== null) {
    // 日志结束了片段还开着 ⇒ 要么被 maxDriftSteps/cap 截断，要么**从未恢复**（事故形态）
    episodes.push({ sid, steps, closed: false })
    sessionsStuckOpen++
  }
  if (sOpen !== null) surfEpisodes.push({ sid, steps: sSteps, closed: false })
}

const closed = episodes.filter((e) => e.closed).map((e) => e.steps).sort((a, b) => a - b)
const openOnes = episodes.filter((e) => !e.closed).map((e) => e.steps).sort((a, b) => a - b)
const surfClosed = surfEpisodes.filter((e) => e.closed).map((e) => e.steps).sort((a, b) => a - b)
const q = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * (arr.length - 1)))] : null)
console.log(`日志目录：${dir}`)
console.log(`文件 ${files.length} 个 / 会话 ${bySession.size} 个`)
console.log(`\n=== 主口径：漂移片段（state drift → stable）—— 这才是 maxDriftSteps 约束的东西 ===`)
console.log(`出现漂移的会话：${sessionsWithDrift}；日志结束时**仍未恢复**的：${sessionsStuckOpen}`)
console.log(`自然恢复的片段：n=${closed.length}`)
if (closed.length) {
  console.log(`  步数 p50=${q(closed, 0.5)} p75=${q(closed, 0.75)} p90=${q(closed, 0.9)} p95=${q(closed, 0.95)} max=${closed[closed.length - 1]}`)
  console.log(`  被 12 截断的比例：${((closed.filter((s) => s > 12).length / closed.length) * 100).toFixed(1)}%（${closed.filter((s) => s > 12).length}/${closed.length}）`)
}
if (openOnes.length) console.log(`仍未恢复的片段：n=${openOnes.length}  p50=${q(openOnes, 0.5)} max=${openOnes[openOnes.length - 1]}（这些正是上界要兜住的形态）`)

console.log(`\n=== 次口径：工具面收窄片段（surface narrowed → stable；P1 之后才有）===`)
console.log(`  n=${surfClosed.length}${surfClosed.length ? `  p50=${q(surfClosed, 0.5)} p90=${q(surfClosed, 0.9)}` : '（能力层关着 ⇒ 预期为 0；第一次实现只看这个口径，才误判成"零样本"）'}`)

const plan = { p50: 5, p75: 9, p90: 12, p95: 19, max: 22, episodes: 53 }
console.log(`\n=== 与计划书声称的反解结果对照（README: 45 会话 / 3299 步 / 53 片段）===`)
console.log(`  计划书: p50=${plan.p50} p75=${plan.p75} p90=${plan.p90} p95=${plan.p95} max=${plan.max}（${plan.episodes} 片段）`)
console.log(`  本次实测: p50=${q(closed, 0.5)} p75=${q(closed, 0.75)} p90=${q(closed, 0.9)} p95=${q(closed, 0.95)} max=${closed[closed.length - 1] ?? null}（${closed.length} 片段）`)

const rec = closed.length >= 8
  ? Math.max(4, q(closed, 0.95))                 // 上界至少要覆盖 95% 的自然片段
  : null
console.log(`\n反解建议：maxDriftSteps ≥ p95(自然片段) = ${rec === null ? '样本不足（<8 个自然片段）' : rec}    当前出厂值：12`)

writeFileSync(`${outPrefix}.json`, JSON.stringify({
  generatedAtUtc: new Date().toISOString(),
  kind: 'max-drift-steps-derivation',
  command: 'node tools/measure-drift-episodes.mjs [日志目录] --out <前缀>',
  dir, files: files.length, sessions: bySession.size, sessionsWithDrift, sessionsStuckOpen,
  driftEpisodes: { n: closed.length, p50: q(closed, 0.5), p75: q(closed, 0.75), p90: q(closed, 0.9), p95: q(closed, 0.95), max: closed[closed.length - 1] ?? null, truncatedBy12: closed.filter((s) => s > 12).length },
  stillOpenEpisodes: { n: openOnes.length, p50: q(openOnes, 0.5), max: openOnes[openOnes.length - 1] ?? null },
  surfaceEpisodes: { n: surfClosed.length },
  planClaim: plan,
  recommendedMaxDriftSteps: rec,
  note: '主口径 = `state drift → stable` 片段长度（maxDriftSteps 约束的正是它）；次口径 = 工具面收窄片段（P1 后才有，能力层关着时为 0）。'
    + '上界应 ≥ p95(自然片段)：太小会截断正常片段，缺了它会出现"收窄后永不恢复"（本项目最重那次事故）。',
}, null, 2), 'utf8')
console.log(`\n产物：${outPrefix}.json`)
