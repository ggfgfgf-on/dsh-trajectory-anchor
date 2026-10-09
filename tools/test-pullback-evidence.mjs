/**
 * test-pullback-evidence.mjs —— L2 门禁输入（在线证据件）的**判定逻辑**测试
 *
 * 为什么需要这个套件：`analyze-pullback-outcomes.mjs` 是 L2 开门的唯一数据来源，
 * 但在此之前它只被"闭环跑一遍"和"真实日志跑一遍"碰过——它的**判定链本身没有测试**。
 * 一个判 PASS 的判定器如果写松了，没人会知道（"假阳性开门"正是本轮反复处理的那类风险）。
 *
 * 覆盖（每条正向都配反向对照）：
 *   · 两臂都有、显著、稳健 ⇒ PASS-online
 *   · 对照臂更好 / 单臂 / 会话数不足 / 留一不稳（单会话撑着）⇒ 都不许开门
 *   · **随机化分层**：多控制率合并检验为主体；但任何"足够大"（两臂各 ≥2）的分层方向相反 ⇒ 不许开门；
 *     反向对照：分层小到不参与闸门时只报出、不影响判定；多个分层方向一致时照样可以 PASS
 *   · v1 行混进来 ⇒ 排除并**报出条数**，且不影响 v2 判定
 *
 * 用法：node tools/test-pullback-evidence.mjs [analyze-pullback-outcomes.mjs 路径]
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const analyzer = resolve(here, process.argv[2] || 'analyze-pullback-outcomes.mjs')

let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ': ' + detail}`)
}

const dir = mkdtempSync(join(tmpdir(), 'pb-ev-'))
let seq = 0

/** 一条 v2 观测单元：good ⇒ verifiesAfterPullback>0（分析器的 good() 要求三项同时成立）。 */
const row = (sid, arm, good, rate, turn = 1) => ({
  schemaVersion: 2, at: 1, sessionId: sid, arm, intervened: arm === 'intervened',
  triggerIndex: turn, triggersInSession: 1, triggerTurn: turn, triggerStep: 1, reason: 'unverified',
  controlRate: rate, pullbacks: 1, controls: 0,
  verifiesAfterPullback: good ? 1 : 0, scopeViolationsAfter: 0, claimedUnverifiedAfter: false,
  family: 'test/family @ no-preset @ none', endedNarrowed: false, sawUnknownTool: false,
  finalState: { machineState: 'stable', surfacePhase: 'stable', anchored: false, lifted: false },
  sessionLevelFields: ['claimedUnverifiedAfter'],
})

function run(rows, extra = []) {
  seq += 1
  const src = join(dir, `rows-${seq}.jsonl`)
  const out = join(dir, `ev-${seq}`)
  writeFileSync(src, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  const stdout = execFileSync(process.execPath, [analyzer, src, '--out', out, ...extra], { encoding: 'utf8' })
  return { artifact: JSON.parse(readFileSync(`${out}.json`, 'utf8')), stdout }
}

// ── ① 两臂都有、显著、稳健 ⇒ PASS-online ────────────────────────────────────
{
  const rows = []
  for (let s = 1; s <= 6; s++) {
    rows.push(row(`s${s}`, 'intervened', true, 0.2, 1), row(`s${s}`, 'intervened', true, 0.2, 2), row(`s${s}`, 'control', false, 0.2, 3))
  }
  const { artifact } = run(rows)
  check('① 两臂显著且稳健 ⇒ PASS-online', artifact.verdict === 'PASS-online', `${artifact.verdict}（${artifact.verdictReason}）`)
  check('① 观测单元与会话数被如实报出', artifact.pullbacksObserved === 18 && artifact.sessionsObserved === 6,
    `${artifact.pullbacksObserved}/${artifact.sessionsObserved}`)
}
// 反向对照：对照臂更好 ⇒ FAIL（"测出来了、没用"必须被采纳）
{
  const rows = []
  for (let s = 1; s <= 6; s++) {
    rows.push(row(`s${s}`, 'intervened', false, 0.2, 1), row(`s${s}`, 'intervened', false, 0.2, 2), row(`s${s}`, 'control', true, 0.2, 3))
  }
  const { artifact } = run(rows)
  check('① 反向对照：对照臂更好 ⇒ FAIL（不是"测不出来"）',
    artifact.verdict === 'FAIL' && /并不更好/.test(artifact.verdictReason), `${artifact.verdict}（${artifact.verdictReason}）`)
}

// ── ② 单臂 / 会话数不足 ⇒ 都不许开门 ────────────────────────────────────────
{
  const rows = []
  for (let s = 1; s <= 12; s++) rows.push(row(`s${s}`, 'intervened', true, 0.2, 1))
  const { artifact } = run(rows)
  check('② 只有单臂 ⇒ INSUFFICIENT（无法估计效果）',
    artifact.verdict === 'INSUFFICIENT' && /单臂/.test(artifact.verdictReason), `${artifact.verdict}（${artifact.verdictReason}）`)
}
{
  // 12 个单元、两臂都有，但只来自 3 个会话 ⇒ 独立性不足，不许当 12 个独立样本
  const rows = []
  for (let s = 1; s <= 3; s++) for (let i = 0; i < 3; i++) rows.push(row(`s${s}`, 'intervened', true, 0.2, i + 1), row(`s${s}`, 'control', false, 0.2, i + 1))
  const { artifact } = run(rows)
  check('② 会话数 < minSessions ⇒ INSUFFICIENT（独立性在会话层）',
    artifact.verdict === 'INSUFFICIENT' && /会话数/.test(artifact.verdictReason), `${artifact.verdict}（${artifact.verdictReason}）`)
  check('② 反向对照：放宽 --min-sessions 后同一批数据即可判定（说明卡在会话数而不是别的）',
    run(rows, ['--min-sessions', '2']).artifact.verdict !== 'INSUFFICIENT', '')
}

// ── ③ 留一：单个会话撑着 ⇒ 不许开门 ─────────────────────────────────────────
{
  // 对照臂**只**出现在 A 会话里 ⇒ 去掉 A 就没有对照 ⇒ 留一最大 p=1
  const rows = []
  for (let i = 0; i < 8; i++) rows.push(row('A', 'intervened', true, 0.2, i + 1))
  for (let i = 0; i < 4; i++) rows.push(row('A', 'control', false, 0.2, i + 9))
  for (const s of ['B', 'C', 'D', 'E']) rows.push(row(s, 'intervened', true, 0.2, 1))
  const { artifact } = run(rows)
  check('③ 合并显著但"对照数据只来自一个会话" ⇒ INSUFFICIENT（留一不稳）',
    artifact.verdict === 'INSUFFICIENT' && /留一/.test(artifact.verdictReason), `${artifact.verdict}（${artifact.verdictReason}）`)
  check('③ 留一最大 p 被如实报出', artifact.sensitivity.looMaxP === 1, String(artifact.sensitivity.looMaxP))
}

// ── ④ 随机化分层：合并为主、分层为闸 ────────────────────────────────────────
{
  // 构造：率 0.2 的分层极强正向；率 0.5 的分层方向相反且**两臂各 ≥2**（参与闸门）
  const rows = []
  for (let s = 1; s <= 6; s++) {
    for (let i = 1; i <= 5; i++) rows.push(row(`s${s}`, 'intervened', true, 0.2, i))
    rows.push(row(`s${s}`, 'control', false, 0.2, 9))
  }
  for (const s of ['t1', 't2', 't3']) rows.push(row(s, 'intervened', false, 0.5, 1))
  for (const s of ['t4', 't5']) { rows.push(row(s, 'control', true, 0.5, 1), row(s, 'control', true, 0.5, 2)) }
  const { artifact } = run(rows)
  const strata = artifact.rateStrata
  check('④ 分层被报出（两组、且标出矛盾的那组）',
    strata.mixed === true && strata.perRate.length === 2 && strata.contradiction && strata.contradiction.rate === '0.5',
    JSON.stringify(strata.contradiction))
  check('④ **分层方向矛盾 ⇒ 不许开门**（即便合并检验显著）',
    artifact.verdict === 'INSUFFICIENT' && /分层/.test(artifact.verdictReason), `${artifact.verdict}（${artifact.verdictReason}）`)
  check('④ 反向对照：合并检验本身是显著的（说明拦下来的确实只有分层这一关）',
    artifact.comparison && artifact.comparison.oneSidedP <= 0.05 && artifact.comparison.effectPP > 0,
    JSON.stringify({ p: artifact.comparison?.oneSidedP, eff: artifact.comparison?.effectPP }))
}
{
  // 反向对照：两个分层方向**一致**（都正向）⇒ 分层不该成为一刀切禁令，照常 PASS
  const rows = []
  for (let s = 1; s <= 5; s++) {
    for (let i = 1; i <= 4; i++) rows.push(row(`s${s}`, 'intervened', true, 0.2, i))
    rows.push(row(`s${s}`, 'control', false, 0.2, 9))
  }
  for (let s = 6; s <= 10; s++) {
    rows.push(row(`s${s}`, 'intervened', true, 0.5, 1), row(`s${s}`, 'intervened', true, 0.5, 2), row(`s${s}`, 'control', false, 0.5, 3))
  }
  const { artifact } = run(rows)
  check('④ 反向对照：多控制率但方向一致 ⇒ 仍可 PASS-online（分层闸不是"禁止多比例"）',
    artifact.verdict === 'PASS-online' && artifact.rateStrata.mixed === true && artifact.rateStrata.contradiction === null,
    `${artifact.verdict}（${artifact.verdictReason}）`)
}
{
  // 反向对照：方向相反的分层**太小**（两臂各 1）⇒ 只报出、不参与闸门
  const rows = []
  for (let s = 1; s <= 6; s++) {
    for (let i = 1; i <= 5; i++) rows.push(row(`s${s}`, 'intervened', true, 0.2, i))
    rows.push(row(`s${s}`, 'control', false, 0.2, 9))
  }
  rows.push(row('z1', 'intervened', false, 0.9, 1), row('z1', 'control', true, 0.9, 2))
  const { artifact } = run(rows)
  const small = artifact.rateStrata.perRate.find((s) => s.rate === '0.9')
  check('④ 反向对照：小分层方向相反 ⇒ 只报出、不闸门（gate=false）',
    small && small.gating === false && small.contradicts === false, JSON.stringify(small))
  check('④ 反向对照：因此判定不受它影响', artifact.verdict === 'PASS-online', `${artifact.verdict}（${artifact.verdictReason}）`)
}

// ── ⑤ v1 行混入 ⇒ 排除并报出，不参与运算 ────────────────────────────────────
{
  const rows = []
  for (let s = 1; s <= 6; s++) {
    rows.push(row(`s${s}`, 'intervened', true, 0.2, 1), row(`s${s}`, 'intervened', true, 0.2, 2), row(`s${s}`, 'control', false, 0.2, 3))
  }
  rows.push({ sessionId: 'old1', arm: 'intervened', pullbacks: 1, controls: 1, verifiesAfterPullback: 0, scopeViolationsAfter: 0, claimedUnverifiedAfter: false })
  rows.push({ sessionId: 'old2', arm: 'control', pullbacks: 0, controls: 1, verifiesAfterPullback: 0, scopeViolationsAfter: 0, claimedUnverifiedAfter: false })
  const { artifact, stdout } = run(rows)
  check('⑤ v1 行被排除且**报出条数**', artifact.legacyIgnored === 2 && /已排除 v1 行 2 条/.test(stdout), String(artifact.legacyIgnored))
  check('⑤ v1 行不参与运算（单元数与会话数都只算 v2）',
    artifact.pullbacksObserved === 18 && artifact.sessionsObserved === 6,
    `${artifact.pullbacksObserved}/${artifact.sessionsObserved}`)
  check('⑤ 反向对照：排除 v1 之后判定仍成立', artifact.verdict === 'PASS-online', `${artifact.verdict}（${artifact.verdictReason}）`)
}

rmSync(dir, { recursive: true, force: true })
console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
