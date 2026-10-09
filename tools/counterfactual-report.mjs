/**
 * counterfactual-report.mjs —— 反事实候选的**离线消费者**（`mineCounterfactualCandidates` 的下游）
 *
 * 背景（为什么这条数据此前是"休眠记账"）：收窄时插件会把"注入前的工具面"记成一条
 * `counterfactual` 审计（`{decisionPoint, injected: denyPatterns, requests, turn, step}`，
 * 恢复时补 `restored`）。但**没有任何消费者**——离线也不读 ⇒ 在能力层关闭时是纯记账。
 *
 * 这个消费者回答一个**真正有用的问题**（也正是本插件最重那次事故的形态）：
 *   **我们自己摘掉的工具，后来是不是被用到了？**
 *   · 若摘掉之后出现 `unknown-tool`，且被拒的工具名**命中注入的模式** ⇒ 这就是"收窄打断了工作"的直接证据；
 *   · 若整段收窄期间没有 unknown-tool ⇒ 这次收窄没有可见代价（对照事实）。
 *
 * 口径（与其它测量件一致）：
 *   · 只读审计日志（`anchor-*.jsonl*`，主文件 + 块文件按序号拼时间序）；
 *   · `unknown-tool` 事件必须**晚于**该次注入且**在同一次收窄片段内**才算"由收窄引起"；
 *   · 没有候选时**明确说"没有"**，不编造结论（能力层关着 ⇒ 预期为 0）。
 *
 * 用法：node tools/counterfactual-report.mjs [日志目录] [--out 前缀]
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const args = process.argv.slice(2)
const FLAGS = new Set(['--out'])
const pos = []
for (let i = 0; i < args.length; i++) {
  if (FLAGS.has(args[i])) { i += 1; continue }
  if (args[i].startsWith('--')) continue
  pos.push(args[i])
}
const dir = resolve(pos[0] || 'D:/deepseek-harness-dsh-v0.1.1-rc.2/.dsh-trajectory-logs')
const outPrefix = resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : './counterfactual-report')

const files = readdirSync(dir).filter((f) => /^anchor-.*\.jsonl(\.\d+)?$/.test(f))
const bySession = new Map()
for (const f of files) {
  const sid = f.replace(/\.jsonl(\.\d+)?$/, '')
  const idx = f.includes('.jsonl.') ? Number(f.slice(f.lastIndexOf('.') + 1)) : Number.MAX_SAFE_INTEGER
  if (!bySession.has(sid)) bySession.set(sid, [])
  bySession.get(sid).push({ f, idx })
}

/** deny 模式是 shell 风格通配（`*` 后缀）；转成正则做匹配。 */
const patternRe = (p) => new RegExp('^' + String(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*') + '$')
const matchesDenied = (tool, patterns) => patterns.some((p) => { try { return patternRe(p).test(tool) } catch { return false } })

const episodes = []
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
  let stepsInEpisode = 0
  for (const e of events) {
    if (e.kind === 'counterfactual' && e.injected && e.injected.length) {
      open = { sid, at: e.t ?? null, injected: e.injected.slice(), decisionPoint: e.decisionPoint ?? null, turn: e.turn ?? null, step: e.step ?? null, requests: e.requests ?? null, nameHits: [], restored: null, stepsInEpisode: 0 }
      stepsInEpisode = 0
      continue
    }
    if (e.kind === 'counterfactual' && e.restored && open) { open.restored = e.restored; episodes.push(open); open = null; continue }
    if (open) {
      if (e.kind === 'assistant-message') { stepsInEpisode += 1; open.stepsInEpisode = stepsInEpisode }
      // "我们自己摘掉的工具后来被用到了吗"：unknown-tool 事件里通常带工具名（写入 detail/note 时不一定有）
      if (e.kind === 'unknown-tool') {
        const tool = String(e.tool || e.name || '')
        open.nameHits.push({ at: e.t ?? null, turn: e.turn ?? null, step: e.step ?? null, tool: tool || null, matchedInjected: tool ? matchesDenied(tool, open.injected) : null })
      }
    }
  }
  if (open) { open.restored = { reason: 'log-ended-unrestored' }; episodes.push(open) }
}

const withHits = episodes.filter((ep) => ep.nameHits.length > 0)
const matched = episodes.filter((ep) => ep.nameHits.some((h) => h.matchedInjected === true))
const patterns = {}
for (const ep of episodes) for (const p of ep.injected) patterns[p] = (patterns[p] || 0) + 1
const topPatterns = Object.entries(patterns).sort((a, b) => b[1] - a[1]).slice(0, 12)

console.log(`日志目录：${dir}`)
console.log(`文件 ${files.length} / 会话 ${bySession.size}`)
console.log(`\n=== 反事实候选（收窄时记下的"注入前工具面"）===`)
console.log(`  片段数：${episodes.length}`)
if (episodes.length === 0) {
  console.log('  **没有候选** —— 能力层关闭期间不会发生收窄，这是预期状态（不是"分析失败"）。')
  console.log('  试运行/未来收窄一旦发生，本报告会立刻给出"摘掉的工具后来有没有被用到"。')
} else {
  const closed = episodes.filter((ep) => ep.restored && ep.restored.reason !== 'log-ended-unrestored')
  console.log(`  自然恢复 ${closed.length} / 日志结束仍未恢复 ${episodes.length - closed.length}`)
  console.log(`  平均片段步数：${(episodes.reduce((a, ep) => a + ep.stepsInEpisode, 0) / episodes.length).toFixed(1)}`)
  console.log(`  摘掉的模式数（去重）：${topPatterns.length}；出现最多的：${topPatterns.slice(0, 4).map(([p, n]) => `${p}×${n}`).join(' ')}`)
  console.log(`\n=== 代价侧：摘掉的工具后来被用到了吗 ===`)
  console.log(`  摘掉后出现 unknown-tool 的片段：${withHits.length}/${episodes.length}`)
  console.log(`  其中**工具名命中注入模式**（= 收窄直接打断工作）：${matched.length}`)
  if (withHits.length > matched.length) console.log(`  其余 ${withHits.length - matched.length} 个片段虽有 unknown-tool，但名字不在注入列表里（可能是别的原因）`)
}

writeFileSync(`${outPrefix}.json`, JSON.stringify({
  generatedAtUtc: new Date().toISOString(),
  kind: 'counterfactual-candidates',
  command: 'node tools/counterfactual-report.mjs [日志目录] --out <前缀>',
  note: '反事实候选的离线消费者：回答"我们自己摘掉的工具，后来是不是被用到了"。'
    + 'unknown-tool 必须晚于注入且在同一次收窄片段内才算"由收窄引起"；'
    + '没有候选时明确说"没有"（能力层关着 ⇒ 预期为 0），不编造结论。',
  dir, files: files.length, sessions: bySession.size,
  episodes: episodes.length,
  withUnknownTool: withHits.length,
  matchedInjectedPattern: matched.length,
  topPatterns,
  detail: episodes.slice(0, 50),
}, null, 2), 'utf8')
console.log(`\n产物：${outPrefix}.json`)
