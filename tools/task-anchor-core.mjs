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
/** 去掉包裹 token 的反引号/引号与结尾标点 —— **实测**提示里常写成 `` `D:\path\`` ``。 */
function stripWrappers(s) {
  return String(s == null ? '' : s)
    .replace(/^[`'"“”‘’<(\[]+/, '')
    .replace(/[`'"“”‘’>)\]]+$/, '')
    .replace(/[.,;:]+$/, '')
}

/** 绝对路径（Windows 盘符或 POSIX 根）。 */
function isAbsPath(s) {
  return /^[A-Za-z]:[\\/]/.test(s) || /^\//.test(s)
}

export function parseTaskAnchors(prompt) {
  const text = typeof prompt === 'string' ? prompt : ''
  const evidence = {}
  const scopeNames = []
  const scopeDirs = []
  let outsideForbidden = false

  // ① 英文式范围子句："Work only inside bugfix-a4" / "only inside the X directory"
  // ⚠ 两处实测缺陷（A/B 实验里至少 3 个代理独立报告为误报，见 ablation-log 第二十一条）：
  //   ① token 常被**反引号/引号**包着（`Work ONLY inside `D:\...\runs\cf-b1`.`）；
  //      `[^\s,.]+` 会把反引号一起抓走 ⇒ 名字成 "cf-b1`"，与路径段名**永不相等**；
  //   ② 英文式里也可能是**绝对路径** ⇒ 必须进 scopeDirs（前缀匹配），
  //      否则范围名匹配注定失效，范围内文件会被判越界。
  //   ③ 实测第三处：`[^\s,.]+` 还会**在空格处截断**
  //      （`D:\My Projects\cf-b1` ⇒ `d:/my`，既丢掉真范围、又把范围放得过宽）
  //      ⇒ 所以**优先捕获引号/反引号包起来的整段**，裸 token 才退回"不许含空格"的匹配。
  //   ④ 回放门（设计 §8 门 2）实测第四处：`Work ONLY inside the directory `X`` 的
  //      裸 token 兜底会抓到功能词 "the" ⇒ 范围变成 ["the"]，**范围内所有写都被判越界**
  //      （cal-r1/cal-r2/cal2-r1 三个会话 5 条假阳）。修法：功能词不进范围，
  //      且 "the directory `X`" 形态单独先抓引号内的 X。
  let enScope = text.match(/work only inside\s+`([^`]+)`/i)
    || text.match(/work only inside\s+"([^"]+)"/i)
    || text.match(/work only inside\s+(?:the |a |an |this |that )?(?:directory|folder|dir)\s*`([^`]+)`/i)
    || text.match(/work only inside\s+(?:the |a |an |this |that )?(?:directory|folder|dir)\s*"([^"]+)"/i)
    || text.match(/work only inside\s+([^\s,.`"']+)/i)
    || text.match(/only (?:modify|touch|edit|change)[^.]*?\b([A-Za-z][\w.-]*-\w[\w.-]*)\b/i)
  if (enScope) {
    evidence.scopeClause = enScope[0].trim()
    const tok = stripWrappers(enScope[1])
    if (/^(?:the|a|an|this|that|it|here|there|inside)$/i.test(tok)) {
      // 功能词不算范围：宁可 parsed=false 也不把 "the" 当范围名（④的假阳就是这么来的）
      enScope = null
    } else if (isAbsPath(tok)) scopeDirs.push(normalizePath(tok))
    else {
      const n = baseName(tok)
      if (n) scopeNames.push(n)
    }
  }
  // ② 中文式范围子句："工作区仅限 D:\...\workspace 目录" / "仅在 X 内" / "只依赖 workspace 内内容"
  //    同样优先捕获引号/反引号包裹的整段 —— 与英文式①是**同一个缺陷类**（空格截断）。
  //    回放门（§8 门 2）实测：裸 "仅 `X`"（不带"限/工作区"语境）会把依赖声明当成范围
  //    ——本会话自己的计划书里 "依赖项仅有 `@deepseek-ai/cordis`" 被解析成范围 ⇒ 假阳。
  //    修法：反引号形态必须带 仅限/只限/限定 或 工作区/范围 语境；裸 仅/只 只保留
  //    **绝对路径**形态（依赖声明不会紧跟一个绝对路径）。
  const cnScope = text.match(/(?:工作区|范围)?(?:仅限|只限|限定)(?:在|于)?\s*`([^`]+)`/)
    || text.match(/(?:工作区|范围)(?:仅|只)(?:在|于)?\s*`([^`]+)`/)
    || text.match(/(?:仅限|只限|仅|只)(?:在)?\s*([A-Za-z]:[\\/][^\s，。；、）)]+)/)
  if (cnScope) {
    evidence.scopeClause = evidence.scopeClause || cnScope[0].trim()
    scopeDirs.push(normalizePath(stripWrappers(cnScope[1])))
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
  // 回放门（§8 门 2）实测假阳：范围是**绝对目录**、而写工具的路径是**相对路径**
  // （`workspace/project2_task/...`）时，前缀匹配必然失败 ⇒ 范围内文件被误判越界
  // （p2-gap3-a4 / p2-gap2-a3）。判据保守：相对路径没有范围名可对 ⇒ 无法判定 ⇒ 不判越界
  // （宁可漏检；范围名的段匹配仍然照常做）。
  const isRel = !isAbsPath(p)
  const dirs = (anchors.scopeDirs || []).filter(Boolean)
  const names = (anchors.scopeNames || []).filter(Boolean)
  for (const d of dirs) {
    if (d && (p === d || p.startsWith(d + '/'))) return true
  }
  for (const n of names) {
    if (!n) continue
    const segs = p.split('/')
    if (segs.includes(n.toLowerCase())) return true
  }
  if (isRel && dirs.length > 0 && names.length === 0) return true   // 无法判定 ⇒ 按不越界
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
    // ⚠ python 解释器标志（-X utf8 / -u / -O …）在实测里是**常态**（本项目的评测命令
    // 就是 `python -X utf8 evaluator/run_hidden_tests.py`），旧模式 `python\s+[^\s]*test…`
    // 会把 "-X" 当脚本名 ⇒ 最重要的隐藏评测一次都认不出（flash f1 会话 23 条验证命令
    // 只认到 1 条）。修：python 后允许任意个 `-<标志>`，再取脚本路径。
    ['python-test-file', /\bpython[0-9.]*(?:\s+-[A-Za-z][^\s]*)*\s+[^\s]*test[^\s]*\.py\b/],
    ['npm-test', /\bnpm\s+(run\s+)?test\b/],
    ['pnpm-test', /\bpnpm\s+(run\s+)?(test|check|verify)\b/],
    ['yarn-test', /\byarn\s+(run\s+)?test\b/],
    ['node-test', /\bnode\s+--test\b/],
    // 本项目自己的验证形态：`node tools/test-xxx.mjs`。不加这条的话，形态表虽然"保守"，
    // 却在最容易观察的地方（本项目会话）永不触发——观察期照样攒不到数据。
    ['node-test-file', /\bnode\s+[^\s|;]*test[^\s|;]*\.(mjs|cjs|js)\b/],
    ['go-test', /\bgo\s+test\b/],
    ['cargo-test', /\bcargo\s+(test|check)\b/],
    ['dotnet-test', /\bdotnet\s+test\b/],
    ['make-test', /\bmake\s+(test|check)\b/],
    ['gradle-test', /\b(\.\/)?gradlew?\s+\S*test\b/],
    ['maven-test', /\bmvn\s+\S*test\b/],
    // ⚠ run_hidden_tests.py / run_public_tests.py / run_full_eval.py 这类评测脚本名中间是
    // **任意**单词（hidden/public/full/optional…），旧模式只认固定拼法 ⇒
    // `python -X utf8 evaluator/run_hidden_tests.py` 两条规则都漏。锚词放宽到
    // test/eval/check/verify/grade（run_debug_probe.py 仍不算——诊断探针不是验证）。
    ['run-tests-script', /\b(run|invoke)[-_ ]?[\w-]*(?:test|eval|check|verify|grade)[\w-]*\.(py|ps1|sh|js|mjs)\b/],
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
  // 交付式宣告（收紧过）：只认"交付/完工"措辞，不认中途进度报告。
  // 为什么收紧（2026-10-10 契约重锚定验收实测）：旧判据 `all (?:tests )?pass` 让 T2 的
  // "A/B/C all pass"（一份**中途**报告）也被当成"宣告完成" ⇒ 契约回声在冲突回合就注入，
  // 交付时早已过期（ablation-log 第二十四条原因①）。收紧后：
  //   · 保留 PASS=n/m（含"取最后一次"）与中文完成措辞；
  //   · 英文只认 (the )?(task|work|engagement) (is )?(done|complete|finished)、
  //     all <n> (tests|checks|groups) (pass|green)、everything (passes|is done|…)。
  const claimedDone = /(已修好|已修复|修复完成|完成|可提测|全部通过)/.test(t)
    || /(?:the )?(?:task|work|engagement)(?: is)? (?:done|complete|finished)/i.test(t)
    || /all (?:\d+ )?(?:tests|checks|groups) (?:pass|green)/i.test(t)
    || /everything (?:passes|is done|is green|works)/i.test(t)
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

/**
 * F5 验证过期事实（纯函数，可单测）：宣告完成/通过，但其**最后一次验证之后**
 * 又改过验证覆盖的同一工件 ⇒ "验证早于这次改动"。
 *
 * 判据保守（宁可漏检也不误报）：
 *   · 没有完成/通过宣告 ⇒ 不是过期，是无法判定；
 *   · 验证命令里认不出**被验证的工件**（见 verifyArtifactsFromCmd）⇒ 绑定不上 ⇒ 不是过期；
 *   · 改动必须属于"会让验证失效"的类型（changeInvalidatesVerification 同一判据）；
 *   · 路径比较用 normalizePath + `./` 前缀归一（实测：命令里的相对路径常带 `./`，
 *     而写工具的 file_path 不带——同一文件不能因此判成两个）。
 *
 * 绑定规则（回放门 §8 门 2 实测收紧）：
 *   · **文件**绑定：验证命令里出现的代码类文件路径，编辑同一文件才绑定；
 *   · **目录**绑定：只认"验证命令的 cd/Set-Location 目标**等于或位于**声明范围目录之内"
 *     的目录——cd 到范围**之外/之上**（如 `cd D:\DSHwork\modeltest` 而范围是
 *     `…\modeltest\workspace`）不绑定。旧实现把所有 cd 目标都当绑定目录，
 *     把"验证后写 `_tmp_verify.py` / 无关 ps1"这类**假阳**全部放了进来（3 条实测假阳）。
 *
 * @param {object} input
 * @param {object} [input.claim] 声明（含 claimedDone/claimedPass，可选 turn/step）
 * @param {Array} input.verifyEvidence [{turn,step,cmd,failed,...}]
 * @param {Array} input.edits [{turn,step,path,invalidates,...}]
 * @param {Array} [input.scopeDirs] 声明范围目录（目录绑定的白名单来源）
 * @returns {{stale:boolean, reason:string|null, evidence:object|null}}
 */
export function verifyStaleness(input) {
  const { claim = null, verifyEvidence = [], edits = [], scopeDirs = [] } = input || {}
  if (!claim || (claim.claimedDone !== true && claim.claimedPass === null)) {
    return { stale: false, reason: 'no-completion-claim', evidence: null }
  }
  const hasPos = (v) => typeof v === 'number'
  const after = (a, b) => (a.turn > b.turn) || (a.turn === b.turn && a.step > b.step)
  const claimAt = hasPos(claim.turn) && hasPos(claim.step) ? { turn: claim.turn, step: claim.step } : null
  const atOrBefore = (v) => !claimAt || !hasPos(v.turn) || !hasPos(v.step) || !after(v, claimAt)
  const list = (verifyEvidence || []).filter((v) => v && atOrBefore(v))
  const lastV = list[list.length - 1]
  if (!lastV) return { stale: false, reason: 'no-verify-before-claim', evidence: null }
  if (!hasPos(lastV.turn) || !hasPos(lastV.step)) return { stale: false, reason: 'verify-position-unknown', evidence: null }
  const { files, dirs } = verifyArtifactsFromCmd(lastV.cmd, scopeDirs)
  if (files.length === 0 && dirs.length === 0) return { stale: false, reason: 'no-artifact-binding', evidence: null }
  const underDir = (p, d) => p === d || p.startsWith(d + '/')
  for (const e of edits || []) {
    if (!e || e.invalidates !== true) continue
    if (!hasPos(e.turn) || !hasPos(e.step)) continue
    if (!after(e, lastV)) continue
    const ep = normComparable(e.path)
    if (!ep) continue
    const bound = files.some((a) => ep === a) || dirs.some((d) => underDir(ep, d))
    if (!bound) continue
    return {
      stale: true,
      reason: 'edited-after-verify',
      evidence: {
        verifyCmd: typeof lastV.cmd === 'string' ? lastV.cmd : null,
        verifyTurn: lastV.turn, verifyStep: lastV.step,
        editPath: e.path, editTurn: e.turn, editStep: e.step,
      },
    }
  }
  return { stale: false, reason: 'fresh', evidence: null }
}

/**
 * 从验证命令里认出"被验证的工件"（F5 的绑定来源）。
 *   · 文件：代码类扩展名的路径（绝对或 ./ 相对），编辑**同一文件**才绑定；
 *   · 目录：cd/Set-Location 目标**等于或位于**声明范围目录之内（范围是白名单——
 *     没有范围 ⇒ 没有目录绑定；cd 到范围之外/之上不绑定）。
 * 返回的都是 normComparable 之后的路径。
 */
export function verifyArtifactsFromCmd(cmd, scopeDirs = []) {
  if (typeof cmd !== 'string' || !cmd) return { files: [], dirs: [] }
  const files = commandPaths(cmd)
    .filter((p) => CODE_EXT_RE.test(p))
    .map((p) => normComparable(p))
    .filter(Boolean)
  const scopes = (scopeDirs || []).map((d) => normComparable(d)).filter(Boolean)
  const dirs = []
  if (scopes.length > 0) {
    const cdRe = /(?:^|[\s;&|])(?:cd|chdir|set-location)\s+["']?([A-Za-z]:[\\/][^"';&|]+)/gi
    let m
    while ((m = cdRe.exec(cmd)) !== null) {
      const t = normComparable(m[1])
      if (!t) continue
      // 目标 == 范围，或目标在范围**之内**，才构成目录绑定
      if (scopes.some((s) => t === s || t.startsWith(s + '/'))) dirs.push(t)
    }
  }
  return { files, dirs }
}

/** 比较用路径：normalizePath + 去前导 `./`（`./a/b.py` 与 `a/b.py` 是同一个文件）。 */
function normComparable(p) {
  if (typeof p !== 'string' || p.length === 0) return ''
  let s = normalizePath(p)
  while (s.startsWith('./')) s = s.slice(2)
  return s
}
