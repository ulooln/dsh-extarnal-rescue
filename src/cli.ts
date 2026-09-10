#!/usr/bin/env node
/**
 * `dsh-rescue` — the entry point a person runs when the harness will not start.
 *
 * It imports nothing from the harness at module scope: every harness package is
 * loaded at runtime from a deployment plane this file finds first. That is the
 * whole point — a broken profile composition, a broken bundle, or a broken
 * plugin cannot prevent this command from running.
 *
 * Commands:
 *   doctor     diagnose without booting or calling a model
 *   verify     boot the real profile once and report whether it came up
 *   repair     boot a minimal creation-mode agent and repair the harness
 *   supervise  run the real profile; if it fails, capture and repair automatically
 *   shim       install a short launcher next to the harness home
 * @module @dsh-external/dsh-rescue/cli
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runDoctor, worstLevel } from './doctor.ts'
import { defaultStateRoot, launchRescue, verifyCommand, type PermissionMode } from './launcher.ts'
import { dshHome, homePath, packageRootDir, planeCandidates, requireFromPlane } from './plane.ts'
import { captureBoot, writeIncident } from './probe.ts'
import { renderJson, renderReport } from './report.ts'

/** Parsed command line. */
interface Invocation {
  command: 'doctor' | 'verify' | 'fix' | 'repair' | 'supervise' | 'shim' | 'help'
  plane?: string
  profile: string
  task?: string
  provider?: string
  model?: string
  permissionMode: PermissionMode
  workspace?: string
  stateRoot: string
  json: boolean
  noLlm: boolean
  dryRun: boolean
  timeoutMs: number
  args: string[]
}

const USAGE = `dsh-rescue — repair a DeepSeek Harness deployment that will not start

Usage
  dsh-rescue doctor [--json]             diagnose without booting or calling a model
  dsh-rescue verify                      boot the target profile once and report the result
  dsh-rescue fix [--dry-run]             apply the mechanically provable repairs
  dsh-rescue repair [task...]            boot a minimal creation-mode agent and repair
  dsh-rescue supervise [-- <dsh args>]   run the target profile; on failure, fix it
  dsh-rescue shim                        install a short launcher under the harness home

Options
  --plane <dir>            node_modules root to boot from (default: first usable)
  --profile <name>         profile to inspect, boot, or repair (default: web)
  --state-root <dir>       where rescue artifacts and redirected state live
                           (default: $DSH_HOME/rescue)
  --permission-mode <m>    read-only | workspace-write | danger-full-access
                           (default: danger-full-access — the repair target lies outside any workspace)
  --workspace <dir>        workspace root used by workspace-write
  --model <id>             model for the repair agent (default: the deployment's own route)
  --provider <id>          provider for the repair agent
  --no-llm                 stop after the deterministic pass; never call a model
  --dry-run                report what fix would change without writing
  --json                   machine-readable doctor output
  --timeout <ms>           how long a boot attempt may run before it counts as up (default: 25000)
  -h, --help               this help

Exit codes
  0 ok    1 the repair agent reported a failure    2 no usable deployment plane
  3 the rescue tree could not boot                 4 the target profile did not come up
  5 nothing was mechanically fixable
`

/** Read one option value, failing loudly on a missing operand. */
function value(args: readonly string[], index: number, name: string): string {
  const next = args[index + 1]
  if (next === undefined || next.startsWith('--')) throw new Error(`${name} requires a value`)
  return next
}

/**
 * Parse the command line.
 * @param args - `process.argv.slice(2)`.
 * @returns the resolved invocation.
 * @throws when an option is malformed.
 */
export function parseArgs(args: readonly string[]): Invocation {
  const invocation: Invocation = {
    command: 'help',
    profile: 'web',
    permissionMode: 'danger-full-access',
    stateRoot: defaultStateRoot(),
    json: false,
    noLlm: false,
    dryRun: false,
    timeoutMs: 25_000,
    args: [],
  }
  const rest: string[] = []
  let command: Invocation['command'] | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === undefined) continue
    if (arg === '--') {
      invocation.args = args.slice(index + 1)
      break
    }
    if (arg === '-h' || arg === '--help') return { ...invocation, command: 'help' }
    if (arg === '--json') { invocation.json = true; continue }
    if (arg === '--no-llm') { invocation.noLlm = true; continue }
    if (arg === '--dry-run') { invocation.dryRun = true; continue }
    if (arg === '--plane') { invocation.plane = value(args, index, arg); index++; continue }
    if (arg === '--profile') { invocation.profile = value(args, index, arg); index++; continue }
    if (arg === '--state-root') { invocation.stateRoot = resolve(value(args, index, arg)); index++; continue }
    if (arg === '--workspace') { invocation.workspace = resolve(value(args, index, arg)); index++; continue }
    if (arg === '--model') { invocation.model = value(args, index, arg); index++; continue }
    if (arg === '--provider') { invocation.provider = value(args, index, arg); index++; continue }
    if (arg === '--timeout') { invocation.timeoutMs = Number(value(args, index, arg)); index++; continue }
    if (arg === '--permission-mode') {
      const mode = value(args, index, arg)
      if (mode !== 'read-only' && mode !== 'workspace-write' && mode !== 'danger-full-access') {
        throw new Error(`--permission-mode must be read-only, workspace-write, or danger-full-access (got ${mode})`)
      }
      invocation.permissionMode = mode
      index++
      continue
    }
    if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`)
    if (command === undefined) {
      if (arg === 'doctor' || arg === 'verify' || arg === 'fix' || arg === 'repair' || arg === 'supervise' || arg === 'shim' || arg === 'help') {
        command = arg
        continue
      }
      throw new Error(`unknown command ${arg}; run dsh-rescue --help`)
    }
    rest.push(arg)
  }
  if (command === 'repair' && rest.length > 0) invocation.task = rest.join(' ')
  if (command === 'supervise' && invocation.args.length === 0 && rest.length > 0) invocation.args = rest
  return { ...invocation, command: command ?? 'repair' }
}

/** Resolve the plane a capture should run against, preferring a usable one. */
async function resolveProbePlane(invocation: Invocation): Promise<string | undefined> {
  const report = await runDoctor({
    ...invocation.plane === undefined ? {} : { plane: invocation.plane },
    profile: invocation.profile,
    packageDir: packageRootDir(),
  })
  return report.planes.find(plane => plane.usable)?.root
}

/** Write the short launcher shims next to the harness home. */
function installShim(stateRoot: string): number {
  const cli = join(packageRootDir(), 'lib', 'cli.js')
  mkdirSync(stateRoot, { recursive: true })
  const cmd = [
    '@echo off',
    `rem dsh-rescue launcher — runs the standalone rescue CLI with this Node.`,
    `"${process.execPath}" "${cli}" %*`,
    '',
  ].join('\r\n')
  const sh = [
    '#!/bin/sh',
    '# dsh-rescue launcher — runs the standalone rescue CLI with this Node.',
    `exec "${process.execPath}" "${cli}" "$@"`,
    '',
  ].join('\n')
  writeFileSync(join(stateRoot, 'dsh-rescue.cmd'), cmd)
  writeFileSync(join(stateRoot, 'dsh-rescue.sh'), sh)
  process.stdout.write(`dsh-rescue: launcher written\n  ${join(stateRoot, 'dsh-rescue.cmd')}\n  ${join(stateRoot, 'dsh-rescue.sh')}\n`)
  process.stdout.write(`dsh-rescue: add ${stateRoot} to PATH, or call the file directly, when the harness will not start.\n`)
  return 0
}

/**
 * Apply the mechanical repairs the doctor can prove.
 *
 * Only one class of failure has an unambiguous minimal fix: an inserted row whose
 * package does not resolve. Disabling that row in the profile's own patch layer
 * removes it from the tree without deleting anything, works whether the insert
 * came from the profile or from a bundle below it, and is undone by deleting the
 * appended lines. Everything else needs a human decision — which duplicate insert
 * to keep, which package to reinstall — so it is reported, not guessed at.
 * @param invocation - the parsed command line.
 * @returns the number of fixes applied, and the lines describing them.
 */
async function applyMechanicalFixes(invocation: Invocation): Promise<{ applied: string[]; skipped: string[]; rollback: () => void }> {
  const report = await runDoctor({
    ...invocation.plane === undefined ? {} : { plane: invocation.plane },
    profile: invocation.profile,
    packageDir: packageRootDir(),
  })
  const applied: string[] = []
  const skipped: string[] = []
  const written: Array<{ path: string; original: string }> = []
  const rollback = (): void => {
    for (const file of written) {
      try {
        writeFileSync(file.path, file.original)
      } catch {
        // A rollback that cannot write is reported by the caller's own message;
        // the backup beside the file is the manual recovery path.
      }
    }
  }
  const profile = report.profiles.find(entry => entry.name === invocation.profile)
  if (profile === undefined) return { applied, skipped, rollback }

  const patchPath = join(profile.dir, 'cordis.patch.yml')
  const targets = profile.unresolvedInserts.filter(row => !profile.disabledRows.includes(row.id))
  for (const row of targets) {
    if (!existsSync(patchPath)) {
      skipped.push(`${row.id}: ${patchPath} does not exist, so there is no user layer to disable it in`)
      continue
    }
    const before = readFileSync(patchPath, 'utf8')
    const stamp = new Date().toISOString()
    const addition = [
      '',
      `# Added by dsh-rescue at ${stamp}: row "${row.id}" mounts ${row.name},`,
      '# which does not resolve, so the whole tree refused to activate.',
      '# Delete these four lines to undo this change.',
      `- id: ${row.id}`,
      '  disabled: true',
      '',
    ].join('\n')
    const after = before.replace(/\n*$/, '\n') + addition
    // A patch file that cannot be parsed refuses the WHOLE tree, so the new text
    // is parsed with the Loader's own dialect before it is allowed to land.
    if (!patchListParses(invocation, after)) {
      skipped.push(`${row.id}: refusing to write ${patchPath}; the result would not parse`)
      continue
    }
    if (!invocation.dryRun) {
      copyFileSync(patchPath, `${patchPath}.rescue-bak-${stamp.replace(/[:.]/g, '-')}`)
      writeFileSync(patchPath, after)
      written.push({ path: patchPath, original: before })
    }
    applied.push(`${row.id} (${row.name}) disabled in ${patchPath}`)
  }
  return { applied, skipped, rollback }
}

/**
 * Parse a candidate patch file with the Loader's own dialect.
 * @param invocation - the parsed command line, for the plane override.
 * @param content - the candidate file text.
 * @returns true when the text parses as a top-level array of patch entries.
 */
function patchListParses(invocation: Invocation, content: string): boolean {
  try {
    const report = planeCandidates(invocation.plane, packageRootDir())
    const root = report.find(plane => plane.usable)?.root
    if (root === undefined) return false
    const yaml = requireFromPlane(root, 'js-yaml') as { load(text: string, options?: unknown): unknown } | undefined
    if (yaml === undefined) return false
    const parsed = yaml.load(content)
    return Array.isArray(parsed)
  } catch {
    return false
  }
}

/** `fix`: apply the mechanical repairs and report the rest. */
async function commandFix(invocation: Invocation): Promise<number> {
  const { applied, skipped } = await applyMechanicalFixes(invocation)
  for (const line of applied) process.stdout.write(`dsh-rescue: ${invocation.dryRun ? 'would fix' : 'fixed'} ${line}\n`)
  for (const line of skipped) process.stderr.write(`dsh-rescue: skipped ${line}\n`)
  if (applied.length === 0) {
    process.stdout.write('dsh-rescue: no mechanically fixable problem found.\n')
    process.stdout.write('dsh-rescue: run dsh-rescue doctor for the full diagnosis, or dsh-rescue repair to hand it to an agent.\n')
    return 5
  }
  if (!invocation.dryRun) process.stdout.write(`dsh-rescue: applied ${String(applied.length)} fix(es); run dsh-rescue verify to confirm the boot.\n`)
  return 0
}

/** `doctor`: print the deterministic diagnosis. */
async function commandDoctor(invocation: Invocation): Promise<number> {
  const report = await runDoctor({
    ...invocation.plane === undefined ? {} : { plane: invocation.plane },
    profile: invocation.profile,
    packageDir: packageRootDir(),
  })
  process.stdout.write(invocation.json ? renderJson(report) : renderReport(report))
  if (invocation.json) {
    process.stdout.write('\n')
    return 0
  }
  const worst = worstLevel(report)
  if (worst === 'error') process.stdout.write('\nnext: dsh-rescue repair      (boot a repair agent with this diagnosis)\n')
  else if (worst === 'warn') process.stdout.write('\nno blocking error found; run dsh-rescue verify to boot the profile and confirm.\n')
  else process.stdout.write('\nnothing wrong found. If a boot still fails, run dsh-rescue supervise to capture it.\n')
  return 0
}

/** `verify`: capture one boot of the real profile. */
async function commandVerify(invocation: Invocation): Promise<number> {
  const planeRoot = await resolveProbePlane(invocation)
  if (planeRoot === undefined) {
    process.stderr.write('dsh-rescue: no usable deployment plane; run dsh-rescue doctor\n')
    return 2
  }
  process.stderr.write(`dsh-rescue: booting ${verifyCommand(planeRoot, invocation.profile)} (up to ${String(invocation.timeoutMs)}ms)\n`)
  const attempt = await captureBoot({
    planeRoot,
    profile: invocation.profile,
    cwd: process.cwd(),
    timeoutMs: invocation.timeoutMs,
    extraArgs: invocation.args,
    logPath: join(invocation.stateRoot, 'boot.log'),
    echo: true,
  })
  if (attempt.booted) {
    process.stdout.write(`\ndsh-rescue: profile "${invocation.profile}" came up (${String(attempt.durationMs)}ms)\n`)
    return 0
  }
  const incident = writeIncident(invocation.stateRoot, attempt, {
    profileDir: homePath('profiles', invocation.profile),
    dshHome: dshHome(),
  })
  process.stderr.write(`\ndsh-rescue: profile "${invocation.profile}" did NOT come up (exit ${String(attempt.exitCode)}, ${String(attempt.durationMs)}ms)\n`)
  if (attempt.signals.length > 0) {
    process.stderr.write('dsh-rescue: diagnostics:\n')
    for (const signal of attempt.signals.slice(-8)) process.stderr.write(`  ${signal}\n`)
  }
  process.stderr.write(`dsh-rescue: full capture in ${incident.dir ?? invocation.stateRoot}\n`)
  process.stderr.write('dsh-rescue: run dsh-rescue repair to fix it with this evidence.\n')
  return 4
}

/**
 * The mission `supervise` hands the repair agent when the human gave none.
 *
 * A supervised run is unattended by definition: the profile just failed and the
 * human is not sitting at a prompt. The mission text carries the evidence; this
 * only states what to do with it.
 * @param profile - the profile that failed to boot.
 * @returns the default one-shot task.
 */
function defaultRepairTask(profile: string): string {
  return [
    `Restore a normal boot of profile "${profile}".`,
    'The captured failure in the mission already reproduces it and names the offending row: treat that capture as authoritative and start from the fix, not from another reproduction.',
    'Fix exactly that target in the file the mission names, backing the file up first, then run the verification command and quote what it printed.',
    'If the shell tool cannot spawn processes in this environment, say so in one line and finish with the exact edit you made, so the human can verify it themselves.',
  ].join(' ')
}

/** `supervise`: run the real profile, then repair automatically on failure. */
async function commandSupervise(invocation: Invocation): Promise<number> {
  const planeRoot = await resolveProbePlane(invocation)
  if (planeRoot === undefined) {
    process.stderr.write('dsh-rescue: no usable deployment plane; run dsh-rescue doctor\n')
    return 2
  }
  process.stderr.write(`dsh-rescue: supervising ${verifyCommand(planeRoot, invocation.profile)} (boot window ${String(invocation.timeoutMs)}ms)\n`)
  const attempt = await captureBoot({
    planeRoot,
    profile: invocation.profile,
    cwd: process.cwd(),
    timeoutMs: invocation.timeoutMs,
    extraArgs: invocation.args,
    logPath: join(invocation.stateRoot, 'boot.log'),
    keepAlive: true,
    echo: true,
  })
  if (attempt.booted) {
    process.stderr.write(`\ndsh-rescue: profile "${invocation.profile}" came up${attempt.pid === undefined ? '' : ` (pid ${String(attempt.pid)})`}; nothing to repair\n`)
    process.stderr.write(`dsh-rescue: boot log ${attempt.logPath}\n`)
    return 0
  }
  const incident = writeIncident(invocation.stateRoot, attempt, {
    profileDir: homePath('profiles', invocation.profile),
    dshHome: dshHome(),
  })
  process.stderr.write(`\ndsh-rescue: profile "${invocation.profile}" did NOT come up\n`)
  if (attempt.signals.length > 0) {
    for (const signal of attempt.signals.slice(-8)) process.stderr.write(`  ${signal}\n`)
  }
  process.stderr.write(`dsh-rescue: capture ${incident.dir ?? invocation.stateRoot}\n`)

  // Deterministic pass first: it is instant, it never touches a model, and it
  // covers the failure class where the minimal fix is provable. Only a boot that
  // is still broken afterwards is worth an agent.
  const { applied, skipped, rollback } = await applyMechanicalFixes(invocation)
  for (const line of applied) process.stderr.write(`dsh-rescue: fixed ${line}\n`)
  for (const line of skipped) process.stderr.write(`dsh-rescue: skipped ${line}\n`)

  if (applied.length > 0) {
    process.stderr.write(`dsh-rescue: re-verifying after ${String(applied.length)} mechanical fix(es)\n`)
    const retry = await captureBoot({
      planeRoot,
      profile: invocation.profile,
      cwd: process.cwd(),
      timeoutMs: invocation.timeoutMs,
      extraArgs: invocation.args,
      logPath: join(invocation.stateRoot, 'boot.log'),
      keepAlive: true,
      echo: true,
    })
    if (retry.booted) {
      process.stderr.write(`\ndsh-rescue: profile "${invocation.profile}" came up after ${String(applied.length)} mechanical fix(es); no agent needed\n`)
      return 0
    }
    writeIncident(invocation.stateRoot, retry, {
      profileDir: homePath('profiles', invocation.profile),
      dshHome: dshHome(),
    })
    // An automatic writer that cannot prove it helped must not leave its guess
    // behind: the deployment goes back exactly as it was found, and the agent
    // reasons over the original state rather than over a pile of rejected edits.
    rollback()
    process.stderr.write('dsh-rescue: the mechanical pass did not restore the boot; it has been rolled back\n')
  }

  if (invocation.noLlm) {
    process.stdout.write(renderReport(await runDoctor({
      ...invocation.plane === undefined ? {} : { plane: invocation.plane },
      profile: invocation.profile,
      packageDir: packageRootDir(),
    })))
    return 4
  }
  return await launchRescue({
    ...invocation.plane === undefined ? {} : { plane: invocation.plane },
    profile: invocation.profile,
    bootArgs: invocation.args,
    task: invocation.task ?? defaultRepairTask(invocation.profile),
    permissionMode: invocation.permissionMode,
    stateRoot: invocation.stateRoot,
    ...invocation.workspace === undefined ? {} : { workspace: invocation.workspace },
    ...invocation.provider === undefined ? {} : { provider: invocation.provider },
    ...invocation.model === undefined ? {} : { model: invocation.model },
  })
}

/** `repair`: diagnose, then boot the repair agent. */
async function commandRepair(invocation: Invocation): Promise<number> {
  if (invocation.noLlm) return await commandDoctor(invocation)
  return await launchRescue({
    ...invocation.plane === undefined ? {} : { plane: invocation.plane },
    profile: invocation.profile,
    task: invocation.task,
    permissionMode: invocation.permissionMode,
    stateRoot: invocation.stateRoot,
    ...invocation.workspace === undefined ? {} : { workspace: invocation.workspace },
    ...invocation.provider === undefined ? {} : { provider: invocation.provider },
    ...invocation.model === undefined ? {} : { model: invocation.model },
  })
}

/** Run one invocation and return its exit code. */
async function main(): Promise<number> {
  let invocation: Invocation
  try {
    invocation = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`dsh-rescue: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`)
    return 64
  }
  switch (invocation.command) {
    case 'help': process.stdout.write(USAGE); return 0
    case 'shim': return installShim(invocation.stateRoot)
    case 'doctor': return await commandDoctor(invocation)
    case 'verify': return await commandVerify(invocation)
    case 'fix': return await commandFix(invocation)
    case 'supervise': return await commandSupervise(invocation)
    case 'repair': return await commandRepair(invocation)
  }
}

const code = await main()
// The rescue tree owns its own teardown; nothing else should keep the loop alive.
process.exit(code)
