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
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { runDoctor, worstLevel } from "./doctor.js";
import { renderJson, renderReport } from "./report.js";
import { defaultStateRoot } from "./launcher.js";
import { packageRootDir } from "./plane.js";
/** Stable Cordis plugin name. */
export const name = '@dsh-external/dsh-rescue';
/** The tool registry is the only hard dependency. */
export const inject = ['tools'];
export const Config = z.object({
    profile: z.string().default('web'),
    stateRoot: z.string(),
    installShim: z.boolean().default(true),
});
/** Render a text tool result. */
function text(value) {
    return [{ type: 'text', text: String(value) }];
}
/**
 * Write the short launcher the human runs when the harness will not start.
 * @param stateRoot - the rescue state root.
 * @returns the written file paths, or the failure that prevented writing.
 */
function writeShim(stateRoot) {
    try {
        mkdirSync(stateRoot, { recursive: true });
        const cli = join(packageRootDir(), 'lib', 'cli.js');
        const cmd = join(stateRoot, 'dsh-rescue.cmd');
        const sh = join(stateRoot, 'dsh-rescue.sh');
        writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`);
        writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`);
        return { files: [cmd, sh] };
    }
    catch (error) {
        return { files: [], error: error instanceof Error ? error.message : String(error) };
    }
}
/**
 * Mount the rescue tools.
 * @param ctx - plugin context carrying the tool registry.
 * @param config - bundle configuration.
 */
export function apply(ctx, config) {
    const stateRoot = config.stateRoot ?? defaultStateRoot();
    if (config.installShim)
        writeShim(stateRoot);
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'rescue_doctor',
        description: 'Diagnose this DeepSeek Harness deployment without booting it: profiles, bundles, links, patch layers, duplicate entry ids, model route, and the last captured boot failure.',
        parameters: {
            json: { type: 'boolean', description: 'Return the raw report as JSON instead of the readable form.' },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
        async execute(args) {
            const report = await runDoctor({ profile: config.profile, packageDir: packageRootDir() });
            return args.json === true ? renderJson(report) : renderReport(report);
        },
    })), '@dsh-external/dsh-rescue: rescue_doctor');
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'rescue_handoff',
        description: 'Record what you are doing and what must happen next in $DSH_HOME/rescue/handoff.md, so a rescue agent started after a crash knows where to resume. Returns the exact rescue command.',
        parameters: {
            note: { type: 'string', required: true, description: 'What to record: the objective, the files touched, and how to tell whether the change worked.' },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
        async execute(args) {
            const path = join(stateRoot, 'handoff.md');
            const stamp = new Date().toISOString();
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
            ].join('\n');
            try {
                mkdirSync(stateRoot, { recursive: true });
                writeFileSync(path, body);
            }
            catch (error) {
                return `could not write ${path}: ${error instanceof Error ? error.message : String(error)}`;
            }
            return `handoff recorded in ${path}\nrescue command: ${join(stateRoot, 'dsh-rescue.cmd')} repair`;
        },
    })), '@dsh-external/dsh-rescue: rescue_handoff');
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'rescue_launch',
        description: 'Start the standalone rescue agent in a separate process, where it survives a crash of this one. It diagnoses the deployment, then repairs it with the creation-mode toolset. Use before risky self-modification.',
        parameters: {
            task: { type: 'string', required: true, description: 'The mission for the repair agent: what to fix and how to verify it.' },
            profile: { type: 'string', description: `Profile to repair. Default: ${config.profile}` },
            permission_mode: { type: 'string', description: 'read-only | workspace-write | danger-full-access. Default: danger-full-access' },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
        async execute(args) {
            const profile = args.profile ?? config.profile;
            const launches = join(stateRoot, 'launches');
            mkdirSync(launches, { recursive: true });
            const logPath = join(launches, `${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
            const cli = join(packageRootDir(), 'lib', 'cli.js');
            const argv = [
                cli, 'repair', args.task,
                '--profile', profile,
                '--state-root', stateRoot,
                ...args.permission_mode === undefined ? [] : ['--permission-mode', args.permission_mode],
            ];
            const log = openSync(logPath, 'a');
            const child = spawn(process.execPath, argv, { detached: true, stdio: ['ignore', log, log] });
            child.unref();
            return [
                `rescue agent started in a separate process (pid ${String(child.pid ?? 0)})`,
                `profile      ${profile}`,
                `log          ${logPath}`,
                `command      ${process.execPath} ${argv.map(part => (part.includes(' ') ? `"${part}"` : part)).join(' ')}`,
                '',
                'The agent diagnoses first, writes its report into the state root, and repairs with the creation-mode toolset. It keeps running even if this process dies.',
            ].join('\n');
        },
    })), '@dsh-external/dsh-rescue: rescue_launch');
    // Report the deployment's state once at mount so a session starts knowing
    // whether a rescue is already warranted.
    void runDoctor({ profile: config.profile, packageDir: packageRootDir() }).then((report) => {
        const worst = worstLevel(report);
        if (worst === 'error') {
            process.stderr.write(`dsh-rescue: deployment has ${String(report.findings.filter(finding => finding.level === 'error').length)} blocking problem(s); run rescue_doctor or \`dsh-rescue doctor\`\n`);
        }
    }, () => {
        // A diagnosis failure is not a plugin failure: the tools still register and
        // report it when called.
    });
}
//# sourceMappingURL=index.js.map