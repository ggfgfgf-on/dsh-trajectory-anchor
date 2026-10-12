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
import { readFileSync, existsSync, readdirSync } from 'node:fs'
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

// ── C31 硬：运行面不得调用 tools.restrict（§61 瘦身：派生面结构性消灭分裂 bug）────
const anyRestrict = countCode(/\.restrict\s*\(/g)
if (anyRestrict > 0) {
  fails.push(`C31 运行面仍有 ${anyRestrict} 处 .restrict( 调用：工具面只能在组装期派生（anchorAllow 过滤），注册层 restrict 的相交语义/disposer 分裂已被结构性消灭`)
} else {
  oks.push('C31 运行面不调用 tools.restrict（工具面 100% 组装期派生）')
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

// ── C4 硬：配置面收缩（§61 瘦身：~40 键 → 12~20 键）────────────────────────
{
  const defined = [...(src.match(/const DEFAULTS = \{([\s\S]*?)\n\}/)?.[1] ?? '')
    .matchAll(/^\s{2}([A-Za-z_][A-Za-z0-9_]*):/gm)].map((m) => m[1])
  const n = defined.length
  if (n === 0) fails.push('C4 解析不出 DEFAULTS 键表')
  else if (n < 10 || n > 32) fails.push(`C4 配置键 ${n} 个，超出 [10,32]（瘦身目标 12~20，§61）`)
  else if (n > 20) warns.push(`C4 配置键 ${n} 个，仍未达到 12~20 的瘦身目标（§61）`)
  else oks.push(`C4 配置面已收缩：${n} 个键（目标 12~20）`)
}

// ── C6 硬：bootstrap 工具面在组装期派生（P1 瘦身重构接线）───────────────────
{
  const problems = []
  if (!/system-prompt\/assemble/.test(src)) problems.push('缺少 system-prompt/assemble 处理器')
  if (!/rec\.anchorAllow\.includes\(t\.name\)/.test(src)) {
    problems.push('组装期派生工具面的接线不在位（unpromoted ⇒ 只发 anchorAllow 里的工具）')
  }
  if (problems.length) for (const p of problems) fails.push(`C6 ${p}`)
  else oks.push('C6 组装期派生工具面接线在位（anchorAllow 过滤 + fail-open 全量）')
}

// ── C7 硬：两个"证据不足"档都必须留痕 ─────────────────────────────────────
// 能力面已删除（§61 瘦身）：该不变量随能力面移除。

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
// 能力面已删除（§61 瘦身）：该不变量随能力面移除。

// ── C13 硬：CONFIG 每次挂载从 DEFAULTS 重播种（防跨挂载粘住）──────────────
{
  const problems = []
  if (!/CONFIG = cloneDefaults\(\)/.test(src)) {
    problems.push('apply() 未从 DEFAULTS 重新播种 CONFIG（旧配置值会跨挂载粘住）')
  }
  if (!/function cloneDefaults\(\)/.test(src)) problems.push('缺少 cloneDefaults()（浅拷贝会让 DEFAULTS 被就地改写）')
  if (problems.length) for (const p of problems) fails.push(`C13 ${p}`)
  else oks.push('C13 CONFIG 每次挂载重播种（cloneDefaults 深拷贝）')
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
  for (const t of ['test-ledger-semantics.mjs']) {
    if (!existsSync(resolve(dirname(indexPath), 'tools', t))) problems.push(`缺少语义测试 tools/${t}`)
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

// ── C18 硬：L2' 确认即恢复的纪律（信息型、只响应当场确认、每会话一次）────────
{
  const problems = []
  if (!/reanchorOnConfirm: false/.test(src)) problems.push('reanchorOnConfirm 默认必须是 false（确认即恢复默认关）')
  if (!/function confirmReanchorAllowed\(/.test(src)) problems.push('缺少 confirmReanchorAllowed()（确认路径必须单独门控）')
  const codeNoComments = src.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
  const rd = src.match(/function reanchorDecision\([\s\S]*?\n\}/)
  if (!rd) problems.push('找不到 reanchorDecision（重锚定判定必须集中在一处）')
  else {
    if (!/rec\.reanchor\.count > 0/.test(rd[0])) problems.push('reanchorDecision 缺少"每会话只重锚定一次"的判定')
    if (!/rec\.confirm \|\| rec\.confirm\.handled === true/.test(rd[0])) problems.push('reanchorDecision 缺少"只在当场确认时开门"的判定')
  }
  if (!/function recordPullbackOutcome\(rec\)/.test(src)) problems.push('缺少效果采集 recordPullbackOutcome（L2\' 的效果没有数据来源）')
  if (!/^\s*recordPullbackOutcome\(rec\)$/m.test(codeNoComments)) problems.push('效果采集写了但没有被调用（从不执行）')
  const refn = src.match(/export function reanchorText\([\s\S]*?\n\}/)
  if (!refn) problems.push('找不到 reanchorText')
  else {
    if (!/\$\{persona\}/.test(refn[0])) problems.push('重锚定文本没有原样带回 persona（重置载荷 = 已知有效的首轮载荷）')
    const forbidden = ['必须', '务必', '禁止', 'do not', "don't", 'never', 'shall', 'follow']
    const hit = forbidden.filter((w) => refn[0].includes(w))
    if (hit.length) problems.push(`重锚定文本出现命令式措辞 [${hit.join(', ')}]`)
    if (!/忽略本条即可|建议/.test(refn[0])) problems.push('重锚定文本缺少建议式/可忽略表述')
  }
  if (problems.length) for (const p of problems) fails.push(`C18 ${p}`)
  else oks.push('C18 L2\' 确认即恢复：默认关 + 只响应当场确认 + 每会话一次 + 措辞建议式 + 效果采集在位')
}

// ── C19 硬：L3 族先验收缩的接线（默认不收缩、fail-safe、族键只来自事件流）────────
// 族先验随能力面删除（§61 瘦身）。binomialLowerP 仍作为离线判定件导出。

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
    if (!/test-pullback\.mjs/.test(l) || !/test-reanchor-confirm\.mjs/.test(l) || !/test-anchor-switch\.mjs/.test(l)) {
      problems.push('闭环的自门禁没有覆盖关键套件（拉回/确认重锚定/工具面）')
    }
    if (!/analyze-pullback-outcomes\.mjs/.test(l)) problems.push('闭环没有产出在线证据（L2 的门会永远缺数据）')
    if (!/process\.exit\(ok \? 0 : 1\)/.test(l)) problems.push('闭环失败时没有以非零码退出（"拒绝发布"必须是硬失败）')
  }
  if (problems.length) for (const p of problems) fails.push(`C20 ${p}`)
  else oks.push('C20 L4 闭环：自产先验+标定件+在线证据、自门禁覆盖全部关键套件、失败即拒绝发布、且"召回未测不授权"写在源头')
}

// ── C21 硬：累积状态（记忆）持久化的纪律 ──────────────────────────────────────
// 累积状态随能力面删除（§61 瘦身）。派生状态重播种由 C13 守住。

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
  if (!/function markTrigger\(rec, arm, reason, turn, step,/.test(src)) {
    // 只要求"前五个参数与顺序不变"（两臂共用同一入口），允许后面追加参数
    // （如 action）——否则每次扩展签名都会得到一个假失败。
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
    // ③b 随机化分层（控制率）：合并检验为主、分层复核为闸。
    // 为什么要分层：改控制率**不产生偏差**（臂在触发点上随机分配，意向性比较依然有效），
    // 但要防"时段效应"——所以任何足够大的分层方向相反时不许开门；小分层只报出不闸门。
    if (!/controlRate/.test(src) || !/controlRate: Number\.isFinite\(t\.rate\)/.test(src)) {
      problems.push('落盘行没有记录 controlRate（单元的随机化分层标识丢了，跨比例汇总无法审计）')
    }
    if (!/rateStrata/.test(a)) problems.push('分析器没有报出随机化分层（跨控制率的证据无法审计）')
    // **负向**：分层矛盾必须真的**参与判定**，不能只写进产物了事
    // （这条抓的是一个真实的自伤：我算出了 stratumContradiction 却忘了把它接进判定链，
    //  产物里写着"矛盾"、判定却说"无矛盾"——新套件第一次跑就抓到了。）
    if (!/else if \(stratumContradiction\)/.test(a)) {
      problems.push('分析器算出了分层矛盾却没有接进判定链（产物与判定会自相矛盾）')
    }
  }
  for (const s of ['test-pullback-evidence.mjs']) {
    if (!existsSync(resolve(toolsDir, s))) problems.push(`缺少 ${s}（L2 门的判定逻辑没有套件守）`)
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
  for (const s of ['test-pullback-arms.mjs', 'test-audit-durability.mjs', 'test-pullback-evidence.mjs']) {
    if (!existsSync(resolve(toolsDir, s))) problems.push(`缺少 ${s}（这些纪律没有套件守）`)
  }
  const loop = resolve(toolsDir, 'auto-loop.mjs')
  if (existsSync(loop)) {
    const l = readFileSync(loop, 'utf8')
    if (!/test-pullback-arms\.mjs/.test(l) || !/test-audit-durability\.mjs/.test(l) || !/test-pullback-evidence\.mjs/.test(l)) {
      problems.push('闭环的自门禁没有覆盖两臂观测/审计持久性/证据判定套件')
    }
  }
  if (problems.length) for (const p of problems) fails.push(`C22 ${p}`)
  else oks.push('C22 观测单元与审计持久性：两臂共用触发记录、窗口按触发点、对照臂一样被计数、采样规则两臂同一、v2 行才进证据（会话级留一 + 随机化分层闸）、审计块序号从磁盘续起且先于第一次落盘')
}

// ── C23 硬：人工试运行放行的纪律（唯一能绕过"标定不合格"的动作路径）────────────
// 试运行随能力面删除（§61 瘦身）。

// ── C24 硬：判别力评估的纪律（召回必须与"同预算随机召回"比）────────────────────
// 由来：我第一次跑候选信号评估时只看**召回绝对值**，差点得出"unverified-edit 召回 24.2%、
// 远高于统计通道 2.8% ⇒ 判别力最强"这个**错误结论**。补上同预算随机召回基线后真相反转：
// 它每会话触发 52.9 次，随机撒同样多的点本就能蒙到 36.8% —— 比随机**更差**（0.64×）；
// 按运行期节流后（1/turn、≤3/会话）≈ 随机（1.06×）。这条不变量防止后人再犯同一个错。
{
  const problems = []
  const toolsDir = resolve(dirname(indexPath), 'tools')
  const ev = resolve(toolsDir, 'evaluate-signals.mjs')
  if (!existsSync(ev)) problems.push('缺少 tools/evaluate-signals.mjs（判别力评估没有单一实现）')
  else {
    const s = readFileSync(ev, 'utf8')
    // 剥注释后再查：**"写在注释里"不算数**（这一条我自己就踩过两次——
    // 第一次是只报召回不报基线，第二次是"随机召回"只出现在注释/note 里就满足了检查）
    const code = s.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
    if (!/function chanceRecall\(/.test(code)) {
      problems.push('评估器没有"同预算随机召回"基线（高频信号会假装有判别力——这正是第一次犯过的错）')
    }
    if (!/chanceRecall\(rows, LEAD\)/.test(code)) problems.push('基线算出来了却没有进表格/产物')
    if (!/console\.log\('[^']*随机召回/.test(code)) {
      problems.push('汇总表没有把"随机召回"作为一列打出来（只写在注释或 note 里不算）')
    }
    if (!/function throttleFires\(/.test(code) || !/const throttled = throttleFires\(/.test(code)) {
      problems.push('没有真正计算"按运行期节流后"的形态')
    }
    if (!/ORDERED\.push\([^\n]*节流/.test(code)) {
      problems.push('节流形态没有被排进汇总表（算了但不报 = 没测）')
    }
    // 前提覆盖率：触发 0 次可能是"没有漂移"，也可能是"语料里没有该信号的前提"——
    // 两者结论完全不同（plan-order 就是前者：57% 覆盖但 0 触发）。不报覆盖率就无法区分。
    if (!/preconditionCoverage/.test(code)) problems.push('没有报"前提覆盖率"（0 触发无法解释）')
    if (!/console\.log\('[^']*前提覆盖/.test(code)) problems.push('汇总表没有"前提覆盖"这一列（只写进产物不算）')
    if (!/const coverage = \{\}/.test(code)) problems.push('没有统计覆盖率的数据结构')
    if (!/UNKNOWN_TOOL, ANCHOR_KINDS\.USER_CORRECTION, ANCHOR_KINDS\.ABANDONED_TURN/.test(s)) {
      problems.push('评估锚点没有收敛到强语义子集（tool-error/failure-marker 是工作常态，会把基线膨胀到 ~19%）')
    }
    if (!/OWN_SIGNAL/.test(s)) problems.push('没有声明各信号的自有信号（会循环标注）')
  }
  const rep = resolve(dirname(indexPath), 'signalEvalReport.json')
  if (!existsSync(rep)) problems.push('缺少 signalEvalReport.json（"为什么能力层关着"必须随包发布可查的证据）')
  else {
    try {
      const j = JSON.parse(readFileSync(rep, 'utf8'))
      if (j.kind !== 'drift-signal-discriminative-power') problems.push('signalEvalReport.json 的种类标记不对')
      for (const name of ['unverified-edit·节流', 'edit-thrash·节流', 'inaction', 'repetition', 'failure']) {
        const e = (j.signals && j.signals[name]) || (j.reference && j.reference[name])
        if (!e) { problems.push(`signalEvalReport.json 缺少 ${name} 的结果`); continue }
        if (!Number.isFinite(e.chanceRecall)) problems.push(`signalEvalReport.json 的 ${name} 没有随机召回基线`)
        if (!Number.isFinite(e.precisionLift)) problems.push(`signalEvalReport.json 的 ${name} 没有精度倍数`)
      }
    } catch (e) { problems.push(`signalEvalReport.json 解析失败：${e.message}`) }
  }
  if (problems.length) for (const p of problems) fails.push(`C24 ${p}`)
  else oks.push('C24 判别力评估：召回必须与**同预算随机召回**比较、必须测"按运行期节流后"的部署形态、锚点收敛到强语义子集且排除自有信号，结论随包发布')
}

// ── C25 硬：bootstrap 上下文抑制的 fail-open 契约 ───────────────────────────────
// 由来：上下文抑制（替换 persona 段 + 摘掉 runtime context）是**已经在跑**的功能，
// 却一直没有专门的安全审计。做审计时当场发现一个真缺陷：还原函数**无论成败**都把
// `contextSuppressed` 置 false ⇒ disposer 抛错时状态会**说谎**（显示"未抑制"、实际
// persona 仍被替换），而开头那句早退又让重试永久失效 —— 永久卡在看不见的降级里，
// 正是本项目最重那次事故（工具面被摘、归还路径不可达）的翻版。
{
  const problems = []
  const toolsDir = resolve(dirname(indexPath), 'tools')
  const r = (src.match(/function restoreBootstrapContext\(rec\)[\s\S]*?\n\}/) || [''])[0]
  if (!r) problems.push('取不到 restoreBootstrapContext 函数体（模式串失配）')
  else {
    // 必须"只有成功才敢写未抑制"
    if (!/if \(ok\) \{[\s\S]{0,140}?rec\.contextSuppressed = false/.test(r)) {
      problems.push('还原无条件把 contextSuppressed 置 false（失败时状态会说谎——这就是修掉的那个缺陷）')
    }
    const beforeOk = r.split('if (ok)')[0]
    if (/rec\.contextSuppressed = false/.test(beforeOk)) {
      problems.push('在 `if (ok)` 之前就写了 contextSuppressed = false（乐观置位）')
    }
    if (!/contextRestoreError/.test(r)) problems.push('还原失败没有留错误字段（失败不可见）')
    else if (!/'restore-failed'/.test(r)) {
      // 只要求"出现了这个字段名"太松：`rec.contextRestoreError = null`（成功分支）也能满足它。
      // 必须要求**失败分支真的记了东西**——这是我第二次被"检查被别处的字样满足"咬到。
      problems.push('失败分支没有真的记录错误（只出现字段名不算）')
    }
    if (!/stillSuppressed: rec\.contextSuppressed === true/.test(r)) {
      problems.push('审计没有写明"是否仍然被抑制"（还原结果的语义必须可查）')
    }
  }
  if (!/contextRestoreError: rec\.contextRestoreError \|\| null/.test(src)) {
    problems.push('状态里没有暴露 contextRestoreError')
  }
  if (!/suppressedSources: CONFIG\.suppressedSources\.slice\(\)/.test(src)) {
    problems.push('状态里没有暴露 suppressedSources（"到底摘了什么"必须可见）')
  }
  // 抑制清单不许含插件自己的消息种类（否则 L1 的提醒会被自己的抑制吃掉）
  if (!/suppressedSources must not contain the plugin's own message kinds/.test(src)) {
    problems.push('缺少"抑制清单不得含自有消息种类"的配置守卫')
  }
  for (const s of ['test-context-suppression.mjs']) {
    if (!existsSync(resolve(toolsDir, s))) problems.push(`缺少 ${s}（这条契约没有套件守）`)
  }
  const loop3 = resolve(toolsDir, 'auto-loop.mjs')
  if (existsSync(loop3) && !/test-context-suppression\.mjs/.test(readFileSync(loop3, 'utf8'))) {
    problems.push('闭环的自门禁没有覆盖上下文抑制审计')
  }
  if (problems.length) for (const p of problems) fails.push(`C25 ${p}`)
  else oks.push('C25 上下文抑制 fail-open：锚定即抑制且可见、有晋升与窗口两条还原路径、服务不可用则不抑制、**还原失败时状态不说谎**（保持 true + 暴露错误 + 留重试）、抑制清单不得含自有消息种类')
}

// ── C26（DEBT 登记）：随能力面删除（§61 瘦身）───────────────────────────────

// ── C27 硬：L2'「确认即恢复」的纪律（不做预测、只响应已确认的问题）──────────────
// 由来：L2 原来的门要求"拉回**有效**"的在线证据（回答"有没有用"），而"防降智"因此长期**没有
// 执行器**（通知层/能力层/L2 全关，只剩 L1 管任务事实）。L2' 把问题换成一个**当场可确认**的
// 问题："已经确认出问题了（用户纠正/工具不存在/验证未通过），把已知有效的首轮载荷放回去"。
// 它可以不需要效果件的前提是：载荷是**信息型**的（不改工具面、不改系统基线、不删信息），
// 与 L1 同一风险类别；但必须——只响应确认、每会话一次、硬闸门优先、留痕、**有对照臂**。
{
  const problems = []
  const toolsDir = resolve(dirname(indexPath), 'tools')
  // ① 默认关 + 三种确认信号
  if (!/reanchorOnConfirm: false/.test(src)) problems.push('缺少 reanchorOnConfirm 出厂默认 false')
  if (!/function noteConfirmation\(rec, reason, turn, step, detail\)/.test(src)) problems.push('缺少 noteConfirmation（确认信号必须单一入口）')
  for (const r of ['user-correction', 'unknown-tool', 'verify-failed']) {
    if (!new RegExp(`noteConfirmation\\(rec, '${r}'`).test(src)) problems.push(`确认信号 ${r} 没有被接线`)
  }
  // ② 纠偏判据必须**共用离线标注那一份**（不许在运行时再写一份）
  if (!/import \{ CORRECTION_CUES \} from '\.\/tools\/drift-label-core\.mjs'/.test(src)) {
    problems.push('运行时没有共用 CORRECTION_CUES（判据会与离线标注悄悄漂移）')
  }
  // ③ 硬闸门随能力面删除（§61 瘦身）：确认路径只受 reanchorOnConfirm 开关与每会话一次约束。
  // ④ 每会话一次：**两条臂都要消费**确认信号（否则对照臂会无限重复触发）。
  //    "存在一处赋值"太松——干预臂被删掉、对照臂那处还在，检查照样通过（负向副本抓到过）。
  const handledCount = (src.match(/rec\.confirm\.handled = true/g) || []).length
  if (handledCount < 2) {
    problems.push(`确认信号被消费的处数 ${handledCount} < 2（干预臂与对照臂都必须消费）`)
  }
  if (!/reanchorConfirmControlRate > 0 && Math\.random\(\) < CONFIG\.reanchorConfirmControlRate/.test(src)) {
    problems.push('确认路径没有随机化对照（只有单臂 ⇒ 效果永远估不出来）')
  }
  if (!/logAudit\(rec, 'reanchor-control'/.test(src)) problems.push('对照臂没有审计留痕')
  // ⑤b `verify-failed` 必须是"**宣告完成之后**仍失败"才算确认 —— 红色测试是正常工作状态。
  //    （2026-10-09 线上真实误触发：我跑一次**故意红**的基准夹具就把重锚定触发了。）
  if (!/if \(rec\.claimedDoneAt\) \{/.test(src)) {
    problems.push('verify-failed 没有要求"先宣告完成"（红色测试=正常工作状态，会误触发重锚定）')
  }
  if (!/logAudit\(rec, 'confirm-declined'/.test(src)) problems.push('被拒绝的确认信号没有留痕（看不见的抑制）')
  // ⑤ 落盘行必须区分动作（两种动作混在一起算会把两条效果糊成一条）
  if (!/action: t\.action \|\| 'pullback'/.test(src)) problems.push('落盘行没有 action 字段（pullback 与 reanchor 会混在一起）')
  if (!/function markTrigger\(rec, arm, reason, turn, step, action = 'pullback'\)/.test(src)) {
    problems.push('markTrigger 没有 action 参数（两种动作必须走同一入口但可区分）')
  }
  // ⑥ 可测性跟着执行器走：只开确认路径时也必须落盘
  if (!/CONFIG\.pullbackEnabled !== true && CONFIG\.reanchorOnConfirm !== true/.test(src)) {
    problems.push('只开确认路径（L1 关）时效果不会被落盘 ⇒ 那条路径的效果永远测不出来')
  }
  // ⑦ 分析器必须分开报
  const an = resolve(toolsDir, 'analyze-pullback-outcomes.mjs')
  if (existsSync(an)) {
    const a = readFileSync(an, 'utf8')
    if (!/r\.action === 'reanchor'/.test(a)) problems.push('分析器没有把 reanchor 行分出来')
    if (!/reanchor: \{/.test(a)) problems.push('分析器没有单独报 reanchor 的效果')
  }
  for (const s of ['test-reanchor-confirm.mjs']) {
    if (!existsSync(resolve(toolsDir, s))) problems.push(`缺少 ${s}`)
  }
  const loop4 = resolve(toolsDir, 'auto-loop.mjs')
  if (existsSync(loop4) && !/test-reanchor-confirm\.mjs/.test(readFileSync(loop4, 'utf8'))) {
    problems.push('闭环的自门禁没有覆盖确认即恢复套件')
  }
  if (problems.length) for (const p of problems) fails.push(`C27 ${p}`)
  else oks.push('C27 确认即恢复：默认关、三种确认信号共用离线判据、硬闸门优先、每会话一次、有对照臂、落盘区分动作、只开它也照样记账、分析器分开报')
}

// ── C28 硬：被实测否定的判据不得回到判断面（风格/词典通道的"结构性关闭"）────────
// 能力面（含词典/风格通道与标定件授权）已删除（§61 瘦身）。词典本身仍作为锚定判据保留。

// ── C29 硬：工具链/元数据不得说谎（本轮的闭环真的抓到了一条）────────────────────
// 由来：本轮我用 PowerShell `Set-Content -Encoding UTF8` 改 package.json —— 当前 shell 是
// Windows PowerShell **5.1**，它写的 UTF-8 **带 BOM**。于是：
//   ① 不变量自己 `JSON.parse(package.json)` 直接抛（闭环报 FAIL，是我自己发现的入口）；
//   ② 更隐蔽的是 `calibrate-channels.mjs` 读版本失败后**保底写 "unknown"**，
//      于是出厂标定件里的 `pluginVersion` 与 package.json 不符，而**没有任何地方会报错**。
// 所以这条不变量钉两件事：源文件不许带 BOM；出厂产物里的版本号必须与 package.json 一致。
// ⚠ 这**不是新坑**：DSH 操作要点（dsh_notes）§31 早已实锤，且记着它的最坏后果是
//    「重启后整站打不开」（DSH 启动时 parse 每个包的 package.json，BOM ⇒ SyntaxError ⇒
//    插件加载崩溃 ⇒ web 壳注入不了 __ModuleLoader__ facade）。本轮是运气好，先炸在
//    不变量与产物版本号上。C29 的作用就是把"手册里的规矩"变成**机器可查**的一条：
//    文本一律用 write/edit 工具；必须用 pwsh 写文本时用
//    `[System.IO.File]::WriteAllText(..., New-Object System.Text.UTF8Encoding($False))`。
{
  const problems = []
  const rel = ['package.json', 'index.js', ...readdirSync(resolve(dirname(indexPath), 'tools')).filter((f) => f.endsWith('.mjs')).map((f) => `tools/${f}`),
    ...readdirSync(dirname(indexPath)).filter((f) => f.endsWith('.json') && !f.startsWith('.')).map((f) => f)]
  const bom = []
  for (const f of rel) {
    const p = resolve(dirname(indexPath), f)
    if (!existsSync(p)) continue
    const b = readFileSync(p)
    if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) bom.push(f)
  }
  if (bom.length) problems.push(`源文件带 BOM（让 JSON 解析器直接抛，且会把假值写进产物）：${bom.slice(0, 6).join(', ')}`)
  // 出厂产物必须写明**当前**版本（否则"标定件是为哪个版本算的"就是假的）
  const pkgPath = resolve(dirname(indexPath), 'package.json')
  const artPath = resolve(dirname(indexPath), 'responsePolicy.json')
  if (existsSync(pkgPath) && existsSync(artPath)) {
    let pkgVersion = null
    let art = null
    try { pkgVersion = JSON.parse(readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, '')).version } catch (e) { problems.push(`package.json 解析失败：${e.message}`) }
    try { art = JSON.parse(readFileSync(artPath, 'utf8').replace(/^\uFEFF/, '')) } catch (e) { problems.push(`responsePolicy.json 解析失败：${e.message}`) }
    if (art && pkgVersion) {
      const v = art.scope && art.scope.pluginVersion
      if (v !== pkgVersion) problems.push(`标定件的 pluginVersion=${v} 与 package.json 的 ${pkgVersion} 不符（改版本号后必须重跑 calibrate-channels.mjs）`)
      if (!Number.isFinite(Date.parse(art.generatedAtUtc))) problems.push('标定件缺可解析的 generatedAtUtc')
    }
  }
  if (problems.length) for (const p of problems) fails.push(`C29 ${p}`)
  else oks.push(`C29 元数据不说谎：源文件无 BOM（${rel.length} 个），标定件 pluginVersion 与 package.json 一致`)
}

// ── C30 硬：门禁不许漏接套件（"有测试但没接进门禁"= 等于没测）──────────────────
// 由来：本轮为 A/B 实验新写了 tools/test-anchor-switch.mjs 之后，闭环的套件清单是**显式数组**，
// 差一点就被漏掉——而"文件在、门禁没跑"与"没有这个测试"在效果上完全一样。
// 所以这条直接把"每个 tools/test-*.mjs 都必须出现在闭环清单里"变成机器可查的一条。
{
  const problems = []
  const toolsDir30 = resolve(dirname(indexPath), 'tools')
  const loop = resolve(toolsDir30, 'auto-loop.mjs')
  if (!existsSync(loop)) problems.push('缺少 tools/auto-loop.mjs（闭环门禁）')
  else {
    const loopSrc = readFileSync(loop, 'utf8')
    const suites = readdirSync(toolsDir30).filter((f) => /^test-.*\.mjs$/.test(f)).sort()
    const missing = suites.filter((f) => !loopSrc.includes(f))
    if (missing.length) problems.push(`这些套件没有接进闭环门禁（等于没测）：${missing.join(', ')}`)
    else if (suites.length < 10) problems.push(`只找到 ${suites.length} 个套件（数量异常，检查是否误删）`)
  }
  if (problems.length) for (const p of problems) fails.push(`C30 ${p}`)
  else oks.push('C30 门禁不漏接：每个 tools/test-*.mjs 都出现在闭环 auto-loop.mjs 的套件清单里')
}

// ── 输出 ────────────────────────────────────────────────────────────────
for (const s of oks) console.log(`  OK    ${s}`)
for (const s of debts) console.log(`  DEBT  ${s}`)
for (const s of warns) console.log(`  WARN  ${s}`)
for (const s of fails) console.log(`  FAIL  ${s}`)
console.log(`\n[invariants] ${indexPath}`)
console.log(`  通过 ${oks.length} / 债务 ${debts.length} / 警告 ${warns.length} / 失败 ${fails.length}`)
process.exit(fails.length ? 1 : 0)
