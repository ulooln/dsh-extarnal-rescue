#!/usr/bin/env node
/**
 * `dsh-rescue` —the entry point a person runs when the harness will not start.
 *
 * It imports nothing from the harness at module scope: every harness package is
 * loaded at runtime from a deployment plane this file finds first. That is the
 * whole point —a broken profile composition, a broken bundle, or a broken
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
import { join } from 'node:path';
import { parseArgs, USAGE } from "./args.js";
import { runDoctor, worstLevel } from "./doctor.js";
import { launchRescue, verifyCommand } from "./launcher.js";
import { dshHome, homePath, packageRootDir } from "./plane.js";
import { captureBoot, writeIncident } from "./probe.js";
import { applyMechanicalFixes } from "./repair.js";
import { renderJson, renderReport } from "./report.js";
import { writeShim } from "./shim.js";
/** Resolve the plane a capture should run against, preferring a usable one. */
async function resolveProbePlane(invocation) {
    const report = await runDoctor({
        ...invocation.plane === undefined ? {} : { plane: invocation.plane },
        profile: invocation.profile,
        packageDir: packageRootDir(),
    });
    return report.planes.find(plane => plane.usable)?.root;
}
/** Write the short launcher shims next to the harness home. */
function installShim(stateRoot) {
    const shim = writeShim(stateRoot);
    if (shim.error !== undefined) {
        process.stderr.write(`dsh-rescue: cannot write the launcher into ${stateRoot}: ${shim.error}\n`);
        return 1;
    }
    process.stdout.write('dsh-rescue: launcher written\n');
    for (const file of shim.files)
        process.stdout.write(`  ${file}\n`);
    process.stdout.write(shim.pathAdvice === undefined
        ? `dsh-rescue: ${stateRoot} is on PATH; the bare command works.\n`
        : `dsh-rescue: ${shim.pathAdvice}\n`);
    return 0;
}
/** `fix`: apply the mechanical repairs and report the rest. */
async function commandFix(invocation) {
    const { applied, skipped } = await applyMechanicalFixes({
        profile: invocation.profile,
        ...invocation.plane === undefined ? {} : { plane: invocation.plane },
        dryRun: invocation.dryRun,
    });
    for (const line of applied)
        process.stdout.write(`dsh-rescue: ${invocation.dryRun ? 'would fix' : 'fixed'} ${line}\n`);
    for (const line of skipped)
        process.stderr.write(`dsh-rescue: skipped ${line}\n`);
    if (applied.length === 0) {
        process.stdout.write('dsh-rescue: no mechanically fixable problem found.\n');
        process.stdout.write('dsh-rescue: run dsh-rescue doctor for the full diagnosis, or dsh-rescue repair to hand it to an agent.\n');
        return 5;
    }
    if (!invocation.dryRun)
        process.stdout.write(`dsh-rescue: applied ${String(applied.length)} fix(es); run dsh-rescue verify to confirm the boot.\n`);
    return 0;
}
/** `doctor`: print the deterministic diagnosis. */
async function commandDoctor(invocation) {
    const report = await runDoctor({
        ...invocation.plane === undefined ? {} : { plane: invocation.plane },
        profile: invocation.profile,
        packageDir: packageRootDir(),
    });
    process.stdout.write(invocation.json ? renderJson(report) : renderReport(report));
    if (invocation.json) {
        process.stdout.write('\n');
        return 0;
    }
    const worst = worstLevel(report);
    if (worst === 'error')
        process.stdout.write('\nnext: dsh-rescue repair      (boot a repair agent with this diagnosis)\n');
    else if (worst === 'warn')
        process.stdout.write('\nno blocking error found; run dsh-rescue verify to boot the profile and confirm.\n');
    else
        process.stdout.write('\nnothing wrong found. If a boot still fails, run dsh-rescue supervise to capture it.\n');
    return 0;
}
/** `verify`: capture one boot of the real profile. */
async function commandVerify(invocation) {
    const planeRoot = await resolveProbePlane(invocation);
    if (planeRoot === undefined) {
        process.stderr.write('dsh-rescue: no usable deployment plane; run dsh-rescue doctor\n');
        return 2;
    }
    process.stderr.write(`dsh-rescue: booting ${verifyCommand(planeRoot, invocation.profile)} (up to ${String(invocation.timeoutMs)}ms)\n`);
    const attempt = await captureBoot({
        planeRoot,
        profile: invocation.profile,
        cwd: process.cwd(),
        timeoutMs: invocation.timeoutMs,
        extraArgs: invocation.args,
        logPath: join(invocation.stateRoot, 'boot.log'),
        echo: true,
    });
    if (attempt.booted) {
        process.stdout.write(`\ndsh-rescue: profile "${invocation.profile}" came up (${String(attempt.durationMs)}ms)\n`);
        return 0;
    }
    const incident = writeIncident(invocation.stateRoot, attempt, {
        profileDir: homePath('profiles', invocation.profile),
        dshHome: dshHome(),
    });
    process.stderr.write(`\ndsh-rescue: profile "${invocation.profile}" did NOT come up (exit ${String(attempt.exitCode)}, ${String(attempt.durationMs)}ms)\n`);
    if (attempt.signals.length > 0) {
        process.stderr.write('dsh-rescue: diagnostics:\n');
        for (const signal of attempt.signals.slice(-8))
            process.stderr.write(`  ${signal}\n`);
    }
    process.stderr.write(`dsh-rescue: full capture in ${incident.dir ?? invocation.stateRoot}\n`);
    process.stderr.write('dsh-rescue: run dsh-rescue repair to fix it with this evidence.\n');
    return 4;
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
function defaultRepairTask(profile) {
    return [
        `Restore a normal boot of profile "${profile}".`,
        'The captured failure in the mission already reproduces it and names the offending row: treat that capture as authoritative and start from the fix, not from another reproduction.',
        'Fix exactly that target in the file the mission names, backing the file up first, then run the verification command and quote what it printed.',
        'If the shell tool cannot spawn processes in this environment, say so in one line and finish with the exact edit you made, so the human can verify it themselves.',
    ].join(' ');
}
/** `supervise`: run the real profile, then repair automatically on failure. */
async function commandSupervise(invocation) {
    const planeRoot = await resolveProbePlane(invocation);
    if (planeRoot === undefined) {
        process.stderr.write('dsh-rescue: no usable deployment plane; run dsh-rescue doctor\n');
        return 2;
    }
    process.stderr.write(`dsh-rescue: supervising ${verifyCommand(planeRoot, invocation.profile)} (boot window ${String(invocation.timeoutMs)}ms)\n`);
    const attempt = await captureBoot({
        planeRoot,
        profile: invocation.profile,
        cwd: process.cwd(),
        timeoutMs: invocation.timeoutMs,
        extraArgs: invocation.args,
        logPath: join(invocation.stateRoot, 'boot.log'),
        keepAlive: true,
        echo: true,
    });
    if (attempt.booted) {
        process.stderr.write(`\ndsh-rescue: profile "${invocation.profile}" came up${attempt.pid === undefined ? '' : ` (pid ${String(attempt.pid)})`}; nothing to repair\n`);
        process.stderr.write(`dsh-rescue: boot log ${attempt.logPath}\n`);
        return 0;
    }
    const incident = writeIncident(invocation.stateRoot, attempt, {
        profileDir: homePath('profiles', invocation.profile),
        dshHome: dshHome(),
    });
    process.stderr.write(`\ndsh-rescue: profile "${invocation.profile}" did NOT come up\n`);
    if (attempt.signals.length > 0) {
        for (const signal of attempt.signals.slice(-8))
            process.stderr.write(`  ${signal}\n`);
    }
    process.stderr.write(`dsh-rescue: capture ${incident.dir ?? invocation.stateRoot}\n`);
    // Deterministic pass first: it is instant, it never touches a model, and it
    // covers the failure class where the minimal fix is provable. Only a boot that
    // is still broken afterwards is worth an agent.
    const { applied, skipped, rollback } = await applyMechanicalFixes({
        profile: invocation.profile,
        ...invocation.plane === undefined ? {} : { plane: invocation.plane },
        dryRun: invocation.dryRun,
    });
    for (const line of applied)
        process.stderr.write(`dsh-rescue: fixed ${line}\n`);
    for (const line of skipped)
        process.stderr.write(`dsh-rescue: skipped ${line}\n`);
    if (applied.length > 0) {
        process.stderr.write(`dsh-rescue: re-verifying after ${String(applied.length)} mechanical fix(es)\n`);
        const retry = await captureBoot({
            planeRoot,
            profile: invocation.profile,
            cwd: process.cwd(),
            timeoutMs: invocation.timeoutMs,
            extraArgs: invocation.args,
            logPath: join(invocation.stateRoot, 'boot.log'),
            keepAlive: true,
            echo: true,
        });
        if (retry.booted) {
            process.stderr.write(`\ndsh-rescue: profile "${invocation.profile}" came up after ${String(applied.length)} mechanical fix(es); no agent needed\n`);
            return 0;
        }
        writeIncident(invocation.stateRoot, retry, {
            profileDir: homePath('profiles', invocation.profile),
            dshHome: dshHome(),
        });
        // An automatic writer that cannot prove it helped must not leave its guess
        // behind: the deployment goes back exactly as it was found, and the agent
        // reasons over the original state rather than over a pile of rejected edits.
        rollback();
        process.stderr.write('dsh-rescue: the mechanical pass did not restore the boot; it has been rolled back\n');
    }
    if (invocation.noLlm) {
        process.stdout.write(renderReport(await runDoctor({
            ...invocation.plane === undefined ? {} : { plane: invocation.plane },
            profile: invocation.profile,
            packageDir: packageRootDir(),
        })));
        return 4;
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
    });
}
/** `repair`: diagnose, then boot the repair agent. */
async function commandRepair(invocation) {
    if (invocation.noLlm)
        return await commandDoctor(invocation);
    return await launchRescue({
        ...invocation.plane === undefined ? {} : { plane: invocation.plane },
        profile: invocation.profile,
        task: invocation.task,
        permissionMode: invocation.permissionMode,
        stateRoot: invocation.stateRoot,
        ...invocation.workspace === undefined ? {} : { workspace: invocation.workspace },
        ...invocation.provider === undefined ? {} : { provider: invocation.provider },
        ...invocation.model === undefined ? {} : { model: invocation.model },
    });
}
/** Run one invocation and return its exit code. */
async function main() {
    let invocation;
    try {
        invocation = parseArgs(process.argv.slice(2));
    }
    catch (error) {
        process.stderr.write(`dsh-rescue: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
        return 64;
    }
    switch (invocation.command) {
        case 'help':
            process.stdout.write(USAGE);
            return 0;
        case 'shim': return installShim(invocation.stateRoot);
        case 'doctor': return await commandDoctor(invocation);
        case 'verify': return await commandVerify(invocation);
        case 'fix': return await commandFix(invocation);
        case 'supervise': return await commandSupervise(invocation);
        case 'repair': return await commandRepair(invocation);
    }
}
const code = await main();
// The rescue tree owns its own teardown; nothing else should keep the loop alive.
process.exit(code);
//# sourceMappingURL=cli.js.map