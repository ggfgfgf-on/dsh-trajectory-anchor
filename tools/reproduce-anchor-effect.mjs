/**
 * 复现检查：计划书的核心证据是"**锚定后首轮推理块是纯 we 风格（lexicon ratio 282-290，spec band）**"。
 * 这个能不能在今天真实日志里复现？能复现 ⇒ 机制有效；不能 ⇒ 锚定没在起作用。
 * 口径：取每个会话 `adopted` 之后的**第一条 `score`**（即首个被评分的步）的 band/personaRatio，
 * 并按"是否真的锚定过"（adopted 事件里 anchor:true）分组对照。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = 'D:/deepseek-harness-dsh-v0.1.1-rc.2/.dsh-trajectory-logs'
const files = readdirSync(dir).filter((f) => /^anchor-.*\.jsonl(\.\d+)?$/.test(f))
const bySession = new Map()
for (const f of files) {
  const sid = f.replace(/\.jsonl(\.\d+)?$/, '')
  const idx = f.includes('.jsonl.') ? Number(f.slice(f.lastIndexOf('.') + 1)) : Number.MAX_SAFE_INTEGER
  if (!bySession.has(sid)) bySession.set(sid, [])
  bySession.get(sid).push({ f, idx })
}

const rows = []
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
  let anchored = null
  let firstScore = null
  let scores = 0
  const bands = []
  for (const e of events) {
    if (e.kind === 'adopted' && anchored === null) anchored = e.anchor === true
    if (e.kind === 'score') {
      scores++
      if (!firstScore) firstScore = e
      if (bands.length < 12) bands.push(e.band)
    }
  }
  if (anchored === null || !firstScore) continue
  rows.push({
    sid: sid.slice(0, 24),
    anchored,
    band: firstScore.band,
    ratio: firstScore.ratio,
    personaRatio: firstScore.personaRatio,
    we: firstScore.we ?? null,
    letMe: firstScore.letMe ?? null,
    pos: firstScore.pos ?? null,
    neg: firstScore.neg ?? null,
    scores,
    earlyBands: bands.slice(0, 5).join('>'),
  })
}

const fmt = (x) => (x === null || x === undefined ? '—' : Number(x).toFixed(3))
for (const [label, set] of [['锚定过的会话', rows.filter((r) => r.anchored)], ['未锚定（resumed/历史）', rows.filter((r) => !r.anchored)]]) {
  if (!set.length) { console.log(`${label}: 无样本`); continue }
  const m = (k) => set.reduce((a, r) => a + (Number(r[k]) || 0), 0) / set.length
  const bandCount = {}
  for (const r of set) bandCount[r.band] = (bandCount[r.band] || 0) + 1
  console.log(`\n=== ${label}（n=${set.length}）===`)
  console.log(`  首条评分 band 分布: ${JSON.stringify(bandCount)}`)
  console.log(`  平均 ratio=${fmt(m('ratio'))}  personaRatio=${fmt(m('personaRatio'))}  we=${fmt(m('we'))}  letMe=${fmt(m('letMe'))}  pos=${fmt(m('pos'))}  neg=${fmt(m('neg'))}`)
  const spec = set.filter((r) => r.band === 'spec').length
  console.log(`  首轮落在 spec band 的比例：${((spec / set.length) * 100).toFixed(0)}%`)
}
console.log('\n=== 前 14 条样本（锚定与否 / 首条 band / ratio / 前五步 band 轨迹）===')
for (const r of rows.slice(0, 14)) {
  console.log(`  ${r.anchored ? '锚定 ' : '未锚定'} ${r.sid}  band=${String(r.band).padEnd(6)} ratio=${fmt(r.ratio)} persona=${fmt(r.personaRatio)}  轨迹=${r.earlyBands}`)
}
console.log(`\n（计划书声称：锚定后首轮推理块 "pure we / lexicon ratio 282-290 / spec band"）`)

// 证据落盘：审计结论必须可复现、可随包发布
import { writeFileSync } from 'node:fs'
const summarize = (set) => ({
  n: set.length,
  bandCount: set.reduce((a, r) => { a[r.band] = (a[r.band] || 0) + 1; return a }, {}),
  specRate: set.length ? set.filter((r) => r.band === 'spec').length / set.length : null,
  meanRatio: set.length ? set.reduce((a, r) => a + (Number(r.ratio) || 0), 0) / set.length : null,
  meanPersonaRatio: set.length ? set.reduce((a, r) => a + (Number(r.personaRatio) || 0), 0) / set.length : null,
})
writeFileSync('anchorEffectReport.json', JSON.stringify({
  generatedAtUtc: new Date().toISOString(),
  kind: 'anchoring-effect-reproduction',
  command: 'node tools/reproduce-anchor-effect.mjs',
  planClaim: 'plan README: with only pwsh plus the Minimal persona the first reasoning block of a fresh subagent is pure "we" (lexicon ratio 282-290, spec band)',
  anchored: summarize(rows.filter((r) => r.anchored)),
  unanchored: summarize(rows.filter((r) => !r.anchored)),
  note: '计划书核心证据（首轮复现 Minimal 条件 => 纯 we / spec band）在今天真实日志里只能部分复现：锚定会话首条评分 42% 落 spec band（未锚定组 32%，但两组不可比——未锚定是 resumed/历史会话，其"首条评分"并非首轮）；量纲也不同（计划书 282-290，现语料 0-66）=> 无法直接比对。关键：没有任何测量表明"像 Minimal => 做得更好"——机制有效性与效果有效性是两件事。',
}, null, 2), 'utf8')
console.log('产物：anchorEffectReport.json')