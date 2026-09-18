/**
 * A spare deployment plane: a second, independent module root that can boot the
 * rescue when the deployment's own install is the thing that broke.
 *
 * An upgrade is the case this exists for. Upgrading rewrites the very
 * `node_modules` the rescue would boot from, so a rescue that only ever reads the
 * install under repair can be taken down by the same upgrade it is meant to
 * survive. A spare plane is built while the install is still healthy and is then
 * pointed at with `--plane`.
 *
 * Two modes, and the difference is the whole point: links follow the source
 * packages, so they survive profile and composition damage but not the packages
 * themselves being replaced; a copy is physically independent and costs the
 * source's full size.
 * @module @dsh-external/dsh-rescue/spare
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { probePlane } from "./plane.js";
/**
 * Names inside a `node_modules` root that carry no package.
 * The lockfiles and store metadata describe the install rather than being part of
 * it, and copying the store would duplicate every package a second time.
 */
const METADATA_PREFIX = '.';
/**
 * Materialize a spare plane from an existing one.
 *
 * Every scope is walked one level deep and every package is linked individually:
 * linking a whole scope directory would make one unreadable package hide all its
 * siblings, and the point of a spare is that it works when something else did not.
 *
 * Refreshing is idempotent. An entry already pointing where it should is left
 * alone, because replacing a link that still resolves would rewrite the spare for
 * no reason, and a spare that is being rebuilt is often the one currently booting
 * a rescue.
 * @param source - the plane to copy or link from.
 * @param dest - the spare plane's path.
 * @param mode - `links` to follow the source packages, `copy` to be independent.
 * @returns what the spare now holds.
 * @throws when the destination cannot be created.
 */
export function buildSparePlane(source, dest, mode = 'links') {
    const sourceRoot = resolve(source);
    const destRoot = resolve(dest);
    if (sourceRoot === destRoot)
        throw new Error('the spare plane cannot be the plane it is built from');
    mkdirSync(destRoot, { recursive: true });
    const skipped = [];
    let entries = 0;
    for (const name of packageEntries(sourceRoot)) {
        try {
            if (mode === 'copy') {
                const to = join(destRoot, name);
                rmSync(to, { recursive: true, force: true });
                cpSync(join(sourceRoot, name), to, { recursive: true, dereference: true });
                entries += 1;
                continue;
            }
            if (ensureLink(resolvedSource(sourceRoot, name), join(destRoot, name)))
                entries += 1;
        }
        catch (error) {
            skipped.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return { dest: destRoot, source: sourceRoot, mode, entries, skipped, plane: probePlane(destRoot, 'spare') };
}
/** Resolve a source entry, so a link never points at another link. */
function resolvedSource(sourceRoot, relative) {
    const path = join(sourceRoot, relative);
    try {
        return realpathSync(path);
    }
    catch {
        // A source entry that does not resolve cannot be linked; the linker reports it.
        return path;
    }
}
/**
 * Point `path` at `target`, keeping an equivalent link that is already there.
 * @param target - the absolute directory the spare entry must resolve to.
 * @param path - the entry inside the spare plane.
 * @returns true when the entry resolves to the target afterwards.
 * @throws when the entry exists as something else and cannot be replaced.
 */
function ensureLink(target, path) {
    let current;
    try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) {
            try {
                current = realpathSync(path);
            }
            catch {
                current = undefined;
            }
        }
        else if (stat.isDirectory()) {
            // A copied plane and a linked plane must not be mixed silently: a real
            // directory here is the previous build in the other mode.
            rmSync(path, { recursive: true, force: true });
        }
    }
    catch {
        current = undefined;
    }
    if (current !== resolve(target)) {
        rmSync(path, { recursive: true, force: true });
        // A scope's own directory does not exist until its first package is linked.
        mkdirSync(dirname(path), { recursive: true });
        symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return existsSync(path);
}
/**
 * Every package entry of a module root, scopes expanded one level.
 *
 * An entry counts as a package only when it holds a manifest. Layouts leave
 * non-package entries behind (metadata files, empty scope directories), and a
 * spare that reproduced them would claim packages it cannot resolve.
 */
function packageEntries(root) {
    const entries = [];
    for (const name of entriesOf(root)) {
        if (name === '.bin')
            continue;
        if (name.startsWith(METADATA_PREFIX))
            continue;
        if (!name.startsWith('@')) {
            if (hasManifest(root, name))
                entries.push(name);
            continue;
        }
        for (const child of entriesOf(join(root, name))) {
            if (child.startsWith(METADATA_PREFIX))
                continue;
            if (hasManifest(root, `${name}/${child}`))
                entries.push(`${name}/${child}`);
        }
    }
    return entries;
}
/** Whether a module-root entry carries a manifest. */
function hasManifest(root, relative) {
    return existsSync(join(root, relative, 'package.json'));
}
/** Read a directory's entries, treating an unreadable directory as empty. */
function entriesOf(root) {
    try {
        return readdirSync(root);
    }
    catch {
        // A missing or unreadable directory contributes no entries; the caller
        // reports the absence through the plane probe rather than here.
        return [];
    }
}
/**
 * Report what a spare plane looks like now, without repairing it.
 * @param dest - the spare plane's path.
 * @returns its usability, size in entries, and any entry that no longer resolves.
 */
export function inspectSparePlane(dest) {
    const destRoot = resolve(dest);
    const exists = existsSync(destRoot);
    // A package's manifest is what makes it usable in a source root, but an entry
    // whose target is gone has no manifest left to read — and that entry is exactly
    // what this inspection exists to name.
    const entries = exists ? listedEntries(destRoot) : [];
    const dangling = entries.filter(name => !existsSync(join(destRoot, name)));
    return { exists, plane: probePlane(destRoot, 'spare'), entries: entries.length, dangling };
}
/** Every entry a module root lists, scopes expanded one level, broken links included. */
function listedEntries(root) {
    const entries = [];
    for (const name of entriesOf(root)) {
        if (name === '.bin' || name.startsWith(METADATA_PREFIX))
            continue;
        if (!name.startsWith('@')) {
            entries.push(name);
            continue;
        }
        for (const child of entriesOf(join(root, name))) {
            if (child.startsWith(METADATA_PREFIX))
                continue;
            entries.push(`${name}/${child}`);
        }
    }
    return entries;
}
/**
 * Total bytes of a spare plane's packages, for reporting what a copy costs.
 * Symlinked entries are measured through the link, so a linked spare reports the
 * size it borrows rather than the size it owns.
 * @param root - the plane or spare plane to measure.
 * @param limit - stop counting past this many entries, to bound the walk.
 * @returns the byte total and whether the walk stopped early.
 */
export function planeSize(root, limit = 200_000) {
    let bytes = 0;
    let seen = 0;
    const queue = [resolve(root)];
    while (queue.length > 0) {
        const current = queue.pop();
        if (current === undefined)
            break;
        let names;
        try {
            names = readdirSync(current);
        }
        catch {
            continue;
        }
        for (const name of names) {
            if (seen >= limit)
                return { bytes, truncated: true };
            const path = join(current, name);
            let stat;
            try {
                stat = statSync(path);
            }
            catch {
                continue;
            }
            seen += 1;
            if (stat.isDirectory())
                queue.push(path);
            else
                bytes += stat.size;
        }
    }
    return { bytes, truncated: false };
}
//# sourceMappingURL=spare.js.map