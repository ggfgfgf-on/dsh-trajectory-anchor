/**
 * test-ledger-parity.mjs —— "离线标定 = 在线判定"的**逐步对拍**（真实 + 合成事件流驱动真实 apply）
 *
 * 由来（2026-10 实测）：tools/behaviour-channel-core.mjs 曾自带一套台账定稿规则，
 * 与运行时不一致——它把"回合末步（合法的无工具收尾）"也记成 A′ 命中。后果：
 *     128 个会话里 123 个序列不同；A′ 命中率 运行时 0.16% 对 离线 8.10%（差 51 倍）
 * 于是 B2 反解出来的 α 是给一条**运行时不存在**的通道算的。文字上说"两处同源"没有用，
 * 必须有断言；而这个断言唯一可靠的形式是**把同一批事件喂进真实运行时，逐步比对**。
 *
 * 两类输入，缺一不可：
 *   · **真实会话**（从日志解码）——覆盖真实事件顺序、真实并发形态；
 *   · **合成事件流**——覆盖真实语料里**走不到**的分支。实测教训：真实语料每个回回合都有
 *     `turn/end`，于是"跨回合推进定稿"这条分支永远不被执行，只跑真实语料时把该分支改坏
 *     也能全过（假过）。合成流把该分支逼出来。
 *
 * 反向验证（工具链）：
 *   node tools/test-ledger-semantics.mjs <改坏的副本>      —— 手算真值兜底
 *   node tools/test-ledger-parity.mjs --sessions=1 <副本>  —— 一致性兜底
 *   两份副本生成方式见 D:\DSHwork\scratch\inv-neg-b3\。
 *
 * 用法：node tools/test-ledger-parity.mjs [会话目录] [--sessions=N] [index.js 路径]
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve, basename, join } from 'node:path'
import { statSync } from 'node:fs'
import { decodeSessionLog, walk } from './session-log-core.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const args = process.argv.slice(2)
const idxArg = args.find((a) => a.endsWith('.js'))
const indexPath = resolve(here, idxArg || '../index.js')
const sessionDir = resolve(args.find((a) => !a.startsWith('--') && !a.endsWith('.js')) || 'C:\\Users\\chesand\\.dsh\\sessions')
const maxSessions = Number((args.find((a) => a.startsWith('--sessions=')) || '').split('=')[1] || 3)
const TEST_WINDOW = 3
const REF_MIN = 3
const MAX_CMP = 300

const mod = await import(pathToFileURL(indexPath).href)
const { buildLedgerFromEvents } = mod

const TOOLS = ['pwsh', 'read', 'edit'].map((n) => ({ name: n }))
let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ': ' + detail}`)
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const hasText = (event) => {
  const blocks = event && event.data && event.data.message && event.data.message.content
  if (!Array.isArray(blocks)) return false
  return blocks.some((b) => b && (b.type === 'reasoning' || b.type === 'text') && typeof b.text === 'string' && b.text.length > 0)
}

/**
 * 把一段事件流按序喂进一个**全新的**插件实例，并在每个"运行时会重算的画面"上
 * 与批量台账（buildLedgerFromEvents 的 trace）逐步比对。
 */
async function patrol(name, events, opts = {}) {
  const sampleAll = opts.sampleAll === true
  let handlers = {}
  let registered = {}
  const agents = new Map()
  const origWarn = console.warn
  console.warn = () => {}
  const ctx = {
    get: (n) => {
      if (n === 'tools') return { register: (t) => { registered[t.name] = t; return () => {} } }
      if (n === 'agents') return { get: (id) => agents.get(id), list: () => [...agents.values()] }
      return undefined
    },
    on: (n, fn) => { handlers[n] = fn; return () => {} },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  }
  await mod.apply(ctx, {
    rollbackEnabled: false,
    notifyEnabled: false,
    historyCap: 1000000,
    refMinSteps: REF_MIN,
    testWindow: TEST_WINDOW,
    responseChannels: {
      inaction: { enabled: true, refMinSteps: REF_MIN, testWindow: TEST_WINDOW, capabilityEligible: true },
      repetition: { enabled: true, refMinSteps: REF_MIN, testWindow: TEST_WINDOW, capabilityEligible: true, window: 5, minRepeats: 2 },
      failure: { enabled: true, refMinSteps: REF_MIN, testWindow: TEST_WINDOW, capabilityEligible: true },
      lexicon: { enabled: true, refMinSteps: REF_MIN, testWindow: TEST_WINDOW, capabilityEligible: false },
    },
  })
  const sid = name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)
  const agent = { id: sid, session: { id: sid, events: [] }, ctx: { tools: { schemas: () => TOOLS.map((t) => ({ ...t })), restrict: () => () => {} } } }
  agents.set(sid, agent)
  handlers['internal/dispatch']('x', 'agent/created', [{ agent }], null)
  const session = { id: sid }
  const statusOf = async () => (await registered.anchor_status.execute({})).rows.find((r) => r.sessionId === sid)

  const built = buildLedgerFromEvents(events, { repetitionWindow: 5, minRepeats: 2, trace: true, testWindow: TEST_WINDOW })
  const trace = built.trace
  const allCellsLen = built.allCells.length
  const decisionIdx = []
  for (let i = 0; i < events.length; i++) if (events[i].type === 'assistant/message' && hasText(events[i])) decisionIdx.push(i)
  const sampled = new Set()
  if (sampleAll || decisionIdx.length <= MAX_CMP) {
    for (const i of decisionIdx) sampled.add(i)
  } else {
    const stride = Math.floor(decisionIdx.length / MAX_CMP)
    for (let k = 0; k < decisionIdx.length; k += stride) sampled.add(decisionIdx[k])
    sampled.add(decisionIdx[decisionIdx.length - 1])
  }
  const mismatches = []
  let checked = 0
  let ledgerMismatches = 0
  for (let i = 0; i < events.length; i++) {
    handlers['internal/dispatch']('x', 'session/event', [session, events[i]], null)
    if (!sampled.has(i)) continue
    const exp = trace[i]
    const row = await statusOf()
    if (!row) { mismatches.push({ at: i, why: 'row missing' }); continue }
    checked++
    if (Number.isFinite(row.ledgerSize) && exp && row.ledgerSize < exp.len) {
      ledgerMismatches++
      if (ledgerMismatches <= 3) mismatches.push({ at: i, why: `ledgerSize run=${row.ledgerSize} < 已定稿 ${exp.len}` })
    }
    if (!exp) { mismatches.push({ at: i, why: 'no trace entry' }); continue }
    for (const nm of ['inaction', 'repetition', 'failure']) {
      const got = (row.channels || []).find((c) => c.name === nm) || {}
      if (got.refLen !== exp.refLen) {
        mismatches.push({ at: i, why: `${nm} refLen run=${got.refLen} exp=${exp.refLen}` })
        continue
      }
      if (exp.refLen >= 1 && (got.observed !== exp.win[nm] || got.refHits !== exp.ref[nm])) {
        mismatches.push({ at: i, why: `${nm} run(o=${got.observed},r=${got.refHits}) exp(o=${exp.win[nm]},r=${exp.ref[nm]})` })
      }
    }
    if (mismatches.length > 6) break
  }
  console.warn = origWarn
  console.log(`── ${name}: 比对 ${checked}/${decisionIdx.length} 个决策点（事件 ${events.length}，定稿 ${allCellsLen} 格）`)
  check(`${name}：逐步通道快照一致（observed/refHits/refLen）`, mismatches.length === 0,
    mismatches.slice(0, 3).map((m) => `@${m.at} ${m.why}`).join(' | '))
  check(`${name}：ledgerSize 每一步不少于已定稿格数`, ledgerMismatches === 0, `不一致 ${ledgerMismatches} 次`)
  return { trace, allCellsLen }
}

// ══ 合成事件流：把真实语料走不到的分支逼出来 ═══════════════════════════════
const msg = (turn, step, text = 'x') => ({ type: 'assistant/message', data: { turn, step, message: { content: [{ type: 'reasoning', text }] } } })
const call = (turn, step, name = 'pwsh', a = 'a') => ({ type: 'tool/call', data: { turn, step, name, arguments: a } })
const result = (turn, step, text) => ({ type: 'tool/result', data: { turn, step, message: { content: [{ type: 'tool-result', content: [{ type: 'text', text }] }] } } })
const turnEnd = (turn) => ({ type: 'turn/end', data: { turn } })

console.log(`[parity] index.js = ${indexPath}\n[parity] 合成事件流（真实语料覆盖不到的分支）`)
// 注意：合成流必须**长到 refLen ≥ 1**，否则通道快照里 observed/refHits 都是 null，
// 信号值的差异在快照里根本看不见——第一版合成流只有 3 个事件，因此"跨回合定稿"改坏
// 也能全过（假过）。这是实测踩到并修掉的坑。
const synthTurnEnd = []
for (let t = 1; t <= 4; t++) synthTurnEnd.push(msg(t, 1), call(t, 1), msg(t, 2), turnEnd(t))
await patrol('合成-回合末步排除', synthTurnEnd, { sampleAll: true })

const synthCrossTurn = []
for (let t = 1; t <= 4; t++) synthCrossTurn.push(msg(t, 1), msg(t, 2))   // 全程没有 turn/end
synthCrossTurn.push(msg(5, 1))                                          // 逼出"跨回合推进定稿"
await patrol('合成-跨回合推进定稿', synthCrossTurn, { sampleAll: true })

const synthAbandon = []
for (let t = 1; t <= 3; t++) synthAbandon.push(msg(t, 1), call(t, 1), msg(t, 2))
synthAbandon.push(msg(4, 1))                                            // 末格（3#2）永不 backfill
await patrol('合成-断在回合中间（未定稿排除）', synthAbandon, { sampleAll: true })

const synthRepFail = []
for (let t = 1; t <= 4; t++) {
  synthRepFail.push(msg(t, 1), call(t, 1, 'pwsh', 'same'), result(t, 1, t % 2 === 0 ? '[exit code: 1]' : 'ok'), msg(t, 2), call(t, 2, 'pwsh', 'same'), msg(t, 3), turnEnd(t))
}
await patrol('合成-重复与失败', synthRepFail, { sampleAll: true })

// ══ 真实会话（按文件大小挑中等规模，避免把 67 万行的日志全解码）════════════
const LEDGER_TYPES = new Set(['tool/call', 'tool/result', 'turn/end', 'assistant/message'])
const files = walk(sessionDir, []).filter((f) => f.endsWith('session.jsonl.zstd'))
const sized = files.map((f) => ({ f, bytes: statSync(f).size }))
  .filter((x) => x.bytes >= 150_000 && x.bytes <= 4_000_000)
  .sort((a, b) => b.bytes - a.bytes)
const picked = []
for (const cand of sized) {
  if (picked.length >= maxSessions) break
  let text
  try { text = decodeSessionLog(cand.f) } catch { continue }
  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch { /* 坏行 */ }
  }
  const relevant = events.filter((e) => LEDGER_TYPES.has(e.type))
  if (relevant.length < 80) continue
  picked.push({ f: cand.f, relevant })
}
console.log(`\n[parity] 真实语料 ${files.length} 个会话；取 ${picked.length} 个中等会话（150KB–4MB）`)
for (const p of picked) await patrol(basename(join(p.f, '..')).slice(0, 12), p.relevant)

console.log(`\n${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
