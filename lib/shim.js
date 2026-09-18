/**
 * The short launcher a person runs when the harness will not start.
 *
 * A launcher nobody can invoke is not a launcher. Its directory is normally not
 * on PATH, and a shell then reports the bare name as unknown, which reads exactly
 * like the tool does not exist. Writing the files and saying how to reach them is
 * one job, so both callers that can install them (`dsh-rescue shim` and the
 * in-process mount) share this module rather than keeping two copies that drift.
 *
 * No harness package is imported here: the CLI has to be able to install its own
 * launcher while the rest of the deployment is broken.
 * @module @dsh-external/dsh-rescue/shim
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isOnSearchPath, packageRootDir } from "./plane.js";
/** The marker that remembers whether the PATH notice has already been shown. */
const NOTICE_MARKER = '.shim-path-state';
/**
 * Write the launcher into the rescue state root.
 * @param stateRoot - the rescue state root.
 * @returns the written paths, whether they are reachable as a command, and the
 * advice to show when they are not.
 */
export function writeShim(stateRoot) {
    try {
        mkdirSync(stateRoot, { recursive: true });
        const cli = join(packageRootDir(), 'lib', 'cli.js');
        const cmd = join(stateRoot, 'dsh-rescue.cmd');
        const sh = join(stateRoot, 'dsh-rescue.sh');
        writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`);
        writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`);
        const onPath = isOnSearchPath(stateRoot);
        if (onPath)
            return { files: [cmd, sh], onPath };
        return { files: [cmd, sh], onPath, pathAdvice: launcherAdvice(stateRoot, cmd) };
    }
    catch (error) {
        return { files: [], onPath: false, error: error instanceof Error ? error.message : String(error) };
    }
}
/**
 * How to reach the launcher while it is not a command.
 * @param stateRoot - the launcher's directory.
 * @param cmd - the launcher file itself, for the copy-pasteable first command.
 * @returns the advice, one line per fact.
 */
function launcherAdvice(stateRoot, cmd) {
    const add = process.platform === 'win32'
        ? `[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';${stateRoot}', 'User')`
        : `echo 'export PATH="$PATH:${stateRoot.replace(/\\/g, '/')}"' >> ~/.profile`;
    return [
        `'dsh-rescue' is not a command yet: ${stateRoot} is not on PATH.`,
        `  use it now:      "${cmd}" doctor`,
        `  make it a command (then reopen the terminal): ${add}`,
        '  note: that directory also holds rescue state (sessions, incidents); on PATH the whole directory becomes visible.',
    ].join('\n');
}
/**
 * Whether the PATH notice is worth printing again.
 *
 * The mount runs on every boot, and the default layout keeps the launcher off
 * PATH, so printing the same advice each time turns advice into noise the reader
 * learns to skip. The answer is remembered per state root and shown again only
 * when it changes, which is the only time it carries information.
 * @param stateRoot - the rescue state root.
 * @param onPath - whether the launcher's directory is on the search path now.
 * @returns true when this differs from the last recorded state.
 */
export function pathNoticeIsNews(stateRoot, onPath) {
    const marker = join(stateRoot, NOTICE_MARKER);
    const state = onPath ? 'on-path' : 'off-path';
    let previous;
    try {
        previous = readFileSync(marker, 'utf8').trim();
    }
    catch {
        // No record yet means this is the first mount that can tell.
        previous = undefined;
    }
    if (previous === state)
        return false;
    try {
        writeFileSync(marker, `${state}\n`);
    }
    catch {
        // A state root that cannot record the answer repeats the notice rather than
        // losing it, which is the same failure direction as never having recorded it.
        return true;
    }
    return true;
}
//# sourceMappingURL=shim.js.map