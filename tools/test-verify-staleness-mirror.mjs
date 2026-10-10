/**
 * test-verify-staleness-mirror.mjs -- the read-only "verification staleness mirror" (F5 fact).
 *
 * Theory (design doc `docs/design-criteria-refactor.md`): F5 = the agent declares done, but its
 * most recent verification ran BEFORE a later edit of the same file the verification covered.
 * The intervention mirrors the fact back: the verification command + the post-verify edit.
 *
 * Acceptance shape (same discipline as done-gap): both directions, the one-shot guarantee, the
 * lazy claim-independent path (a late verify result still arms it), and the "must not fire"
 * controls (different file / edit before verify / doc edit / no artifact binding / no claim).
 * The pure predicate `verifyStaleness` is also negative-controlled directly.
 * Usage: node tools/test-verify-staleness-mirror.mjs [path/to/index.js]
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const here = fileURLToPath(new URL('.', import.meta.url))
const mod = await import(pathToFileURL(resolve(here, process.argv[2] || '../index.js')).href)
const { verifyStaleness } = await import(pathToFileURL(resolve(here, 'task-anchor-core.mjs')).href)

let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ': ' + detail}`)
}

let handlers = {}
let registered = {}
const agentsById = new Map()
async function boot(config) {
  handlers = {}
  registered = {}
  agentsById.clear()
  const ctx = {
    get: (n) => {
      if (n === 'tools') return { register: (t) => { registered[t.name] = t; return () => {} } }
      if (n === 'agents') return { get: (id) => agentsById.get(id), list: () => [...agentsById.values()] }
      return undefined
    },
    on: (name, fn) => {
      if (name === 'system-prompt/assemble') (handlers[name] = handlers[name] || []).push(fn)
      else handlers[name] = fn
      return () => {}
    },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  }
  await mod.apply(ctx, { adaptiveStateEnabled: false, ...config })
}
const dispatch = (name, ...args) => handlers['internal/dispatch']('x', name, args, null)
const sessionEvent = (session, event) => dispatch('session/event', session, event)
const summaryOf = async (sid) => (await registered.anchor_status.execute({})).rows.find((r) => r.sessionId === sid)

const PASS_TEXT = '[hidden] failed=0 errors=0 passed=45/45\n'
const verifyCall = (turn, step, command) => ({ type: 'tool/call', data: { turn, step, name: 'pwsh', arguments: JSON.stringify({ command }) } })
const verifyResult = (turn, step, out) => ({ type: 'tool/result', data: { turn, step, message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: out }] }] } } })
const editCall = (turn, step, path) => ({ type: 'tool/call', data: { turn, step, name: 'edit', arguments: JSON.stringify({ file_path: path }) } })
const editOk = (turn, step) => ({ type: 'tool/result', data: { turn, step, message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }] } } })
const doneEvent = (turn, step) => ({ type: 'assistant/message', data: { turn, step, message: { content: [{ type: 'text', text: 'The task is done, all checks pass.' }] } } })

function makeAgent(sid) {
  const agent = { id: sid, session: { id: sid, events: [] }, ctx: { tools: { schemas: () => [], restrict: () => () => {} } } }
  agentsById.set(sid, agent)
  dispatch('agent/created', { agent })
  return { agent, session: { id: sid } }
}
// 多监听器瀑布：真实运行时同名 assemble 监听器**全部**依次运行（P1/P4 → 契约 → 缺口 →
// 越界 → 过期），next() 指向链上剩余监听器。旧的单槽 mock 只留最后一个（测试台缺陷，
// 基线 79a8fa1 上契约套件已被它"影子"成红——见 test-contract-reanchor.mjs 的同名注释）。
const assemble = (sid) => {
  const list = handlers['system-prompt/assemble'] || []
  let i = -1
  const run = (out) => {
    i += 1
    if (i >= list.length) return out
    return list[i](out, { agent: { id: sid } }, async (o) => run(o === undefined ? out : o))
  }
  return run({ sections: [], contexts: [], tools: [], variables: {} })
}
const staleSection = (out) => (out.sections || []).find((s) => s.name === 'trajectory-anchor:verify-staleness')

// ── ① 默认关 ──────────────────────────────────────────────────────────────
await boot({})
{
  const { session } = makeAgent('vs-off')
  sessionEvent(session, verifyCall(1, 1, 'python ./tests/run_hidden_tests.py'))
  sessionEvent(session, verifyResult(1, 1, PASS_TEXT))
  sessionEvent(session, editCall(1, 2, 'tests/run_hidden_tests.py'))
  sessionEvent(session, editOk(1, 2))
  sessionEvent(session, doneEvent(1, 3))
  const out = await assemble('vs-off')
  const row = await summaryOf('vs-off')
  check('① 默认关：没有过期回放段', staleSection(out) === undefined, JSON.stringify((out.sections || []).map((s) => s.name)))
  check('① 默认关：也没有 verify-staleness-mirror 审计', !(row.auditKinds || []).includes('verify-staleness-mirror'), JSON.stringify(row.auditKinds))
}

// ── ② 开：验证（全绿）后改同一文件 + 宣告 ⇒ 一次性回放"验证早于改动" ─────────
await boot({ verifyStalenessMirror: true })
{
  const { session } = makeAgent('vs-on')
  sessionEvent(session, verifyCall(1, 1, 'python ./tests/run_hidden_tests.py'))
  sessionEvent(session, verifyResult(1, 1, PASS_TEXT))
  sessionEvent(session, editCall(1, 2, 'tests/run_hidden_tests.py'))
  sessionEvent(session, editOk(1, 2))
  sessionEvent(session, doneEvent(1, 3))
  const out = await assemble('vs-on')
  const sec = staleSection(out)
  const row = await summaryOf('vs-on')
  check('② 开：组装里有过期回放段', sec !== undefined, JSON.stringify((out.sections || []).map((s) => s.name)))
  check('② 开：回放的是**验证命令**与**事后编辑**（即使验证当时全绿）',
    sec && /run_hidden_tests\.py/.test(sec.text) && /turn 1#1/.test(sec.text) && /turn 1#2/.test(sec.text), sec && sec.text.slice(0, 200))
  check('② 开：留审计且状态可见（via=claim，served）',
    Array.isArray(row.auditKinds) && row.auditKinds.includes('verify-staleness-mirror') && row.verifyStalenessMirror && row.verifyStalenessMirror.served === true && row.verifyStalenessMirror.via === 'claim',
    JSON.stringify(row.verifyStalenessMirror))
  const out2 = await assemble('vs-on')
  check('② 开：**只注入一次**', staleSection(out2) === undefined, JSON.stringify((out2.sections || []).map((s) => s.name)))
}

// ── ③ 反向：改的是**别的文件** ⇒ 绑定不上，不注入 ───────────────────────────
await boot({ verifyStalenessMirror: true })
{
  const { session } = makeAgent('vs-other')
  sessionEvent(session, verifyCall(1, 1, 'python ./tests/run_hidden_tests.py'))
  sessionEvent(session, verifyResult(1, 1, PASS_TEXT))
  sessionEvent(session, editCall(1, 2, 'tests/other.py'))
  sessionEvent(session, editOk(1, 2))
  sessionEvent(session, doneEvent(1, 3))
  const out = await assemble('vs-other')
  check('③ 反向：改别的文件不注入', staleSection(out) === undefined, JSON.stringify((out.sections || []).map((s) => s.name)))
}

// ── ④ 反向：编辑**早于**验证 ⇒ 验证仍是新的，不注入 ─────────────────────────
await boot({ verifyStalenessMirror: true })
{
  const { session } = makeAgent('vs-before')
  sessionEvent(session, editCall(1, 1, 'tests/run_hidden_tests.py'))
  sessionEvent(session, editOk(1, 1))
  sessionEvent(session, verifyCall(1, 2, 'python ./tests/run_hidden_tests.py'))
  sessionEvent(session, verifyResult(1, 2, PASS_TEXT))
  sessionEvent(session, doneEvent(1, 3))
  const out = await assemble('vs-before')
  check('④ 反向：编辑早于验证不注入', staleSection(out) === undefined, JSON.stringify((out.sections || []).map((s) => s.name)))
}

// ── ⑤ 反向：改的是文档 ⇒ 不作废验证，不注入 ────────────────────────────────
await boot({ verifyStalenessMirror: true })
{
  const { session } = makeAgent('vs-doc')
  sessionEvent(session, verifyCall(1, 1, 'python ./tests/run_hidden_tests.py'))
  sessionEvent(session, verifyResult(1, 1, PASS_TEXT))
  sessionEvent(session, editCall(1, 2, 'README.md'))
  sessionEvent(session, editOk(1, 2))
  sessionEvent(session, doneEvent(1, 3))
  const out = await assemble('vs-doc')
  check('⑤ 反向：文档编辑不注入', staleSection(out) === undefined, JSON.stringify((out.sections || []).map((s) => s.name)))
}

// ── ⑥ 反向：验证命令认不出工件（裸 npm test）⇒ 绑定不上，不注入 ─────────────
await boot({ verifyStalenessMirror: true })
{
  const { session } = makeAgent('vs-bare')
  sessionEvent(session, verifyCall(1, 1, 'npm test'))
  sessionEvent(session, verifyResult(1, 1, PASS_TEXT))
  sessionEvent(session, editCall(1, 2, 'tests/run_hidden_tests.py'))
  sessionEvent(session, editOk(1, 2))
  sessionEvent(session, doneEvent(1, 3))
  const out = await assemble('vs-bare')
  check('⑥ 反向：裸验证命令绑定不上，不注入', staleSection(out) === undefined, JSON.stringify((out.sections || []).map((s) => s.name)))
}

// ── ⑦ 反向：有验证有编辑但没有宣告 ⇒ 不注入 ────────────────────────────────
await boot({ verifyStalenessMirror: true })
{
  const { session } = makeAgent('vs-noclaim')
  sessionEvent(session, verifyCall(1, 1, 'python ./tests/run_hidden_tests.py'))
  sessionEvent(session, verifyResult(1, 1, PASS_TEXT))
  sessionEvent(session, editCall(1, 2, 'tests/run_hidden_tests.py'))
  sessionEvent(session, editOk(1, 2))
  const out = await assemble('vs-noclaim')
  check('⑦ 反向：无宣告不注入', staleSection(out) === undefined, JSON.stringify((out.sections || []).map((s) => s.name)))
}

// ── ⑧ 惰性：验证结果**晚于**宣告到达 ⇒ 下一次组装补判并回放 ──────────────────
await boot({ verifyStalenessMirror: true })
{
  const { session } = makeAgent('vs-late')
  sessionEvent(session, verifyCall(1, 1, 'python ./tests/run_hidden_tests.py'))
  sessionEvent(session, doneEvent(1, 2))
  sessionEvent(session, editCall(1, 3, 'tests/run_hidden_tests.py'))
  sessionEvent(session, editOk(1, 3))
  sessionEvent(session, verifyResult(1, 1, PASS_TEXT))   // 结果迟到：宣告与编辑都已在它之前
  const out = await assemble('vs-late')
  const sec = staleSection(out)
  const row = await summaryOf('vs-late')
  check('⑧ 惰性：迟到结果也触发（via=post-claim-assemble）', sec !== undefined && /run_hidden_tests\.py/.test(sec.text), JSON.stringify((out.sections || []).map((s) => s.name)))
  check('⑧ 惰性：状态写明补判路径', row.verifyStalenessMirror && row.verifyStalenessMirror.via === 'post-claim-assemble', JSON.stringify(row.verifyStalenessMirror))
}

// ── ⑨ 纯函数对照（负向验证：改一个必要条件必须翻掉判定）──────────────────
// 绑定规则（回放门 §8 门 2 收紧后）：文件=验证命令里的代码类文件路径（编辑同一文件才绑定）；
// 目录=cd 目标**等于或位于**声明范围之内（cd 到范围之上/之外不绑定）。
{
  const claim = { turn: 1, step: 3, claimedDone: true, claimedPass: null }
  const verifyEvidence = [{ turn: 1, step: 1, cmd: 'python ./tests/run_hidden_tests.py', failed: false }]
  const edits = [{ turn: 1, step: 2, path: 'tests/run_hidden_tests.py', invalidates: true }]
  const base = verifyStaleness({ claim, verifyEvidence, edits })
  check('⑨ 纯函数：真过期 ⇒ stale=true 且证据齐全', base.stale === true && base.evidence && base.evidence.editPath === 'tests/run_hidden_tests.py', JSON.stringify(base))
  const flipClaim = verifyStaleness({ claim: { ...claim, claimedDone: false }, verifyEvidence, edits })
  check('⑨ 反向：无宣告 ⇒ 翻掉', flipClaim.stale === false && flipClaim.reason === 'no-completion-claim', JSON.stringify(flipClaim))
  const flipEdits = verifyStaleness({ claim, verifyEvidence, edits: [{ ...edits[0], invalidates: false }] })
  check('⑨ 反向：文档类改动 ⇒ 翻掉', flipEdits.stale === false && flipEdits.reason === 'fresh', JSON.stringify(flipEdits))
  const flipBinding = verifyStaleness({ claim, verifyEvidence: [{ ...verifyEvidence[0], cmd: 'npm test' }], edits })
  check('⑨ 反向：认不出被验证工件 ⇒ 翻掉', flipBinding.stale === false && flipBinding.reason === 'no-artifact-binding', JSON.stringify(flipBinding))
  const flipOrder = verifyStaleness({ claim, verifyEvidence: [{ ...verifyEvidence[0], turn: 1, step: 4 }], edits })
  check('⑨ 反向：验证晚于宣告 ⇒ 翻掉', flipOrder.stale === false && flipOrder.reason === 'no-verify-before-claim', JSON.stringify(flipOrder))
  const dotPath = verifyStaleness({ claim, verifyEvidence: [{ ...verifyEvidence[0], cmd: './tests/run_hidden_tests.py' }], edits })
  check('⑨ 正向：`./` 前缀与不带前缀的同一文件视为同一工件', dotPath.stale === true, JSON.stringify(dotPath))
  const dirBind = verifyStaleness({
    claim,
    verifyEvidence: [{ turn: 1, step: 1, cmd: 'cd "D:/proj/ws"; python tests/run_public_tests.py', failed: false }],
    edits: [{ turn: 1, step: 2, path: 'D:/proj/ws/gateway/auth.py', invalidates: true }],
    scopeDirs: ['D:/proj/ws'],
  })
  check('⑨ 正向：cd 目标==声明范围 ⇒ 目录绑定成立（范围内编辑 ⇒ 过期）', dirBind.stale === true, JSON.stringify(dirBind))
  const dirOutOfScope = verifyStaleness({
    claim,
    verifyEvidence: [{ turn: 1, step: 1, cmd: 'Set-Location D:\\proj; .\\.venv\\python.exe tests\\run_public_tests.py', failed: false }],
    edits: [{ turn: 1, step: 2, path: 'D:/proj/_tmp_verify.py', invalidates: true }],
    scopeDirs: ['D:/proj/ws'],
  })
  check('⑨ 反向：cd 目标是范围**之外**（父目录）⇒ 不绑定（回放门假阳形态）', dirOutOfScope.stale === false && dirOutOfScope.reason === 'no-artifact-binding', JSON.stringify(dirOutOfScope))
  const tmpAdjacent = verifyStaleness({
    claim,
    verifyEvidence: [{ turn: 1, step: 1, cmd: 'cd "D:/proj/ws"; python tests/run_public_tests.py', failed: false }],
    edits: [{ turn: 1, step: 2, path: 'D:/proj/_tmp_verify.py', invalidates: true }],
    scopeDirs: ['D:/proj/ws'],
  })
  check('⑨ 反向：临时脚本在范围目录**旁边**（不在其内）⇒ 不绑定', tmpAdjacent.stale === false && tmpAdjacent.reason === 'fresh', JSON.stringify(tmpAdjacent))
}

// ── ⑩ 跨镜像：同一会话越界 + 过期都开火 ⇒ 两个段都注入（不短路）──────────
await boot({ scopeBreachMirror: true, verifyStalenessMirror: true })
{
  const { session } = makeAgent('vs-both')
  sessionEvent(session, { type: 'user/message', data: { source: { kind: 'user' }, turn: 1, step: 1, content: [{ type: 'text', text: 'Work only inside `bugfix-a1` directory. Verify with python ./tests/run_hidden_tests.py' }] } })
  sessionEvent(session, verifyCall(1, 2, 'python ./tests/run_hidden_tests.py'))
  sessionEvent(session, verifyResult(1, 2, PASS_TEXT))
  sessionEvent(session, editCall(1, 3, 'tests/run_hidden_tests.py'))
  sessionEvent(session, editOk(1, 3))
  sessionEvent(session, editCall(1, 4, 'D:/elsewhere/extra.py', 'c9'))
  sessionEvent(session, editOk(1, 4, 'c9'))
  sessionEvent(session, doneEvent(1, 5))
  const out = await assemble('vs-both')
  const names = (out.sections || []).map((s) => s.name)
  check('⑩ 跨镜像：越界段与过期段**都**注入（链不短路）',
    names.includes('trajectory-anchor:scope-breach') && names.includes('trajectory-anchor:verify-staleness'), JSON.stringify(names))
  const row = await summaryOf('vs-both')
  check('⑩ 跨镜像：两个标记都 served=true',
    row.scopeBreachMirror && row.scopeBreachMirror.served === true && row.verifyStalenessMirror && row.verifyStalenessMirror.served === true,
    JSON.stringify({ sb: row.scopeBreachMirror, vs: row.verifyStalenessMirror }))
}

// ── ⑪ 反向：写/读工具的参数里带着测试命令 ⇒ 不算验证（回放门假阳形态）────────
await boot({ verifyStalenessMirror: true })
{
  const { session } = makeAgent('vs-editargs')
  // edit 的 new_string 含 "python -X utf8 tests/test_all.py"——旧实现把它当验证，
  // 证据 cmd 变成一坨参数 JSON，随后对同一文件的编辑被误判"验证后改动"（本会话实测假阳）。
  sessionEvent(session, { type: 'tool/call', data: { turn: 1, step: 1, name: 'edit', callId: 'c1', arguments: JSON.stringify({ file_path: 'tests/test_all.py', new_string: '    python -X utf8 tests/test_all.py', old_string: '    python tests/test_all.py' }) } })
  sessionEvent(session, { type: 'tool/result', data: { turn: 1, step: 1, message: { source: { callId: 'c1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }] } } })
  sessionEvent(session, doneEvent(1, 2))
  const out = await assemble('vs-editargs')
  const row = await summaryOf('vs-editargs')
  check('⑪ 反向：编辑参数里的测试命令不算验证 ⇒ 不注入',
    staleSection(out) === undefined && (row.evidence.verifyEvidence === 0), JSON.stringify({ v: row.evidence, sections: (out.sections || []).map((s) => s.name) }))
}

console.log(`\n${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
