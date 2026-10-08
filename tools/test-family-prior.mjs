/**
 * test-family-prior.mjs —— L3 第二层（族先验收缩）的机制测试
 *
 * 这一层要证明的不是"我写了收缩公式"，而是**同一个偏离在不同族里得到不同的 p**，
 * 以及**没有先验时行为与之前完全一样**（fail-safe 而非 fail-open）。
 * 每条正向都配反向对照：高基频族 ⇒ p 更大（同样的命中更不意外）；低基频族 ⇒ p 更小；
 * 族未知/未装载/先验文件坏 ⇒ 与"无先验"逐位相同。
 *
 * 用法：node tools/test-family-prior.mjs [index.js 路径]
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const here = fileURLToPath(new URL('.', import.meta.url))
const target = resolve(here, process.argv[2] || '../index.js')
const mod = await import(pathToFileURL(target).href)
const { binomialLowerP } = mod

let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ': ' + detail}`)
}

// ── ① 纯函数层：先验方向必须可判（高基频 ⇒ p 更大）────────────────────────────
{
  // 参考 100 步命中 5 次（数据基频 5%），检验窗 3 步命中 2 次
  const noPrior = binomialLowerP(2, 3, 5, 100, 0.5)
  const highFam = binomialLowerP(2, 3, 5, 100, { rate: 0.0884, strength: 20 })
  const lowFam = binomialLowerP(2, 3, 5, 100, { rate: 0.0261, strength: 20 })
  check('① 高基频族的 p 大于低基频族（同一偏离更不意外）', highFam > lowFam, JSON.stringify({ high: highFam, low: lowFam }))
  check('① 无先验时的 p 落在两者之间（先验确实在起作用，但不是压倒性）',
    noPrior > lowFam && noPrior < highFam, JSON.stringify({ no: noPrior, high: highFam, low: lowFam }))
  // 收缩的正确行为：参考段越长，族差异越小（会话自己的数据主导）
  const shortRef = Math.abs(binomialLowerP(2, 3, 1, 20, { rate: 0.0884, strength: 20 }) - binomialLowerP(2, 3, 1, 20, { rate: 0.0261, strength: 20 }))
  const longRef = Math.abs(binomialLowerP(20, 30, 10, 2000, { rate: 0.0884, strength: 20 }) - binomialLowerP(20, 30, 10, 2000, { rate: 0.0261, strength: 20 }))
  check('① 参考段越长 ⇒ 族差异越小（早借先验、晚信自己）', longRef < shortRef, JSON.stringify({ short: shortRef, long: longRef }))
  // strength 越大 ⇒ 越贴先验
  const weak = Math.abs(binomialLowerP(2, 3, 5, 100, { rate: 0.0884, strength: 1 }) - binomialLowerP(2, 3, 5, 100, { rate: 0.0261, strength: 1 }))
  const strong = Math.abs(binomialLowerP(2, 3, 5, 100, { rate: 0.0884, strength: 200 }) - binomialLowerP(2, 3, 5, 100, { rate: 0.0261, strength: 200 }))
  check('① strength 越大 ⇒ 族间差异越大', strong > weak, JSON.stringify({ weak, strong }))
  // 边界：非法先验不得产生 NaN/越界
  for (const bad of [{ rate: NaN, strength: 20 }, { rate: 1.5, strength: 20 }, { rate: -1, strength: 20 }, { rate: 0.05, strength: 0 }]) {
    const v = binomialLowerP(2, 3, 5, 100, bad)
    if (!(Number.isFinite(v) && v >= 0 && v <= 1)) { check('① 非法先验被夹紧且结果有界', false, JSON.stringify(bad)); break }
  }
  check('① 非法先验被夹紧且结果有界', [NaN, 1.5, -1].every((r) => {
    const v = binomialLowerP(2, 3, 5, 100, { rate: r, strength: 20 })
    return Number.isFinite(v) && v >= 0 && v <= 1
  }))
}

// ── ② 端到端：族键从事件流采集，先验真的进了判定 ─────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'familyprior-'))
const priorsPath = (name, families) => {
  const p = join(dir, name)
  writeFileSync(p, typeof families === 'string' ? families : JSON.stringify({ generatedAtUtc: new Date().toISOString(), families }, null, 2), 'utf8')
  return p
}
const FAM = (key, inaction, repetition, failure) => ({ key, sessions: 10, steps: 1000, baseRates: { inaction, repetition, failure } })

const TOOLS = ['pwsh', 'read', 'edit'].map((n) => ({ name: n }))
let handlers = {}
let registered = {}
const agents = new Map()
const warnings = []
const origWarn = console.warn
async function boot(config) {
  handlers = {}
  registered = {}
  agents.clear()
  warnings.length = 0
  console.warn = (...a) => warnings.push(a.join(' '))
  const ctx = {
    get: (n) => {
      if (n === 'tools') return { register: (t) => { registered[t.name] = t; return () => {} } }
      if (n === 'agents') return { get: (id) => agents.get(id), list: () => [...agents.values()] }
      return undefined
    },
    on: (n, fn) => { handlers[n] = fn; return () => {} },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  }
  await mod.apply(ctx, config)
}
const dispatch = (name, ...args) => handlers['internal/dispatch']('x', name, args, null)
const sessionEvent = (s, e) => dispatch('session/event', s, e)
const statusOf = async (sid) => (await registered.anchor_status.execute({})).rows.find((r) => r.sessionId === sid)

/**
 * 造一个会话：声明族（request/header）+ 任务范围（人类消息）+ 一段重复调用序列。
 * 注意：助手文本必须带**正标记**（"We will …"、不含 "let me"），否则会话不会晋级
 * （anchored && lifted 才有收窄），决策级断言就会假过——实测踩到。
 */
function runSession(sid, { provider, model, hits = 2, refLen = 20 }) {
  const agent = { id: sid, session: { id: sid, events: [] }, ctx: { tools: { schemas: () => TOOLS.map((t) => ({ ...t })), restrict: () => () => {} } } }
  agents.set(sid, agent)
  dispatch('agent/created', { agent })
  const session = { id: sid }
  const say = (turn, step) => ({ type: 'assistant/message', data: { turn, step, message: { content: [{ type: 'reasoning', text: 'We will inspect the repository and run the tests.' }] } } })
  sessionEvent(session, { type: 'request/header', data: { header: { config: { provider, model, maxTokens: 1000 } } }, turn: 1, step: 1 })
  sessionEvent(session, { type: 'session', data: { agentPreset: 'no-preset' } })
  sessionEvent(session, { type: 'user/message', data: { source: { kind: 'user' }, role: 'user', content: [{ type: 'text', text: 'Work only inside bugfix-a4. Run the tests (python test_calc.py).' }] } })
  let turn = 1
  let step = 0
  for (let i = 0; i < refLen; i++) {
    step += 1
    sessionEvent(session, say(turn, step))
    if (i % 5 === 0) {
      sessionEvent(session, { type: 'tool/call', data: { turn, step, name: 'pwsh', arguments: JSON.stringify({ command: 'same' }) } })
      sessionEvent(session, { type: 'tool/call', data: { turn, step, name: 'pwsh', arguments: JSON.stringify({ command: 'same' }) } })
    }
  }
  for (let i = 0; i < 3; i++) {
    step += 1
    sessionEvent(session, say(turn, step))
    if (i < hits) {
      sessionEvent(session, { type: 'tool/call', data: { turn, step, name: 'pwsh', arguments: JSON.stringify({ command: 'same' }) } })
      sessionEvent(session, { type: 'tool/call', data: { turn, step, name: 'pwsh', arguments: JSON.stringify({ command: 'same' }) } })
    }
  }
  sessionEvent(session, { type: 'turn/end', data: { turn } })
  return { agent, session }
}

// 机制测试用**拉开**的基频：真实语料的族差约 1.5–3.4 倍，落在 round2 的显示精度之下
// （实测：两端都印成 0.03 分不出来），所以这里放大到 0.4 vs 0.002 让差异可判；
// 真实数据上的效果另有 tools/family-priors.mjs --eval 专门测。
const HIGH = FAM('deepseek-official/deepseek-v4-pro @ no-preset @ bugfix-a4', 0.002, 0.4, 0.4)
const LOW = FAM('deepseek-official/deepseek-v4-pro @ no-preset @ bugfix-a4', 0.002, 0.002, 0.002)
/** α 夹在两个 p 之间：高基频族不触发、低基频族触发——决策级、不受显示精度影响。 */
const MID_ALPHA = 0.1
const DECISION_CFG = {
  rollbackEnabled: true,
  notifyEnabled: false,
  responseChannels: {
    lexicon: { enabled: false },
    repetition: { enabled: true, refMinSteps: 20, testWindow: 3, actAlpha: MID_ALPHA, notifyAlpha: 0.5, capabilityEligible: true },
  },
}

// 无先验基线
await boot({ rollbackEnabled: false, notifyEnabled: false })
let baseP = null
{
  runSession('fp-base', { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  const row = await statusOf('fp-base')
  const rep = (row.channels || []).find((c) => c.name === 'repetition')
  baseP = rep.p
  check('② 未装载先验 ⇒ 通道 prior 为 null（不收缩）', rep.prior === null, JSON.stringify(rep.prior))
  check('② 族键来自事件流并被记录', row.family && row.family.key === 'deepseek-official/deepseek-v4-pro @ no-preset @ bugfix-a4',
    JSON.stringify(row.family))
}

// 高基频族先验（**单独一份**：同族键的多个族会互相覆盖——第一版 fixture 就栽在这里，
// 于是"高基频"会话实际吃到了低基频的先验，p 完全相同）
await boot({ rollbackEnabled: false, notifyEnabled: false, familyPriorPath: priorsPath('high.json', [HIGH]) })
let highP = null
{
  runSession('fp-high', { provider: 'deepseek-official', model: 'deepseek-v4-pro', refLen: 25 })
  const row = await statusOf('fp-high')
  const rep = (row.channels || []).find((c) => c.name === 'repetition')
  highP = rep.p
  check('② 装载先验后通道带 prior 信息（rate/strength/matched）',
    rep.prior && rep.prior.strength === 20 && rep.prior.matched.includes('deepseek-v4-pro'), JSON.stringify(rep.prior))
}
// 低基频族先验（另一份文件，同一个族键）
await boot({ rollbackEnabled: false, notifyEnabled: false, familyPriorPath: priorsPath('low.json', [LOW]) })
let lowP = null
{
  runSession('fp-low', { provider: 'deepseek-official', model: 'deepseek-v4-pro', refLen: 25 })
  const row = await statusOf('fp-low')
  const rep = (row.channels || []).find((c) => c.name === 'repetition')
  lowP = rep.p
}
check('② 同一序列：高基频族的 p > 低基频族的 p（端到端）', highP > lowP, JSON.stringify({ high: highP, low: lowP, base: baseP }))
check('② 且都与无先验基线不同（先验真的进了判定）', highP !== baseP && lowP !== baseP, JSON.stringify({ base: baseP }))

// ── ②b 决策级：α 夹在两个 p 之间 ⇒ 一个族触发、另一个不触发（不受显示精度影响）──
{
  await boot({ ...DECISION_CFG, familyPriorPath: priorsPath('dec-high.json', [HIGH]) })
  runSession('fp-dec-high', { provider: 'deepseek-official', model: 'deepseek-v4-pro', refLen: 25 })
  const rowHigh = await statusOf('fp-dec-high')
  const repHigh = (rowHigh.channels || []).find((c) => c.name === 'repetition')
  await boot({ ...DECISION_CFG, familyPriorPath: priorsPath('dec-low.json', [LOW]) })
  runSession('fp-dec-low', { provider: 'deepseek-official', model: 'deepseek-v4-pro', refLen: 25 })
  const rowLow = await statusOf('fp-dec-low')
  const repLow = (rowLow.channels || []).find((c) => c.name === 'repetition')
  check('②b 低基频族在同一 α 下触发（p 更小）', repLow.p <= MID_ALPHA && rowLow.narrowedNow === true,
    JSON.stringify({ p: repLow.p, narrowed: rowLow.narrowedNow }))
  check('②b 高基频族在同一 α 下**不**触发（p 更大）', repHigh.p > MID_ALPHA && rowHigh.narrowedNow === false,
    JSON.stringify({ p: repHigh.p, narrowed: rowHigh.narrowedNow }))
  check('②b 决策差异来自族先验而不是别的（两族键相同、序列相同）',
    rowHigh.family.key === rowLow.family.key && repHigh.refLen === repLow.refLen && repHigh.observed === repLow.observed,
    JSON.stringify({ k1: rowHigh.family.key, k2: rowLow.family.key, ref: [repHigh.refLen, repLow.refLen] }))
}

// ── ③ fail-safe：未知族 / 坏文件 / 空族表 ⇒ 与无先验逐位相同 ────────────────
await boot({ rollbackEnabled: false, notifyEnabled: false, familyPriorPath: priorsPath('unknown.json', [FAM('some/other-model @ p @ s', 0.5, 0.5, 0.5)]) })
{
  runSession('fp-unknown', { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  const row = await statusOf('fp-unknown')
  const rep = (row.channels || []).find((c) => c.name === 'repetition')
  check('③ 族未知 ⇒ p 与无先验逐位相同（fail-safe）', rep.p === baseP, JSON.stringify({ got: rep.p, base: baseP }))
  check('③ 族未知时通道 prior 为 null', rep.prior === null)
}
await boot({ rollbackEnabled: false, notifyEnabled: false, familyPriorPath: priorsPath('broken.json', 'not json at all') })
{
  runSession('fp-broken', { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  const row = await statusOf('fp-broken')
  const rep = (row.channels || []).find((c) => c.name === 'repetition')
  check('③ 先验文件坏 ⇒ p 与无先验相同 + 响亮告警',
    rep.p === baseP && warnings.some((w) => /failed to load family priors/.test(w)), JSON.stringify({ p: rep.p, w: warnings.slice(0, 1) }))
}
await boot({ rollbackEnabled: false, notifyEnabled: false, familyPriorPath: priorsPath('empty.json', []) })
{
  runSession('fp-empty', { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  const row = await statusOf('fp-empty')
  const rep = (row.channels || []).find((c) => c.name === 'repetition')
  check('③ 族表为空 ⇒ 退回固定 Jeffreys + 响亮告警',
    rep.p === baseP && warnings.some((w) => /contained no usable families/.test(w)), JSON.stringify({ p: rep.p }))
}

// ── ④ 报告无损 + 顶层可见 ───────────────────────────────────────────────────
await boot({ rollbackEnabled: false, notifyEnabled: false, familyPriorPath: priorsPath('both.json', [
  HIGH,
  FAM('huoshan/ark-code-latest @ no-preset @ workspace', 0, 0.03, 0.09),   // 不同族键，才会各自入表
]) })
{
  const s = await registered.anchor_status.execute({})
  const bad = []
  const walk = (v, path) => {
    if (v === undefined) { bad.push(path); return }
    if (typeof v === 'number' && !Number.isFinite(v)) { bad.push(path); return }
    if (typeof v === 'function') { bad.push(path); return }
    if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], `${path}.${k}`)
  }
  walk(s, 'summary')
  check('④ anchor_status 可无损 JSON 序列化', bad.length === 0, bad.slice(0, 3).join(','))
  check('④ 顶层报告族先验来源与族数', s.familyPriors && s.familyPriors.families === 2, JSON.stringify(s.familyPriors))
  check('④ config 暴露 priorStrength 与路径', s.config.priorStrength === 20 && typeof s.config.familyPriorPath === 'string',
    JSON.stringify({ st: s.config.priorStrength, p: s.config.familyPriorPath }))
}

console.warn = origWarn
try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略清理失败 */ }
console.log(`\n${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
