// Disposable-profile E3 matrix for a DSH bundle.
// install -> boot/start -> uninstall(restore baseline) against a throwaway DSH_HOME.
// Usage: node e3-matrix.mjs --cli <lib/bin.js> --plugin <dir> --label <ver> --work <dir> [--keep]
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

function argsOf(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue
    const key = argv[i].slice(2)
    const next = argv[i + 1]
    out[key] = next && !next.startsWith('--') ? (i += 1, next) : true
  }
  return out
}
const args = argsOf(process.argv.slice(2))
const cli = resolve(args.cli)
const pluginDir = resolve(args.plugin)
const label = String(args.label ?? 'unknown')
const workBase = resolve(args.work ?? '.')
const keep = args.keep === true
const pkgName = '@dsh-ext/trajectory-anchor'

const root = await mkdtemp(join(workBase, `e3-${label.replace(/[^A-Za-z0-9._-]/g, '_')}-`))

// Evidence is committed to a public repo: never persist session tokens or
// machine-specific absolute paths.
const cliPrefix = cli.replace(/[\\/]node_modules[\\/].*$/, '')
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const redactions = [
  [/token=[A-Za-z0-9._~+/=-]+/g, 'token=<redacted>'],
  [new RegExp(escapeRegExp(pluginDir), 'g'), '<fixed-checkout>'],
  [new RegExp(escapeRegExp(pluginDir.replace(/\\/g, '/')), 'g'), '<fixed-checkout>'],
  [new RegExp(escapeRegExp(cliPrefix), 'g'), '<dsh-prefix>'],
  [new RegExp(escapeRegExp(cliPrefix.replace(/\\/g, '/')), 'g'), '<dsh-prefix>'],
  [new RegExp(escapeRegExp(root), 'g'), '<scratch>'],
  [new RegExp(escapeRegExp(root.replace(/\\/g, '/')), 'g'), '<scratch>'],
]
const redact = value => {
  if (typeof value === 'string') return redactions.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value)
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]))
  return value
}

const home = join(root, 'home')
const agents = join(root, 'agents')
await mkdir(home, { recursive: true })
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|PASSWORD|API_KEY/i.test(key)))
Object.assign(env, {
  DSH_HOME: home,
  DSH_AGENTS_HOME: agents,
  DSH_TELEMETRY_DISABLED: '1',
  CI: 'true',
  npm_config_cache: join(workBase, 'npm-cache'),
})

const log = []
const record = (step, value) => { log.push({ step, at: new Date().toISOString(), ...value }); return value }
const run = (step, cliArgs) => new Promise((resolveRun, reject) => {
  const started = Date.now()
  execFile(process.execPath, [cli, ...cliArgs], { cwd: root, env, timeout: 300000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
    const entry = record(step, {
      argv: cliArgs, exitCode: error?.code ?? 0, ms: Date.now() - started,
      stdoutTail: String(stdout).slice(-1200), stderrTail: String(stderr).slice(-1200),
    })
    if (error) reject(Object.assign(new Error(`${step} failed`), { entry }))
    else resolveRun(String(stdout))
  })
})
const sha256 = async file => createHash('sha256').update(await readFile(file)).digest('hex')

let child = null
const result = { label, status: 'unknown', cli, pluginDir }
try {
  const cliVersion = (await run('cli-version', ['--version'])).trim()
  result.cliVersion = cliVersion
  result.artifacts = {
    'package.json': await sha256(join(pluginDir, 'package.json')),
    'cordis.patch.yml': await sha256(join(pluginDir, 'cordis.patch.yml')),
    'index.js': await sha256(join(pluginDir, 'index.js')),
  }
  const pluginManifest = JSON.parse(await readFile(join(pluginDir, 'package.json'), 'utf8'))
  result.pluginVersion = pluginManifest.version

  const baseline = await run('baseline-dump-config', ['--profile', 'web', '--dump-config'])
  result.baselineLines = baseline.split(/\r?\n/).length

  await run('install', ['plugin', '--profile', 'web', 'add', '--ignore-scripts', '--config.auto-install-peers=false', `file:${pluginDir.replace(/\\/g, '/')}`])
  const installed = await run('installed-dump-config', ['--profile', 'web', '--dump-config'])
  if (!installed.includes(pkgName) || !installed.includes('id: trajectory-anchor')) throw new Error('installed config does not list the bundle entry')
  result.installListed = true
  result.profilePackageAfterInstall = JSON.parse(await readFile(join(home, 'profiles', 'web', 'package.json'), 'utf8'))

  const server = createServer()
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  await new Promise(done => server.close(done))
  const started = Date.now()
  child = spawn(process.execPath, [cli, 'web', '--no-open', '--port', String(port)], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const bootUrl = await new Promise((done, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('startup-timeout')), 180000)
    const append = chunk => {
      buffer = (buffer + chunk.toString()).slice(-131072)
      const match = /dsh web: (http:\/\/[^\s]+)/.exec(buffer)
      if (match) { clearTimeout(timer); done(match[1]) }
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`startup-exited-${code}`)) })
  })
  result.startUrl = bootUrl
  result.startMs = Date.now() - started
  const response = await fetch(bootUrl, { redirect: 'manual', signal: AbortSignal.timeout(15000) })
  result.startHttpStatus = response.status
  if (!(response.status >= 200 && response.status < 400)) throw new Error(`start HTTP ${response.status}`)
  child.kill('SIGTERM')
  await new Promise(done => child.once('exit', done))
  child = null

  await run('uninstall', ['plugin', '--profile', 'web', 'remove', pkgName])
  const after = await run('after-dump-config', ['--profile', 'web', '--dump-config'])
  result.uninstallRestoresBaseline = after === baseline
  if (!result.uninstallRestoresBaseline) throw new Error('uninstall did not restore the exact baseline composition')
  result.status = 'passed'
} catch (error) {
  result.status = 'failed'
  result.error = String(error?.message ?? error)
  if (error?.entry) log.push(error.entry)
} finally {
  if (child && child.exitCode === null) { child.kill('SIGKILL'); await new Promise(done => child.once('exit', done)) }
  result.log = log
  const outFile = join(workBase, `e3-result-${label.replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
  await writeFile(outFile, `${JSON.stringify(redact(result), null, 2)}\n`)
  console.log(JSON.stringify({ label, status: result.status, cliVersion: result.cliVersion, pluginVersion: result.pluginVersion, error: result.error, outFile }))
  if (!keep) await rm(root, { recursive: true, force: true })
}
if (result.status !== 'passed') process.exitCode = 1
