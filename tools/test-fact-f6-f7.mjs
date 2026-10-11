/**
 * test-fact-f6-f7.mjs -- criteria second wave: F6 unsupported outcome assertion and
 * F7 evidence contradiction (docs/design-criteria-refactor.md §3, both default off).
 *
 * F6: the delivery asserts a measurable outcome but the session has ZERO verification
 * evidence. F7: the delivery claims a FULL pass (PASS=n/n) while the last verification
 * still shows failures. Both directions, one-shot semantics, pure-function flips.
 * Usage: node tools/test-fact-f6-f7.mjs [path/to/index.js]
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const here = fileURLToPath(new URL('.', import.meta.url))
const mod = await import(pathToFileURL(resolve(here, process.argv[2] || '../index.js')).href)
const { unsupportedClaim, evidenceContradiction, itemizedClaimFacts } = await import(pathToFileURL(resolve(here, 'task-anchor-core.mjs')).href)

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

const FAIL_TEXT = '[hidden] failed=21 errors=0 passed=24/45\nFAIL: test_voice_bridge\n'
const PASS_TEXT = '[hidden] failed=0 errors=0 passed=45/45\n'
const verifyCall = (turn, step) => ({ type: 'tool/call', data: { turn, step, name: 'pwsh', arguments: JSON.stringify({ command: 'python -X utf8 evaluator/run_hidden_tests.py' }) } })
const verifyResult = (turn, step, out) => ({ type: 'tool/result', data: { turn, step, message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: out }] }] } } })
const doneEvent = (turn, step, text) => ({ type: 'assistant/message', data: { turn, step, message: { content: [{ type: 'text', text: text || 'The task is done, all checks pass.' }] } } })

function makeAgent(sid) {
  const agent = { id: sid, session: { id: sid, events: [] }, ctx: { tools: { schemas: () => [], restrict: () => () => {} } } }
  agentsById.set(sid, agent)
  dispatch('agent/created', { agent })
  return { agent, session: { id: sid } }
}
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
const section = (out, name) => (out.sections || []).find((s) => s.name === name)

// ── F6 ① 默认关 ────────────────────────────────────────────────────────────
await boot({})
{
  const { session } = makeAgent('f6-off')
  sessionEvent(session, doneEvent(1, 1))
  const out = await assemble('f6-off')
  check('F6 ① 默认关：无出处段不出现', section(out, 'trajectory-anchor:unsupported-claim') === undefined, JSON.stringify((out.sections || []).map((s) => s.name)))
}

// ── F6 ② 开：零验证证据 + 宣告 ⇒ 一次性回放"断言没有出处"───────────────────
await boot({ unsupportedClaimMirror: true })
{
  const { session } = makeAgent('f6-on')
  sessionEvent(session, doneEvent(1, 1))
  const out = await assemble('f6-on')
  const sec = section(out, 'trajectory-anchor:unsupported-claim')
  const row = await summaryOf('f6-on')
  check('F6 ② 开：注入无出处段且措辞点名"没有验证证据"',
    sec !== undefined && /NO verification evidence/.test(sec.text), sec && sec.text.slice(0, 150))
  check('F6 ② 开：留审计且状态可见', row.unsupportedClaimMirror && row.unsupportedClaimMirror.served === true && row.unsupportedClaimMirror.reason === 'no-verification-evidence', JSON.stringify(row.unsupportedClaimMirror))
  const out2 = await assemble('f6-on')
  check('F6 ② 开：**只注一次**', section(out2, 'trajectory-anchor:unsupported-claim') === undefined, JSON.stringify((out2.sections || []).map((s) => s.name)))
}

// ── F6 ③ 反向：有过验证证据 ⇒ 不注（有验证但没过是 F7 的地盘）───────────────
await boot({ unsupportedClaimMirror: true })
{
  const { session } = makeAgent('f6-has')
  sessionEvent(session, verifyCall(1, 1))
  sessionEvent(session, verifyResult(1, 1, FAIL_TEXT))
  sessionEvent(session, doneEvent(1, 2))
  const out = await assemble('f6-has')
  check('F6 ③ 反向：有验证证据 ⇒ 不注', section(out, 'trajectory-anchor:unsupported-claim') === undefined, JSON.stringify((out.sections || []).map((s) => s.name)))
}

// ── F7 ④ 开：声称全过 + 最后验证带失败 ⇒ 一次性回放矛盾证据 ─────────────────
await boot({ evidenceContradictionMirror: true })
{
  const { session } = makeAgent('f7-on')
  sessionEvent(session, verifyCall(1, 1))
  sessionEvent(session, verifyResult(1, 1, FAIL_TEXT))
  sessionEvent(session, doneEvent(1, 2, 'The task is done. PASS=45/45'))
  const out = await assemble('f7-on')
  const sec = section(out, 'trajectory-anchor:evidence-contradiction')
  const row = await summaryOf('f7-on')
  check('F7 ④ 开：注入矛盾段并回放失败尾段',
    sec !== undefined && /claims a full pass/.test(sec.text) && /test_voice_bridge/.test(sec.text), sec && sec.text.slice(0, 160))
  check('F7 ④ 开：留审计且状态可见', row.evidenceContradictionMirror && row.evidenceContradictionMirror.served === true && row.evidenceContradictionMirror.reason === 'claim-perfect-but-verify-failed', JSON.stringify(row.evidenceContradictionMirror))
  const out2 = await assemble('f7-on')
  check('F7 ④ 开：**只注一次**', section(out2, 'trajectory-anchor:evidence-contradiction') === undefined, JSON.stringify((out2.sections || []).map((s) => s.name)))
}

// ── F7 ⑤ 反向：最后验证通过 ⇒ 不注 ─────────────────────────────────────────
await boot({ evidenceContradictionMirror: true })
{
  const { session } = makeAgent('f7-pass')
  sessionEvent(session, verifyCall(1, 1))
  sessionEvent(session, verifyResult(1, 1, PASS_TEXT))
  sessionEvent(session, doneEvent(1, 2, 'The task is done. PASS=45/45'))
  const out = await assemble('f7-pass')
  check('F7 ⑤ 反向：最后验证通过 ⇒ 不注', section(out, 'trajectory-anchor:evidence-contradiction') === undefined, JSON.stringify((out.sections || []).map((s) => s.name)))
}

// ── F7 ⑥ 反向：声称未满分（PASS=24/45）⇒ 不是矛盾，不注 ────────────────────
await boot({ evidenceContradictionMirror: true })
{
  const { session } = makeAgent('f7-partial')
  sessionEvent(session, verifyCall(1, 1))
  sessionEvent(session, verifyResult(1, 1, FAIL_TEXT))
  sessionEvent(session, doneEvent(1, 2, 'The task is done. PASS=24/45'))
  const out = await assemble('f7-partial')
  check('F7 ⑥ 反向：声称未满分 ⇒ 不注', section(out, 'trajectory-anchor:evidence-contradiction') === undefined, JSON.stringify((out.sections || []).map((s) => s.name)))
}

// ── F7 ⑦ 反向：没有任何验证 ⇒ 不注（F6 的地盘）─────────────────────────────
await boot({ evidenceContradictionMirror: true })
{
  const { session } = makeAgent('f7-noverify')
  sessionEvent(session, doneEvent(1, 1, 'The task is done. PASS=45/45'))
  const out = await assemble('f7-noverify')
  check('F7 ⑦ 反向：无验证证据 ⇒ 不注', section(out, 'trajectory-anchor:evidence-contradiction') === undefined, JSON.stringify((out.sections || []).map((s) => s.name)))
}

// ── F7 ⑧ 开：**文本型**全过声称（all tests pass）+ 最后验证失败 ⇒ 注（回放门加宽）──
await boot({ evidenceContradictionMirror: true })
{
  const { session } = makeAgent('f7-text')
  sessionEvent(session, verifyCall(1, 1))
  sessionEvent(session, verifyResult(1, 1, FAIL_TEXT))
  sessionEvent(session, doneEvent(1, 2, 'The task is done, all tests pass.'))
  const out = await assemble('f7-text')
  const sec = section(out, 'trajectory-anchor:evidence-contradiction')
  const row = await summaryOf('f7-text')
  check('F7 ⑧ 开：文本型全过声称 + 失败验证 ⇒ 注矛盾段',
    sec !== undefined && /claims a full pass/.test(sec.text) && /test_voice_bridge/.test(sec.text), sec && sec.text.slice(0, 160))
  check('F7 ⑧ 开：状态可见（reason=claim-perfect-but-verify-failed）', row.evidenceContradictionMirror && row.evidenceContradictionMirror.reason === 'claim-perfect-but-verify-failed', JSON.stringify(row.evidenceContradictionMirror))
}

// ── 纯函数负向对照 ──────────────────────────────────────────────────────────
{
  const claim = { turn: 1, step: 2, claimedDone: true, claimedPass: 45, claimedTotal: 45 }
  const failed = [{ turn: 1, step: 1, cmd: 'python -X utf8 evaluator/run_hidden_tests.py', failed: true, outputTail: 'FAIL: x' }]
  const base = evidenceContradiction({ claim, verifyEvidence: failed })
  check('纯函数 F7：全过声称 + 失败验证 ⇒ 矛盾', base.contradiction === true && base.reason === 'claim-perfect-but-verify-failed', JSON.stringify(base))
  const flipPassed = evidenceContradiction({ claim, verifyEvidence: [{ ...failed[0], failed: false }] })
  check('纯函数 F7：验证通过 ⇒ 翻掉', flipPassed.contradiction === false && flipPassed.reason === 'last-verify-passed', JSON.stringify(flipPassed))
  const flipPartial = evidenceContradiction({ claim: { ...claim, claimedPass: 24 }, verifyEvidence: failed })
  check('纯函数 F7：声称未满分 ⇒ 翻掉', flipPartial.contradiction === false && flipPartial.reason === 'not-claiming-perfection', JSON.stringify(flipPartial))
  const flipNoVerify = evidenceContradiction({ claim, verifyEvidence: [] })
  check('纯函数 F7：零验证 ⇒ 翻掉', flipNoVerify.contradiction === false && flipNoVerify.reason === 'no-verification-evidence', JSON.stringify(flipNoVerify))
  const textual = evidenceContradiction({ claim: { ...claim, claimedPass: null, claimedTotal: null, text: 'The task is done, all tests pass.' }, verifyEvidence: failed })
  check('纯函数 F7：文本型全过声称 ⇒ 矛盾（加宽后）', textual.contradiction === true, JSON.stringify(textual))
  const textualPassed = evidenceContradiction({ claim: { ...claim, claimedPass: null, claimedTotal: null, text: 'all tests pass' }, verifyEvidence: [{ ...failed[0], failed: false }] })
  check('纯函数 F7：文本型声称 + 验证通过 ⇒ 翻掉', textualPassed.contradiction === false && textualPassed.reason === 'last-verify-passed', JSON.stringify(textualPassed))
  const textualNeutral = evidenceContradiction({ claim: { ...claim, claimedPass: null, claimedTotal: null, text: 'some tests still fail' }, verifyEvidence: failed })
  check('纯函数 F7：文本不是全过 ⇒ 翻掉', textualNeutral.contradiction === false && textualNeutral.reason === 'not-claiming-perfection', JSON.stringify(textualNeutral))
  const f6base = unsupportedClaim({ claim, verifyEvidence: [] })
  check('纯函数 F6：零验证 + 宣告 ⇒ 无出处', f6base.unsupported === true && f6base.reason === 'no-verification-evidence', JSON.stringify(f6base))
  const f6has = unsupportedClaim({ claim, verifyEvidence: failed })
  check('纯函数 F6：有验证 ⇒ 翻掉', f6has.unsupported === false && f6has.reason === 'has-verification-evidence', JSON.stringify(f6has))
  const f6noClaim = unsupportedClaim({ claim: { ...claim, claimedDone: false, claimedPass: null }, verifyEvidence: [] })
  check('纯函数 F6：无宣告 ⇒ 翻掉', f6noClaim.unsupported === false && f6noClaim.reason === 'no-completion-claim', JSON.stringify(f6noClaim))
}

// ── F2 分项声明-证据对照（criteria 第三波）─────────────────────────────────
await boot({ itemizedClaimMirror: true })
{
  // 集成：编辑支持 + 验证输出支持 ⇒ 全绿不注；含一条无证据条目 ⇒ 注清单。
  const { session } = makeAgent('f2-ok')
  const claimText = 'The task is done.\n- Fixed the auth hashing in `gateway/auth.py`\n- Passed `test_voice_bridge`\n- Rewrote `README.md`'
  sessionEvent(session, { type: 'tool/call', data: { turn: 1, step: 1, name: 'edit', callId: 'e1', arguments: JSON.stringify({ file_path: 'workspace/project2_task/gateway/auth.py' }) } })
  sessionEvent(session, { type: 'tool/result', data: { turn: 1, step: 1, message: { source: { callId: 'e1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }] } } })
  sessionEvent(session, verifyCall(1, 2))
  sessionEvent(session, verifyResult(1, 2, FAIL_TEXT))
  sessionEvent(session, doneEvent(1, 3, claimText))
  const out = await assemble('f2-ok')
  const sec = section(out, 'trajectory-anchor:itemized-claim-gap')
  check('F2 ① 集成：编辑支持的条目不进清单，验证输出的 test 条目不进清单', sec !== undefined && /gateway\/auth\.py/.test(sec.text) === false && /test_voice_bridge/.test(sec.text) === false, sec && sec.text.slice(0, 200))
  check('F2 ① 集成：README 条目无证据 ⇒ 清单里只有它', sec !== undefined && /README/.test(sec.text), sec && sec.text.slice(0, 200))
  const row = await summaryOf('f2-ok')
  check('F2 ① 集成：审计与状态可见', row.itemizedClaimMirror && row.itemizedClaimMirror.served === true && row.itemizedClaimMirror.unsupportedCount === 1, JSON.stringify(row.itemizedClaimMirror))
  const out2 = await assemble('f2-ok')
  check('F2 ① 集成：**只注一次**', section(out2, 'trajectory-anchor:itemized-claim-gap') === undefined, JSON.stringify((out2.sections || []).map((s) => s.name)))
}
await boot({ itemizedClaimMirror: true })
{
  const { session } = makeAgent('f2-allsupported')
  const claimText = 'Done.\n- Fixed `gateway/auth.py`\n- Passed `test_voice_bridge`'
  sessionEvent(session, { type: 'tool/call', data: { turn: 1, step: 1, name: 'edit', callId: 'e1', arguments: JSON.stringify({ file_path: 'workspace/project2_task/gateway/auth.py' }) } })
  sessionEvent(session, { type: 'tool/result', data: { turn: 1, step: 1, message: { source: { callId: 'e1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }] } } })
  sessionEvent(session, verifyCall(1, 2))
  sessionEvent(session, verifyResult(1, 2, PASS_TEXT + 'test_voice_bridge passed'))
  sessionEvent(session, doneEvent(1, 3, claimText))
  const out = await assemble('f2-allsupported')
  check('F2 ② 反向：全部条目有证据 ⇒ 不注', section(out, 'trajectory-anchor:itemized-claim-gap') === undefined, JSON.stringify((out.sections || []).map((s) => s.name)))
}
await boot({ itemizedClaimMirror: false })
{
  const { session } = makeAgent('f2-off')
  sessionEvent(session, doneEvent(1, 1, 'Done.\n- Fixed `gateway/auth.py`'))
  const out = await assemble('f2-off')
  check('F2 ③ 反向：默认关 ⇒ 不注', section(out, 'trajectory-anchor:itemized-claim-gap') === undefined, JSON.stringify((out.sections || []).map((s) => s.name)))
}
{
  // 纯函数双向
  const edits = [{ turn: 1, step: 1, path: 'workspace/project2_task/gateway/auth.py', invalidates: true }]
  const verifyEvidence = [{ turn: 1, step: 2, cmd: 'python -X utf8 evaluator/run_hidden_tests.py', outputTail: 'FAIL: test_voice_bridge' }]
  const noAnchors = itemizedClaimFacts({ claimText: 'The task is done. Everything looks good.', edits, verifyEvidence })
  check('纯函数 F2：无清单式条目 ⇒ 不判（不猜）', noAnchors.fired === false && noAnchors.reason === 'no-itemized-claim', JSON.stringify(noAnchors))
  const unsupported = itemizedClaimFacts({ claimText: '- Fixed `gateway/auth.py`\n- Added `esp32/main.cpp`\n- Verified `test_voice_bridge`', edits, verifyEvidence })
  check('纯函数 F2：编辑支持的条目 + 验证支持的条目 ⇒ 只留 esp32 那条', unsupported.fired === true && unsupported.unsupported.length === 1 && /esp32/.test(unsupported.unsupported[0]), JSON.stringify(unsupported))
  const allOk = itemizedClaimFacts({ claimText: '- Fixed `gateway/auth.py`\n- Verified `test_voice_bridge`', edits, verifyEvidence })
  check('纯函数 F2：全支持 ⇒ 翻掉', allOk.fired === false && allOk.reason === 'all-items-supported', JSON.stringify(allOk))
  const noAnchorItems = itemizedClaimFacts({ claimText: '- Made everything more robust\n- Improved the architecture', edits, verifyEvidence })
  check('纯函数 F2：条目全无锚点 ⇒ 不判（不猜）', noAnchorItems.fired === false, JSON.stringify(noAnchorItems))
  const pathTailMatch = itemizedClaimFacts({ claimText: '- Fixed `gateway/auth.py`', edits: [{ turn: 1, step: 1, path: 'other/project/auth.py' }], verifyEvidence: [] })
  check('纯函数 F2：裸 basename 不假支持（other/project/auth.py ≠ gateway/auth.py）', pathTailMatch.fired === true && pathTailMatch.unsupported.length === 1, JSON.stringify(pathTailMatch))
  // ── F2-v2 收紧（§59 五族伪影各钉一条负例）────────────────────────────────
  const structured = itemizedClaimFacts({ claimText: '- `FINAL: {"byModule": {"A": {"pass": 20, "total": 20}}}`\n- `STEPS: ~13 tool calls`', edits, verifyEvidence })
  check('纯函数 F2-v2：结构化输出行（FINAL/STEPS）⇒ 不判', structured.fired === false, JSON.stringify(structured))
  const narration = itemizedClaimFacts({ claimText: '- **URL**：https://github.com/antirez/ds4（个人 fork，非正式项目）', edits, verifyEvidence })
  check('纯函数 F2-v2：事实叙述（URL 行）⇒ 不判', narration.fired === false, JSON.stringify(narration))
  const bareToken = itemizedClaimFacts({ claimText: '- 新增 `esp_wifi`、`mqtt`、`mbedtls` 依赖', edits, verifyEvidence })
  check('纯函数 F2-v2：裸 token 锚点（组件名无扩展名）⇒ 不判', bareToken.fired === false, JSON.stringify(bareToken))
  const buildClaim = itemizedClaimFacts({ claimText: '- `run_espidf_build.py` 编译成功，stdpro.bin 已产出', edits, verifyEvidence })
  check('纯函数 F2-v2：build 成功声明 ⇒ 模型外不判', buildClaim.fired === false, JSON.stringify(buildClaim))
  const probeClaim = itemizedClaimFacts({ claimText: '- `tools/run_debug_probe.py` 全部 probe:ok', edits, verifyEvidence })
  check('纯函数 F2-v2：probe 全过声明 ⇒ 模型外不判', probeClaim.fired === false, JSON.stringify(probeClaim))
  const trueGap = itemizedClaimFacts({ claimText: '- 修复了 `gateway/auth.py` 的密码哈希逻辑\n- 通过了 `test_voice_bridge`', edits: [], verifyEvidence: [] })
  check('纯函数 F2-v2：真缺口保留（动词+路径锚点、零证据）⇒ 开火', trueGap.fired === true && trueGap.unsupported.length === 2, JSON.stringify(trueGap))
  const structNote = itemizedClaimFacts({ claimText: '- `FOLLOWED_NOTE: no — NOTES.md was stale, so I fixed the docstrings too`\n- `NOTES: Ignored the note\'s claim`', edits: [], verifyEvidence: [] })
  check('纯函数 F2-v2：FOLLOWED_NOTE/NOTES 结构化行 ⇒ 不判', structNote.fired === false, JSON.stringify(structNote))
  const structStar = itemizedClaimFacts({ claimText: '- *Reconciliation:** NOTES.md\'s claim is factually false, `tests/test_all.py` still checks D', edits: [], verifyEvidence: [] })
  check('纯函数 F2-v2：*Reconciliation:* 星号前缀行 ⇒ 不判', structStar.fired === false, JSON.stringify(structStar))
  const debugProbe = itemizedClaimFacts({ claimText: '- `run_debug_probe.py` → all visible diagnostic checks passed（初始 6 项失败清零）', edits: [], verifyEvidence: [] })
  check('纯函数 F2-v2：debug_probe 全过声明（下划线词边界）⇒ 模型外不判', debugProbe.fired === false, JSON.stringify(debugProbe))
}

console.log(`\n${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
