/**
 * test-ledger-semantics.mjs —— 台账定稿语义的**手算真值**单测（合成事件，期望值人工算好）
 *
 * 为什么需要它（对拍的盲区）：
 *   test-ledger-parity.mjs 比的是"运行时实时路径 vs 批量路径"——它能抓住**两者不一致**，
 *   但抓不住"两者一起错了"（例如规则被同步改坏）。而且实测发现：真实语料里每个回合都有
 *   `turn/end`，因此"跨回合推进定稿"这条分支在语料上**根本走不到**——用它做反向验证会假过。
 *   所以定稿语义必须有**手算期望**的基准用例，这是唯一能定义"什么是对的"的东西。
 *
 * 覆盖四条定稿路径（与 index.js 的 ledgerAdvanceStep / ledgerCloseTurn 一一对应）：
 *   ① 同回合后面还有步     ⇒ 中途停手 = (tools === 0)
 *   ② turn/end 收尾        ⇒ 合法收尾 = 0（**永不**判为中途停手）
 *   ③ 跨回合推进（旧格）    ⇒ 合法收尾 = 0
 *   ④ 既无后续步又无 turn/end ⇒ 不定稿，**不进序列**
 * 外加：定稿后迟到的 tool/result 必须仍能改写该格的失败位（前缀和同步）。
 *
 * 用法：node tools/test-ledger-semantics.mjs [index.js 路径]
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const here = fileURLToPath(new URL('.', import.meta.url))
const target = resolve(here, process.argv[2] || '../index.js')
const mod = await import(pathToFileURL(target).href)
const { buildLedgerFromEvents } = mod

let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ': ' + detail}`)
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const msg = (turn, step) => ({ type: 'assistant/message', data: { turn, step, message: { content: [{ type: 'reasoning', text: 'x' }] } } })
const call = (turn, step, name = 'pwsh', args = 'a') => ({ type: 'tool/call', data: { turn, step, name, arguments: args } })
const result = (turn, step, text) => ({ type: 'tool/result', data: { turn, step, message: { content: [{ type: 'tool-result', content: [{ type: 'text', text }] }] } } })
const turnEnd = (turn) => ({ type: 'turn/end', data: { turn } })

// ── ① 同回合"后面还有步" ⇒ 无工具调用即中途停手 ─────────────────────────────
{
  const ev = [msg(1, 1), call(1, 1), msg(1, 2), call(1, 2), msg(1, 3), turnEnd(1)]
  const { series, cells } = buildLedgerFromEvents(ev)
  // 步 1：有工具 ⇒ 0；步 2：有工具 ⇒ 0；步 3：末步 + turn/end ⇒ 合法收尾 0
  check('① 同回合推进：有工具步 = 0', eq(series.inaction, [0, 0, 0]), JSON.stringify(series.inaction))
  check('① turn/end 收尾的末步 = 合法收尾（不判中途停手）', series.inaction[2] === 0 && cells.length === 3, `cells=${cells.length}`)
}
{
  // 步 2 无工具调用，但同回合后面还有步 3 ⇒ 步 2 = 中途停手（1）
  const ev = [msg(1, 1), call(1, 1), msg(1, 2), msg(1, 3), call(1, 3), turnEnd(1)]
  const { series } = buildLedgerFromEvents(ev)
  check('② 同回合中间的无工具步 = 中途停手（1）', eq(series.inaction, [0, 1, 0]), JSON.stringify(series.inaction))
}

// ── ③ 跨回合推进：旧回合的未定稿格按"合法收尾"定稿 ──────────────────────────
{
  // turn 1 步 1 无工具、**没有 turn/end**；turn 2 步 1 到来 ⇒ 步 1 定为合法收尾（0）
  const ev = [msg(1, 1), msg(2, 1)]
  const { series, cells } = buildLedgerFromEvents(ev)
  check('③ 跨回合推进定稿为合法收尾（不是中途停手）', eq(series.inaction, [0]), JSON.stringify(series.inaction))
  check('③ 旧回合的格被定稿（含在序列里）', cells.length === 1, `cells=${cells.length}`)
}

// ── ④ 会话断在回合中间：既无后续步也无 turn/end ⇒ 不进序列 ───────────────────
{
  const ev = [msg(1, 1), call(1, 1), msg(1, 2)]   // 步 2 是最后一步，没有 turn/end
  const { series, cells, allCells } = buildLedgerFromEvents(ev)
  check('④ 未定稿的末步不进序列（步 2 被排除）', eq(series.inaction, [0]), JSON.stringify(series.inaction))
  check('④ 该格仍存在于全量格表（只是未定稿）', allCells.length === 2 && cells.length === 1,
    `all=${allCells.length} finalized=${cells.length}`)
}

// ── ⑤ 失败位：定稿后迟到的 tool/result 仍要改写该格（前缀和同步）────────────
{
  const ev = [msg(1, 1), call(1, 1), msg(1, 2), call(1, 2), turnEnd(1), result(1, 1, '[exit code: 1]')]
  const { series } = buildLedgerFromEvents(ev)
  // 步 1 在 turn/end 时已被定稿；随后迟到的失败结果仍须把步 1 的 failure 置 1
  check('⑤ 定稿后迟到的失败结果仍被计入（failure[0] = 1）', eq(series.failure, [1, 0]), JSON.stringify(series.failure))
  check('⑤ 该改动不串到其他格', series.failure[1] === 0 && series.inaction[0] === 0)
}

// ── ⑥ trace 的窗口/参考和必须与最终序列自洽 ──────────────────────────────────
{
  const ev = []
  for (let t = 1; t <= 4; t++) {
    ev.push(msg(t, 1), call(t, 1), msg(t, 2), t === 4 ? { type: 'noop' } : turnEnd(t))
  }
  ev.push(turnEnd(4))
  const { series, trace } = buildLedgerFromEvents(ev, { trace: true, testWindow: 3 })
  const last = trace[trace.length - 1]
  const len = series.inaction.length
  const win = series.inaction.slice(len - 3).reduce((a, b) => a + b, 0)
  const ref = series.inaction.slice(0, len - 3).reduce((a, b) => a + b, 0)
  check('⑥ trace 末态 len/refLen 与序列一致', last.len === len && last.refLen === len - 3, JSON.stringify({ len: last.len, refLen: last.refLen, series: len }))
  check('⑥ trace 末态 窗口和/参考和 与序列一致', last.win.inaction === win && last.ref.inaction === ref,
    JSON.stringify({ win: last.win.inaction, expWin: win, ref: last.ref.inaction, expRef: ref }))
}

console.log(`\n${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
