/**
 * The rescue launcher: compose a host plane that does not depend on the failed
 * profile, boot it, and hand it the diagnosis.
 *
 * The launcher is the part that must survive a broken deployment, so it touches
 * as little of it as possible: it reads the plane's own `dsh-base` patch, its own
 * `rescue.cordis.yml`, and appends one runner row. Every failure path prints the
 * diagnosis it already computed instead of a bare stack.
 * @module @dsh-external/dsh-rescue/launcher
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runDoctor } from "./doctor.js";
import { verifyMountedOverrides, checkRescueCompatibility } from "./compat.js";
import { buildMission, RESCUE_PERSONA } from "./mission.js";
import { renderJson, renderReport } from "./report.js";
import { dshHome, homePath, loadAppBoot, packageRootDir, prepareRuntime, } from "./plane.js";
import { pathToFileURL } from 'node:url';
/** Create this run's artifact directory. */
function prepareRunDir(stateRoot) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const runDir = join(stateRoot, 'runs', stamp);
    mkdirSync(runDir, { recursive: true });
    return {
        runDir,
        doctorText: join(runDir, 'doctor.txt'),
        doctorJson: join(runDir, 'doctor.json'),
        missionPath: join(runDir, 'mission.md'),
        transcript: join(runDir, 'transcript.txt'),
    };
}
/**
 * The exact command that proves a repair worked, run against the same plane the
 * rescue itself uses so the agent verifies the deployment rather than a guess.
 *
 * Extra arguments carry through deliberately: a supervisor that booted on a
 * non-default port must hand the agent that same port, or the agent's own
 * verification fails on an unrelated bind error.
 * @param planeRoot - the plane's node_modules root.
 * @param profile - profile name.
 * @param extraArgs - arguments the supervising boot used, in order.
 * @returns a copy-pasteable command line.
 */
export function verifyCommand(planeRoot, profile, extraArgs = []) {
    const bin = join(planeRoot, '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    const quote = (value) => (value.includes(' ') ? `"${value}"` : value);
    return [process.execPath, bin, '--profile', profile, ...extraArgs].map(quote).join(' ');
}
/** The skill directories the rescue agent reads: shipped composition skills plus ours. */
function skillDirs(planeRoot) {
    const packageDir = packageRootDir();
    const shipped = join(planeRoot, '@deepseek-ai', 'dsh-agent-presets', 'presets', 'cordis', 'skills');
    return [join(packageDir, 'skills'), shipped].filter(directory => directory !== '');
}
/**
 * Boot the rescue tree on one plane.
 * @param report - the diagnosis, already computed.
 * @param planeRoot - the plane to boot from.
 * @param options - run options.
 * @param paths - this run's artifact paths.
 * @returns the process exit code once the agent finishes.
 * @throws when the tree cannot boot, so the caller can try another plane.
 */
async function bootOnPlane(report, planeRoot, options, paths) {
    const appBoot = await loadAppBoot(planeRoot);
    const stateRoot = options.stateRoot ?? homePath('rescue');
    const bootArgs = options.bootArgs ?? [];
    const mission = buildMission({
        report,
        profile: options.profile,
        planeRoot,
        ...report.checkout === undefined ? {} : { checkout: report.checkout },
        verifyCommand: verifyCommand(planeRoot, options.profile, bootArgs),
        runDir: paths.runDir,
    }, options.task);
    const basePatches = appBoot.loadOverlayPatches('dsh-rescue', join(planeRoot, '@deepseek-ai', 'dsh-base', 'cordis.patch.yml'));
    const rescuePatches = appBoot.loadOverlayPatches('dsh-rescue', join(packageRootDir(), 'rescue.cordis.yml'));
    const runtime = prepareRuntime(stateRoot, planeRoot);
    const runnerRow = {
        insert: [{
                id: 'rescue-runner',
                name: runtime.runnerUrl,
                config: {
                    ...options.task === undefined ? {} : { task: options.task },
                    ...options.provider === undefined ? {} : { provider: options.provider },
                    ...options.model === undefined ? {} : { model: options.model },
                    runDir: paths.runDir,
                    verifyCommand: verifyCommand(planeRoot, options.profile, bootArgs),
                    missionPath: paths.missionPath,
                    mission,
                },
            }],
    };
    // The composition reads these through `!!js` expressions, so the values are
    // set before the tree mounts and cleared again afterwards.
    const environment = {};
    const setEnv = (name, value) => {
        environment[name] = process.env[name];
        if (value === undefined)
            delete process.env[name];
        else
            process.env[name] = value;
    };
    setEnv('DSH_RESCUE_PERSONA', RESCUE_PERSONA);
    setEnv('DSH_RESCUE_PERMISSION_MODE', options.permissionMode);
    setEnv('DSH_RESCUE_WORKSPACE', options.workspace ?? options.cwd ?? process.cwd());
    setEnv('DSH_RESCUE_SKILL_DIRS', skillDirs(planeRoot).join(';'));
    setEnv('DSH_RESCUE_SESSIONS_ROOT', join(stateRoot, 'sessions'));
    setEnv('DSH_RESCUE_STORAGES_ROOT', join(stateRoot, 'storages'));
    setEnv('DSH_RESCUE_ATTACHMENTS_HOME', join(stateRoot, 'home'));
    let resolveExit = () => { };
    const finished = new Promise((resolveFinished) => { resolveExit = resolveFinished; });
    // The base bare row names resolve from. Node's own resolution always inserts
    // `node_modules`, so the base must be a directory that CONTAINS one: the
    // runtime directory, whose `node_modules` links the plane. Passing the plane
    // root itself only worked when the plane happened to be a directory named
    // `node_modules`, which made `--plane <any other dir>` silently fail to boot.
    const bareModuleBaseUrl = `${pathToFileURL(runtime.rootDir).href}/`;
    let context;
    try {
        context = await appBoot.boot('dsh-rescue', runtime.rootConfig, [...basePatches, ...rescuePatches, runnerRow], (hostCtx) => {
            hostCtx.provide('appExit', (code) => { resolveExit(code); });
        }, bareModuleBaseUrl);
    }
    catch (error) {
        for (const [name, value] of Object.entries(environment)) {
            if (value === undefined)
                delete process.env[name];
            else
                process.env[name] = value;
        }
        throw error;
    }
    // The tree reported itself healthy; confirm the overrides it depends on
    // actually landed. A deployment that renamed a permission row boots fine and
    // silently confines the agent, which would burn a repair run and report
    // nothing usable — better to stop here and say exactly what changed.
    const mounted = verifyMountedOverrides([...context.get('loader')?.entries() ?? []], { permissionMode: options.permissionMode, approvalPolicy: 'never' });
    for (const line of mounted.cosmetic)
        process.stderr.write(`dsh-rescue: warning: ${line}\n`);
    if (mounted.blocking.length > 0) {
        throw new Error([
            'the rescue tree booted, but the permissions it needs did not apply:',
            ...mounted.blocking.map(line => `  - ${line}`),
            'The rescue would start an agent that cannot write the files it was started to repair.',
            `Update the row ids in ${join(packageRootDir(), 'rescue.cordis.yml')} to match this deployment, or pass --plane pointing at a plane it matches.`,
        ].join('\n'));
    }
    const interrupt = () => {
        resolveExit(130);
        void context.fiber.dispose();
    };
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    const code = await finished;
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    await context.fiber.dispose();
    for (const [name, value] of Object.entries(environment)) {
        if (value === undefined)
            delete process.env[name];
        else
            process.env[name] = value;
    }
    return code;
}
/**
 * Run one rescue: diagnose, write the artifacts, then boot the repair agent.
 * @param options - run options.
 * @returns the process exit code.
 */
export async function launchRescue(options) {
    const stateRoot = options.stateRoot ?? homePath('rescue');
    const packageDir = packageRootDir();
    const report = await runDoctor({
        ...options.plane === undefined ? {} : { plane: options.plane },
        profile: options.profile,
        packageDir,
        ...options.cwd === undefined ? {} : { cwd: options.cwd },
    });
    const paths = prepareRunDir(stateRoot);
    writeFileSync(paths.doctorText, renderReport(report));
    writeFileSync(paths.doctorJson, renderJson(report));
    const usable = report.planes.filter(plane => plane.usable);
    if (usable.length === 0) {
        process.stderr.write(renderReport(report));
        process.stderr.write('\ndsh-rescue: no usable deployment plane; cannot boot a repair agent.\n');
        process.stderr.write(`dsh-rescue: diagnosis written to ${paths.doctorText}\n`);
        return 2;
    }
    const failures = [];
    for (const plane of usable) {
        // A plane whose base bundle no longer provides the permission rows will boot
        // the rescue into a state where it cannot write anything. Refusing the plane
        // leaves the next candidate — often an older install — a chance to work.
        const compatibility = await checkRescueCompatibility(plane.root, packageDir);
        if (compatibility.criticalMissing.length > 0) {
            const message = [
                `this plane's dsh-base (${compatibility.baseVersion ?? 'unknown'}) no longer provides ${compatibility.criticalMissing.join(', ')},`,
                'so the rescue could not claim the file access it needs.',
                `Update the row ids in ${join(packageDir, 'rescue.cordis.yml')} for this deployment.`,
            ].join(' ');
            failures.push(`${plane.root}: ${message}`);
            process.stderr.write(`dsh-rescue: skipping plane ${plane.root}: ${message}\n`);
            continue;
        }
        process.stderr.write(`dsh-rescue: booting the repair agent from ${plane.root} (${plane.origin})\n`);
        try {
            return await bootOnPlane(report, plane.root, options, paths);
        }
        catch (error) {
            const message = error instanceof Error ? error.stack ?? error.message : String(error);
            failures.push(`${plane.root}: ${message}`);
            process.stderr.write(`dsh-rescue: plane ${plane.root} failed to boot the rescue tree\n${message}\n`);
        }
    }
    process.stderr.write(renderReport(report));
    process.stderr.write(`\ndsh-rescue: every usable plane failed to boot the repair agent:\n${failures.join('\n')}\n`);
    process.stderr.write(`dsh-rescue: diagnosis written to ${paths.doctorText}\n`);
    return 3;
}
/**
 * The default state root, exposed for the CLI's help and the in-process tools.
 * @returns the absolute rescue state directory under the harness home.
 */
export function defaultStateRoot() {
    return resolve(dshHome(), 'rescue');
}
//# sourceMappingURL=launcher.js.map