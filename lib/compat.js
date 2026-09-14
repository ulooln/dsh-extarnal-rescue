/**
 * Compatibility between the rescue composition and the deployment it is rescuing.
 *
 * The rescue layer overrides rows of the deployment's own `dsh-base` bundle by id.
 * A patch that targets a row the deployment no longer provides is not an error in
 * the Loader: it warns and applies nothing. That is the dangerous case, because
 * the rescue would still start, and would quietly lose the permissions it needs
 * to write outside any workspace while its approval policy fell back to one that
 * fails closed with no answerer attached. An agent that cannot write cannot
 * repair, and nothing in its output would say why.
 *
 * This module turns that silence into a named finding, before the tree boots, and
 * a hard check, after it does.
 * @module @dsh-external/dsh-rescue/compat
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { loadAppBoot, packageRootDir } from "./plane.js";
/** Row ids this rescue layer overrides in the deployment's base bundle. */
export const RESCUE_OVERRIDES = [
    'system-prompt',
    'sandbox-policy',
    'approval',
    'session-telemetry-otel',
    'session-persistence-jsonl',
    'storage-json',
    'attachment-local',
    'skill-filesystem',
];
/** Row ids this rescue layer inserts. */
export const RESCUE_INSERTS = ['cordis-host-runner', 'tool-cordis'];
/**
 * Overrides whose disappearance stops the rescue from being able to repair.
 * Losing a permission row is not a cosmetic degradation: with the base defaults
 * the agent is confined to the working directory and its approval requests have
 * no answerer, so every write fails.
 */
export const CRITICAL_OVERRIDES = ['sandbox-policy', 'approval'];
/**
 * Compare the rows a rescue layer addresses with the rows the deployment provides.
 *
 * Pure on purpose: the judgement is what needs testing, and it does not need a
 * harness install to be exercised.
 * @param baseRowIds - every row id the deployment's base bundle provides.
 * @param rescueTargets - the ids the rescue layer patches.
 * @param rescueInserts - the ids the rescue layer inserts.
 * @returns the differences, with the repair-blocking ones called out.
 */
export function diffComposition(baseRowIds, rescueTargets, rescueInserts) {
    const provided = new Set(baseRowIds);
    const missingTargets = rescueTargets.filter(id => !provided.has(id));
    return {
        missingTargets,
        collisions: rescueInserts.filter(id => provided.has(id)),
        criticalMissing: missingTargets.filter(id => CRITICAL_OVERRIDES.includes(id)),
    };
}
/** Every row id one patch list provides, whether by insert or by composition. */
function rowIds(rows) {
    return rows.map(row => row.id).filter((id) => typeof id === 'string');
}
/** Whether a row's module specifier resolves from the plane.
 *
 * The plane root IS a `node_modules` directory, so it is checked directly first;
 * Node's own search is the fallback and only finds it when the path happens to
 * end in a directory of that name.
 */
function resolvesFrom(name, planeRoot) {
    if (name.startsWith('cordis:') || name.startsWith('.') || name.includes(':'))
        return true;
    const [first = '', second = ''] = name.split('/');
    const packageName = first.startsWith('@') ? `${first}/${second}` : first;
    if (existsSync(join(planeRoot, packageName, 'package.json')))
        return true;
    try {
        const searchPaths = createRequire(join(planeRoot, '..', 'noop.cjs')).resolve.paths(packageName);
        if (searchPaths === null)
            return false;
        return searchPaths.some(searchPath => existsSync(join(searchPath, packageName, 'package.json')));
    }
    catch {
        return false;
    }
}
/**
 * Check the rescue composition against a deployment plane.
 *
 * Returns a result even when it cannot run the comparison (a plane without the
 * boot glue), because "cannot tell" is itself something the doctor must report.
 * @param planeRoot - the plane's node_modules root.
 * @param packageDir - this package's directory, holding `rescue.cordis.yml`.
 * @returns the compatibility picture.
 */
export async function checkRescueCompatibility(planeRoot, packageDir = packageRootDir()) {
    const basePatch = join(planeRoot, '@deepseek-ai', 'dsh-base', 'cordis.patch.yml');
    const rescueFile = join(packageDir, 'rescue.cordis.yml');
    const empty = {
        planeRoot, basePatch, missingTargets: [], collisions: [], unresolvedRows: [], criticalMissing: [], ok: false,
    };
    if (!existsSync(basePatch) || !existsSync(rescueFile))
        return empty;
    let appBoot;
    let base;
    let rescue;
    try {
        appBoot = await loadAppBoot(planeRoot);
        base = appBoot.loadOverlayPatches('dsh-rescue', basePatch);
        rescue = appBoot.loadOverlayPatches('dsh-rescue', rescueFile);
    }
    catch {
        return empty;
    }
    let baseRowIds;
    try {
        baseRowIds = rowIds(appBoot.composeEntries([base]));
    }
    catch {
        return empty;
    }
    // A rescue insert sits inside `insert:` lists; a rescue override carries the id
    // directly. Reading them apart is what makes a missing target distinguishable
    // from a collision.
    const rescueTargets = [];
    const rescueInserts = [];
    for (const row of rescue) {
        if (typeof row.id === 'string' && !Array.isArray(row.insert))
            rescueTargets.push(row.id);
        if (!Array.isArray(row.insert))
            continue;
        for (const inserted of row.insert) {
            if (typeof inserted.id === 'string')
                rescueInserts.push(inserted.id);
        }
    }
    const diff = diffComposition(baseRowIds, rescueTargets, rescueInserts);
    const unresolvedRows = rescue
        .flatMap(row => Array.isArray(row.insert) ? row.insert : [])
        .map(inserted => inserted.name)
        .filter((name) => typeof name === 'string')
        .filter(name => !resolvesFrom(name, planeRoot));
    let baseVersion;
    try {
        const manifest = JSON.parse(readFileSync(join(planeRoot, '@deepseek-ai', 'dsh-base', 'package.json'), 'utf8'));
        if (typeof manifest.version === 'string')
            baseVersion = manifest.version;
    }
    catch {
        baseVersion = undefined;
    }
    return {
        planeRoot,
        basePatch,
        ...diff,
        unresolvedRows,
        baseVersion,
        ok: diff.missingTargets.length === 0 && diff.collisions.length === 0 && unresolvedRows.length === 0,
    };
}
/**
 * Verify that the overrides the rescue depends on actually took effect.
 *
 * Runs after the tree boots, because the preflight compares text and this
 * compares the mounted tree. The resolved config lives on the fiber — an entry's
 * `options.config` still holds the unevaluated `!!js` expressions — so both are
 * read, fiber first.
 *
 * The rule for refusing is deliberately narrow: a row that is absent, or a
 * resolved scalar that differs from what was asked for, is a definite failure. A
 * value this code cannot interpret means the Loader's internals differ from what
 * this check assumes, which is a reason to warn rather than to deny a working
 * deployment its rescue.
 * @param loaderEntries - the settled Loader's entries.
 * @param expectations - the config values the rescue asked for.
 * @returns the rows whose override definitely did not take effect, and the ones
 * whose state could not be confirmed.
 */
export function verifyMountedOverrides(loaderEntries, expectations) {
    const configOf = (id) => {
        for (const entry of loaderEntries) {
            if (entry.options?.id !== id)
                continue;
            const resolved = entry.fiber?.config;
            if (isRecord(resolved))
                return resolved;
            const raw = entry.options?.config;
            return isRecord(raw) ? raw : undefined;
        }
        return undefined;
    };
    const present = (id) => loaderEntries.some(entry => entry.options?.id === id);
    /** `undefined` when the value cannot be read, otherwise whether it matches. */
    const matches = (config, key, expected) => {
        const value = config?.[key];
        return typeof value === 'string' ? value === expected : undefined;
    };
    const blocking = [];
    const cosmetic = [];
    const check = (id, key, expected, consequence) => {
        if (!present(id)) {
            blocking.push(`${id}: the deployment provides no such row, so ${consequence}`);
            return;
        }
        const verdict = matches(configOf(id), key, expected);
        if (verdict === false)
            blocking.push(`${id}.${key} is ${JSON.stringify(configOf(id)?.[key])}, not ${JSON.stringify(expected)}`);
        else if (verdict === undefined)
            cosmetic.push(`${id}.${key} could not be read back, so ${consequence} is unconfirmed`);
    };
    check('sandbox-policy', 'mode', expectations.permissionMode, 'the rescue may not be able to write outside the working directory');
    check('approval', 'policy', expectations.approvalPolicy, 'the rescue may block on an approval prompt it has no answerer for');
    const persona = configOf('system-prompt')?.persona;
    if (!present('system-prompt')) {
        cosmetic.push('system-prompt: the deployment provides no such row, so the rescue runs on the mission text alone');
    }
    else if (persona === '') {
        cosmetic.push('system-prompt: the rescue persona did not apply, so the agent runs on the mission text alone');
    }
    const skillDirs = configOf('skill-filesystem')?.customSkillDirs;
    if (present('skill-filesystem') && skillDirs !== undefined && !Array.isArray(skillDirs)) {
        cosmetic.push('skill-filesystem: customSkillDirs did not apply, so the repair playbook skill may be missing from the catalog');
    }
    return { blocking, cosmetic };
}
/** Narrow an unknown value to a plain record. */
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=compat.js.map