/**
 * The in-process half of the rescue: three model-callable tools that let a
 * healthy session inspect the deployment, record a handoff for a future rescue,
 * and launch the standalone rescue agent as a separate process.
 *
 * This half cannot help when the harness is already down — that is what
 * `lib/cli.js` is for. What it does is make the rescue reachable *before* the
 * damage: check the deployment, write down what you were doing, and start a
 * repair agent that outlives this process.
 * @module @dsh-external/dsh-rescue
 */

import { spawn } from 'node:child_process'
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { classifyCrash, readBootState, readIncident, runDoctor, worstLevel, writeBootState } from './doctor.ts'
import { renderJson, renderReport } from './report.ts'
import { defaultStateRoot } from './launcher.ts'
import { packageRootDir } from './plane.ts'
import { PACKAGE_VERSION } from './version.ts'

/** Stable Cordis plugin name. */
export const name = '@dsh-external/dsh-rescue'

/** The tool registry is the only hard dependency. */
export const inject = ['tools']

/** Bundle configuration. */
export interface Config {
  /** Profile these tools inspect and hand off to. */
  profile: string
  /** Where rescue artifacts live; defaults to `$DSH_HOME/rescue`. */
  stateRoot?: string
  /** Write the short launcher shim under the state root on mount. */
  installShim: boolean
}

export const Config: z<Config> = z.object({
  profile: z.string().default('web'),
  stateRoot: z.string(),
  installShim: z.boolean().default(true),
})

/** Render a text tool result. */
function text(value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: String(value) }]
}

/**
 * Write the short launcher the human runs when the harness will not start.
 * @param stateRoot - the rescue state root.
 * @returns the written file paths, or the failure that prevented writing.
 */
function writeShim(stateRoot: string): { files: string[]; error?: string } {
  try {
    mkdirSync(stateRoot, { recursive: true })
    const cli = join(packageRootDir(), 'lib', 'cli.js')
    const cmd = join(stateRoot, 'dsh-rescue.cmd')
    const sh = join(stateRoot, 'dsh-rescue.sh')
    writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`)
    writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`)
    return { files: [cmd, sh] }
  } catch (error) {
    return { files: [], error: error instanceof Error ? error.message : String(error) }
  }
}

/** How long to wait before assuming a surface with no readiness signal came up. */
const READY_FALLBACK_MS = 30_000

/**
 * Record this run's boot outcome so the next run can attribute a crash.
 *
 * A dying process cannot write its own post-mortem, so the handshake runs the
 * other way round: this mount opens the record as unfinished, and only readiness
 * closes it as finished. The next mount — or `dsh-rescue doctor`, which reads the
 * same file — therefore knows a previous run never came up, and `lastGoodAt`
 * survives as the anchor for what changed since.
 *
 * Readiness is the launcher's own signal (`appReady`) when the surface provides
 * one; the timer is the fallback for surfaces that never commit it, and a clean
 * unload before readiness is recorded as such rather than as a crash.
 * @param ctx - plugin context owning the handshake's lifetime.
 * @param stateRoot - the rescue state root holding the record.
 */
function installBootHandshake(ctx: Context, stateRoot: string): void {
  const previous = readBootState(stateRoot)
  const crashed = previous !== undefined && previous.ok !== true && previous.cleanExit !== true
  const startedAt = new Date().toISOString()
  let settled = false
  // Only an interrupt or termination signal means someone asked this run to stop.
  // Every other teardown before readiness is a load that failed, and treating it
  // as a clean stop would hide exactly the failure this record exists to catch.
  let signalled = false
  const onSignal = (): void => { signalled = true }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  const finish = (cleanExit: boolean): void => {
    settled = true
    writeBootState(stateRoot, {
      ok: true,
      startedAt,
      okAt: new Date().toISOString(),
      lastGoodAt: new Date().toISOString(),
      pid: process.pid,
      cleanExit,
      crashReason: null,
      version: PACKAGE_VERSION,
    })
  }

  // Classify the previous failure now, while its captured output still exists:
  // by the next boot the log may have rolled over, and the class is what tells
  // the doctor and the repair agent which fix applies.
  let crashReason = previous?.crashReason ?? null
  let crashEvidence = previous?.crashEvidence
  if (crashed && crashReason === null) {
    const incident = readIncident(stateRoot)
    const text = incident?.output ?? safeText(join(stateRoot, 'boot.log'))
    if (text !== undefined) {
      crashReason = classifyCrash(text)
      crashEvidence = incident?.dir ?? join(stateRoot, 'boot.log')
    }
  }

  writeBootState(stateRoot, {
    ok: false,
    startedAt,
    lastGoodAt: previous?.lastGoodAt ?? null,
    pid: process.pid,
    crashReason,
    ...crashEvidence === undefined ? {} : { crashEvidence },
    version: PACKAGE_VERSION,
  })
  if (crashed) {
    process.stderr.write(`dsh-rescue: the previous harness run did not reach ready (classified: ${String(crashReason ?? 'unknown')}); run rescue_doctor or \`dsh-rescue doctor\`\n`)
  }

  ctx.effect(() => {
    const timer = setTimeout(() => { finish(false) }, READY_FALLBACK_MS)
    const ready = ctx.get('appReady') as { onReady(listener: () => void): () => void } | undefined
    const offReady = ready?.onReady(() => {
      clearTimeout(timer)
      finish(false)
    })
    return () => {
      clearTimeout(timer)
      offReady?.()
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      // An unload after readiness is a clean shutdown. One before readiness is a
      // boot that was stopped: a signal asked for it, or the tree was torn down
      // under a load that never completed. Recording which is what keeps the next
      // doctor from reporting a deliberate stop as a crash, and from hiding a
      // failed load as a deliberate stop.
      if (settled) {
        writeBootState(stateRoot, { ...readBootState(stateRoot), ok: true, cleanExit: true, tornDown: false, version: PACKAGE_VERSION })
        return
      }
      const current = readBootState(stateRoot)
      writeBootState(stateRoot, {
        ...current, ok: false, cleanExit: signalled, tornDown: !signalled, version: PACKAGE_VERSION,
      })
    }
  }, '@dsh-external/dsh-rescue: boot handshake')
}

/** Read a file as text, or `undefined` when it is absent or unreadable. */
function safeText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Mount the rescue tools.
 * @param ctx - plugin context carrying the tool registry.
 * @param config - bundle configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const stateRoot = config.stateRoot ?? defaultStateRoot()
  if (config.installShim) writeShim(stateRoot)
  installBootHandshake(ctx, stateRoot)

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'rescue_doctor',
    description: 'Diagnose this DeepSeek Harness deployment without booting it: profiles, bundles, links, patch layers, duplicate entry ids, model route, boot history (whether the previous run reached readiness and what killed it), and the last captured boot failure.',
    parameters: {
      json: { type: 'boolean', description: 'Return the raw report as JSON instead of the readable form.' },
    },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: unknown) => text(value) },
    async execute(args: { json?: boolean }) {
      const report = await runDoctor({ profile: config.profile, packageDir: packageRootDir() })
      return args.json === true ? renderJson(report) : renderReport(report)
    },
  })), '@dsh-external/dsh-rescue: rescue_doctor')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'rescue_handoff',
    description: 'Record what you are doing and what must happen next in $DSH_HOME/rescue/handoff.md, so a rescue agent started after a crash knows where to resume. Returns the exact rescue command.',
    parameters: {
      note: { type: 'string', required: true, description: 'What to record: the objective, the files touched, and how to tell whether the change worked.' },
    },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: unknown) => text(value) },
    async execute(args: { note: string }) {
      const path = join(stateRoot, 'handoff.md')
      const stamp = new Date().toISOString()
      const body = [
        '# Rescue handoff',
        '',
        `recorded at ${stamp}`,
        `cwd         ${process.cwd()}`,
        `profile     ${config.profile}`,
        '',
        args.note.trim(),
        '',
        '## How to resume',
        '',
        'Run `dsh-rescue repair` (or `dsh-rescue supervise`) from a terminal. The repair agent reads this file as part of its mission.',
        '',
      ].join('\n')
      try {
        mkdirSync(stateRoot, { recursive: true })
        writeFileSync(path, body)
      } catch (error) {
        return `could not write ${path}: ${error instanceof Error ? error.message : String(error)}`
      }
      return `handoff recorded in ${path}\nrescue command: ${join(stateRoot, 'dsh-rescue.cmd')} repair`
    },
  })), '@dsh-external/dsh-rescue: rescue_handoff')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'rescue_launch',
    description: 'Start the standalone rescue agent in a separate process, where it survives a crash of this one. It diagnoses the deployment, then repairs it with the creation-mode toolset. Use before risky self-modification.',
    parameters: {
      task: { type: 'string', required: true, description: 'The mission for the repair agent: what to fix and how to verify it.' },
      profile: { type: 'string', description: `Profile to repair. Default: ${config.profile}` },
      permission_mode: { type: 'string', description: 'read-only | workspace-write | danger-full-access. Default: danger-full-access' },
    },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: unknown) => text(value) },
    async execute(args: { task: string; profile?: string; permission_mode?: string }) {
      const profile = args.profile ?? config.profile
      const launches = join(stateRoot, 'launches')
      mkdirSync(launches, { recursive: true })
      const logPath = join(launches, `${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
      const cli = join(packageRootDir(), 'lib', 'cli.js')
      const argv = [
        cli, 'repair', args.task,
        '--profile', profile,
        '--state-root', stateRoot,
        ...args.permission_mode === undefined ? [] : ['--permission-mode', args.permission_mode],
      ]
      const log = openSync(logPath, 'a')
      const child = spawn(process.execPath, argv, { detached: true, stdio: ['ignore', log, log] })
      child.unref()
      return [
        `rescue agent started in a separate process (pid ${String(child.pid ?? 0)})`,
        `profile      ${profile}`,
        `log          ${logPath}`,
        `command      ${process.execPath} ${argv.map(part => (part.includes(' ') ? `"${part}"` : part)).join(' ')}`,
        '',
        'The agent diagnoses first, writes its report into the state root, and repairs with the creation-mode toolset. It keeps running even if this process dies.',
      ].join('\n')
    },
  })), '@dsh-external/dsh-rescue: rescue_launch')

  // Report the deployment's state once at mount so a session starts knowing
  // whether a rescue is already warranted.
  void runDoctor({ profile: config.profile, packageDir: packageRootDir() }).then((report) => {
    const worst = worstLevel(report)
    if (worst === 'error') {
      process.stderr.write(`dsh-rescue: deployment has ${String(report.findings.filter(finding => finding.level === 'error').length)} blocking problem(s); run rescue_doctor or \`dsh-rescue doctor\`\n`)
    }
  }, () => {
    // A diagnosis failure is not a plugin failure: the tools still register and
    // report it when called.
  })
}
