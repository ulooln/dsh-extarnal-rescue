/**
 * The mechanically provable repairs.
 *
 * Two failure classes have an unambiguous minimal fix, and both are repairs the
 * launcher itself makes unavoidable:
 *
 * - an **inserted row** whose package does not resolve — disabling that row in
 *   the profile's own patch layer removes it from the tree without deleting
 *   anything, and works whether the insert came from the profile or a bundle
 *   below it;
 * - a **bundle** the launcher cannot mount — the bundle layer has no disable
 *   switch at all, so the only mechanical repair is dropping its name from
 *   `dsh.profile.bundles`. The package stays installed and its dependency entry
 *   stays in place, so reinstalling or repairing it later is a one-line restore.
 *
 * Everything else needs a human decision — which duplicate insert to keep, which
 * package to reinstall — so it is reported, not guessed at.
 *
 * Two invariants hold for every write: the candidate text is proved parseable
 * before it lands (a patch layer or manifest that cannot be parsed refuses the
 * whole tree), and each overwritten file is backed up beside itself. The caller
 * can roll every write of one run back as a unit.
 * @module @dsh-external/dsh-rescue/repair
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runDoctor } from "./doctor.js";
import { packageRootDir, planeCandidates, requireFromPlane } from "./plane.js";
/** This package's own name: the one bundle a mechanical repair must never drop. */
export const RESCUE_PACKAGE_NAME = '@dsh-external/dsh-rescue';
/**
 * Parse a candidate patch file with the Loader's own dialect.
 * @param plane - explicit plane from the command line, when given.
 * @param content - the candidate file text.
 * @returns true when the text parses as a top-level array of patch entries.
 */
export function patchListParses(plane, content) {
    try {
        const root = planeCandidates(plane, packageRootDir()).find(candidate => candidate.usable)?.root;
        if (root === undefined)
            return false;
        const yaml = requireFromPlane(root, 'js-yaml');
        if (yaml === undefined)
            return false;
        return Array.isArray(yaml.load(content));
    }
    catch {
        return false;
    }
}
/**
 * Apply every repair this package can prove is correct.
 * @param options - target profile, optional plane, and dry-run flag.
 * @returns what was applied, what was refused, and a unit rollback.
 */
export async function applyMechanicalFixes(options) {
    const report = await runDoctor({
        ...options.plane === undefined ? {} : { plane: options.plane },
        profile: options.profile,
        packageDir: packageRootDir(),
    });
    const applied = [];
    const skipped = [];
    const written = [];
    const rollback = () => {
        for (const file of written) {
            try {
                writeFileSync(file.path, file.original);
            }
            catch {
                // A rollback that cannot write is reported by the caller's own message;
                // the backup beside the file is the manual recovery path.
            }
        }
    };
    const profile = report.profiles.find(entry => entry.name === options.profile);
    if (profile === undefined)
        return { applied, skipped, rollback };
    const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
    const patchPath = join(profile.dir, 'cordis.patch.yml');
    for (const row of profile.unresolvedInserts.filter(entry => !profile.disabledRows.includes(entry.id))) {
        if (!existsSync(patchPath)) {
            skipped.push(`${row.id}: ${patchPath} does not exist, so there is no user layer to disable it in`);
            continue;
        }
        const before = readFileSync(patchPath, 'utf8');
        const at = new Date().toISOString();
        const addition = [
            '',
            `# Added by dsh-rescue at ${at}: row "${row.id}" mounts ${row.name},`,
            '# which does not resolve, so the whole tree refused to activate.',
            '# Delete these four lines to undo this change.',
            `- id: ${row.id}`,
            '  disabled: true',
            '',
        ].join('\n');
        const after = before.replace(/\n*$/, '\n') + addition;
        if (!patchListParses(options.plane, after)) {
            skipped.push(`${row.id}: refusing to write ${patchPath}; the result would not parse`);
            continue;
        }
        if (!options.dryRun) {
            copyFileSync(patchPath, `${patchPath}.rescue-bak-${stamp()}`);
            writeFileSync(patchPath, after);
            written.push({ path: patchPath, original: before });
        }
        applied.push(`${row.id} (${row.name}) disabled in ${patchPath}`);
    }
    const unusable = profile.bundles.filter(bundle => !bundle.resolved);
    if (unusable.length > 0) {
        const manifestPath = join(profile.dir, 'package.json');
        const raw = readFileSync(manifestPath, 'utf8');
        const parsed = JSON.parse(raw);
        const dshSection = (parsed.dsh ?? {});
        const profileSection = (dshSection.profile ?? {});
        const list = Array.isArray(profileSection.bundles) ? profileSection.bundles : [];
        // Never drop this package's own bundle: a repair that removes the rescue
        // leaves the next crash with no tool to run.
        const droppable = unusable.filter(bundle => bundle.name !== RESCUE_PACKAGE_NAME);
        for (const bundle of unusable) {
            if (bundle.name === RESCUE_PACKAGE_NAME) {
                skipped.push(`${bundle.name}: refusing to drop the rescue bundle itself; repair its install instead`);
            }
        }
        const kept = list.filter(entry => !droppable.some(bundle => bundle.name === entry));
        if (kept.length !== list.length) {
            dshSection.profile = { ...profileSection, bundles: kept };
            parsed.dsh = dshSection;
            const after = JSON.stringify(parsed, undefined, 2) + '\n';
            let parses = false;
            try {
                parses = typeof JSON.parse(after).dsh === 'object';
            }
            catch {
                parses = false;
            }
            if (!parses) {
                skipped.push(`refusing to write ${manifestPath}; the result would not parse`);
            }
            else {
                if (!options.dryRun) {
                    copyFileSync(manifestPath, `${manifestPath}.rescue-bak-${stamp()}`);
                    writeFileSync(manifestPath, after);
                    written.push({ path: manifestPath, original: raw });
                }
                for (const bundle of droppable) {
                    applied.push(`${bundle.name} dropped from dsh.profile.bundles in ${manifestPath} (${bundle.code ?? 'unresolved'}: ${bundle.error ?? ''})`);
                }
            }
        }
    }
    return { applied, skipped, rollback };
}
//# sourceMappingURL=repair.js.map