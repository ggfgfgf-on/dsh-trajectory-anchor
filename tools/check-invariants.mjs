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
  // 自动降档的分母必须是**单调**标记：narrowedSteps 会在片段恢复时被清零，
  // 用它回答"本会话动过手吗"会系统性低估（收窄后又恢复的会话全部漏计），
  // 安全阀因此更难触发——实测踩到（同一批会话 narrowed 被记成 0 而不是 2）。
  if (!/sessionOutcomes\.push\(\{ narrowed: rec\.didNarrow === true \}\)/.test(src)) {
    problems.push('自动降档仍在用非单调口径（应为 rec.didNarrow；narrowedSteps 会被 recoverRollback 清零）')
  }
  if (!/rec\.didNarrow = true/.test(src)) problems.push('缺少单调标记 rec.didNarrow 的置位点')
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
    // 这里只断言"规则存在"（用宽松到不锁拼写的模式）；"两条臂必须同规则"归 C22 ——
    // 否则同一个性质被两处各写一份，改一处就会得到一个假失败（本文件已经吃过这个亏：
    // 把节流标记从 lastTurn 换成 lastTriggerTurn 后，这里因为锁了字面量而误报）。
    if (!/rec\.pullback\.last[A-Za-z]*Turn\s*!==\s*null[^\n]*===\s*turn/.test(codeNoComments)) {
      problems.push('缺少"同一 turn 至多一次"的节流条件（代码里找不到）')
    }
    if (!/[A-Za-z_$][\w$.]*\s*>=\s*CONFIG\.pullbackMaxPerSession/.test(codeNoComments)) {
      problems.push('缺少每会话上限判定（代码里找不到）')
    }
  }
  // 成功门：`tool/call` 只说明"**发起**了写操作"，落地与否要看 `tool/result` 的**结构化**失败标记。
  // 由来（真实触发）：一次被 harness 拒绝的 edit 仍被算作"改了代码"，L1 随即说出一句前提为假的提醒。
  if (!/export function toolResultFailed\(/.test(src)) problems.push('缺少 toolResultFailed（成功门没有单一实现）')
  if (!/if \(toolResultFailed\(event\)\) retractArm\(rec, event\)/.test(src)) {
    problems.push('tool/result 分支没有接成功门（发起了但没落地的写仍会被算作改动）')
  }
  if (!/function retractArm\(rec, event\)/.test(src)) problems.push('缺少 retractArm（撤回必须单一实现）')
  if (!/logAudit\(rec, 'arm-retracted'/.test(src)) problems.push('撤回没有审计留痕（静默忽略不可接受）')
  if (!/armRetracted/.test(src)) problems.push('撤回没有计数（撤回不可见）')
  // 事故症状 sawUnknownTool：必须**同时**要求"调用失败"与"文本命中"。只看文本会误报——
  // 实测本会话 29 次文本命中**全是成功的 read**（读的正是本插件自己的代码与笔记，
  // 里面写着 "unknown tool"），而它是 L3.3 结局代理的一项、也是落盘行的 sessionLevelFields。
  if (!/toolResultFailed\(event\) && \/\\bunknown tool\\b\|not a known tool\/i\.test\(toolResultText\(event\)\)/.test(src)) {
    problems.push('sawUnknownTool 判据没有同时要求"调用失败"（成功的 read 里含该词即误报）')
  }
  if (!/sawUnknownTool: rec\.sawUnknownTool === true/.test(src)) {
    problems.push('sawUnknownTool 不在状态里可见（"这一项为什么是 true"只能靠翻日志）')
  }
  {
    const gate = (src.match(/export function toolResultFailed\([\s\S]*?\n\}/) || [''])[0]
    if (!gate) problems.push('取不到 toolResultFailed 的函数体（检查模式串失配）')
    else {
      if (!/d\.error/.test(gate) || !/isError === true/.test(gate)) {
        problems.push('成功门没有用结构化字段（data.error / isError）判定')
      }
      // **负向**：不许文本匹配——结果文本里完全可能带着 "Error"（读到的代码/日志），
      // 按文本判会把**成功**的写当成失败 ⇒ 把 L1 说哑（本项目栽过两次的"能力其实没在跑"）。
      if (/\.test\(/.test(gate)) problems.push('成功门用了文本匹配（会误撤成功的写，把 L1 说哑）')
    }
  }
  {
    const retract = (src.match(/function retractArm\(rec, event\)[\s\S]*?\n\}/) || [''])[0]
    if (!retract) problems.push('取不到 retractArm 的函数体（检查模式串失配）')
    // 明确口径：**验证 mark 不许被成功门撤回**——命令跑过就是跑过，报错/非零退出同样携带信息。
    else if (/verifyMarks/.test(retract)) {
      problems.push('成功门动了验证 mark（验证命令报错也必须算"验证过"）')
    }
  }
  // 门槛必须**按原因**分别判定：统一要求"解析出提示锚点"会让自由形态的长会话永远沉默
  // （实测：用例 ⑬ 的 n=0 就是被这道统一门槛挡住的 ⇒ L1 停在"存在但从不运行"）。
  {
    const pd = src.match(/function pullbackDecision\([\s\S]*?\n\}/)
    if (!pd) problems.push('找不到 pullbackDecision')
    else {
      if (!/pending\.reason === 'scope' && !anchorsParsed/.test(pd[0])) {
        problems.push('pullbackDecision 未按原因分别判门槛（scope 才需要提示范围；unverified 不该要求）')
      }
      // 无锚点时的门槛必须**同时**看"行为观测到的验证"，不能只看提示解析结果。
      // 注意别写成匹配某段旧文本：第一版就是这么写的，于是把 `!anchorsParsed` 这种等价改写放过了
      // （负向副本 ① 抓到）；这里改成"门槛条件里必须出现 observedVerify"。
      if (!/if \(!anchorsParsed && !observedVerify\)/.test(pd[0])) {
        problems.push('pullbackDecision 的无锚点门槛未把 observedVerify 计入（自由会话会永远沉默）')
      }
    }
  }
  // 验证命令必须有两种来源，且"形态识别"共用 core 的一份实现。
  // 注意：检查必须落在**调用点**上，且**不能写死参数名**——第一版查标识符（import 行就满足），
  // 第二版查 `verifyCommandKind(cmd)` 这种精确形态（把变量改名就失效，实测踩到）。
  // 现在只要求"以某个标识符为参数真实调用过"。
  if (!/verifyCommandKind\([A-Za-z_$][\w$.]*\)/.test(src)) problems.push('运行时没有真的调用 verifyCommandKind(...)（验证命令只能来自提示 ⇒ 自由会话沉默）')
  if (!/import\s*\{[\s\S]*?verifyCommandKind[\s\S]*?\}\s*from\s*'\.\/tools\/task-anchor-core\.mjs'/.test(src)) {
    problems.push('verifyCommandKind 未从 task-anchor-core 共用（禁止在 index.js 再写一份形态表）')
  }
  {
    const corePath = resolve(dirname(indexPath), 'tools', 'task-anchor-core.mjs')
    if (!existsSync(corePath) || !/export function verifyCommandKind\(cmd\)/.test(readFileSync(corePath, 'utf8'))) {
      problems.push('task-anchor-core 里找不到 verifyCommandKind')
    }
  }
  if (problems.length) for (const p of problems) fails.push(`C17 ${p}`)
  else oks.push('C17 L1 拉回接线：默认关、受门控、共用单一锚定实现、门槛按原因分别判、验证命令两种来源、措辞建议式带豁免、turn 级节流 + 会话上限')
}

// ── C18 硬：L2 重锚定的门禁（最强干预必须最难开）─────────────────────────────
// 由来：本项目最重的事故是"未经验证的信号 → 不可逆执行器"（23 会话进收窄、0 恢复）。
// 重锚定改的是**模型上下文**，比收窄工具面更强，因此：① 默认关；② 除开关外还要求一份
// **在线证据件**（真实会话累积、verdict=PASS-online、未过期）；③ 先轻后重（L1 已说过话）；
// ④ 每会话只做一次；⑤ 评测保护与自动降档都能关掉它；⑥ 效果采集必须真的被调用。
{
  const problems = []
  if (!/reanchorEnabled: false/.test(src)) problems.push('reanchorEnabled 默认必须是 false（最强干预）')
  if (!/function effectiveReanchor\(\)/.test(src)) problems.push('缺少 effectiveReanchor()（重锚定必须经门禁）')
  if (!/ev\.synthetic === true\) reject\('synthetic-evidence'\)/.test(src)) {
    problems.push('证据加载器接受合成/演示证据（synthetic:true 必须被拒——实测第一版会被它开门）')
  }
  if (!/reanchorEvidence \|\| reanchorEvidence\.verdict !== 'PASS-online'/.test(src)) {
    problems.push('effectiveReanchor 未要求在线证据件（只有开关没有证据 = 未验证的执行器）')
  }
  const codeNoComments = src.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
  // 这两条必须**在 reanchorDecision 函数体内**检查：同名条件在 recordPullbackOutcome 里也出现，
  // 全局检查会被它"撞"过去（反向验证抓出来的——把"先轻后重"删掉仍然全绿）。
  const rd = src.match(/function reanchorDecision\([\s\S]*?\n\}/)
  if (!rd) problems.push('找不到 reanchorDecision（重锚定判定必须集中在一处）')
  else {
    if (!/rec\.reanchor\.count > 0/.test(rd[0])) problems.push('reanchorDecision 缺少"每会话只重锚定一次"的判定')
    if (!/rec\.pullback\.count === 0/.test(rd[0])) problems.push('reanchorDecision 缺少"先轻后重"的判定（L1 未说过话就不许重锚定）')
    if (!/effectiveReanchor\(\)/.test(rd[0])) problems.push('reanchorDecision 未走门禁 effectiveReanchor()')
  }
  if (!/function recordPullbackOutcome\(rec\)/.test(src)) problems.push('缺少效果采集 recordPullbackOutcome（L2 的门没有数据来源）')
  if (!/^\s*recordPullbackOutcome\(rec\)$/m.test(codeNoComments)) problems.push('效果采集写了但没有被调用（从不执行）')
  if (!/mkdirSync\(dirname2\(dir\), \{ recursive: true \}\)/.test(codeNoComments)) problems.push('效果采集未建目录（首次落盘会失败）')
  const refn = src.match(/export function reanchorText\([\s\S]*?\n\}/)
  if (!refn) problems.push('找不到 reanchorText')
  else {
    if (!/\$\{persona\}/.test(refn[0])) problems.push('重锚定文本没有原样带回 persona（社区依据：重置载荷 = 逐字节对齐已有效载荷）')
    const forbidden = ['必须', '务必', '禁止', 'do not', "don't", 'never', 'shall', 'follow']
    const hit = forbidden.filter((w) => refn[0].includes(w))
    if (hit.length) problems.push(`重锚定文本出现命令式措辞 [${hit.join(', ')}]`)
    if (!/忽略本条即可|建议/.test(refn[0])) problems.push('重锚定文本缺少建议式/可忽略表述')
  }
  if (problems.length) for (const p of problems) fails.push(`C18 ${p}`)
  else oks.push('C18 L2 门禁：默认关 + 在线证据件（PASS-online/未过期）+ 先轻后重 + 每会话一次 + 措辞建议式 + 效果采集在位')
}

// ── C19 硬：L3 族先验收缩的接线（默认不收缩、fail-safe、族键只来自事件流）────────
// 由来：① 先验是"外部数据进入判定"，拿不到必须**退回**固定 Jeffreys（fail-safe），
//       而不是让 p 变 NaN 或静默关掉通道；② 族键必须来自真实事件流
//       （request/header 的 provider/model + session 的 agentPreset），不许猜；
//       ③ 收缩必须"先验与本会话数据共同估计"（公式里必须同时出现 refHits 与 refLen），
//       否则就是拿族均值替代会话自己的观测——那会把"会话内自参考"这个立身之本换掉。
{
  const problems = []
  if (!/familyPriorPath: null/.test(src)) problems.push('familyPriorPath 默认必须是 null（出厂不收缩）')
  if (!/priorStrength: 20/.test(src)) problems.push('缺少 priorStrength（先验等效样本量必须可配）')
  if (!/function priorForFamily\(rec, channelName\)/.test(src)) problems.push('缺少 priorForFamily()')
  if (!/function familyKeyOf\(rec\)/.test(src)) problems.push('缺少 familyKeyOf()')
  if (!/let familyPriors = null/.test(src)) problems.push('先验状态必须初始为 null（未装载 ⇒ 不收缩）')
  const bl = src.match(/export function binomialLowerP\([\s\S]*?\n\}/)
  if (!bl) problems.push('找不到 binomialLowerP')
  else {
    if (!/refHits \+ r \* pseudo\.strength/.test(bl[0]) || !/refLen \+ pseudo\.strength/.test(bl[0])) {
      problems.push('收缩公式未同时使用 refHits 与 refLen（会退化成拿族均值替代会话观测）')
    }
    if (!/Math\.min\(0\.999, Math\.max\(0\.001, pseudo\.rate\)\)/.test(bl[0])) problems.push('先验 rate 未被夹紧（非法值会污染 p）')
  }
  if (!/event\.data\.header\.config/.test(src)) problems.push('未从 request/header 事件读取 provider/model（族键必须来自事件流）')
  if (!/d\.agentPreset/.test(src)) problems.push('未从 session 事件读取 agentPreset')
  if (!/shrinkage disabled \(fixed Jeffreys\)/.test(src)) problems.push('先验加载失败时没有明确退回固定 Jeffreys 的告警')
  if (!/contained no usable families/.test(src)) problems.push('先验表为空时没有明确告警（会静默不收缩）')
  if (!/prior: c\.prior \? \{ rate: c\.prior\.rate, strength: c\.prior\.strength, matched: c\.prior\.matched \} : null/.test(src)) {
    problems.push('通道行未暴露本次判定所用的先验')
  }
  if (problems.length) for (const p of problems) fails.push(`C19 ${p}`)
  else oks.push('C19 L3 族先验：默认不收缩、先验与本会话数据共同估计、族键只来自事件流、加载失败明确退回、先验可见')
}

// ── C20 硬：L4 闭环（自产产物 + 自门禁 + 无召回证据不授权）─────────────────────
// 由来：自动闭环某次跑时忘了传召回报告，标定器就产出了一个**更松的**产物
// （PARTIAL-PASS + 授予资格）——被 C16 与门禁用例 ⑪ 拦下了，但源头就该拦。
{
  const problems = []
  const cal = resolve(dirname(indexPath), 'tools', 'calibrate-channels.mjs')
  const loop = resolve(dirname(indexPath), 'tools', 'auto-loop.mjs')
  if (!existsSync(cal)) problems.push('找不到 tools/calibrate-channels.mjs')
  else {
    const c = readFileSync(cal, 'utf8')
    // 没有召回报告 ⇒ 不予资格（不得写成 `!recallSide || ...` 那种"没数据就放过"）
    if (/const recallOk = !recallSide \|\|/.test(c)) {
      problems.push('标定器在"召回未测"时仍可能授予资格（应为 Boolean(recallSide) && …）')
    }
    if (!/const recallOk = Boolean\(recallSide\) &&/.test(c)) problems.push('标定器缺少"无召回证据不授权"的硬性判定')
    if (!/withFamilyPrior: Boolean\(priorArtifact\)/.test(c)) problems.push('标定件未记录"标定时是否带先验"（两套 α 会无从解释）')
    if (!/derivedWithFamilyPrior/.test(c)) problems.push('标定器未产出 derivedWithFamilyPrior（带先验的 α 上不了线）')
  }
  if (!existsSync(loop)) problems.push('缺少 tools/auto-loop.mjs（L4 闭环入口）')
  else {
    const l = readFileSync(loop, 'utf8')
    if (!/check-invariants\.mjs/.test(l)) problems.push('闭环的自门禁没有包含不变量检查')
    if (!/test-policy-gate\.mjs/.test(l) || !/test-reanchor\.mjs/.test(l) || !/test-outcome-feedback\.mjs/.test(l)) {
      problems.push('闭环的自门禁没有覆盖关键套件（门禁/重锚定/回灌）')
    }
    if (!/analyze-pullback-outcomes\.mjs/.test(l)) problems.push('闭环没有产出在线证据（L2 的门会永远缺数据）')
    if (!/process\.exit\(ok \? 0 : 1\)/.test(l)) problems.push('闭环失败时没有以非零码退出（"拒绝发布"必须是硬失败）')
  }
  if (problems.length) for (const p of problems) fails.push(`C20 ${p}`)
  else oks.push('C20 L4 闭环：自产先验+标定件+在线证据、自门禁覆盖全部关键套件、失败即拒绝发布、且"召回未测不授权"写在源头')
}

// ── C21 硬：累积状态（记忆）持久化的纪律 ──────────────────────────────────────
// 由来：把"累积状态"与"派生状态"混为一谈。派生状态（配置 + 产物）每次挂载必须重算——那是修过的事故；
// 累积状态（降档窗口 / 回灌计数 / 倍率 / 纪元）是**学到的记忆**，清掉就等于"跨天自适应永远从零开始"。
// 于是拆成两条纪律：派生状态照旧重算；累积状态**按会话落盘、挂载时装载**。
// 下面每条守卫都对应一个真实风险。
{
  const problems = []
  const toolsDir = resolve(dirname(indexPath), 'tools')
  // 剥注释后再查（防止 `/* loadAdaptiveState() */` 这种注释满足检查——实测负向副本抓到）
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
  const applyBody = src.match(/export function apply\(ctx, config\) \{[\s\S]*?\n\}/)
  if (!applyBody) problems.push('找不到 apply()')
  else {
    const applyCode = stripComments(applyBody[0])
    for (const need of ['CONFIG = cloneDefaults()', 'policyArtifact = null', 'reanchorEvidence = null', 'familyPriors = null']) {
      if (!applyCode.includes(need)) problems.push(`apply() 未重置派生状态：缺 ${need}（跨挂载粘住的事故会回来）`)
    }
    if (!/loadAdaptiveState\(\)/.test(applyCode)) problems.push('apply() 未装载累积状态（记忆永远攒不满）')
  }
  const loadBody = src.match(/function loadAdaptiveState\(\) \{[\s\S]*?\n\}/)
  if (!loadBody) problems.push('找不到 loadAdaptiveState()')
  else {
    const loadCode = stripComments(loadBody[0])
    for (const need of ['delete channelFeedback[k]', 'sessionOutcomes.length = 0', 'feedbackEpoch = 0', 'autoDemote = null']) {
      if (!loadCode.includes(need)) problems.push(`loadAdaptiveState 未自清空：缺 ${need}（重复装载会翻倍计数）`)
    }
    if (!/starting from empty memory/.test(loadCode)) problems.push('装载失败时没有明确退回空记忆的告警')
    if (!/unreadable line/.test(loadCode)) problems.push('坏行没有被处理（应跳过 + 告警）')
    if (!/recordedBase === currentBase/.test(loadCode)) problems.push('倍率恢复缺少"基准 α 匹配"守卫（换标定件后旧倍率会静默生效）')
    if (!/multipliersDropped/.test(loadCode)) problems.push('丢弃倍率没有计数（不可观测）')
    if (!/slice\(-window\)/.test(loadCode)) problems.push('装载没有按 adaptiveStateWindow 取尾（文件再长也不该全量装载）')
    if (!/evaluateAutoDemote\(null\)/.test(loadCode)) problems.push('装载后未重算降档（窗口已超标却要等到下个会话）')
  }
  const recFn = src.match(/function sessionOutcomeRecord\(rec\) \{[\s\S]*?\n\}/)
  if (!recFn) problems.push('找不到 sessionOutcomeRecord()')
  else if (!/if \(!didNarrow && totalFires === 0\) return null/.test(recFn[0])) {
    problems.push('没有"无关会话不落盘"的判据（默认全关时会凭空写文件）')
  }
  if (!/adaptiveStateEnabled: true/.test(src)) problems.push('缺少 adaptiveStateEnabled 开关（无法一键关闭记忆）')
  // 测试隔离：持久化让状态跨挂载存活 ⇒ 各套件必须显式隔离（实测六个套件同时崩）
  const suitesNeedingIsolation = ['test-anchor-contract.mjs', 'test-response-policy.mjs', 'test-policy-gate.mjs',
    'test-reanchor.mjs', 'test-family-prior.mjs', 'test-outcome-feedback.mjs',
    'test-pullback-arms.mjs', 'test-audit-durability.mjs']
  for (const s of suitesNeedingIsolation) {
    const p = resolve(toolsDir, s)
    if (!existsSync(p)) { problems.push(`找不到 ${s}`); continue }
    if (!/adaptiveStateEnabled: false/.test(readFileSync(p, 'utf8'))) {
      problems.push(`${s} 未隔离累积状态（会继承别的套件写下的记忆，互相污染）`)
    }
  }
  if (problems.length) for (const p of problems) fails.push(`C21 ${p}`)
  else oks.push('C21 记忆持久化：派生状态仍每次重算、装载自清空且 fail-safe、倍率受"基准 α 匹配"守卫、装载有界、装载后重算降档、无关会话不落盘、各套件已隔离')
}

// ── C22 硬：L4 观测单元（两臂对称 + 按触发点记账）与审计跨挂载持久性 ──────────
// 由来（2026-10-08 在线数据，两条都是真事故）：
//   ① 拉回效果采集把"说过之后"的计数器挂在 `if (rec.pullback.count > 0)` 上 ⇒ 对照臂
//      （触发但故意不说）永远拿不到窗口，verifiesAfterPullback 恒为 0；而分析器要求
//      verifiesAfterPullback > 0 才算"改善" ⇒ 对照臂**恒为未改善**，两臂 Fisher 比较
//      退化成"有窗口 vs 没窗口"，会假阳性地开 L2 的门。真数据里还出现过
//      `{"arm":"intervened","pullbacks":1,"controls":1}`——对照观测被静默并入干预臂。
//   ② 审计主文件每次 flush 是重写，块序号 `rec.chunkIdx` 随挂载从 1 重新数 ⇒ 每次重启
//      既抹掉上一轮未满块的尾部缓冲，又覆写上一轮的 chunk 1..N。实测证据：目录里
//      `.jsonl.1` 是 10-08 12:30–12:54 而 `.jsonl.2` 是 09-28–10-03（序号与时间反序），
//      且 12:54–14:08 那一整段审计在磁盘上不存在。
// 下面每条都是**负向断言**：宁可钉住"旧口径不许复活"。
{
  const problems = []
  const toolsDir = resolve(dirname(indexPath), 'tools')
  const analyze = resolve(toolsDir, 'analyze-pullback-outcomes.mjs')
  // ① 两臂走同一条记录路径（口径对称靠共用代码保证，不靠自觉）
  if (!/markTrigger\(rec, 'control'/.test(src)) problems.push('对照臂没有记触发点（对照观测会被整条丢掉）')
  if (!/markTrigger\(rec, 'intervened'/.test(src)) problems.push('干预臂没有记触发点（两臂不是同一路径）')
  if (!/function markTrigger\(rec, arm, reason, turn, step\)/.test(src)) {
    problems.push('缺少唯一的 markTrigger 实现（两臂必须共用）')
  }
  // 窗口必须只有一处实现，且落盘行必须用它
  if (!/function windowAfter\(rec, trig\)/.test(src)) problems.push('缺少 windowAfter（窗口口径必须唯一）')
  if (!/\.\.\.windowAfter\(rec, t\)/.test(src)) problems.push('落盘行没有用 windowAfter 计算窗口')
  // **负向**：验证/越界的窗口计数不得再被"说过话"把守
  if (/if \(rec\.pullback\.count > 0\) rec\.pullback\.verifiesAfter/.test(src)) {
    problems.push('验证计数回到了"说过话才算"（对照臂恒为未改善 ⇒ 两臂比较是假的）')
  }
  if (/if \(rec\.pullback\.count > 0\) \{\s*const last = rec\.scopeViolations/.test(src)) {
    problems.push('越界计数回到了"说过话才算"（对照臂窗口不对称）')
  }
  // ② 观测单元是**触发点**，不是会话
  if (!/triggersInSession: triggers\.length/.test(src)) problems.push('落盘行没有标注同会话触发点数（会话级/触发点级会无从区分）')
  if (!/triggerIndex: i \+ 1/.test(src)) problems.push('落盘行没有触发点序号')
  if (!/sessionLevelFields/.test(src)) problems.push('落盘行没有标出"会话级字段"（终态字段会被误当成逐触发点指标）')
  if (/arm: rec\.pullback\.count > 0 \? 'intervened' : 'control'/.test(src)) {
    problems.push('arm 仍按会话判定（同会话的对照触发会被并入干预臂）')
  }
  // ②b 采样规则也必须两臂相同（预算与节流）。否则对照单元被富集在"干预预算已用尽"的时段，
  // 那些单元的窗口更短、verifiesAfterPullback 系统性偏低 ⇒ 对照臂被做差，朝"干预更好"偏。
  if (!/const triggersSoFar = rec\.pullback\.count \+ rec\.pullback\.controls/.test(src)) {
    problems.push('触发预算没有把两条臂一起数（对照触发不受限 ⇒ 采样规则不对称）')
  }
  if (/if \(rec\.pullback\.count >= CONFIG\.pullbackMaxPerSession\)/.test(src)) {
    problems.push('触发预算回到了"只算干预"（对照单元会被富集在最糟的时段）')
  }
  if (!/lastTriggerTurn !== null && rec\.pullback\.lastTriggerTurn === turn/.test(src)) {
    problems.push('每回合节流没有覆盖对照臂（必须用 lastTriggerTurn）')
  }
  if (/if \(rec\.pullback\.lastTurn !== null && rec\.pullback\.lastTurn === turn\)/.test(src)) {
    problems.push('每回合节流回到了"只节流说过话的那次"（对照可重复触发）')
  }
  // ③ 分析器只吃 v2 行，且判定要对"会话内相关性"保守
  if (!existsSync(analyze)) problems.push('找不到 tools/analyze-pullback-outcomes.mjs')
  else {
    const a = readFileSync(analyze, 'utf8')
    if (!/schemaVersion === 2/.test(a)) problems.push('分析器没有区分 v2 行（v1 的窗口不可比，混进来会污染证据）')
    if (!/legacyIgnored/.test(a)) problems.push('分析器没有报出被忽略的旧行（静默丢弃不可接受）')
    if (!/leaveOneSessionOut|looMaxP|maxP/.test(a)) problems.push('分析器缺少"逐会话留一"敏感性（单个会话就能定成败）')
    if (!/minSessions|min-sessions/.test(a)) problems.push('分析器没有会话级最小样本量（独立性在会话层）')
  }
  // ④ 审计接手：块序号必须先从磁盘续起，且必须发生在第一次落盘之前
  if (!/function ensureAuditFiles\(rec\)/.test(src)) problems.push('缺少 ensureAuditFiles（续号与接手必须只有一个入口）')
  if (!/drainAuditChunk[\s\S]{0,700}?ensureAuditFiles\(rec\)/.test(src)) {
    problems.push('drainAuditChunk 没有先续块序号（阈值小时会先落盘，第一步就覆写 chunk 1）')
  }
  if (!/flushRec[\s\S]{0,900}?ensureAuditFiles\(rec\)/.test(src)) problems.push('flushRec 没有接手审计文件（重写主文件会抹掉上一轮尾部）')
  if (/rec\.chunkIdx = \(rec\.chunkIdx \|\| 0\) \+ 1/.test(src) && !/adoptAuditFiles/.test(src)) {
    problems.push('块序号仍从 1 重新数（每次重启覆写上一轮的块）')
  }
  for (const s of ['test-pullback-arms.mjs', 'test-audit-durability.mjs']) {
    if (!existsSync(resolve(toolsDir, s))) problems.push(`缺少 ${s}（这两条纪律没有套件守）`)
  }
  const loop = resolve(toolsDir, 'auto-loop.mjs')
  if (existsSync(loop)) {
    const l = readFileSync(loop, 'utf8')
    if (!/test-pullback-arms\.mjs/.test(l) || !/test-audit-durability\.mjs/.test(l)) {
      problems.push('闭环的自门禁没有覆盖两臂观测/审计持久性套件')
    }
  }
  if (problems.length) for (const p of problems) fails.push(`C22 ${p}`)
  else oks.push('C22 观测单元与审计持久性：两臂共用触发记录、窗口按触发点、对照臂一样被计数、v2 行才进证据（含会话级留一敏感性）、审计块序号从磁盘续起且先于第一次落盘')
}

// ── 输出 ────────────────────────────────────────────────────────────────
for (const s of oks) console.log(`  OK    ${s}`)
for (const s of debts) console.log(`  DEBT  ${s}`)
for (const s of warns) console.log(`  WARN  ${s}`)
for (const s of fails) console.log(`  FAIL  ${s}`)
console.log(`\n[invariants] ${indexPath}`)
console.log(`  通过 ${oks.length} / 债务 ${debts.length} / 警告 ${warns.length} / 失败 ${fails.length}`)
process.exit(fails.length ? 1 : 0)
