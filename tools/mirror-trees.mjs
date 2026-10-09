/**
 * mirror-trees.mjs -- three-tree mirror with hash verification.
 *
 * "All three trees must be byte-identical" is part of this project's release ritual, but it used to
 * be an ad-hoc command retyped every round: not re-runnable, not reviewable by anyone else, and it
 * once flattened a scratch path into the source tree (a stray directory left behind by a shell
 * quoting accident) that nobody noticed for several rounds. This file makes the ritual a single
 * reproducible step.
 *
 * The three trees:
 *   A source  D:\DSHwork\trajectory-anchor-bundle                     (where edits happen)
 *   B repo    D:\DSHwork\dsh-trajectory-anchor-github                 (the git repository)
 *   C live    %USERPROFILE%\.dsh\profiles\web\node_modules\@dsh-ext\trajectory-anchor
 *                                                                    (what the DSH process loads)
 *
 * Rules:
 *   - One direction only: A -> B -> C. Moving files the other way must be an explicit, justified
 *     action, never a side effect of this tool.
 *   - Files present in a target but absent from the source are deleted, except `.git` and
 *     `.gitignore`; otherwise "identical" is an illusion.
 *   - After copying, every file is compared by sha256 and any mismatch exits non-zero. A tree that
 *     merely looks synced is not synced.
 *
 * Usage:
 *   node tools/mirror-trees.mjs            # dry run: report differences, write nothing
 *   node tools/mirror-trees.mjs --write    # mirror and verify
 */
import { readFileSync, readdirSync, statSync, mkdirSync, copyFileSync, rmSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'

const WRITE = process.argv.includes('--write')
const A = resolve('D:/DSHwork/trajectory-anchor-bundle')
const B = resolve('D:/DSHwork/dsh-trajectory-anchor-github')
const C = join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', '@dsh-ext', 'trajectory-anchor')

/** Entries a target may keep without being compared (the repo's own metadata). */
const KEEP_LOCAL = new Set(['.git', '.gitignore'])
/** Entries of the source tree that are never mirrored. */
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

if (!existsSync(A)) { console.error(`source tree does not exist: ${A}`); process.exit(2) }
const src = files(A)
console.log(`source A: ${A}\n  ${src.length} files`)

let problems = 0
for (const [label, target] of [['B repo', B], ['C live', C]]) {
  if (!existsSync(target)) { console.log(`\n${label} does not exist: ${target} (skipped)`); problems++; continue }
  const have = new Set(files(target))
  const want = new Set(src)
  const missing = src.filter((f) => !have.has(f))
  const extra = [...have].filter((f) => !want.has(f) && !KEEP_LOCAL.has(f.split('/')[0]))
  const changed = src.filter((f) => have.has(f) && sha(join(A, f)) !== sha(join(target, f)))
  console.log(`\n${label}: ${target}`)
  console.log(`  missing ${missing.length} / extra ${extra.length} / differing ${changed.length}`)
  if (missing.length) console.log(`  missing: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ' ...' : ''}`)
  if (extra.length) console.log(`  extra: ${extra.slice(0, 8).join(', ')}${extra.length > 8 ? ' ...' : ''}`)
  if (changed.length) console.log(`  differing: ${changed.slice(0, 8).join(', ')}${changed.length > 8 ? ' ...' : ''}`)
  if (missing.length + extra.length + changed.length === 0) { console.log('  already identical'); continue }
  problems++
  if (!WRITE) { console.log('  (dry run: nothing written)'); continue }
  for (const f of extra) rmSync(join(target, f), { force: true })
  for (const f of src) {
    const dst = join(target, f)
    mkdirSync(dirname(dst), { recursive: true })
    copyFileSync(join(A, f), dst)
  }
  console.log(`  wrote ${src.length} files, removed ${extra.length} extra files`)
}

// ── Verification: every file must have the same sha256 in all three trees ────────────────
console.log('\n=== verify (sha256 per file) ===')
let mismatch = 0
for (const f of src) {
  const a = sha(join(A, f))
  const b = existsSync(join(B, f)) ? sha(join(B, f)) : '(缺)'
  const c = existsSync(join(C, f)) ? sha(join(C, f)) : '(缺)'
  if (a !== b || a !== c) { mismatch++; if (mismatch <= 10) console.log(`  ✗ ${f}: A=${a.slice(0, 8)} B=${b.slice(0, 8)} C=${c.slice(0, 8)}`) }
}
// A target must not hold files the source lacks: that is the usual way an "identical tree" is faked.
for (const [label, target] of [['B', B], ['C', C]]) {
  if (!existsSync(target)) continue
  for (const f of files(target)) {
    if (!src.includes(f) && !KEEP_LOCAL.has(f.split('/')[0])) { mismatch++; if (mismatch <= 10) console.log(`  x ${label} unexpected file: ${f}`) }
  }
}
console.log(`\n[mirror] source ${src.length} files; ${mismatch} mismatches; mode=${WRITE ? 'write' : 'dry-run'}`)
process.exit(mismatch === 0 ? 0 : 1)
