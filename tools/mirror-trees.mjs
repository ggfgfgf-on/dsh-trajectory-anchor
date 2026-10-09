/**
 * mirror-trees.mjs —— 三棵树镜像 + 哈希校验（把"每轮临时命令"变成可复跑的一步）
 *
 * 本项目的口径里有"三棵树 hash 一致"这一条，但此前它是**每轮现敲的命令**，
 * 于是它既不可复跑、也没法被别人复核（而且我在某个 PowerShell 引号事故里
 * 把临时路径压平、在源树里留下一坨垃圾目录，直到这一轮才发现）。
 *
 * 三棵树：
 *   A 源树   D:\DSHwork\trajectory-anchor-bundle                      （我编辑的地方）
 *   B 仓库树 D:\DSHwork\dsh-trajectory-anchor-github                 （git 仓库，提交/推送）
 *   C 线上树 %USERPROFILE%\.dsh\profiles\web\node_modules\@dsh-ext\trajectory-anchor
 *                                                                    （DSH 进程真正加载的代码）
 *
 * 纪律：
 *   · **单向**：A → B → C。任何反方向的搬运都必须是一次显式的、有理由的操作，而不是本工具的副作用；
 *   · 目标树里"源树没有"的文件会被删掉（否则"一致"只是假象），但 `.git` 与 `.gitignore` 除外；
 *   · 复制后**逐个文件比对 sha256**，任何不一致都以非零退出码收场（不许"看起来同步了"）。
 *
 * 用法：
 *   node tools/mirror-trees.mjs            # 干跑：只报告差异，不写任何文件
 *   node tools/mirror-trees.mjs --write    # 真镜像并校验
 */
import { readFileSync, readdirSync, statSync, mkdirSync, copyFileSync, rmSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'

const WRITE = process.argv.includes('--write')
const A = resolve('D:/DSHwork/trajectory-anchor-bundle')
const B = resolve('D:/DSHwork/dsh-trajectory-anchor-github')
const C = join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', '@dsh-ext', 'trajectory-anchor')

/** 目标树里允许保留、但不参与比对的条目（仓库自身的元数据）。 */
const KEEP_LOCAL = new Set(['.git', '.gitignore'])
/** 源树里永不被镜像的东西。 */
const SKIP = new Set(['.git', 'node_modules', '.gitignore'])

function walk(root, rel = '') {
  const out = []
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...walk(root, r))
    else if (e.isFile()) out.push(r)
  }
  return out
}
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const files = (root) => existsSync(root) ? walk(root) : null

if (!existsSync(A)) { console.error(`源树不存在：${A}`); process.exit(2) }
const src = files(A)
console.log(`源树 A：${A}\n  ${src.length} 个文件`)

let problems = 0
for (const [label, target] of [['B 仓库树', B], ['C 线上树', C]]) {
  if (!existsSync(target)) { console.log(`\n${label} 不存在：${target}（跳过）`); problems++; continue }
  const have = new Set(files(target))
  const want = new Set(src)
  const missing = src.filter((f) => !have.has(f))
  const extra = [...have].filter((f) => !want.has(f) && !KEEP_LOCAL.has(f.split('/')[0]))
  const changed = src.filter((f) => have.has(f) && sha(join(A, f)) !== sha(join(target, f)))
  console.log(`\n${label}：${target}`)
  console.log(`  缺 ${missing.length} / 多 ${extra.length} / 内容不同 ${changed.length}`)
  if (missing.length) console.log(`  缺: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ' …' : ''}`)
  if (extra.length) console.log(`  多: ${extra.slice(0, 8).join(', ')}${extra.length > 8 ? ' …' : ''}`)
  if (changed.length) console.log(`  不同: ${changed.slice(0, 8).join(', ')}${changed.length > 8 ? ' …' : ''}`)
  if (missing.length + extra.length + changed.length === 0) { console.log('  ✓ 已一致'); continue }
  problems++
  if (!WRITE) { console.log('  （干跑：未写任何文件）'); continue }
  for (const f of extra) rmSync(join(target, f), { force: true })
  for (const f of src) {
    const dst = join(target, f)
    mkdirSync(dirname(dst), { recursive: true })
    copyFileSync(join(A, f), dst)
  }
  console.log(`  已写入 ${src.length} 个文件、删除 ${extra.length} 个多余文件`)
}

// ── 校验：三棵树逐文件 sha256 必须完全相同 ────────────────────────────────
console.log('\n=== 校验（逐文件 sha256）===')
let mismatch = 0
for (const f of src) {
  const a = sha(join(A, f))
  const b = existsSync(join(B, f)) ? sha(join(B, f)) : '(缺)'
  const c = existsSync(join(C, f)) ? sha(join(C, f)) : '(缺)'
  if (a !== b || a !== c) { mismatch++; if (mismatch <= 10) console.log(`  ✗ ${f}: A=${a.slice(0, 8)} B=${b.slice(0, 8)} C=${c.slice(0, 8)}`) }
}
// 目标树不得有源树里没有的文件（伪造"一致"的常见方式）
for (const [label, target] of [['B', B], ['C', C]]) {
  if (!existsSync(target)) continue
  for (const f of files(target)) {
    if (!src.includes(f) && !KEEP_LOCAL.has(f.split('/')[0])) { mismatch++; if (mismatch <= 10) console.log(`  ✗ ${label} 多出文件: ${f}`) }
  }
}
console.log(`\n[mirror] 源树 ${src.length} 文件；不一致 ${mismatch} 处；模式 ${WRITE ? '写入' : '干跑'}`)
process.exit(mismatch === 0 ? 0 : 1)
