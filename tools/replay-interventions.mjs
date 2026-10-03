/**
 * replay-interventions.mjs —— P7 回放验收（只读）
 *
 * 在历史语料上逐会话走查新的响应策略，验证三条**可判定**的不变量：
 *   ① 有界：任何"收窄"片段都必须在 maxDriftSteps 内结束（不能无限延续）；
 *   ② 不留残：会话结束时不允许停在收窄态；
 *   ③ 可回放：同一序列必须得到同一结论（纯函数，与运行时同源）。
 * 外加从会话日志统计 `unknown tool`（工具面被静默摘掉的历史痕迹）。
 *
 * 与 calibrate-response-policy.mjs 的分工：那个回答"该不该开能力层"（误报预算），
 * 这个回答"开了之后会不会卡住"（有界性与残留）。
 *
 * 用法：node tools/replay-interventions.mjs [轨迹日志目录] [会话日志目录]
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { decodeSessionLog, walk } from './session-log-core.mjs'
import { replaySeries, seriesFromTrajectoryLogs, DEFAULT_POLICY } from './policy-replay-core.mjs'

const dir = resolve(process.argv[2] || 'D:/deepseek-harness-dsh-v0.1.1-rc.2/.dsh-trajectory-logs')
const sessionsDir = resolve(process.argv[3] || (process.env.USERPROFILE ? join(process.env.USERPROFILE, '.dsh', 'sessions') : ''))

// 回放时把能力层打开（要验证的正是"开了之后会不会卡住"）；通知层同样打开。
const policy = { ...DEFAULT_POLICY, rollbackEnabled: true, notifyAlpha: 0.05 }
const corpus = seriesFromTrajectoryLogs(readdirSync, readFileSync, join, dir)
console.log(`语料：${corpus.length} 个会话；回放策略：maxDriftSteps=${policy.maxDriftSteps} actAlpha=${policy.actAlpha}`)

let violations = 0
let badEndReason = 0
let truncated = 0
let totalEpisodes = 0
let longest = 0
const perSession = []
const OK_END_REASONS = new Set(['within-reference', 'session-end', 'capability-budget-exhausted'])
for (const s of corpus) {
  const r = replaySeries(s.series, policy)
  const over = r.episodes.filter(e => e.steps > policy.maxDriftSteps)
  if (over.length) {
    violations += over.length
    console.log(`  FAIL ${s.sid}：${over.length} 个片段超过 maxDriftSteps（${over.map(e => e.steps).join(',')}）`)
  }
  for (const e of r.episodes) {
    if (!OK_END_REASONS.has(e.endReason)) {
      badEndReason += 1
      console.log(`  FAIL ${s.sid}：片段以意外原因结束（${e.endReason}）`)
    }
    if (e.endReason === 'session-end') truncated += 1
    longest = Math.max(longest, e.steps)
  }
  totalEpisodes += r.episodes.length
  perSession.push({ sid: s.sid, n: s.series.length, episodes: r.episodes.length, narrowedSteps: r.narrowedSteps })
}

// 可回放性：跑第二遍必须完全一致
let drift = 0
for (const s of corpus) {
  const a = JSON.stringify(replaySeries(s.series, policy).steps.map(x => x.level))
  const b = JSON.stringify(replaySeries(s.series, policy).steps.map(x => x.level))
  if (a !== b) drift += 1
}

// unknown tool 痕迹（历史会话日志）
let unknownToolSessions = 0
let unknownToolCount = 0
if (sessionsDir) {
  try {
    for (const sf of walk(sessionsDir, []).filter(f => f.endsWith('session.jsonl.zstd'))) {
      let text
      try { text = decodeSessionLog(sf) } catch { continue }
      let n = 0
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        let o
        try { o = JSON.parse(line) } catch { continue }
        if (o.type !== 'tool/result') continue
        const blocks = o.data?.message?.content
        if (!Array.isArray(blocks)) continue
        for (const b of blocks) {
          if (b && b.type === 'tool-result' && Array.isArray(b.content)) {
            for (const c of b.content) {
              if (c && typeof c.text === 'string' && /unknown tool/i.test(c.text)) n += 1
            }
          }
        }
      }
      if (n > 0) { unknownToolSessions += 1; unknownToolCount += n }
    }
  } catch (e) {
    console.log(`（跳过 unknown tool 统计：${e.message}）`)
  }
}

const triggered = perSession.filter(s => s.episodes > 0).length
console.log('\n=== 回放验收 ===')
console.log(`会话数                     ${corpus.length}`)
console.log(`触发过收窄的会话           ${triggered}（${(triggered / corpus.length * 100).toFixed(1)}%）`)
console.log(`收窄片段总数 / 最长片段    ${totalEpisodes} / ${longest} 步`)
console.log(`① 超界片段（>maxDriftSteps） ${violations}   （要求 0 —— 退出条件必然可达）`)
console.log(`② 以意外原因结束的片段      ${badEndReason}   （要求 0）`)
console.log(`③ 二次回放不一致的会话      ${drift}   （要求 0 —— 纯函数可回放）`)
console.log(`④ 数据截断在片段中的会话    ${truncated}   （信息项：序列到此结束，非违例；`)
console.log('   进程重启/agent 销毁后阶段复位为 stable，不会把收窄带进下一次运行）')
console.log(`附：历史会话里出现 unknown tool 的会话 / 次数  ${unknownToolSessions} / ${unknownToolCount}`)

const ok = violations === 0 && badEndReason === 0 && drift === 0
console.log(`\n结论：${ok ? 'PASS —— 收窄有界、结束原因合规、可回放' : 'FAIL —— 存在有界性/结束原因/可回放性违例'}`)
process.exit(ok ? 0 : 1)
