/**
 * check-invariants.mjs —— 静态不变量断言（零依赖，只读）
 *
 * 由来：v0.4.1–v0.4.3 的归还分支引用了一个 DEFAULTS 里不存在的键
 * （`driftSteps >= CONFIG.minDriftSteps` → `x >= undefined` 恒 false），
 * 归还因此是死代码：实测 23 个会话触发 rollback、0 个恢复。这类"引用未定义
 * 配置"的死代码在运行期完全静默，只能在源码层断言。
 *
 * 用法：
 *   node tools/check-invariants.mjs [index.js 路径] [README.md 路径]
 *   默认取与本文件同级的 ../index.js 与 ../README.md。
 *
 * 退出码：0 = 无硬失败（可能有 DEBT/WARN）；1 = 有硬失败。
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const indexPath = resolve(process.argv[2] || join(here, '..', 'index.js'))
const readmePath = resolve(process.argv[3] || join(here, '..', 'README.md'))

/** P1 已落地：工具面改为组装期派生（surfaceForPhase），任何 deny 型 restrict 调用点都是回归。 */
const ALLOWED_DENY_RESTRICT_CALLS = 0

const fails = []
const debts = []
const warns = []
const oks = []

if (!existsSync(indexPath)) {
  console.error(`[invariants] 找不到 ${indexPath}`)
  process.exit(1)
}
const src = readFileSync(indexPath, 'utf8')

// ── C1 硬：源码引用的每个 CONFIG.<key> 都必须在 DEFAULTS 里定义 ──────────────
const defaultsBlock = src.match(/const DEFAULTS = \{([\s\S]*?)\n\}/)
if (!defaultsBlock) {
  fails.push('C1 找不到 DEFAULTS 定义块')
} else {
  const defined = new Set([...defaultsBlock[1].matchAll(/^\s{2}([A-Za-z_][A-Za-z0-9_]*):/gm)].map((m) => m[1]))
  const referenced = new Set([...src.matchAll(/CONFIG\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))
  const missing = [...referenced].filter((k) => !defined.has(k))
  if (missing.length) {
    fails.push(`C1 引用了 DEFAULTS 里不存在的配置键：${missing.join(', ')}（这类引用在运行期静默失效，历史上害死 17 个会话的归还路径）`)
  } else {
    oks.push(`C1 CONFIG 引用一致性：定义 ${defined.size} 个 / 引用 ${referenced.size} 个，全部匹配`)
  }
  // ── C2 警告：定义了但从未引用（死配置）──────────────────────────────────
  const unused = [...defined].filter((k) => !referenced.has(k))
  if (unused.length) warns.push(`C2 DEFAULTS 里定义但从未引用（死配置）：${unused.join(', ')}`)
  else oks.push('C2 无死配置（每个 DEFAULTS 键都被引用）')
}

// ── C3 硬：deny 型 restrict 调用点计数（先剥注释，再按"整行是否注释行"复核）──────
const codeOnly = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n')
/** 匹配点所在的整行若以 // 或 * 开头，视为散文而非代码。 */
const onCommentLine = (text, idx) => {
  const start = text.lastIndexOf('\n', idx) + 1
  const end = text.indexOf('\n', idx)
  const line = text.slice(start, end === -1 ? undefined : end)
  return /^\s*(\/\/|\*|\/\*)/.test(line)
}
const countCode = (re) => {
  let n = 0
  let m
  while ((m = re.exec(codeOnly))) {
    if (!onCommentLine(codeOnly, m.index)) n += 1
  }
  return n
}
const denyCalls = countCode(/restrictWithCull\([^)]*\{\s*deny\s*\}?[^)]*\)|\.tools\.restrict\(\{\s*deny/g)
const rawDenyLiteral = countCode(/\{\s*deny\s*\}/g)
const denySites = Math.max(denyCalls, rawDenyLiteral)
if (denySites > ALLOWED_DENY_RESTRICT_CALLS) {
  fails.push(`C3 出现 ${denySites} 处 deny 型工具面限制，上限 ${ALLOWED_DENY_RESTRICT_CALLS}：工具面只允许在组装期派生（surfaceForPhase），注册层突变不可逆`)
} else if (denySites > 0) {
  debts.push(`C3 存在 ${denySites} 处 deny 型 restrict：P1 必须清零`)
} else {
  oks.push('C3 无 deny 型 restrict 调用点（工具面只在组装期派生）')
}

// ── C5 硬：fail-open 契约（降级必须朝"暴露全量"倒，且必须可见）───────────────
if (!/full catalog exposed/.test(src)) {
  fails.push('C5 缺少 fail-open 契约文案「full catalog exposed」（降级路径必须明说放开了全量）')
} else if (!/anchor-degraded/.test(src) || !/anchorDegraded/.test(src)) {
  fails.push('C5 降级路径必须同时写 anchor-degraded 审计并在 summaryOf 里暴露 anchorDegraded')
} else if (!/noteConfigWarning/.test(src)) {
  fails.push('C5 配置问题必须走 noteConfigWarning（响亮且可查），不得静默 console.error 后 continue')
} else {
  oks.push('C5 fail-open 契约在位（full catalog exposed + anchor-degraded + noteConfigWarning）')
}

// ── C4 警告：README 与代码的数值漂移 ──────────────────────────────────────
if (existsSync(readmePath)) {
  const readme = readFileSync(readmePath, 'utf8')
  const listMatch = src.match(/leanDenyPatterns:\s*\[([\s\S]*?)\n\s*\]/)
  const actualCount = listMatch
    ? listMatch[1].split(',').map((s) => s.trim()).filter((s) => /^['"]/.test(s)).length
    : null
  const docMatch = readme.match(/`leanDenyPatterns`\s*\|\s*(\d+)\s*entries?/)
  if (actualCount === null) fails.push('C4 源码里找不到 leanDenyPatterns 列表')
  else if (!docMatch) warns.push('C4 README 里找不到 leanDenyPatterns 条目数（文档表可能被改写）')
  else if (Number(docMatch[1]) !== actualCount) {
    fails.push(`C4 文档/代码漂移：README 写 ${docMatch[1]} entries，代码实际 ${actualCount} 条`)
  } else oks.push(`C4 文档一致：leanDenyPatterns = ${actualCount} 条`)
} else {
  warns.push(`C4 找不到 README（${readmePath}），跳过文档一致性检查`)
}

// ── C6 硬：P6/P0 契约（有界退出 + 安全默认 + 派生面接线在位）─────────────────
{
  const maxDrift = src.match(/maxDriftSteps:\s*(-?\d+)/)
  const rollbackDefault = src.match(/rollbackEnabled:\s*(true|false)/)
  const notifyDefault = src.match(/notifyEnabled:\s*(true|false)/)
  const problems = []
  if (!maxDrift) problems.push('缺少 maxDriftSteps（漂移态必须配一个必然可达的步数上限）')
  else if (Number(maxDrift[1]) <= 0) problems.push(`maxDriftSteps=${maxDrift[1]} 关闭了上限（不允许：退出条件必须必然可达）`)
  if (!rollbackDefault || rollbackDefault[1] !== 'false') problems.push('rollbackEnabled 默认必须为 false（能力层默认关闭，须先通过标定）')
  if (!notifyDefault || notifyDefault[1] !== 'false') problems.push('notifyEnabled 默认必须为 false（通知层默认关闭）')
  if (!/system-prompt\/assemble/.test(src) || !/surfaceForPhase\(/.test(src)) {
    problems.push('组装期派生工具面的接线不在位（system-prompt/assemble + surfaceForPhase）')
  }
  if (problems.length) for (const p of problems) fails.push(`C6 ${p}`)
  else oks.push('C6 有界退出 + 安全默认（双关）+ 派生面接线：全部在位')
}

// ── C7 硬：两个"证据不足"档都必须留痕 ─────────────────────────────────────
{
  const lines = src.split('\n')
  const callLine = lines.findIndex((l) => /notePolicySkipped\(rec, decision\.reason\)/.test(l))
  const guard = callLine === -1 ? '' : lines.slice(Math.max(0, callLine - 8), callLine + 1).join('\n')
  const hasNoObs = /no-observation/.test(guard)
  const hasInsuff = /insufficient-reference/.test(guard)
  if (callLine === -1) fails.push('C7 找不到 notePolicySkipped(rec, decision.reason) 调用点')
  else if (!hasNoObs || !hasInsuff) {
    fails.push(`C7 跳过判定的留痕不完整（no-observation=${hasNoObs} / insufficient-reference=${hasInsuff}）：两档都必须写 policy-skipped，否则"判定为何没启动"无法回溯`)
  } else oks.push('C7 两个证据不足档都写 policy-skipped（日志从第 1 步起可回溯）')
}

// ── 输出 ────────────────────────────────────────────────────────────────
for (const s of oks) console.log(`  OK    ${s}`)
for (const s of debts) console.log(`  DEBT  ${s}`)
for (const s of warns) console.log(`  WARN  ${s}`)
for (const s of fails) console.log(`  FAIL  ${s}`)
console.log(`\n[invariants] ${indexPath}`)
console.log(`  通过 ${oks.length} / 债务 ${debts.length} / 警告 ${warns.length} / 失败 ${fails.length}`)
process.exit(fails.length ? 1 : 0)
