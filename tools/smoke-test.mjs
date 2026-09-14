// Logic regression suite. No DSH install, no network, no model: every case runs
// against built files in `lib/`.
//
// Two groups of cases exist because two mistakes already reached a release:
// subpath specifiers were once read as whole package names (which disabled
// healthy rows), and the verification command once dropped the supervisor's
// arguments. Both have a case here, so neither can come back quietly.
//
// Usage: node tools/smoke-test.mjs   (run npm run build first)
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
// Dynamic import needs a URL, not a Windows drive path.
const lib = (name) => pathToFileURL(join(root, 'lib', name)).href

let passed = 0
const failures = []
const check = (name, condition, detail) => {
  if (condition) {
    passed += 1
    return
  }
  failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
}
const equal = (name, actual, expected) => {
  check(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const doctor = await import(lib('doctor.js'))
const repair = await import(lib('repair.js'))
const argsModule = await import(lib('args.js'))

// ── crash classification ────────────────────────────────────────────────────
// Each class maps to a different repair, so a misclassification sends the user
// to the wrong fix. The samples are verbatim from real boot output shapes.
const CRASH_SAMPLES = [
  ['corrupt Zstandard session log: bad frame at 12', 'session-corrupt'],
  ['dsh: cannot resolve profile bundle @x/y', 'bundle-check'],
  ['@x/y declares no dsh.bundle.patch', 'bundle-check'],
  ['Error: listen EADDRINUSE: address already in use 127.0.0.1:3080', 'port-bind'],
  ['failed to parse patches C:\\x\\cordis.patch.yml: bad indentation', 'settings'],
  ['duplicate loader entry id: timer', 'patch-tree'],
  ['Cannot find package "@dsh-external/does-not-exist"', 'patch-tree'],
  ['plugin(s) failed to load: @x/y', 'patch-tree'],
  ['something nobody has seen before', 'unknown'],
]
for (const [sample, expected] of CRASH_SAMPLES) {
  equal(`classifyCrash: ${sample.slice(0, 42)}`, doctor.classifyCrash(sample), expected)
}
for (const reason of ['session-corrupt', 'bundle-check', 'patch-tree', 'port-bind', 'settings', 'unknown']) {
  const advice = doctor.crashAdvice(reason)
  check(`crashAdvice: ${reason} names a next step`, typeof advice === 'string' && advice.length > 10, `got ${JSON.stringify(advice)}`)
}

// ── boot signal extraction ──────────────────────────────────────────────────
const signals = doctor.extractBootSignals([
  'booting',
  'Error: dsh: plugin tree failed to load: cannot find package "x"',
  'unrelated chatter',
  'EADDRINUSE',
].join('\n'))
check('extractBootSignals keeps the diagnostics', signals.some(line => line.includes('failed to load')))
check('extractBootSignals keeps the bind error', signals.some(line => line.includes('EADDRINUSE')))
check('extractBootSignals drops unrelated chatter', !signals.some(line => line.includes('unrelated chatter')))

// ── specifier → package name ────────────────────────────────────────────────
// Regression: reading `@scope/pkg/sub` as one package name reported every
// subpath row as unresolvable and disabled healthy rows.
equal('packageOfSpecifier: scoped subpath', doctor.packageOfSpecifier('@deepseek-ai/dsh-web-app/startup'), '@deepseek-ai/dsh-web-app')
equal('packageOfSpecifier: scoped bare', doctor.packageOfSpecifier('@deepseek-ai/dsh-base'), '@deepseek-ai/dsh-base')
equal('packageOfSpecifier: plain subpath', doctor.packageOfSpecifier('lodash/fp'), 'lodash')
equal('packageOfSpecifier: relative', doctor.packageOfSpecifier('./runner.js'), undefined)
equal('packageOfSpecifier: absolute', doctor.packageOfSpecifier('C:\\x\\y.js'), undefined)
equal('packageOfSpecifier: builtin', doctor.packageOfSpecifier('cordis:group'), undefined)

// ── command-line grammar ────────────────────────────────────────────────────
equal('parseArgs: default command', argsModule.parseArgs([]).command, 'repair')
equal('parseArgs: doctor', argsModule.parseArgs(['doctor']).command, 'doctor')
equal('parseArgs: profile', argsModule.parseArgs(['doctor', '--profile', 'sdk']).profile, 'sdk')
equal('parseArgs: inner args', argsModule.parseArgs(['supervise', '--', '--port', '3099']).args.join(' '), '--port 3099')
equal('parseArgs: repair task', argsModule.parseArgs(['repair', 'fix', 'it']).task, 'fix it')
check('parseArgs: rejects an unknown option', (() => {
  try { argsModule.parseArgs(['doctor', '--nope']); return false } catch { return true }
})())
check('parseArgs: rejects a non-numeric timeout', (() => {
  try { argsModule.parseArgs(['doctor', '--timeout', 'soon']); return false } catch { return true }
})())
check('parseArgs: rejects a bad permission mode', (() => {
  try { argsModule.parseArgs(['doctor', '--permission-mode', 'root']); return false } catch { return true }
})())

// ── boot handshake ──────────────────────────────────────────────────────────
const scratch = mkdtempSync(join(tmpdir(), 'dsh-rescue-smoke-'))
process.on('exit', () => {
  try { rmSync(scratch, { recursive: true, force: true }) } catch { /* best effort */ }
})

const bootRoot = join(scratch, 'boot')
check('boot: absent record reads as no crash', doctor.readBootReport(bootRoot).crashed === false)
doctor.writeBootState(bootRoot, { ok: false, startedAt: '2026-01-01T00:00:00.000Z', pid: 1, lastGoodAt: '2025-12-31T00:00:00.000Z' })
const crashed = doctor.readBootReport(bootRoot)
check('boot: an unfinished record is a crash', crashed.crashed === true)
equal('boot: last good boot survives', crashed.state?.lastGoodAt, '2025-12-31T00:00:00.000Z')
check('boot: a crash carries a classified reason and advice', typeof crashed.reason === 'string' && typeof crashed.advice === 'string')
doctor.writeBootState(bootRoot, { ok: false, cleanExit: true, startedAt: '2026-01-01T00:00:00.000Z' })
check('boot: a deliberate stop before readiness is not a crash', doctor.readBootReport(bootRoot).crashed === false)
// A fatal load failure disposes the tree without any signal; reporting that as a
// deliberate stop would hide exactly the failure this record exists to catch.
doctor.writeBootState(bootRoot, { ok: false, tornDown: true, startedAt: '2026-01-01T00:00:00.000Z' })
const torn = doctor.readBootReport(bootRoot)
check('boot: a teardown before readiness is a crash', torn.crashed === true)
check('boot: a teardown is not reported as a deliberate stop', torn.state?.cleanExit !== true)
doctor.writeBootState(bootRoot, { ok: true, okAt: '2026-01-01T00:00:01.000Z', lastGoodAt: '2026-01-01T00:00:01.000Z' })
check('boot: a finished record is not a crash', doctor.readBootReport(bootRoot).crashed === false)

// ── bundle check and the mechanical repair ──────────────────────────────────
// The fixture mirrors the launcher's three ways to refuse a bundle, plus one
// healthy bundle and this package itself.
const home = join(scratch, 'home')
const profile = join(home, 'profiles', 'web')
const modules = join(profile, 'node_modules')
const makeBundle = (name, { patch } = {}) => {
  const dir = join(modules, name)
  mkdirSync(dir, { recursive: true })
  const dsh = patch === undefined ? {} : { bundle: { patch } }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', dsh }, undefined, 2))
  if (patch !== undefined && patch !== 'missing.yml') writeFileSync(join(dir, patch), '[]\n')
}
mkdirSync(profile, { recursive: true })
makeBundle('good-bundle', { patch: './cordis.patch.yml' })
makeBundle('no-patch-bundle')
makeBundle('patch-missing-bundle', { patch: 'missing.yml' })
makeBundle(repair.RESCUE_PACKAGE_NAME, { patch: './cordis.patch.yml' })
writeFileSync(join(profile, 'cordis.patch.yml'), '# smoke fixture\n[]\n')
writeFileSync(join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-profile-web',
  private: true,
  dsh: {
    profile: {
      bundles: ['good-bundle', 'not-installed-bundle', 'no-patch-bundle', 'patch-missing-bundle', repair.RESCUE_PACKAGE_NAME],
      patchReload: 'startup',
    },
  },
}, undefined, 2) + '\n')

const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home
try {
  const report = await doctor.runDoctor({ profile: 'web', packageDir: root })
  const web = report.profiles.find(entry => entry.name === 'web')
  check('bundle check: the profile was found', web !== undefined)
  const byName = new Map((web?.bundles ?? []).map(bundle => [bundle.name, bundle]))
  equal('bundle check: a valid bundle resolves', byName.get('good-bundle')?.resolved, true)
  equal('bundle check: a missing package is "unresolved"', byName.get('not-installed-bundle')?.code, 'unresolved')
  equal('bundle check: a manifest without dsh.bundle.patch is "no-patch"', byName.get('no-patch-bundle')?.code, 'no-patch')
  equal('bundle check: an absent patch file is "patch-missing"', byName.get('patch-missing-bundle')?.code, 'patch-missing')
  check('bundle check: findings name each failure', ['bundle-unresolved', 'bundle-no-patch', 'bundle-patch-missing']
    .every(code => report.findings.some(finding => finding.code === code)))

  const dry = await repair.applyMechanicalFixes({ profile: 'web', dryRun: true })
  equal('fix(dry-run): finds all three unusable bundles', dry.applied.length, 3)
  const untouched = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  equal('fix(dry-run): writes nothing', untouched.dsh.profile.bundles.length, 5)

  const applied = await repair.applyMechanicalFixes({ profile: 'web', dryRun: false })
  equal('fix: applies three drops', applied.applied.length, 3)
  const after = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  equal('fix: keeps the healthy bundle', after.dsh.profile.bundles.includes('good-bundle'), true)
  equal('fix: keeps the rescue bundle', after.dsh.profile.bundles.includes(repair.RESCUE_PACKAGE_NAME), true)
  equal('fix: drops exactly the unusable ones', after.dsh.profile.bundles.length, 2)
  const backups = readdirSync(profile).filter(name => name.startsWith('package.json.rescue-bak-'))
  check('fix: backs the manifest up', backups.length === 1, `found ${JSON.stringify(backups)}`)

  applied.rollback()
  const restored = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  equal('fix: rollback restores every entry', restored.dsh.profile.bundles.length, 5)

  // The rescue bundle must survive its own repair even when it is the broken one:
  // dropping it would leave the next crash with no tool to run.
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true,
    dsh: { profile: { bundles: [repair.RESCUE_PACKAGE_NAME], patchReload: 'startup' } },
  }, undefined, 2) + '\n')
  rmSync(join(modules, repair.RESCUE_PACKAGE_NAME), { recursive: true, force: true })
  const selfRepair = await repair.applyMechanicalFixes({ profile: 'web', dryRun: false })
  equal('fix: refuses to drop the rescue bundle', selfRepair.applied.length, 0)
  check('fix: says why it refused', selfRepair.skipped.some(line => line.includes('rescue bundle')))
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
}

// ── compatibility with a deployment that changed under us ───────────────────
// An override that matches nothing is a Loader warning, not a failure: the
// rescue would boot with default permissions and silently be unable to write.
const compat = await import(lib('compat.js'))

const unchanged = compat.diffComposition(['a', 'b', 'sandbox-policy', 'approval'], ['a', 'sandbox-policy', 'approval'], ['new-row'])
check('compat: an unchanged deployment reports nothing missing', unchanged.missingTargets.length === 0)
check('compat: an unchanged deployment reports no collisions', unchanged.collisions.length === 0)
check('compat: an unchanged deployment is not crippled', unchanged.criticalMissing.length === 0)

const renamed = compat.diffComposition(['timer'], ['sandbox-policy', 'approval', 'system-prompt'], ['tool-cordis'])
equal('compat: renamed rows are reported', renamed.missingTargets.join(','), 'sandbox-policy,approval,system-prompt')
equal('compat: the permission rows are called out as critical', renamed.criticalMissing.join(','), 'sandbox-policy,approval')

const collided = compat.diffComposition(['timer', 'tool-cordis'], [], ['timer2', 'tool-cordis'])
equal('compat: an insert that collides is reported', collided.collisions.join(','), 'tool-cordis')

const resolvedEntries = [
  { options: { id: 'sandbox-policy' }, fiber: { config: { mode: 'danger-full-access' } } },
  { options: { id: 'approval' }, fiber: { config: { policy: 'never' } } },
  { options: { id: 'system-prompt' }, fiber: { config: { persona: 'rescue' } } },
  { options: { id: 'skill-filesystem' }, fiber: { config: { customSkillDirs: ['a'] } } },
]
const healthy = compat.verifyMountedOverrides(resolvedEntries, { permissionMode: 'danger-full-access', approvalPolicy: 'never' })
check('mounted: a correct tree blocks nothing', healthy.blocking.length === 0, healthy.blocking.join('; '))
check('mounted: a correct tree warns about nothing', healthy.cosmetic.length === 0, healthy.cosmetic.join('; '))

// The entry keeps its unevaluated `!!js` expression while the fiber holds the
// resolved value. Reading the wrong one would refuse a healthy deployment.
const unevaluated = [
  { options: { id: 'sandbox-policy', config: { mode: { __jsExpr: "process.env.X || 'danger-full-access'" } } }, fiber: { config: { mode: 'danger-full-access' } } },
  { options: { id: 'approval' }, fiber: { config: { policy: 'never' } } },
]
check('mounted: the resolved fiber config is what counts',
  compat.verifyMountedOverrides(unevaluated, { permissionMode: 'danger-full-access', approvalPolicy: 'never' }).blocking.length === 0)

const cannotTell = compat.verifyMountedOverrides(
  [{ options: { id: 'sandbox-policy' }, fiber: { config: { mode: { __jsExpr: 'x' } } } },
    { options: { id: 'approval' }, fiber: { config: { policy: 'never' } } }],
  { permissionMode: 'danger-full-access', approvalPolicy: 'never' },
)
check('mounted: an unreadable value does not block', cannotTell.blocking.length === 0, cannotTell.blocking.join('; '))
check('mounted: an unreadable value is reported instead', cannotTell.cosmetic.some(line => line.includes('could not be read back')))

equal('mounted: missing permission rows block',
  compat.verifyMountedOverrides([], { permissionMode: 'danger-full-access', approvalPolicy: 'never' }).blocking.length, 2)

const wrong = compat.verifyMountedOverrides(
  [{ options: { id: 'sandbox-policy' }, fiber: { config: { mode: 'workspace-write' } } },
    { options: { id: 'approval' }, fiber: { config: { policy: 'never' } } }],
  { permissionMode: 'danger-full-access', approvalPolicy: 'never' },
)
check('mounted: a wrong resolved value blocks', wrong.blocking.length === 1 && wrong.blocking[0].includes('workspace-write'))

// ── the boot verdict ────────────────────────────────────────────────────────
// Liveness alone reported a dead deployment as healthy: a DSH that fails to load
// takes about fourteen seconds to die, so a short window saw a corpse in progress
// still running, and supervise would then skip the repair entirely.
const probe = await import(lib('probe.js'))

check('verdict: a clean exit is up', probe.bootOutcome(0, '') === 'up')
check('verdict: a non-zero exit is down', probe.bootOutcome(1, 'anything') === 'down')
check('verdict: silence from a live process is up', probe.bootOutcome(null, 'dsh: serving on 127.0.0.1:3080') === 'up')

const FAILING = 'Error: dsh: plugin tree failed to load: failed to import loader entry x: Cannot find package "@x/y"'
check('verdict: a live process already failing is undecided', probe.bootOutcome(null, FAILING) === 'undecided')
check('verdict: a failing process shows the signature', probe.showsBootFailure(FAILING))
check('verdict: ordinary output shows no failure', !probe.showsBootFailure('dsh: web ui at http://127.0.0.1:3080'))
check('verdict: a module-not-found trace counts', probe.showsBootFailure('code: "ERR_MODULE_NOT_FOUND"'))
check('verdict: a bind collision counts', probe.showsBootFailure('listen EADDRINUSE: address already in use 127.0.0.1:3080'))
check('verdict: a duplicate entry id counts', probe.showsBootFailure('duplicate loader entry id: timer'))
// The extractor is deliberately broader than the verdict: a reader can judge a
// hint, and this decision cannot afford to.
check('verdict: the verdict is narrower than the diagnostic extractor',
  doctor.extractBootSignals('TypeError: x is not a function').length > 0
  && !probe.showsBootFailure('TypeError: x is not a function'))

if (failures.length > 0) {
  console.error(`smoke-test: FAIL (${failures.length} of ${passed + failures.length})`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`smoke-test: ok (${passed} checks)`)
