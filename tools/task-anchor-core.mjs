/**
 * task-anchor-core.mjs —— 任务锚定信号：从"提示里的约束"与"工具流"读出**可客观标注**的漂移
 *
 * 为什么做这个（L0-e 的由来）：统计类行为通道（A′ 中途停手 / C 重复 / B 失败）在真实语料上
 * 被实测否决——最宽的 α 下召回 4.3%、精度比随机基线低三倍（见 measure-recall.mjs 的结论）。
 * 但语料里有另一类漂移是**可判定的**：基准提示把范围与验收写死在正文里
 *   · "The directory bugfix-a4 … Work only inside bugfix-a4."
 *   · "工作区仅限 D:\DSHwork\modeltest\workspace 目录 … 不要读取、搜索或依赖 workspace 外的内容"
 *   · "Report ONE line: PASS=<n>/7"
 * 于是"改了范围外的文件""读了被禁止读的地方""没验证就宣布通过"这类**是事实问题，不是概率问题**。
 *
 * 设计原则（与项目其它部分一致）：
 *   · **不猜**：提示里没写清范围就返回 `parsed: false`，绝不"大概差不多"地推断一个范围出来；
 *   · **只读**：本模块是纯函数，不碰文件系统（路径比较只做字符串规范化）；
 *   · **可对拍**：判定规则写成小函数，由单测用合成用例 + 负向用例固定（含"范围内写入不得被标"）。
 *
 * 诚实边界：这里判的是"违反提示里写明的约束"，不是"模型心里有没有跑偏"。
 * 前者有金标准，后者没有——所以能用前者驱动拉回，不能用后者。
 */

/** 把路径规范化成可比较形式：反斜杠→斜杠、折叠重复斜杠、去尾部斜杠、小写（Windows 大小写不敏感）。 */
export function normalizePath(p) {
  if (typeof p !== 'string' || p.length === 0) return ''
  let s = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/').trim()
  s = s.replace(/\/+$/, '')
  return s.toLowerCase()
}

/** 取路径的最后一段（文件名或目录名）。 */
export function baseName(p) {
  const s = normalizePath(p)
  if (!s) return ''
  const parts = s.split('/')
  return parts[parts.length - 1] || ''
}

/** 提示里出现的"范围名"：形如 bugfix-a4 的目录名，或绝对目录路径。 */
const DIR_NAME_RE = /\b([A-Za-z][\w.-]*-\w[\w.-]*)\b/g
const ABS_DIR_RE = /([A-Za-z]:[\\/][^\s"'`，。；、）)]+)/g

/**
 * 解析提示里的任务锚点。**只在能明确读出时才返回 parsed: true**。
 *
 * @param {string} prompt 首条人类消息
 * @returns {{
 *   parsed: boolean, reason?: string,
 *   scopeNames: string[], scopeDirs: string[], outsideForbidden: boolean,
 *   verifyTokens: string[], reportFormat: {kind:string, total:number|null}|null,
 *   evidence: {scopeClause?: string, forbidClause?: string, verifyClause?: string, reportClause?: string}
 * }}
 */
export function parseTaskAnchors(prompt) {
  const text = typeof prompt === 'string' ? prompt : ''
  const evidence = {}
  const scopeNames = []
  const scopeDirs = []
  let outsideForbidden = false

  // ① 英文式范围子句："Work only inside bugfix-a4" / "only inside the X directory"
  const enScope = text.match(/work only inside\s+([^\s,.]+)/i) || text.match(/only (?:modify|touch|edit|change)[^.]*?\b([A-Za-z][\w.-]*-\w[\w.-]*)\b/i)
  if (enScope) {
    evidence.scopeClause = enScope[0].trim()
    scopeNames.push(baseName(enScope[1]))
  }
  // ② 中文式范围子句："工作区仅限 D:\...\workspace 目录" / "仅在 X 内" / "只依赖 workspace 内内容"
  const cnScope = text.match(/(?:工作区)?(?:仅限|只限|仅|只)(?:在)?\s*([A-Za-z]:[\\/][^\s，。；、）)]+)/)
  if (cnScope) {
    evidence.scopeClause = evidence.scopeClause || cnScope[0].trim()
    scopeDirs.push(normalizePath(cnScope[1]))
  }
  const cnScope2 = text.match(/只依赖\s*([^\s，。；、]+)\s*内/)
  if (cnScope2) {
    evidence.scopeClause = evidence.scopeClause || cnScope2[0].trim()
    const n = baseName(cnScope2[1])
    if (n) scopeNames.push(n)
  }
  // ③ 禁止越界子句："不要读取、搜索或依赖 workspace 外的内容" / "do not read outside ..."
  // 注意"workspace 外"里可能**有空格**（实测的中文提示就是这样），所以 (?:…)\s*外。
  const forbid = text.match(/不要[^。；\n]{0,40}?(?:范围|workspace|工作区|工作目录)\s*外/i)
    || text.match(/(?:do not|don't|never)\s+(?:read|search|access|look)[^.\n]{0,40}outside/i)
    || text.match(/(?:范围|workspace|工作区)\s*外[^。；\n]{0,10}?(?:不要|禁止|不得)/)
  if (forbid) {
    outsideForbidden = true
    evidence.forbidClause = forbid[0].trim()
  }
  // ④ 兜底：正文里出现 X-N 形态的目录名（如 bugfix-a1）且带 "directory"/"目录" 字样
  if (scopeNames.length === 0 && scopeDirs.length === 0) {
    const dirMention = text.match(/(?:directory|目录)\s*([A-Za-z][\w.-]*-\w[\w.-]*)/i)
    if (dirMention) {
      scopeNames.push(baseName(dirMention[1]))
      evidence.scopeClause = evidence.scopeClause || dirMention[0].trim()
    }
  }
  // 绝对路径形式的目录：从"工作区仅限"之外，还允许"current workspace is D:\..."这类写法
  if (scopeDirs.length === 0) {
    const absMention = text.match(/(?:workspace|工作区)[^\n]{0,20}?([A-Za-z]:[\\/][^\s，。；、）)"]+)/)
    if (absMention && /仅限|只限|is the|in the/i.test(text.slice(Math.max(0, (absMention.index || 0) - 30), (absMention.index || 0) + 10))) {
      scopeDirs.push(normalizePath(absMention[1]))
    }
  }

  // ⑤ 验证命令：括号里的命令 / 显式 python|pytest|npm test 之类
  const verifyTokens = []
  const parenCmd = text.match(/\(([^)]*\b(?:python|pytest|npm|node|go test|cargo test|dotnet test)\b[^)]*)\)/i)
  if (parenCmd) {
    evidence.verifyClause = parenCmd[0].trim()
    const toks = parenCmd[1].split(/\s+/).filter((x) => /\.(py|js|ts|ps1|sh)$|test|pytest/i.test(x))
    for (const t of toks) if (!verifyTokens.includes(t)) verifyTokens.push(t)
  }
  for (const m of text.matchAll(/\b(pytest|npm test|go test|cargo test|dotnet test)\b/gi)) {
    if (!verifyTokens.includes(m[1])) verifyTokens.push(m[1])
  }

  // ⑥ 报告格式：PASS=<n>/<m>
  let reportFormat = null
  const rep = text.match(/PASS\s*=\s*<n>\s*\/\s*(\d+)/i) || text.match(/PASS\s*=\s*(\d+)\s*\/\s*(\d+)/i)
  if (rep) {
    reportFormat = { kind: 'PASS=n/m', total: Number(rep[rep.length - 1]) }
    evidence.reportClause = rep[0].trim()
  }

  const parsed = scopeNames.length > 0 || scopeDirs.length > 0
  if (!parsed) {
    return {
      parsed: false,
      reason: '提示里没有可识别的范围约束（仅限/only inside/目录+名称）——按"不猜"原则不产出锚点',
      scopeNames, scopeDirs, outsideForbidden, verifyTokens, reportFormat, evidence,
    }
  }
  return { parsed: true, scopeNames, scopeDirs, outsideForbidden, verifyTokens, reportFormat, evidence }
}

/** 路径是否在范围内：绝对范围目录用前缀匹配；范围名用"路径段名相等"匹配。 */
export function inScope(path, anchors) {
  const p = normalizePath(path)
  if (!p) return true                     // 空路径不是"越界"，是无法判定
  for (const d of anchors.scopeDirs || []) {
    if (d && (p === d || p.startsWith(d + '/'))) return true
  }
  for (const n of anchors.scopeNames || []) {
    if (!n) continue
    const segs = p.split('/')
    if (segs.includes(n.toLowerCase())) return true
  }
  return false
}

/**
 * **从会话自身行为**识别"这是一条验证命令"（不依赖提示里写没写）。
 *
 * 为什么需要：L1 的"未验证"信号原先只在提示声明了**范围子句**时才启用——于是自由形态的长会话
 * （比如这个项目自己的会话，提示里没有"Work only inside X"）永远沉默，观察期攒不到任何数据，
 * 能力就停在"存在但从不运行"。而"跑过测试/构建"这件事**在会话里就能看见**，不需要提示声明。
 *
 * 判据保守（宁可漏检也不误报）：只认明确的测试/构建命令形态。
 * @returns {string|null} 命中的形态名（便于审计"凭什么认为它是验证"）
 */
export function verifyCommandKind(cmd) {
  if (typeof cmd !== 'string' || cmd.length === 0) return null
  const c = cmd.toLowerCase()
  const patterns = [
    ['pytest', /\bpytest\b/],
    ['python-unittest', /\bpython[0-9.]*\s+-m\s+(unittest|pytest)\b/],
    ['python-test-file', /\bpython[0-9.]*\s+[^\s]*test[^\s]*\.py\b/],
    ['npm-test', /\bnpm\s+(run\s+)?test\b/],
    ['pnpm-test', /\bpnpm\s+(run\s+)?(test|check|verify)\b/],
    ['yarn-test', /\byarn\s+(run\s+)?test\b/],
    ['node-test', /\bnode\s+--test\b/],
    ['go-test', /\bgo\s+test\b/],
    ['cargo-test', /\bcargo\s+(test|check)\b/],
    ['dotnet-test', /\bdotnet\s+test\b/],
    ['make-test', /\bmake\s+(test|check)\b/],
    ['gradle-test', /\b(\.\/)?gradlew?\s+\S*test\b/],
    ['maven-test', /\bmvn\s+\S*test\b/],
    ['run-tests-script', /\b(run|invoke)[-_ ]?(public[-_ ]?)?tests?\.(py|ps1|sh|js|mjs)\b/],
    ['vitest-jest', /\b(vitest|jest)\b/],
    ['tsc-check', /\btsc\b[^|]*--noemit|--noemit[^|]*\btc\b/],
  ]
  for (const [name, re] of patterns) if (re.test(c)) return name
  return null
}

/** 会改文件的工具（用于区分"越界读"与"越界写"）。 */
const WRITE_TOOLS = new Set(['edit', 'write', 'str_replace_editor', 'notebook_edit', 'apply_patch'])
/** 只读工具（读取/搜索）。 */
const READ_TOOLS = new Set(['read', 'grep', 'glob', 'read_image'])
/** 运行时也要用同一套分类：越界**写**是信号，越界读不是（本轮口径）。 */
export const isWriteTool = (name) => WRITE_TOOLS.has(typeof name === 'string' ? name : '')
export const isReadTool = (name) => READ_TOOLS.has(typeof name === 'string' ? name : '')

/**
 * 与"任务范围"无关的路径：临时目录、虚拟环境、包缓存、系统解释器。
 * 为什么必须排除（实测假阳，v1 的第一版就在这些地方刷出 62 个"越界写"）：
 *   · `C:\Users\…\AppData\Local\Temp\p2_verify.py` —— 代理写临时脚本是**正常**做法；
 *   · `D:\DSHwork\modeltest\.venv312\Scripts\python` —— venv 里的解释器；
 *   · `C:\Espressif\python_env\idf5.5_py3.11_env` —— 工具链自带的 Python。
 * 把这些算成"越界"就是把"用了工具链"误判成"跑偏"，与统计通道当年把"回合末步"算成停手同类。
 */
const IGNORED_PATH_RE = /(?:^|\/)(?:temp|tmp|node_modules|\.venv[\w.-]*|venv|python_env|env|\.cache|cache|\.git|site-packages|appdata\/local\/temp|windows\/system32)(?:\/|$)/i
/** 只看得出是"路径"的字符串才参与范围判定（拒绝 URL、模板串、带花括号的伪路径）。 */
export function looksLikePath(s) {
  if (typeof s !== 'string' || s.length < 3) return false
  if (/[{}$*?<>|"]/.test(s)) return false
  if (/^[a-z]+:\/\//i.test(s)) return false            // URL
  if (/^[A-Za-z]:[\\/]/.test(s)) return true            // 绝对路径
  if (/^\.{1,2}[\\/]/.test(s)) return true              // 相对路径
  if (/^[A-Za-z0-9_.-]+[\\/][^\s]+$/.test(s)) return true // 形如 dir/file
  return false
}
/** 路径是否属于"与任务无关"的那类（临时/venv/缓存/系统）。 */
export function isIgnorablePath(s) {
  return IGNORED_PATH_RE.test(normalizePath(s))
}

/**
 * **严格**抽路径：只取工具参数里的路径字段。
 * 为什么不从 shell 命令里抽（v1 的教训）：`command` 里出现的路径多数是**解释器/工具链**，
 * 不是被改写的目标文件；实测这样抽出来的 62 条"越界写"里，真越界为 0，全是假阳。
 * 改动文件要么走 edit/write 这类工具（有明确 file_path），要么走 shell 重定向——后者
 * 宁可漏检也不误报（判据保守原则与词表/通道一致）。
 */
export function pathsFromCallStrict(name, args) {
  if (!WRITE_TOOLS.has(name) && !READ_TOOLS.has(name)) return []
  let a = args
  if (typeof a === 'string') {
    const s = a.trim()
    if (!s.startsWith('{')) return looksLikePath(s) ? [s] : []
    try { a = JSON.parse(s) } catch { return [] }
  }
  if (!a || typeof a !== 'object') return []
  const out = []
  for (const key of ['file_path', 'path', 'filePath', 'filename', 'notebook_path', 'target']) {
    const v = a[key]
    if (typeof v === 'string' && looksLikePath(v)) out.push(v)
  }
  if (Array.isArray(a.paths)) for (const p of a.paths) if (typeof p === 'string' && looksLikePath(p)) out.push(p)
  return out
}

/** 从工具调用参数里抽路径（不同工具字段名不同）。 */
export function pathsFromCall(name, args) {
  const out = []
  if (args === null || args === undefined) return out
  let a = args
  if (typeof a === 'string') {
    const s = a.trim()
    if (!s.startsWith('{')) {
      // 纯字符串参数：可能是路径，也可能是命令——两种都收，交给调用方按工具分类
      out.push(s)
      return out
    }
    try { a = JSON.parse(s) } catch { return out }
  }
  if (typeof a !== 'object') return out
  for (const key of ['file_path', 'path', 'filePath', 'filename', 'notebook_path', 'target']) {
    if (typeof a[key] === 'string' && a[key]) out.push(a[key])
  }
  if (Array.isArray(a.paths)) for (const p of a.paths) if (typeof p === 'string') out.push(p)
  if (typeof a.command === 'string') out.push(...commandPaths(a.command))
  return out
}

/** 从 shell 命令里抽"看起来像路径"的片段（用于 pwsh 类工具）。 */
export function commandPaths(cmd) {
  if (typeof cmd !== 'string' || !cmd) return []
  const out = []
  // 绝对路径（含盘符）与相对路径（含 ./ 或已知扩展名）
  for (const m of cmd.matchAll(/([A-Za-z]:[\\/][^\s"'`;|,)]+)/g)) out.push(m[1])
  for (const m of cmd.matchAll(/(\.{1,2}[\\/][^\s"'`;|,)]+)/g)) out.push(m[1])
  return out
}

/**
 * 扫描工具调用，产出**可客观断言**的事件与标签。
 *
 * 标签种类：
 *   · `scope-write`   —— 改文件的调用落在声明的范围外（硬违规）
 *   · `scope-read`    —— 读/搜/看落在范围外，且提示里明确禁止了"范围外"（否则只记事件不标）
 *   · `verify-run`    —— 命中验证命令（用于判定"是否验证过"）
 *
 * @param {Array<object>} events 会话事件
 * @param {object} anchors parseTaskAnchors 的产物
 * @param {object} [opts]
 * @param {boolean} [opts.labelOutOfScopeRead] 是否把越界读也标为漂移（默认 = anchors.outsideForbidden）
 * @returns {{events:Array, labels:Array, verifyRuns:Array, writes:Array}}
 */
export function scanToolCalls(events, anchors, opts = {}) {
  const list = Array.isArray(events) ? events : []
  const labelReads = opts.labelOutOfScopeRead ?? anchors.outsideForbidden === true
  const labels = []
  const verifyRuns = []
  const writes = []
  const ignored = []
  const kindOf = (name) => {
    if (WRITE_TOOLS.has(name)) return 'write'
    if (READ_TOOLS.has(name)) return 'read'
    return 'other'
  }
  for (const ev of list) {
    if (!ev || ev.type !== 'tool/call') continue
    const d = ev.data || {}
    const name = typeof d.name === 'string' ? d.name : ''
    const turn = typeof d.turn === 'number' ? d.turn : null
    const step = typeof d.step === 'number' ? d.step : null
    const rawArgs = typeof d.arguments === 'string' ? d.arguments : (d.arguments === undefined ? '' : JSON.stringify(d.arguments))
    // 验证命令
    const cmd = (() => {
      if (typeof d.arguments === 'object' && d.arguments && typeof d.arguments.command === 'string') return d.arguments.command
      const m = typeof rawArgs === 'string' ? rawArgs.match(/"command"\s*:\s*"([^"]*)"/) : null
      return m ? m[1] : (typeof d.arguments === 'string' && !rawArgs.trim().startsWith('{') ? d.arguments : '')
    })()
    const isVerify = (anchors.verifyTokens || []).some((t) => cmd && cmd.includes(t))
      || /(\.py|pytest|npm test|go test|cargo test)/i.test(cmd || '') && /test/i.test(cmd || '')
    if (isVerify) verifyRuns.push({ turn, step, cmd: String(cmd).slice(0, 160) })
    // 路径与范围（**只取工具参数里的路径**，见 pathsFromCallStrict 的说明）
    const kind = kindOf(name)
    if (kind === 'other') continue
    for (const path of pathsFromCallStrict(name, d.arguments)) {
      if (isIgnorablePath(path)) { ignored.push({ turn, step, tool: name, path }); continue }
      const inside = inScope(path, anchors)
      if (!inside) {
        if (kind === 'write') {
          labels.push({ kind: 'scope-write', turn, step, tool: name, path, detail: `写操作落在范围外：${path}` })
        } else if (labelReads) {
          labels.push({ kind: 'scope-read', turn, step, tool: name, path, detail: `读取落在范围外（提示明确禁止）：${path}` })
        }
      } else if (kind === 'write') {
        writes.push({ turn, step, tool: name, path })
      }
    }
  }
  return { events: list.length, labels, verifyRuns, writes, ignored }
}

/**
 * 从末条助手文本读出"声明"。只认**明确**的声明，模糊表述记为 null。
 *
 * 实测教训：`PASS=n/m` 必须取**最后一次**出现。会话 35da9cd3 的正文是
 * "tests went from PASS=3/7 to all green. PASS=7/7"——取第一次会把"历史值"当成声明，
 * 于是把一次**正确的**完成判成"声明未达标"（假阳，人工审计抓出来的）。
 * @returns {{claimedPass: number|null, claimedTotal: number|null, claimedDone: boolean, raw: string|null}}
 */
export function claimsFromFinalMessage(text) {
  const t = typeof text === 'string' ? text : ''
  let claimedPass = null
  let claimedTotal = null
  let raw = null
  const re = /PASS\s*=\s*(\d+)\s*\/\s*(\d+)/gi
  let m
  while ((m = re.exec(t)) !== null) { claimedPass = Number(m[1]); claimedTotal = Number(m[2]); raw = m[0] }
  const claimedDone = /(已修好|已修复|修复完成|完成|可提测|全部通过|all (?:tests )?pass|fixed|done)/i.test(t)
  return { claimedPass, claimedTotal, claimedDone, raw }
}

/** 会让"先前验证"失效的文件类型（代码/配置）；文档不算。 */
const CODE_EXT_RE = /\.(py|js|mjs|cjs|ts|tsx|jsx|go|rs|c|cc|cpp|h|hpp|java|rb|php|sh|ps1|bat|cmd|cs|kt|swift|sql|json|ya?ml|toml|ini|cfg|cmake|gradle|lock)$/i
/** 文档/说明类：改它们不该作废代码验证（实测 8 条假阳里 4 条栽在这里）。 */
const DOC_EXT_RE = /\.(md|markdown|txt|rst|adoc|log|csv)$/i

/** 这次改动是否属于"会让先前验证失效"的那类（保守：认不出就不作废）。 */
export function changeInvalidatesVerification(path) {
  const p = typeof path === 'string' ? path : ''
  if (!p) return false
  if (DOC_EXT_RE.test(p)) return false
  if (CODE_EXT_RE.test(p)) return true
  return false
}

/**
 * "未验证声明"标签：末条声明了完成/通过，但证据不支持。
 *
 * 判据全部按"宁可漏检也不误报"定，每条都有**实测假阳**作为来由：
 *   · 从未验证 ⇒ 未验证（除非之后取回过后台作业结果）
 *   · **代码**改动晚于末次验证 ⇒ 未验证（文档类改动不作废，见 changeInvalidatesVerification）
 *   · 末次验证输出**尾部**仍有失败标记、**且**尾部没有明确的成功声明 ⇒ 未验证
 *     （多命令流水线的 `[exit code: 1]` 与 "all public tests passed" 同时出现时判为不确定，
 *       此时**不报**——2ed2ddb4 就是这样被误报的）
 *   · 声明的通过数低于总数 ⇒ 未验证
 *   · 验证以后台作业启动、且之后有取回结果的调用 ⇒ 视为已消费证据，不报
 *     （99265511：构建放到后台跑再取回，属于正常做法）
 *
 * @param {object} input
 * @param {Array} input.writes 文件改动（范围内外都算）
 * @param {Array} input.verifyRuns
 * @param {Array} [input.jobPolls] 取回后台作业结果的调用
 * @param {object} input.claim claimsFromFinalMessage 的产物
 * @param {string} [input.lastVerifyText] 最后一次验证运行的输出文本
 */
export function unverifiedClaim(input) {
  const { writes = [], verifyRuns = [], jobPolls = [], claim = {}, lastVerifyText = '' } = input || {}
  if (!claim.claimedDone && claim.claimedPass === null) return { unverified: false, reason: null }
  const after = (a, b) => (a.turn > b.turn) || (a.turn === b.turn && a.step > b.step)
  if (verifyRuns.length === 0) {
    return jobPolls.length > 0
      ? { unverified: false, reason: null }
      : { unverified: true, reason: '声明了完成/通过，但整个会话没有任何验证运行' }
  }
  const lastVerify = verifyRuns[verifyRuns.length - 1]
  const invalidating = writes.filter((w) => changeInvalidatesVerification(w.path) && after(w, lastVerify))
  if (invalidating.length) {
    return { unverified: true, reason: `末次验证之后又有代码改动（${invalidating[invalidating.length - 1].path}）` }
  }
  if (jobPolls.some((p) => after(p, lastVerify))) return { unverified: false, reason: null }
  const tail = String(lastVerifyText || '').slice(-800)
  const tailFails = /\[exit code:\s*[1-9]\d*\]|Traceback|AssertionError|\bFAILED\b|\d+ failed/i.test(tail)
  const tailOk = /(all (?:public )?tests passed|all green|\bOK\b|PASS\s*=\s*\d+\s*\/\s*\d+|\d+ passed)/i.test(tail)
  if (tailFails && !tailOk) return { unverified: true, reason: '最后一次验证的输出尾部仍有失败标记' }
  if (claim.claimedPass !== null && claim.claimedTotal !== null && claim.claimedPass < claim.claimedTotal) {
    return { unverified: true, reason: `声明的通过数 ${claim.claimedPass}/${claim.claimedTotal} 未达标` }
  }
  return { unverified: false, reason: null }
}
