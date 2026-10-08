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
// 注意：键的提取必须按**花括号深度**判断是不是顶层键，不能按缩进。
// 由来（实测踩到）：`pullbackEnabled` 曾被插到 responseChannels 字面量内部、但用了 2 空格缩进，
// 于是按缩进的旧实现把它当成 DEFAULTS 顶层键，C1 放过了"引用了一个只存在于嵌套对象里的键"——
// 而运行期 CONFIG.pullbackEnabled 是 undefined。缩进是排版，深度才是结构。
const topLevelKeys = (block) => {
  const keys = new Set()
  let depth = 0
  let i = 0
  while (i < block.length) {
    const ch = block[i]
    if (ch === '{' || ch === '[') { depth += 1; i += 1; continue }
    if (ch === '}' || ch === ']') { depth -= 1; i += 1; continue }
    if (ch === '/' && block[i + 1] === '/') { while (i < block.length && block[i] !== '\n') i += 1; continue }
    if (depth === 0) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(block.slice(i))
      if (m) { keys.add(m[1]); i += m[0].length; continue }
    }
    i += 1
  }
  return keys
}
const defaultsBlock = src.match(/const DEFAULTS = \{([\s\S]*?)\n\}/)
if (!defaultsBlock) {
  fails.push('C1 找不到 DEFAULTS 定义块')
} else {
  const defined = topLevelKeys(defaultsBlock[1])
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

// ── C10 硬：零墙钟决策（策略节奏只能用观测量）──────────────────────────────
{
  const problems = []
  if (/setTimeout\s*\(|setInterval\s*\(/.test(src)) problems.push('出现 setTimeout/setInterval（策略不得用计时器）')
  const nowLines = src.split('\n').filter((l) => /Date\.now\(\)/.test(l) && !/^\s*(\/\/|\*)/.test(l))
  // 合法例外必须**显式声明**：该行带 `time-ok: <理由>` 注释。目前只有一处——标定件过期
  // 检查（那测的是"有效期/事件缺失"，时间在那里才是正确单位，不是策略节奏）。
  const enforced = nowLines.filter((l) => !/time-ok:/.test(l))
  const arithmetic = enforced.filter((l) => /[<>]=?|Date\.now\(\)\s*[-+]|[-+]\s*Date\.now\(\)/.test(l.replace(/=>/g, '')))
  for (const l of arithmetic) problems.push(`Date.now() 参与比较/算术：${l.trim().slice(0, 80)}`)
  const setters = enforced.filter((l) => !/(t|at|From|At|time)\s*:\s*Date\.now\(\)|=\s*Date\.now\(\),?\s*$/.test(l))
  for (const l of setters) problems.push(`Date.now() 出现在非时间戳位置：${l.trim().slice(0, 80)}`)
  if (problems.length) for (const p of problems) fails.push(`C10 ${p}`)
  else {
    const exempt = nowLines.length - enforced.length
    oks.push(`C10 零墙钟决策：无计时器，${nowLines.length} 处 Date.now() 全部只是时间戳${exempt ? `（其中 ${exempt} 处为显式声明的例外）` : ''}`)
  }
}

// ── C11 硬：决策路径不得读 band（band 只喂审计与离线标定）───────────────────
{
  const decisionLines = src.split('\n').filter((l) => {
    const t = l.trim()
    if (/^\s*(\/\/|\*)/.test(t)) return false
    return /rec\.band\b|rec\.personaRatio|rec\.percentile/.test(t)
  })
  // 允许的位置：审计载荷、summaryOf 回显、赋值语句、本地计算。
  // 注意 `rec.band =` 必须带否定前瞻，否则 `rec.band === 'spec'`（比较）会被误当成赋值放过
  // ——这正是反向验证（故意注入违规）抓出来的漏洞。
  const ALLOW = new RegExp([
    'logAudit\\(',
    'band:', 'personaRatio:', 'percentile:',
    'summaryOf', 'warnOnce',
    'rec\\.band\\s*=\\s*[^=]', 'rec\\.personaRatio\\s*=\\s*[^=]', 'rec\\.percentile\\s*=\\s*[^=]',
    'const band =', 'const percentile =',
  ].join('|'))
  const bad = decisionLines.filter((l) => !ALLOW.test(l))
  if (bad.length) for (const l of bad) fails.push(`C11 决策路径读了 band/personaRatio/percentile：${l.trim().slice(0, 80)}`)
  else oks.push('C11 决策只依赖会话内参考检验；band/personaRatio/percentile 仅供审计与离线标定')
}

// ── C12 硬：安装面配置一致性（bundle patch 不得与代码 DEFAULTS 漂移）────────
{
  const patchPath = resolve(dirname(indexPath), 'cordis.patch.yml')
  if (!existsSync(patchPath)) warns.push(`C12 找不到 bundle patch（${patchPath}），跳过安装面检查`)
  else {
    const patch = readFileSync(patchPath, 'utf8')
    const defined = new Set([...(src.match(/const DEFAULTS = \{([\s\S]*?)\n\}/)?.[1] ?? '')
      .matchAll(/^\s{2}([A-Za-z_][A-Za-z0-9_]*):/gm)].map((m) => m[1]))
    // 只检查 patch 里 config: 块内的 `key:` 行。块边界按 **config: 自身的缩进** 判定
    // （不能按固定缩进猜——反向验证里 6 空格的行会被误当成 config 内层）。
    const declared = new Set()
    let configIndent = null
    for (const raw of patch.split('\n')) {
      const line = raw.replace(/#.*$/, '')
      if (!line.trim()) continue
      const indent = line.match(/^\s*/)[0].length
      const cfg = line.match(/^(\s*)config:\s*$/)
      if (cfg) { configIndent = cfg[1].length; continue }
      if (configIndent === null) continue
      if (indent <= configIndent) { configIndent = null; continue }
      const m = line.match(/^\s+([A-Za-z_][A-Za-z0-9_]*):/)
      if (m) declared.add(m[1])
    }
    const unknown = [...declared].filter((k) => !defined.has(k))
    const dangerous = []
    if (/rollbackEnabled:\s*true/.test(patch)) dangerous.push('rollbackEnabled: true（能力层默认必须关）')
    if (/notifyEnabled:\s*true/.test(patch)) dangerous.push('notifyEnabled: true（通知层默认必须关）')
    const problems = [...unknown.map((k) => `patch 声明了 DEFAULTS 里不存在的键 "${k}"（新装会触发响亮告警）`), ...dangerous]
    if (problems.length) for (const p of problems) fails.push(`C12 安装面：${p}`)
    else oks.push(`C12 安装面一致：patch 未声明未知键，且未打开任何默认关闭的开关（${declared.size} 个显式键）`)
  }
}

// ── C8 硬：失败标记表在运行时与标定工具之间必须一致 ─────────────────────────
{
  const toolPath = resolve(dirname(indexPath), 'tools', 'calibrate-lexicon-v2.mjs')
  const markers = ['exit code:', 'sandbox: file access denied', 'Traceback (most recent call last)', 'AssertionError', 'FAILED', 'Command failed']
  if (!existsSync(toolPath)) warns.push(`C8 找不到标定工具（${toolPath}），跳过标记表一致性检查`)
  else {
    // 源码里这些标记以**正则字面量**形式出现（转义括号等），所以先剥掉反斜杠再比对，
    // 否则会把 `Traceback \(most recent call last\)` 误判成"缺失"。
    const norm = (s) => s.replace(/\\/g, '')
    const idx = norm(src)
    const tool = norm(readFileSync(toolPath, 'utf8'))
    const missIdx = markers.filter((m) => !idx.includes(m))
    const missTool = markers.filter((m) => !tool.includes(m))
    if (missIdx.length || missTool.length) {
      fails.push(`C8 失败标记表不一致：index.js 缺 [${missIdx.join(', ')}]；标定工具缺 [${missTool.join(', ')}]（两处判定必须同源，否则运行时与离线标定会各说各话）`)
    } else oks.push(`C8 失败标记表一致（${markers.length} 条标记在运行时与标定工具中都存在）`)
  }
}

// ── C9 硬：A′ 通道必须带"回合末步"排除（否则 100% 误判）────────────────────
{
  const hasExclusion = /midTurnInaction/.test(src)
  const hasTurnEnd = /'turn\/end'/.test(src)
  const hasLedgerClose = /function ledgerCloseTurn/.test(src)
  if (!hasExclusion || !hasTurnEnd || !hasLedgerClose) {
    fails.push(`C9 中途停手通道缺少"回合末步"排除（midTurnInaction=${hasExclusion} turn/end=${hasTurnEnd} ledgerCloseTurn=${hasLedgerClose}）：实测不分回合末步就是 100% 误判（67 个无工具调用步全部是回合收尾）`)
  } else oks.push('C9 A′ 通道带回合末步排除（下一步推进 + turn/end 双判）')
}

// ── C13 硬：B3 运行时门禁接线（能力层必须走"有效开关"，且不得跨挂载粘住）────
// 由来（都是本轮真实的失败模式）：
//   ① `apply` 不重播种 CONFIG ⇒ 标定件写入的 measurementSafe / capabilityEligible /
//      反解 α 会在下一次挂载里**粘住**，表现为"改了配置行为不变"的静默降级；
//      而且 `{ ...DEFAULTS }` 是浅拷贝，装载标定件会**就地改掉 DEFAULTS**。
//   ② 连续确认计数用 notifyAlpha 计数、却把守 actAlpha 的行动级 ⇒ 在线比离线标定更松
//      （离线 walkChannel 是在单一 α 上数连续的），正是"离线合格、线上超标"。
//   ③ 决策路径若直接读 CONFIG.rollbackEnabled（而不是 effectiveRollback()），
//      标定件门禁与自动降档会被绕过。
{
  const problems = []
  if (!/CONFIG = cloneDefaults\(\)/.test(src)) {
    problems.push('apply() 未从 DEFAULTS 重新播种 CONFIG（标定件写入的 measurementSafe/资格/α 会跨挂载粘住）')
  }
  if (!/function cloneDefaults\(\)/.test(src)) problems.push('缺少 cloneDefaults()（浅拷贝会让 DEFAULTS 被就地改写）')
  if (!/const hitAct = Number\.isFinite\(c\.p\) && c\.p <= actA/.test(src)) {
    problems.push('行动级连续计数未用 actAlpha（用 notifyAlpha 计数会让在线比离线标定更松）')
  }
  if (!/const hitNot = Number\.isFinite\(c\.p\) && c\.p <= notA/.test(src)) {
    problems.push('通知级连续计数未用 notifyAlpha')
  }
  if (!/confirmed\(c, 'act'\)/.test(src) || !/confirmed\(c, 'notify'\)/.test(src)) {
    problems.push('两级未分别确认（strong 必须用行动级连续计数、weak 用通知级）')
  }
  if (!/const strong = byP\.filter\(\(c\) => c\.p <= actA\(c\) && confirmed\(c, 'act'\)\)/.test(src)) {
    problems.push('strong 入口未同时要求 actAlpha 与行动级连续确认')
  }
  // 决策/肢动路径不得直接读原始开关：合法位置是**门禁函数体内部**（结构判定，
  // 不是字符串白名单——否则新增一行读取照样漏过）与 summaryOf 的回显行。
  const bodySpan = (fnName) => {
    const start = src.indexOf(`function ${fnName}()`)
    if (start === -1) return null
    const open = src.indexOf('{', start)
    if (open === -1) return null
    let depth = 0
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth += 1
      else if (src[i] === '}') {
        depth -= 1
        if (depth === 0) return [start, i]
      }
    }
    return null
  }
  const lineOf = (idx) => src.slice(0, idx).split('\n').length
  const gateSpans = ['effectiveRollback', 'effectiveNotify', 'capabilityGateReason']
    .map(bodySpan).filter(Boolean).map(([a, b]) => [lineOf(a), lineOf(b)])
  const inGateBody = (lineNo) => gateSpans.some(([a, b]) => lineNo >= a && lineNo <= b)
  const rawSwitchLines = src.split('\n')
    .map((l, i) => ({ l: l.trim(), i: i + 1 }))
    .filter(({ l }) => !/^\s*(\/\/|\*)/.test(l) && /CONFIG\.(rollbackEnabled|notifyEnabled)/.test(l))
    .filter(({ i }) => !inGateBody(i))
    .filter(({ l }) => !/^\s*(rollbackEnabled|notifyEnabled):\s*CONFIG\.(rollbackEnabled|notifyEnabled),?$/.test(l))
  if (rawSwitchLines.length) {
    for (const { l, i } of rawSwitchLines) problems.push(`第 ${i} 行在门禁之外直接读原始开关（应走 effectiveRollback()/effectiveNotify()）：${l.slice(0, 80)}`)
  }
  if (!/function effectiveRollback\(\)/.test(src) || !/function effectiveNotify\(\)/.test(src)) {
    problems.push('缺少 effectiveRollback()/effectiveNotify()（能力层与通知层必须经门禁）')
  }
  if (!/if \(CONFIG\.measurementSafe === true\) return false/.test(src)) {
    problems.push('评测保护未进门禁（measurementSafe 必须能强制只观察）')
  }
  if (problems.length) for (const p of problems) fails.push(`C13 ${p}`)
  else oks.push('C13 B3 门禁接线：CONFIG 每次挂载重播种、两级连续计数分层、肢动路径只读有效开关')
}

// ── C14 硬：版本号单一来源（README 必须写 package.json 的版本）──────────────
// 由来：提交文案里的 v0.4.8 / v0.4.9（B1/B2）与 package.json 长期停在 0.4.7 漂移，
// 即"文档说的版本不是装的版本"。README 已声明 package.json 是唯一来源，这里守住它。
{
  const pkgPath = resolve(dirname(indexPath), 'package.json')
  if (!existsSync(pkgPath)) warns.push(`C14 找不到 package.json（${pkgPath}）`)
  else if (!existsSync(readmePath)) warns.push(`C14 找不到 README（${readmePath}）`)
  else {
    const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version
    const readme = readFileSync(readmePath, 'utf8')
    if (!version) fails.push('C14 package.json 没有 version 字段')
    else if (!readme.includes(version)) {
      fails.push(`C14 README 未出现 package.json 的版本号 ${version}（版本口径必须单一来源：提交文案曾与 package.json 漂移）`)
    } else oks.push(`C14 版本一致：package.json = ${version}，README 同步声明`)
  }
}

// ── C15 硬：行为台账必须只有**一份**实现（离线不得自带一套定稿规则）──────────
// 由来（实测，2026-10）：tools/behaviour-channel-core.mjs 曾自带 done 规则
//   done = step < maxStepOfTurn(turn) || turnsWithEnd.has(turn)
// 与运行时不一致（末步只要所在回合有 turn/end 就被收进序列，而它其实是合法收尾）。
// 后果：128 会话中 123 个序列不同；A′ 命中率 运行时 0.16% 对 离线 8.10%（差 51 倍），
// 于是 B2 的 α 是给一条运行时**不存在**的通道算的。这条断言把"共用同一实现"钉住。
{
  const problems = []
  const corePath = resolve(dirname(indexPath), 'tools', 'behaviour-channel-core.mjs')
  if (!existsSync(corePath)) problems.push('找不到 tools/behaviour-channel-core.mjs')
  else {
    const core = readFileSync(corePath, 'utf8')
    if (!/import\s*\{[^}]*buildLedgerFromEvents[^}]*\}\s*from\s*'\.\.\/index\.js'/.test(core)) {
      problems.push('离线核心未从 index.js 导入 buildLedgerFromEvents（台账必须共用一份实现）')
    }
    if (/turnsWithEnd|maxStepOfTurn/.test(core.replace(/^\s*\*.*$/gm, ''))) {
      problems.push('离线核心里又出现了本地定稿规则（turnsWithEnd / maxStepOfTurn）——这正是 51 倍偏差的来源')
    }
  }
  if (!/export function buildLedgerFromEvents\(/.test(src)) problems.push('index.js 未导出 buildLedgerFromEvents（离线无法共用）')
  for (const t of ['test-ledger-parity.mjs', 'test-ledger-semantics.mjs']) {
    if (!existsSync(resolve(dirname(indexPath), 'tools', t))) problems.push(`缺少对拍/语义测试 tools/${t}`)
  }
  if (problems.length) for (const p of problems) fails.push(`C15 ${p}`)
  else oks.push('C15 行为台账单一实现：离线核心共用 buildLedgerFromEvents，且带逐步对拍 + 手算语义测试')
}

// ── C16 硬：出厂标定件必须"能用"（不得自带 measurementSafe、有资格通道必须带 derived）──
// 由来（实测，2026-10）：标定工具曾 (a) 不产出 derived(k,α) ⇒ 反解永远上不了线；
// (b) 写 measurementSafe: true ⇒ 装载即强制只观察，现象是"有资格却永远不动手"。
{
  const artPath = resolve(dirname(indexPath), 'responsePolicy.json')
  if (!existsSync(artPath)) warns.push('C16 未找到出厂标定件 responsePolicy.json（跳过；安装即用时能力层本就不动）')
  else {
    const problems = []
    let art = null
    try { art = JSON.parse(readFileSync(artPath, 'utf8')) } catch (e) { problems.push(`解析失败：${e && e.message}`) }
    if (art) {
      if (art.measurementSafe === true) problems.push('标定件自带 measurementSafe: true ⇒ 装载即强制只观察，"授权"这条路永远走不通')
      const eligible = Array.isArray(art.capabilityEligibleChannels) ? art.capabilityEligibleChannels : []
      const pass = ['PASS', 'PARTIAL-PASS'].includes(art.verdict)
      // FAIL 是合法结果（而且是当前实测的结果），但必须自洽：FAIL ⇒ 不得声称任何通道有资格；
      // PASS/PARTIAL-PASS ⇒ 每个有资格通道都必须带 derived(k,α)，否则反解参数到不了运行时。
      if (!pass && eligible.length > 0) {
        problems.push(`verdict=${art.verdict} 却声称有资格通道 [${eligible.join(', ')}]（要么改裁决，要么清空资格）`)
      }
      if (pass && eligible.length === 0) {
        problems.push(`verdict=${art.verdict} 却没有任何有资格通道（装载后等价于只观察，裁决名不副实）`)
      }
      for (const c of eligible) {
        const d = art.channels && art.channels[c] && art.channels[c].derived
        if (!d || !Number.isFinite(d.alpha) || !Number.isFinite(d.consecutive)) {
          problems.push(`有资格通道 ${c} 没有 derived(k,α) ⇒ 反解参数到不了运行时`)
        }
      }
      // 空转侧合格而召回侧未测 ⇒ 不许给资格（"从不触发"的空转率也是 0）
      if (pass && art.recallSide && art.recallSide.status !== 'MEASURED') {
        problems.push('recallSide 尚未测量却已授予资格（空转侧合格可能是"从不触发"造成的）')
      }
    }
    if (problems.length) for (const p of problems) fails.push(`C16 ${p}`)
    else oks.push(`C16 出厂标定件自洽：verdict=${art.verdict}，授权 ${(art.capabilityEligibleChannels || []).length} 个通道，`
      + `召回侧=${(art.recallSide && art.recallSide.status) || 'n/a'}，未带 measurementSafe`)
  }
}

// ── C17 硬：L1 任务锚定拉回的接线与**措辞纪律** ──────────────────────────────
// 由来：① 拉回是第一个"把话直接说给模型听"的动作，默认必须关（只有机制验证过、效果未测）；
//       ② 措辞必须**建议式**——社区实测（dsh-anchored-monitor 实验 E1/E1.5）"命令式（must/first/
//          follow）会把 we 轨迹打回 let me"，也就是说命令式提醒会**加剧**我们要修的信号；
//       ③ 任务锚定的解析/判定必须共用 tools/task-anchor-core.mjs 一份实现（本项目已两次栽在
//          "两套规则各说各话"：台账定稿 51 倍偏差、两级连续计数混层）。
{
  const problems = []
  if (!/pullbackEnabled: false/.test(src)) problems.push('pullbackEnabled 默认必须是 false（效果尚未测量）')
  if (!/if \(CONFIG\.pullbackEnabled !== true\) return null/.test(src)) {
    problems.push('拉回未受 pullbackEnabled 门控（默认关必须真的关得住）')
  }
  if (!/import\s*\{[^}]*parseTaskAnchors[^}]*\}\s*from\s*'\.\/tools\/task-anchor-core\.mjs'/.test(src)) {
    problems.push('运行时未共用 tools/task-anchor-core.mjs（禁止在 index.js 里再写一份解析/判定）')
  }
  if (/function parseTaskAnchors\(/.test(src)) problems.push('index.js 里又出现了一份 parseTaskAnchors（应共用单一实现）')
  // 措辞纪律：文本模板里不得出现命令式措辞
  const textFn = src.match(/export function pullbackText\([\s\S]*?\n\}/)
  if (!textFn) problems.push('找不到 pullbackText（拉回文本必须集中在一处，便于审计措辞）')
  else {
    const body = textFn[0]
    const forbidden = ['必须', '务必', '禁止', 'do not', "don't", 'never', 'shall', 'first,', 'follow']
    const hit = forbidden.filter((w) => body.includes(w))
    if (hit.length) problems.push(`拉回文本出现命令式措辞 [${hit.join(', ')}]（社区实测会加剧信号，应为建议式）`)
    // **按分支**检查（整体检查会被"另一个分支还有豁免"骗过——反向验证抓出来的）
    // 注意匹配用 `[trajectory-anchor]` 本身：写成 `= \`[trajectory-anchor\]` 会因为源码里是
    // `return \`[…` 而**永远匹配不上**，于是整段检查被跳过（这是第二轮负向验证抓出来的）。
    const chunks = body.split(/if \(reason === '/).slice(1)
    if (chunks.length === 0) problems.push('pullbackText 里没有可识别的分支')
    let checkedBranches = 0
    for (const chunk of chunks) {
      const label = (chunk.match(/^([a-z-]+)'/) || [])[1] || '?'
      if (!/\[trajectory-anchor\]/.test(chunk)) continue
      checkedBranches += 1
      if (!/建议|可以参考|可以考虑|说明一句即可/.test(chunk)) problems.push(`分支 ${label} 缺少建议式表述`)
      if (!/不算|豁免/.test(chunk)) problems.push(`分支 ${label} 缺少明确豁免（否则代理会为讨好提醒而不敢正常做事）`)
    }
    if (checkedBranches === 0) problems.push('pullbackText 的分支一个都没被检查到（模式串失配）')
  }
  // 节流：检查**代码**而不是注释（"节流见 allostasis 的 admitPerTurn"这句注释曾骗过检查）
  {
    const codeNoComments = src.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
    if (!/rec\.pullback\.lastTurn === turn/.test(codeNoComments)) problems.push('缺少"同一 turn 至多一次"的节流条件（代码里找不到）')
    if (!/rec\.pullback\.count >= CONFIG\.pullbackMaxPerSession/.test(codeNoComments)) problems.push('缺少每会话上限判定（代码里找不到）')
  }
  if (problems.length) for (const p of problems) fails.push(`C17 ${p}`)
  else oks.push('C17 L1 拉回接线：默认关、受门控、共用单一锚定实现、措辞为建议式且带豁免、turn 级节流 + 会话上限')
}

// ── 输出 ────────────────────────────────────────────────────────────────
for (const s of oks) console.log(`  OK    ${s}`)
for (const s of debts) console.log(`  DEBT  ${s}`)
for (const s of warns) console.log(`  WARN  ${s}`)
for (const s of fails) console.log(`  FAIL  ${s}`)
console.log(`\n[invariants] ${indexPath}`)
console.log(`  通过 ${oks.length} / 债务 ${debts.length} / 警告 ${warns.length} / 失败 ${fails.length}`)
process.exit(fails.length ? 1 : 0)
