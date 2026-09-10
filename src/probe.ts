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
    const finish = (exitCode: number | null, booted: boolean, pid?: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
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

    const timer = setTimeout(() => {
      if (options.keepAlive === true) {
        // A long-lived surface that bound its port and never exited is up; it
        // keeps running, detached, after this supervisor leaves.
        child.unref()
        finish(null, true, child.pid)
        return
      }
      child.kill()
      finish(null, true)
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

/** Files worth preserving exactly as they were at the moment of failure. */
const SNAPSHOT_FILES = ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml'] as const

/** Keep at most this many incident directories. */
const MAX_INCIDENTS = 20

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
