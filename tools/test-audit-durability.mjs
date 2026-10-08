/**
 * test-audit-durability.mjs —— 审计日志的**跨挂载持久性**（2026-10-08 真实事故的回归）
 *
 * 事故：主文件 anchor-<sid>.jsonl 每次 flush 是**重写**（不是追加），而块文件序号
 * `rec.chunkIdx` 随挂载从 1 重新数。于是每次重启 DSH：
 *   · 上一轮挂载压在主文件里、还没满块的尾部缓冲被直接抹掉；
 *   · 新一轮的 chunk 1..N 覆盖上一轮的 chunk 1..N（"块文件永不重写"的前提被破）。
 * 实测证据（那天的目录）：`.jsonl.1` 是 10-08 12:30–12:54，而 `.jsonl.2` 是 09-28–10-03
 * ——序号与时间**反序**，只有"序号重启覆写"能解释；同时 12:54–14:08 那一整段审计
 * （含两次 pullback-outcome 的 closed 事件）在磁盘上完全不存在。
 *
 * 断言口径（每条都配反向对照）：
 *   · 接手：第二次挂载必须把上一轮主文件的每一行**原样保留**（含事件顺序）；
 *   · 续号：磁盘已有到 .2 ⇒ 新块必须是 .3，且 .1/.2 逐字节不变；
 *   · 反向对照：没有任何预置块时，新块仍从 .1 开始（证明"续号"不是把所有块都跳过）。
 *
 * 用法：node tools/test-audit-durability.mjs [index.js 路径]
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve, join, dirname } from 'node:path'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const here = fileURLToPath(new URL('.', import.meta.url))
const target = resolve(here, process.argv[2] || '../index.js')
const mod = await import(pathToFileURL(target).href)

let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ': ' + detail}`)
}

const root = mkdtempSync(join(tmpdir(), 'audit-dur-'))
const LOGS = join(root, 'logs')
const mainOf = (sid) => join(LOGS, `anchor-${sid}.jsonl`)
const chunkOf = (sid, n) => join(LOGS, `anchor-${sid}.jsonl.${n}`)
const linesOf = (p) => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()) : [])
const chunksOf = (sid) => readdirSync(LOGS).filter((n) => n.startsWith(`anchor-${sid}.jsonl.`)).sort()
const chunkIdxOf = (sid) => chunksOf(sid).map((n) => Number(n.slice(n.lastIndexOf('.') + 1))).sort((a, b) => a - b)

let handlers = {}
let registered = {}
const agents = new Map()
const origWarn = console.warn

/** 真实的 fs 落盘桩：fsSvc.resolve 原样返回，writeText 同步写文件。 */
const fsStub = {
  resolve: (p) => p,
  writeText: (t, text) => { mkdirSync(dirname(t), { recursive: true }); writeFileSync(t, text, 'utf8'); return Promise.resolve() },
}

async function boot(config) {
  handlers = {}
  registered = {}
  agents.clear()
  console.warn = () => {}
  const ctx = {
    get: (n) => {
      if (n === 'tools') return { register: (t) => { registered[t.name] = t; return () => {} } }
      if (n === 'agents') return { get: (id) => agents.get(id), list: () => [...agents.values()] }
      if (n === 'fs') return fsStub
      // baseDir 来自 sandboxPolicy.workspaceRoot ⇒ 审计目录 = <root>/logs
      if (n === 'sandboxPolicy') return { workspaceRoot: root }
      return undefined
    },
    on: (n, fn) => { handlers[n] = fn; return () => {} },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  }
  // 每次 boot 都是一次"新挂载"（与真实重启等价：recs/chunkIdx 全部重建）
  await mod.apply(ctx, { adaptiveStateEnabled: false, logDir: 'logs', ...config })
}
const dispatch = (name, ...args) => handlers['internal/dispatch']('x', name, args, null)
const settle = () => new Promise((r) => setTimeout(r, 10))

function adopt(sid) {
  const agent = { id: sid, session: { id: sid, events: [] }, ctx: { tools: { schemas: () => [], restrict: () => () => {} } } }
  agents.set(sid, agent)
  dispatch('agent/created', { agent })
  return { agent, session: { id: sid } }
}
const human = (text) => ({ type: 'user/message', data: { source: { kind: 'user' }, role: 'user', content: [{ type: 'text', text }] } })
const sessionEvent = (session, event) => dispatch('session/event', session, event)

// ── ① 挂载即写主文件 ───────────────────────────────────────────────────────
const SID_A = 'audit-carry'
let agentA = null
await boot({ logDir: 'logs' })
{
  const a = adopt(SID_A)
  agentA = a.agent
  sessionEvent(a.session, human('do the thing'))
  await settle()
  const before = linesOf(mainOf(SID_A))
  check('① 首次挂载就落主文件（adopted + 会话事件）', before.length >= 2, `lines=${before.length}`)
}

// ── ② 第二次挂载必须**接过**上一轮的尾部（旧实现这里直接抹掉）────────────────
{
  // 同进程里模拟"重启"：真实重启是新进程（recs 为空）。同进程必须先关掉上一轮会话
  // ——closeRec 会 recs.delete，否则第二次 adopt 命中"已跟踪"分支，什么都写不出来。
  dispatch('agent/disposed', { agent: agentA })
  await settle()
  const before = linesOf(mainOf(SID_A))
  await boot({ logDir: 'logs' })   // 等价于重启一次 DSH
  adopt(SID_A)
  await settle()
  const main = linesOf(mainOf(SID_A))
  const allFiles = chunksOf(SID_A).concat([`anchor-${SID_A}.jsonl`])
  const all = allFiles.flatMap((n) => linesOf(join(LOGS, n)))
  const kept = before.filter((l) => all.includes(l))
  check('② 上一轮的每一行都还在（没有被重写抹掉）', kept.length === before.length, `kept=${kept.length}/${before.length}`)
  check('② 上一轮尾部被**转成块文件**（时间序因此仍单调：块在前、主文件是尾）',
    chunksOf(SID_A).length >= 1 && linesOf(chunkOf(SID_A, 1)).join('\n') === before.join('\n'),
    JSON.stringify(chunksOf(SID_A)))
  check('② 承接动作本身留痕（audit-adopted + 承接条数）',
    all.some((l) => l.includes('"kind":"audit-adopted"') && l.includes(`"lines":${before.length}`)),
    all.filter((l) => l.includes('audit-adopted')).join('').slice(0, 160))
  check('② 主文件仍是"最新的尾"（承接后从空开始写本轮事件）',
    main.length >= 1 && main.some((l) => l.includes('"kind":"adopted"')) && main.length < before.length + 3,
    `main=${main.length}`)
}

// ── ③ 块序号必须从磁盘续起（否则新挂载的 chunk 1 会覆写旧块）─────────────────
const SID_B = 'audit-chunk'
{
  writeFileSync(chunkOf(SID_B, 1), 'OLD-CHUNK-1\n', 'utf8')
  writeFileSync(chunkOf(SID_B, 2), 'OLD-CHUNK-2\n', 'utf8')
  await boot({ logDir: 'logs', auditChunkEvents: 1 })  // 阈值 1 ⇒ 每条事件立刻成块
  adopt(SID_B)
  await settle()
  const chunks = chunksOf(SID_B)
  check('③ 已有 .1/.2 ⇒ 新块从 .3 起且连续（续号，不覆写）', chunkIdxOf(SID_B).slice(0, 2).join(',') === '1,2'
    && chunkIdxOf(SID_B).slice(2).every((v, i) => v === 3 + i) && chunkIdxOf(SID_B).length > 2,
    JSON.stringify(chunkIdxOf(SID_B)))
  check('③ 旧块逐字节未变', readFileSync(chunkOf(SID_B, 1), 'utf8') === 'OLD-CHUNK-1\n' && readFileSync(chunkOf(SID_B, 2), 'utf8') === 'OLD-CHUNK-2\n', '')
  const third = linesOf(chunkOf(SID_B, 3))
  check('③ 新块里是本次挂载的真实事件（不是空块）',
    third.length >= 1 && third.some((l) => l.includes('"kind":"adopted"')), JSON.stringify(third.slice(0, 2)))
}

// ── ④ 反向对照：没有任何预置块 ⇒ 仍从 .1 开始（不是无脑跳号）────────────────
const SID_C = 'audit-fresh'
{
  await boot({ logDir: 'logs', auditChunkEvents: 1 })
  adopt(SID_C)
  await settle()
  check('④ 无预置块 ⇒ 第一块就是 .1', chunksOf(SID_C)[0] === 'anchor-audit-fresh.jsonl.1', JSON.stringify(chunksOf(SID_C)))
  check('④ 反向对照：编号是 1..N 的连续序列（没有跳号、没有空号）',
    chunkIdxOf(SID_C).every((v, i) => v === i + 1), JSON.stringify(chunkIdxOf(SID_C)))
}

// ── ⑤ 反向对照：只有 .2 没有 .1 ⇒ 必须续到 .3（"取最大号"而不是"数文件个数"）───
const SID_D = 'audit-gap'
{
  writeFileSync(chunkOf(SID_D, 2), 'OLD-GAP-2\n', 'utf8')
  await boot({ logDir: 'logs', auditChunkEvents: 1 })
  adopt(SID_D)
  await settle()
  check('⑤ 只有 .2 时 ⇒ 新块是 .3（按最大号续，不是按个数）',
    chunksOf(SID_D).includes('anchor-audit-gap.jsonl.3') && readFileSync(chunkOf(SID_D, 2), 'utf8') === 'OLD-GAP-2\n',
    JSON.stringify(chunksOf(SID_D)))
}

console.warn = origWarn
try { rmSync(root, { recursive: true, force: true }) } catch { /* 清理失败不影响判定 */ }
console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
