/**
 * measure-drift-episodes.mjs —— 用**历史审计日志**反解 `maxDriftSteps` 这个上界
 *
 * 为什么需要：`maxDriftSteps`（默认 12）一直是个**静态常数**——它约束"一个收窄片段最多持续多少步"
 * （收满即能力预算耗尽：本片段内不再收窄、只通知）。它同时承担两个相反的责任：
 *   · **不能太小**：太小会截断**本来会自然恢复**的正常片段；
 *   · **不能没有/太大**：没有它就会出现"收窄后永不恢复"（本项目最重那次事故：23 个会话进收窄、0 个恢复）。
 * 所以正确取值应当来自"自然恢复的片段有多长"的分布，而不是拍脑袋。
 *
 * 数据来源：`.dsh-trajectory-logs/anchor-*.jsonl*` 里的 `surface {phase:'narrowed'|'stable'}`
 * 事件对。步数用两次事件之间的 `assistant-message` 计数近似（与运行时 `narrowedSteps` 的口径一致：
 * 它按"面处于收窄态的**步数**"计时，不是墙钟）。
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

const episodes = []
let sessionsWithNarrowing = 0
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
  let sawNarrow = false
  for (const e of events) {
    if (e.kind === 'surface' && e.phase === 'narrowed') { open = e.t ?? 0; steps = 0; sawNarrow = true; continue }
    if (e.kind === 'surface' && e.phase === 'stable' && open !== null) {
      episodes.push({ sid, steps, closed: true })
      open = null
      continue
    }
    if (open !== null && (e.kind === 'assistant-message' || e.kind === 'score')) steps += 1
  }
  if (sawNarrow) sessionsWithNarrowing++
  if (open !== null) {
    // 日志结束了片段还开着 ⇒ 要么被 maxDriftSteps/cap 截断，要么**从未恢复**（事故形态）
    episodes.push({ sid, steps, closed: false })
    sessionsStuckOpen++
  }
}

const closed = episodes.filter((e) => e.closed).map((e) => e.steps).sort((a, b) => a - b)
const openOnes = episodes.filter((e) => !e.closed).map((e) => e.steps).sort((a, b) => a - b)
const q = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * (arr.length - 1)))] : null)
console.log(`日志目录：${dir}`)
console.log(`文件 ${files.length} 个 / 会话 ${bySession.size} 个`)
console.log(`出现收窄的会话：${sessionsWithNarrowing}；日志结束时**仍未恢复**的：${sessionsStuckOpen}`)
console.log(`\n收窄片段（自然恢复 / 正常关闭）：n=${closed.length}`)
if (closed.length) {
  console.log(`  步数 p50=${q(closed, 0.5)} p90=${q(closed, 0.9)} p95=${q(closed, 0.95)} max=${closed[closed.length - 1]}`)
}
console.log(`收窄片段（日志结束仍未恢复）：n=${openOnes.length}`)
if (openOnes.length) console.log(`  步数 p50=${q(openOnes, 0.5)} max=${openOnes[openOnes.length - 1]}（这些正是上界要兜住的形态）`)

const rec = closed.length >= 8
  ? Math.max(4, q(closed, 0.95))                 // 上界至少要覆盖 95% 的自然片段
  : null
console.log(`\n反解建议：maxDriftSteps ≥ p95(自然片段) = ${rec === null ? '样本不足（<8 个自然片段）⇒ 保持不变并记为 DEBT' : rec}`)
console.log(`当前出厂值：12`)

writeFileSync(`${outPrefix}.json`, JSON.stringify({
  generatedAtUtc: new Date().toISOString(),
  command: 'node tools/measure-drift-episodes.mjs [日志目录] --out <前缀>',
  dir, files: files.length, sessions: bySession.size, sessionsWithNarrowing, sessionsStuckOpen,
  closedEpisodes: { n: closed.length, p50: q(closed, 0.5), p90: q(closed, 0.9), p95: q(closed, 0.95), max: closed[closed.length - 1] ?? null },
  openEpisodes: { n: openOnes.length, p50: q(openOnes, 0.5), max: openOnes[openOnes.length - 1] ?? null },
  recommendedMaxDriftSteps: rec,
  note: '上界来自"自然恢复片段"的 p95：太小会截断正常片段，缺了它会出现"收窄后永不恢复"（本项目最重那次事故）。',
}, null, 2), 'utf8')
console.log(`\n产物：${outPrefix}.json`)
