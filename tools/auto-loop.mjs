/**
 * auto-loop.mjs —— L4 全自动闭环：一条命令，从语料走到"可发布的产物 + 门禁结论"
 *
 * 依次做四件事，任一步失败就**拒绝发布**（这才是"自门禁"的含义）：
 *   ① 自产族先验   family-priors.mjs      → familyPriors.json
 *   ② 自产标定件   calibrate-channels.mjs → responsePolicy.json（带先验重解 α，两套 α 一起写）
 *   ③ 自门禁       不变量 + 全部测试套件   → 任一失败即中止
 *   ④ 自产证据     analyze-pullback-outcomes.mjs（有 outcome 日志时）→ pullbackEvidence.json
 *
 * 为什么需要它："离线合格 ≠ 线上合格"这条我们已经吃过亏；让产物、判定与门禁**每次都由同一条
 * 命令重新算出**，才能避免"某次手改的产物没人再审"。命令本身不修改出厂默认（默认仍是全关）。
 *
 * 用法：
 *   node tools/auto-loop.mjs [--sessions <dir>] [--outcomes <jsonl>] [--no-tests] [--budget 0.05]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, copyFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = resolve(here, '..')
const args = process.argv.slice(2)
const val = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt)
const sessionsDir = val('--sessions', process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.dsh\\sessions` : '.')
const outcomes = val('--outcomes', '')
const budget = val('--budget', '0.05')
const runTests = !args.includes('--no-tests')

const step = (n, title) => console.log(`\n${'='.repeat(3)} 步骤 ${n}：${title}`)
const run = (cmd, argv) => {
  const r = spawnSync(cmd, argv, { stdio: 'inherit', cwd: bundle, shell: false })
  return r.status === 0
}

let ok = true
const results = []

// ① 族先验
step(1, '自产族先验（family-priors.mjs）')
{
  const pass = run(process.execPath, [join(here, 'family-priors.mjs'), '--eval', '--sessions', sessionsDir, '--out', join(bundle, 'familyPriors')])
  results.push(['family priors', pass])
  ok = ok && pass
}

// ② 标定件（带先验重解 α；两套 α 都写进产物）
step(2, '自产标定件（calibrate-channels.mjs --priors）')
{
  const argv = [join(here, 'calibrate-channels.mjs'), '--priors', join(bundle, 'familyPriors.json'), '--sessions', sessionsDir, '--budget', budget, '--out', join(bundle, 'responsePolicy')]
  const recall = join(bundle, 'recallReport.json')
  if (existsSync(recall)) argv.push('--recall', recall)
  const r = spawnSync(process.execPath, argv, { stdio: 'inherit', cwd: bundle })
  // 标定器在"无通道合格"时以 2 退出——那**不是**失败，而是合法结论（FAIL 也是结论）。
  const pass = r.status === 0 || r.status === 2
  results.push(['calibration artifact', pass, r.status === 2 ? 'verdict=FAIL（合法结论）' : 'verdict=PASS/PARTIAL'])
  ok = ok && pass
}

// ③ 自门禁：不变量 + 全部测试
step(3, '自门禁：不变量 + 全部测试套件')
if (!runTests) {
  console.log('  （--no-tests：跳过）')
} else {
  const suites = [
    'check-invariants.mjs', 'test-runtime-lexicon.mjs', 'test-anchor-contract.mjs', 'test-response-policy.mjs',
    'test-policy-gate.mjs', 'test-pullback.mjs', 'test-reanchor.mjs', 'test-family-prior.mjs',
    'test-outcome-feedback.mjs', 'test-drift-label.mjs', 'test-task-anchor.mjs',
    'test-ledger-semantics.mjs', 'test-ledger-parity.mjs', 'replay-interventions.mjs',
  ]
  for (const s of suites) {
    const r = spawnSync(process.execPath, [join(here, s)], { cwd: bundle, encoding: 'utf8' })
    const line = (r.stdout || '').trim().split('\n').pop() || ''
    const pass = r.status === 0
    results.push([s, pass, line.slice(0, 80)])
    console.log(`  ${pass ? 'OK  ' : 'FAIL'} ${s.padEnd(30)} ${line.slice(0, 70)}`)
    ok = ok && pass
  }
}

// ④ 在线证据（有 outcome 日志才做；没有就是 INSUFFICIENT，属正常）
step(4, '自产在线证据（analyze-pullback-outcomes.mjs）')
{
  const src = outcomes || join(bundle, '.dsh-trajectory-logs', 'pullback-outcomes.jsonl')
  if (!existsSync(src)) {
    console.log(`  没有 outcome 日志（${src}）⇒ 证据保持 INSUFFICIENT（重锚定不开门，属正常状态）`)
    results.push(['online evidence', true, 'no data (INSUFFICIENT by design)'])
  } else {
    const pass = run(process.execPath, [join(here, 'analyze-pullback-outcomes.mjs'), src, '--out', join(bundle, 'pullbackEvidence')])
    results.push(['online evidence', pass])
    ok = ok && pass
  }
}

// ── 结论与清单 ──────────────────────────────────────────────────────────────
step(5, '结论')
console.log('  产物：')
for (const f of ['familyPriors.json', 'responsePolicy.json', 'pullbackEvidence.json']) {
  const p = join(bundle, f)
  if (!existsSync(p)) { console.log(`    ${f.padEnd(24)} 不存在（未生成/未到条件）`); continue }
  let hint = ''
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'))
    if (j.verdict) hint = `verdict=${j.verdict}`
    if (j.capabilityEligibleChannels) hint += ` eligible=[${j.capabilityEligibleChannels.join(',')}]`
    if (j.families) hint += ` families=${j.families.length}`
  } catch { hint = '(解析失败)' }
  console.log(`    ${f.padEnd(24)} ${hint}`)
}
console.log('\n  上线检查表（每一步都要求先有证据；默认全关是**设计**而不是未完成）：')
console.log('    1) 观察期：三个开关保持 false，先攒 pullback-outcomes 数据')
console.log('    2) L1：pullbackEnabled=true（建议式近因提醒，风险最低）——它自己会写效果日志')
console.log('    3) L4 对照：pullbackControlRate=0.2~0.3 跑一轮，拿到两条臂')
console.log('    4) 跑本脚本步骤 4 ⇒ 只有 verdict=PASS-online 才能继续')
console.log('    5) L2：reanchorEnabled=true + reanchorEvidencePath 指向证据件（先轻后重由代码保证）')
console.log('    6) L3：familyPriorPath 指向先验件（α 会自动切到 derivedWithFamilyPrior）；')
console.log('           outcomeFeedbackEnabled=true 打开结局回灌（非对称、有界、可撤销）')
console.log('    7) 任何时候：measurementSafe=true 强制只观察；autoDemote 会自己降档')
console.log(`\n  门禁：${ok ? 'PASS —— 产物可发布' : 'FAIL —— 拒绝发布（有步骤失败）'}`)
process.exit(ok ? 0 : 1)
