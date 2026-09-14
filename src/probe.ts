/**
 * Boot capture: run the real harness in a child process, keep everything it
 * printed, and decide whether it actually came up.
 *
 * This is the only place that observes the failure from the outside. Its output
 * — command, exit code, duration, and the verbatim combined output — is what the
 * repair agent reads, so nothing here summarizes, filters, or truncates.
 *
 * The child writes straight to a log file rather than through pipes: the capture
 * then survives this process, needs no reader to drain it, and works in
 * environments that deny a child its own stdio pipes.
 * @module @dsh-external/dsh-rescue/probe
 */

import { spawn } from 'node:child_process'
import {
  closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { extractBootSignals } from './doctor.ts'
import type { Incident } from './types.ts'

/** How one boot attempt is run. */
export interface CaptureOptions {
  /** Plane the harness binary is taken from. */
  planeRoot: string
  /** Profile to boot. */
  profile: string
  /** Working directory for the child. */
  cwd: string
  /** Extra arguments appended after `--profile <name>`. */
  extraArgs?: string[]
  /** How long to wait before declaring a long-running surface booted. */
  timeoutMs: number
  /** Absolute path the child's combined output is written to. */
  logPath: string
  /**
   * Leave the child running when the boot window expires. A supervised boot
   * that came up must stay up; a verification boot is stopped instead.
   */
  keepAlive?: boolean
  /** Echo the captured output to this process's streams once the attempt settles. */
  echo?: boolean
}

/** The result of one boot attempt. */
export interface BootAttempt {
  at: string
  command: string
  cwd: string
  exitCode: number | null
  durationMs: number
  booted: boolean
  output: string
  signals: string[]
  /** Absolute path of the raw combined output. */
  logPath: string
  /** Process id of a child left running, when {@link CaptureOptions.keepAlive} applied. */
  pid?: number
}

/** The harness binary inside a plane. */
export function harnessBin(planeRoot: string): string {
  return join(planeRoot, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

/** Quote one argv element for display. */
function quote(part: string): string {
  return part.includes(' ') ? `"${part}"` : part
}

/** Build the exact command line a capture runs. */
export function captureCommand(planeRoot: string, profile: string, extraArgs: readonly string[]): string[] {
  return [process.execPath, harnessBin(planeRoot), '--profile', profile, ...extraArgs]
}

/** Read a capture log, tolerating a file the child is still writing. */
function readLog(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Run one boot attempt and capture it completely.
 * @param options - plane, profile, timeout, log path, and optional extra arguments.
 * @returns the attempt, including whether the surface came up.
 */
export async function captureBoot(options: CaptureOptions): Promise<BootAttempt> {
  const argv = captureCommand(options.planeRoot, options.profile, options.extraArgs ?? [])
  const command = argv.map(quote).join(' ')
  const startedAt = Date.now()
  const at = new Date(startedAt).toISOString()
  const base = {
    at,
    command,
    cwd: options.cwd,
    logPath: options.logPath,
  }

  if (!existsSync(harnessBin(options.planeRoot))) {
    const message = `dsh-rescue: the harness binary is missing at ${harnessBin(options.planeRoot)}\n`
    writeFileSync(options.logPath, message)
    return {
      ...base,
      exitCode: null,
      durationMs: 0,
      booted: false,
      output: message,
      signals: [`harness binary missing: ${harnessBin(options.planeRoot)}`],
    }
  }

  mkdirSync(dirname(options.logPath), { recursive: true })
  const log = openSync(options.logPath, 'w')
  const attempt = await new Promise<BootAttempt>((resolveAttempt) => {
    let child
    try {
      child = spawn(argv[0] as string, argv.slice(1), {
        cwd: options.cwd,
        stdio: ['ignore', log, log],
        env: process.env,
        detached: options.keepAlive === true,
      })
    } catch (error) {
      closeSync(log)
      const message = `dsh-rescue: failed to start the harness: ${error instanceof Error ? error.message : String(error)}\n`
      writeFileSync(options.logPath, message)
      resolveAttempt({ ...base, exitCode: null, durationMs: 0, booted: false, output: message, signals: ['the harness process could not be started'] })
      return
    }

    let settled = false
    let grace: ReturnType<typeof setTimeout> | undefined
    let poll: ReturnType<typeof setTimeout> | undefined
    let settle: ReturnType<typeof setTimeout> | undefined
    const finish = (exitCode: number | null, booted: boolean, pid?: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (grace !== undefined) clearTimeout(grace)
      if (poll !== undefined) clearTimeout(poll)
      if (settle !== undefined) clearTimeout(settle)
      closeSync(log)
      const output = readLog(options.logPath)
      if (options.echo === true && output !== '') process.stderr.write(output)
      resolveAttempt({
        ...base,
        exitCode,
        durationMs: Date.now() - startedAt,
        booted,
        output,
        signals: extractBootSignals(output),
        ...pid === undefined ? {} : { pid },
      })
    }

    // A failure in flight is reported as soon as it is knowable: a failing DSH
    // prints its error and exits several seconds after it stops making progress,
    // so waiting for the deadline to look would often look too early.
    const awaitDeath = (): void => {
      if (settled) return
      grace = setTimeout(() => {
        child.kill()
        finish(null, false)
      }, FAILURE_GRACE_MS)
    }
    const watch = (): void => {
      if (settled) return
      if (showsBootFailure(readLog(options.logPath))) {
        awaitDeath()
        return
      }
      poll = setTimeout(watch, FAILURE_POLL_MS)
    }
    poll = setTimeout(watch, FAILURE_POLL_MS)

    const timer = setTimeout(() => {
      if (settled) return
      if (options.keepAlive === true) {
        // A long-lived surface that bound its port and never exited is up; it
        // keeps running, detached, after this supervisor leaves.
        child.unref()
        finish(null, true, child.pid)
        return
      }
      // Alive at the deadline is not yet proof of success. Hold briefly while
      // the watcher keeps looking: a boot that is failing right now will say so
      // within this window, and calling it up would report a dead deployment as
      // healthy and skip the repair entirely.
      settle = setTimeout(() => {
        child.kill()
        finish(null, true)
      }, SETTLE_MS)
    }, options.timeoutMs)

    child.on('error', (error: Error) => {
      const message = `dsh-rescue: failed to start the harness: ${error.message}\n`
      writeFileSync(options.logPath, readLog(options.logPath) + message)
      finish(null, false)
    })
    child.on('exit', (code: number | null) => { finish(code, code === 0) })
  })
  return attempt
}

/** How long a failing boot is given to finish dying so its exit code is captured. */
export const FAILURE_GRACE_MS = 20_000

/** How often the captured output is re-read while waiting for a boot. */
export const FAILURE_POLL_MS = 500

/** How long a boot alive at its deadline is watched before being called up. */
export const SETTLE_MS = 4_000

/**
 * Signatures that say a boot is failing, matched narrowly on purpose.
 *
 * This decides whether a still-running process came up, so a false positive
 * reports a dead deployment as healthy and skips the repair entirely — the worst
 * outcome this tool can produce. It is therefore much narrower than
 * {@link extractBootSignals}, which only has to be useful to a reader.
 */
const BOOT_FAILURE_SIGNATURES: readonly RegExp[] = [
  /plugin tree failed to load/,
  /plugin\(s\) failed to load/,
  /failed to import loader entry/,
  /duplicate loader entry id/,
  /did not activate/,
  /fatal load failure/,
  /already registered/,
  /invalid config/,
  /Cannot find package/,
  /ERR_MODULE_NOT_FOUND/,
  /must be a top-level YAML array/,
  /failed to parse (patches|overlay|config)/,
  /EADDRINUSE/,
]

/**
 * Whether captured output shows a boot that is failing.
 * @param text - the captured output so far.
 * @returns true when a failure signature is present.
 */
export function showsBootFailure(text: string): boolean {
  return BOOT_FAILURE_SIGNATURES.some(pattern => pattern.test(text))
}

/**
 * Decide what a boot attempt means, from its exit code and its output.
 *
 * Liveness alone is not evidence of success: a DSH that fails to load takes more
 * than ten seconds to die, so a process still running at the deadline may be a
 * corpse in progress. Exit code 0 is success, a non-zero exit is failure, and a
 * live process is only success when nothing in its output says otherwise.
 * @param exitCode - the process exit code, or `null` while it is still running.
 * @param output - everything the process printed.
 * @returns `up`, `down`, or `undecided` for a live process with a failure in flight.
 */
export function bootOutcome(exitCode: number | null, output: string): 'up' | 'down' | 'undecided' {
  if (exitCode === 0) return 'up'
  if (exitCode !== null) return 'down'
  return showsBootFailure(output) ? 'undecided' : 'up'
}

/** Keep at most this many incident directories. */
const MAX_INCIDENTS = 20

/** Files worth preserving exactly as they were at the moment of failure. */
const SNAPSHOT_FILES = ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml'] as const

/**
 * Persist one failed attempt, with the profile state that produced it.
 *
 * The snapshot matters: the repair agent may change these files, and the next
 * rescue must still be able to see what the failure actually looked like.
 * @param stateRoot - the rescue state root (`$DSH_HOME/rescue`).
 * @param attempt - the captured attempt.
 * @param context - profile directory and harness home to snapshot.
 * @returns the incident record, including its directory.
 */
export function writeIncident(
  stateRoot: string,
  attempt: BootAttempt,
  context: { profileDir?: string; dshHome: string },
): Incident {
  const stamp = attempt.at.replace(/[:.]/g, '-')
  const dir = join(stateRoot, 'incidents', stamp)
  mkdirSync(dir, { recursive: true })
  copyFileSync(attempt.logPath, join(dir, 'output.log'))

  const snapshots: string[] = []
  if (context.profileDir !== undefined) {
    for (const name of SNAPSHOT_FILES) {
      const source = join(context.profileDir, name)
      if (!existsSync(source)) continue
      copyFileSync(source, join(dir, `profile-${name}`))
      snapshots.push(`profile-${name}`)
    }
  }
  const homePatch = join(context.dshHome, 'cordis.patch.yml')
  if (existsSync(homePatch)) {
    copyFileSync(homePatch, join(dir, 'home-cordis.patch.yml'))
    snapshots.push('home-cordis.patch.yml')
  }
  const settings = join(context.dshHome, 'settings.yaml')
  if (existsSync(settings)) {
    copyFileSync(settings, join(dir, 'settings.yaml'))
    snapshots.push('settings.yaml')
  }

  const incident: Incident = { ...attempt, dir }
  writeFileSync(join(dir, 'incident.json'), JSON.stringify({ ...incident, snapshots }, undefined, 2) + '\n')
  mkdirSync(join(stateRoot, 'incidents'), { recursive: true })
  writeFileSync(join(stateRoot, 'incidents', 'latest.json'), JSON.stringify(incident, undefined, 2) + '\n')
  pruneIncidents(stateRoot)
  return incident
}

/** Drop the oldest incident directories beyond {@link MAX_INCIDENTS}. */
function pruneIncidents(stateRoot: string): void {
  const root = join(stateRoot, 'incidents')
  try {
    const entries = readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
    for (const stale of entries.slice(0, Math.max(0, entries.length - MAX_INCIDENTS))) {
      rmSync(join(root, stale), { recursive: true, force: true })
    }
  } catch {
    // Pruning is housekeeping; a read-only state root must not fail a rescue.
  }
}
