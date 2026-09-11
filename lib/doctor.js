/**
 * Deterministic diagnosis of a harness deployment.
 *
 * The doctor never boots a plugin tree and never calls a model, so it still
 * produces an answer when the thing it is diagnosing cannot start at all. Every
 * finding carries the observation that produced it, and the report as a whole is
 * the input the repair agent reasons over.
 * @module @dsh-external/dsh-rescue/doctor
 */
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dshHome, findCheckout, homePath, importFromPlane, isDirectory, planeCandidates, requireFromPlane, } from "./plane.js";
/** Read and parse JSON, keeping the failure as data. */
function readJson(path) {
    let text;
    try {
        text = readFileSync(path, 'utf8');
    }
    catch (error) {
        return { ok: false, value: undefined, error: `${path} unreadable: ${describe(error)}` };
    }
    try {
        return { ok: true, value: JSON.parse(text) };
    }
    catch (error) {
        return { ok: false, value: undefined, error: `${path} is not valid JSON: ${describe(error)}` };
    }
}
/** Read and parse YAML in the Loader's own dialect, keeping the failure as data. */
function readYaml(path, planeRoot, schema) {
    let text;
    try {
        text = readFileSync(path, 'utf8');
    }
    catch (error) {
        return { ok: false, value: undefined, error: `${path} unreadable: ${describe(error)}` };
    }
    if (planeRoot === undefined)
        return { ok: false, value: undefined, error: `${path}: no usable plane to parse YAML` };
    const yaml = requireFromPlane(planeRoot, 'js-yaml');
    if (yaml === undefined)
        return { ok: false, value: undefined, error: `${path}: js-yaml unavailable in ${planeRoot}` };
    try {
        return { ok: true, value: schema === undefined ? yaml.load(text) : yaml.load(text, { schema }) };
    }
    catch (error) {
        return { ok: false, value: undefined, error: `${path} is not valid YAML: ${describe(error)}` };
    }
}
/** Render an unknown thrown value as one line. */
function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Narrow an unknown value to a string-keyed record. */
function asRecord(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return undefined;
    return value;
}
/** Narrow an unknown value to an array of records. */
function asRows(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((row) => asRecord(row) !== undefined);
}
/** Read a non-empty string property. */
function str(value) {
    return typeof value === 'string' && value !== '' ? value : undefined;
}
/** Every directory under `$DSH_HOME/profiles`, excluding the module fallback. */
function listProfileDirs() {
    const root = homePath('profiles');
    try {
        return readdirSync(root, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && entry.name !== 'node_modules')
            .map(entry => join(root, entry.name));
    }
    catch {
        // No profiles directory means no profile is configured yet, which the
        // report states as a finding rather than failing here.
        return [];
    }
}
/**
 * One anchor a bundle name is resolved from, in the order the launcher itself
 * would try them: the profile's own project, the harness home, the deployment
 * plane, and this package.
 *
 * Resolution runs through Node's real package search rather than a direct
 * `node_modules/<name>` join, because that search is what decides whether the
 * launcher can load the bundle at all. A direct join reports a package as
 * missing when a parent directory would have supplied it, and this check exists
 * precisely to agree with the boot that just failed.
 * @param profileDir - the profile directory.
 * @param planeRoot - the plane's node_modules root, when one is usable.
 * @param packageDir - this package's directory.
 * @returns absolute anchor paths, best first.
 */
function bundleAnchors(profileDir, planeRoot, packageDir) {
    const anchors = [join(profileDir, 'package.json'), join(dshHome(), 'package.json')];
    if (planeRoot !== undefined)
        anchors.push(join(planeRoot, 'noop.cjs'));
    if (packageDir !== undefined)
        anchors.push(join(packageDir, 'package.json'));
    return anchors;
}
/** Resolve a package directory through Node's own search from the given anchors. */
function resolvePackageDir(name, anchors) {
    for (const anchor of anchors) {
        let searchPaths;
        try {
            searchPaths = createRequire(anchor).resolve.paths(name);
        }
        catch {
            continue;
        }
        /* v8 ignore next -- a file anchor always yields search paths */
        if (searchPaths === null)
            continue;
        for (const searchPath of searchPaths) {
            const candidate = join(searchPath, name);
            if (existsSync(join(candidate, 'package.json')))
                return candidate;
        }
    }
    return undefined;
}
/**
 * Check one bundle the way the launcher does before it will mount it: the package
 * must resolve, its manifest must declare `dsh.bundle.patch`, and that file must
 * exist. Any one of the three failing stops the whole tree from loading, so each
 * failure keeps its own code — they need different fixes.
 * @param name - the bundle package name from `dsh.profile.bundles`.
 * @param anchors - resolution anchors from {@link bundleAnchors}.
 * @returns the bundle's state, resolved or not.
 */
function readBundle(name, anchors) {
    const dir = resolvePackageDir(name, anchors);
    if (dir === undefined) {
        return { name, resolved: false, code: 'unresolved', error: `package ${name} cannot be resolved from the profile, the harness home, or a deployment plane` };
    }
    const manifestPath = join(dir, 'package.json');
    const manifest = readJson(manifestPath);
    if (!manifest.ok)
        return { name, resolved: false, dir, code: 'manifest-invalid', error: manifest.error };
    const dsh = asRecord(asRecord(manifest.value)?.dsh);
    const patch = str(asRecord(dsh?.bundle)?.patch);
    if (patch === undefined) {
        return { name, resolved: false, dir, code: 'no-patch', error: `${manifestPath} declares no dsh.bundle.patch, so it contributes no rows` };
    }
    const patchPath = isAbsolute(patch) ? patch : resolve(dir, patch);
    if (!existsSync(patchPath)) {
        return { name, resolved: false, dir, code: 'patch-missing', error: `${name} declares ${patch} but ${patchPath} does not exist` };
    }
    return { name, resolved: true, dir, patch: patchPath };
}
/** Read one patch file into a layer description. */
function readLayer(path, role, planeRoot, schema) {
    const layer = { path, role, targets: [], inserts: [], insertRows: [], disables: [], problems: [] };
    if (!existsSync(path)) {
        if (role === 'bundle') {
            layer.problems.push({ code: 'patch-missing', level: 'error', title: 'bundle patch file missing', detail: path });
        }
        return layer;
    }
    const parsed = readYaml(path, planeRoot, schema);
    if (!parsed.ok) {
        layer.problems.push({
            code: 'patch-unparsable',
            level: 'error',
            title: 'patch file cannot be parsed, so the whole tree fails to load',
            detail: parsed.error ?? 'unknown parse failure',
            evidence: path,
            fix: `Repair the YAML in ${path}; the Loader refuses a present-but-invalid patch layer.`,
        });
        return layer;
    }
    if (!Array.isArray(parsed.value)) {
        layer.problems.push({
            code: 'patch-not-array',
            level: 'error',
            title: 'patch file is not a top-level YAML array of patch entries',
            detail: `top-level value is ${parsed.value === null ? 'null' : typeof parsed.value}`,
            evidence: path,
        });
        return layer;
    }
    for (const [index, row] of asRows(parsed.value).entries()) {
        const id = str(row.id);
        const insert = row.insert;
        if (Array.isArray(insert)) {
            for (const inserted of asRows(insert)) {
                const insertedId = str(inserted.id);
                const insertedName = str(inserted.name);
                const insertedDisabled = inserted.disabled === true;
                if (insertedId !== undefined) {
                    layer.inserts.push(insertedId);
                    layer.insertRows.push({
                        id: insertedId,
                        ...insertedName === undefined ? {} : { name: insertedName },
                        disabled: insertedDisabled,
                    });
                }
                if (insertedDisabled && insertedId !== undefined)
                    layer.disables.push(insertedId);
            }
        }
        if (id !== undefined) {
            if (row.disabled === true)
                layer.disables.push(id);
            else if (insert === undefined)
                layer.targets.push(id);
            else
                layer.targets.push(id);
        }
        else if (insert === undefined) {
            layer.problems.push({
                code: 'patch-entry-no-id',
                level: 'error',
                title: 'patch entry has neither an id nor an insert list',
                detail: `entry ${String(index + 1)} in ${path}`,
                evidence: JSON.stringify(row).slice(0, 400),
            });
        }
    }
    return layer;
}
/** Resolve `link:` and `file:` dependencies against the installed links. */
function readLinks(manifest, profileDir) {
    const dependencies = asRecord(manifest.dependencies) ?? {};
    const links = [];
    for (const [name, spec] of Object.entries(dependencies)) {
        if (typeof spec !== 'string')
            continue;
        const kind = spec.startsWith('link:') ? 'link' : spec.startsWith('file:') ? 'file' : undefined;
        if (kind === undefined)
            continue;
        const raw = spec.slice('link:'.length === 5 ? 5 : 5);
        const target = isAbsolute(raw) ? raw : resolve(profileDir, raw);
        const installedPath = join(profileDir, 'node_modules', name);
        const installed = existsSync(installedPath);
        let pointsTo;
        try {
            const stat = lstatSync(installedPath);
            if (stat.isSymbolicLink())
                pointsTo = resolve(dirname(installedPath), readlinkSync(installedPath));
        }
        catch {
            // Absence is captured by `installed`.
            pointsTo = undefined;
        }
        const consistent = !installed
            ? false
            : kind === 'link'
                ? pointsTo !== undefined && resolve(pointsTo) === resolve(target)
                : true;
        links.push({ name, target, targetExists: existsSync(target), installed, pointsTo, consistent });
    }
    return links;
}
/** Recognise the lines of captured boot output that name the failure. */
export function extractBootSignals(output) {
    const patterns = [
        /fatal load failure/,
        /plugin\(s\) failed to load/,
        /did not activate/,
        /pending \(waiting for service/,
        /Cannot find package/,
        /Cannot find module/,
        /duplicate loader entry id/,
        /ERR_MODULE_NOT_FOUND/,
        /SyntaxError/,
        /TypeError/,
        /ReferenceError/,
        /invalid config/,
        /must be a top-level YAML array/,
        /failed to parse/,
        /EADDRINUSE/,
        /EPERM/,
        /EACCES/,
        /Error:/,
    ];
    const lines = output.split(/\r?\n/);
    const hits = [];
    for (const line of lines) {
        if (line.trim() === '')
            continue;
        if (patterns.some(pattern => pattern.test(line)))
            hits.push(line.trim());
    }
    // The deepest diagnostic is usually last; keep the tail and drop repeats.
    const unique = [...new Set(hits)];
    return unique.slice(-40);
}
/**
 * The package an entry specifier names, dropping any subpath export.
 *
 * A row may mount `@scope/pkg/subpath` or `pkg/subpath`; the package to look for
 * is the leading name, not the whole specifier. Getting this wrong reports every
 * subpath row as unresolvable, which is exactly the false positive that makes an
 * automatic repair disable a healthy row.
 * @param specifier - the row's `name`.
 * @returns the package name, or `undefined` for a relative, absolute, or builtin specifier.
 */
export function packageOfSpecifier(specifier) {
    if (specifier.startsWith('.') || specifier.includes(':') || isAbsolute(specifier))
        return undefined;
    const [first = '', second = ''] = specifier.split('/');
    return first.startsWith('@') ? `${first}/${second}` : first;
}
/** Whether a row's module specifier can be resolved from the profile or the plane. */
function resolvesRowName(name, layerPath, profileDir, planeRoot, packageDir) {
    if (name.startsWith('cordis:'))
        return true;
    if (name.startsWith('file://')) {
        try {
            return existsSync(fileURLToPath(name));
        }
        catch {
            return false;
        }
    }
    if (name.startsWith('./') || name.startsWith('../'))
        return existsSync(resolve(dirname(layerPath), name));
    if (isAbsolute(name))
        return existsSync(name);
    const packageName = packageOfSpecifier(name);
    if (packageName === undefined)
        return false;
    const roots = [join(profileDir, 'node_modules'), planeRoot, packageDir === undefined ? undefined : join(packageDir, 'node_modules')];
    return roots.some(root => root !== undefined && existsSync(join(root, packageName, 'package.json')));
}
/** Read the most recent captured incident, if any. */
export function readIncident(root = homePath('rescue')) {
    const pointer = join(root, 'incidents', 'latest.json');
    if (existsSync(pointer)) {
        const parsed = readJson(pointer);
        if (parsed.ok) {
            const record = asRecord(parsed.value);
            if (record !== undefined && typeof record.output === 'string')
                return record;
        }
    }
    const dir = join(root, 'incidents');
    if (!isDirectory(dir))
        return undefined;
    const entries = readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => join(dir, entry.name))
        .sort();
    const newest = entries.at(-1);
    if (newest === undefined)
        return undefined;
    const parsed = readJson(join(newest, 'incident.json'));
    if (!parsed.ok)
        return undefined;
    const record = asRecord(parsed.value);
    if (record === undefined || typeof record.output !== 'string')
        return undefined;
    return { ...record, dir: newest };
}
/** The file the boot handshake reads and writes inside the rescue state root. */
export function bootStatePath(stateRoot = homePath('rescue')) {
    return join(stateRoot, 'boot-state.json');
}
/**
 * Read the previous run's outcome.
 * @param stateRoot - the rescue state root.
 * @returns the record, or `undefined` when none was ever written.
 */
export function readBootState(stateRoot = homePath('rescue')) {
    const parsed = readJson(bootStatePath(stateRoot));
    if (!parsed.ok)
        return undefined;
    const record = asRecord(parsed.value);
    if (record === undefined || typeof record.ok !== 'boolean')
        return undefined;
    return record;
}
/**
 * Write the boot handshake's current outcome. A failure here must never break a
 * boot: the record is an observation, not a precondition.
 * @param stateRoot - the rescue state root.
 * @param state - the record to persist.
 * @returns the write failure, or `undefined` when it landed.
 */
export function writeBootState(stateRoot, state) {
    try {
        mkdirSync(stateRoot, { recursive: true });
        const target = bootStatePath(stateRoot);
        const tmp = `${target}.tmp`;
        writeFileSync(tmp, JSON.stringify(state, undefined, 2) + '\n');
        // Rename publishes the whole record at once, so a reader never sees a
        // half-written file — the same reason the patch writer validates before it
        // lands. Windows can hold a brief lock; one retry covers the common case.
        try {
            renameSync(tmp, target);
        }
        catch {
            rmQuietly(target);
            renameSync(tmp, target);
        }
        return undefined;
    }
    catch (error) {
        return describe(error);
    }
}
/** Remove a path, ignoring every failure: callers use it for scratch files. */
function rmQuietly(path) {
    try {
        rmSync(path, { force: true });
    }
    catch {
        // A leftover scratch file is harmless; the next write overwrites it.
    }
}
/**
 * Classify a failed boot from the signatures in its output.
 *
 * The categories exist because each one has a different repair: a corrupt
 * session log is quarantined, an unresolvable bundle is removed from the bundle
 * list, and a broken patch tree is repaired in the patch layer. Naming the class
 * is what lets the doctor, the mission, and the human agree on the next step.
 * @param text - captured boot output, or any excerpt of it.
 * @returns the class, `unknown` when nothing matched.
 */
export function classifyCrash(text) {
    if (/corrupt Zstandard session log/i.test(text))
        return 'session-corrupt';
    if (/declares no dsh\.bundle|cannot resolve profile bundle|failed to read bundle|dsh\.bundle\.patch/i.test(text))
        return 'bundle-check';
    if (/EADDRINUSE|address already in use/i.test(text))
        return 'port-bind';
    if (/settings\.yaml|is not valid YAML|failed to parse (patches|overlay|config)/i.test(text))
        return 'settings';
    if (/already registered|duplicate loader entry|plugin\(s\) failed to load|failed to load plugin|did not activate|cannot find (module|package)|ERR_MODULE_NOT_FOUND/i.test(text))
        return 'patch-tree';
    return 'unknown';
}
/**
 * The concrete next step for one crash class.
 * @param reason - the class from {@link classifyCrash}.
 * @returns one line naming what to do, or an empty string when nothing is known.
 */
export function crashAdvice(reason) {
    switch (reason) {
        case 'session-corrupt':
            return 'A session log is corrupt and the session listing refuses to load it. Move the unreadable session directory aside under $DSH_HOME/sessions, or repair it with `dsh-rescue repair`.';
        case 'bundle-check':
            return 'A bundle listed in dsh.profile.bundles cannot be loaded. Run `dsh-rescue fix` to remove the unusable entries from that list, keeping the packages installed.';
        case 'patch-tree':
            return 'A patch layer or plugin row cannot be applied. Run `dsh-rescue fix` to disable the offending row, or `dsh-rescue repair` to have an agent localize it.';
        case 'port-bind':
            return 'The web surface could not bind its port. Stop the process holding it, or boot with `-- --port <other>`.';
        case 'settings':
            return 'A YAML document is invalid, which refuses the whole tree. Repair the file named in the capture; `dsh-rescue doctor` prints its parse error.';
        case 'unknown':
            return 'No known signature matched. Read the captured output in the incident directory, or run `dsh-rescue repair` to hand it to an agent.';
    }
}
/**
 * Read the boot history and classify a failure from whatever captured output
 * exists, preferring the most recent incident over the last raw boot log.
 * @param stateRoot - the rescue state root.
 * @returns the boot report, with `crashed` false when the last run finished.
 */
export function readBootReport(stateRoot = homePath('rescue')) {
    const state = readBootState(stateRoot);
    if (state === undefined)
        return { crashed: false };
    // A run that exited on purpose before readiness is not a crash; it is a boot
    // that was stopped, and reporting it as a crash would train the user to ignore
    // the alert.
    const crashed = state.ok !== true && state.cleanExit !== true;
    if (!crashed)
        return { state, crashed: false };
    const evidence = state.crashEvidence === undefined ? undefined : state.crashEvidence;
    const text = evidence !== undefined && existsSync(evidence)
        ? safeRead(evidence)
        : lastCapturedOutput(stateRoot);
    const reason = state.crashReason ?? (text === undefined ? 'unknown' : classifyCrash(text));
    return {
        state,
        crashed: true,
        reason,
        advice: crashAdvice(reason),
        ...evidence === undefined && text === undefined ? {} : { evidence: evidence ?? 'captured boot log' },
    };
}
/** Read a file as text, or `undefined` when it cannot be read. */
function safeRead(path) {
    try {
        return readFileSync(path, 'utf8');
    }
    catch {
        return undefined;
    }
}
/** The most recent captured boot output, from the incident store or the boot log. */
function lastCapturedOutput(stateRoot) {
    const incident = readIncident(stateRoot);
    if (incident !== undefined && incident.output.trim() !== '')
        return incident.output;
    return safeRead(join(stateRoot, 'boot.log'));
}
/** Read the model route the harness would select, without booting it. */
function readModelRoute(planeRoot) {
    const settingsPath = homePath('settings.yaml');
    if (!existsSync(settingsPath))
        return undefined;
    const yaml = planeRoot === undefined ? undefined : requireFromPlane(planeRoot, 'js-yaml');
    const parser = yaml;
    if (parser === undefined)
        return undefined;
    try {
        const document = asRecord(parser.load(readFileSync(settingsPath, 'utf8')));
        if (document === undefined)
            return undefined;
        const selection = asRecord(document['agent-default-model']) ?? {};
        const provider = str(selection.provider) ?? 'deepseek-official';
        const model = str(selection.model) ?? 'deepseek-v4-flash';
        const catalog = asRows(asRecord(document['llm-deepseek'])?.models)
            .map(entry => str(entry.id))
            .filter((id) => id !== undefined);
        return { provider, model, source: settingsPath, catalog };
    }
    catch (error) {
        return { provider: '', model: '', source: settingsPath, error: describe(error) };
    }
}
/** Whether a DeepSeek key is resolvable, and from where — never the value. */
function readCredentials() {
    if ((process.env.DEEPSEEK_API_KEY ?? '') !== '')
        return { deepseekKey: true, source: 'environment' };
    const file = homePath('.credentials.yaml');
    if (!existsSync(file))
        return { deepseekKey: false, source: 'no environment variable and no .credentials.yaml' };
    const text = readFileSync(file, 'utf8');
    const present = /^\s{2}DEEPSEEK_API_KEY:/m.test(text);
    return { deepseekKey: present, source: present ? file : `${file} has no DEEPSEEK_API_KEY ref` };
}
/** Load the Loader's YAML dialect from a plane, so patch parsing matches boot. */
async function loadEntrySchema(planeRoot) {
    if (planeRoot === undefined)
        return undefined;
    try {
        const include = await importFromPlane(planeRoot, '@deepseek-ai/cordis-plugin-include', 'lib', 'index.js');
        return include.entryListSchema;
    }
    catch {
        // A plane whose include cannot be imported is reported through the plane
        // probe; patch parsing then falls back to the plain YAML schema.
        return undefined;
    }
}
/** Check one port for a listener without importing anything. */
function portState(port) {
    return new Promise((resolvePort) => {
        void import('node:net').then(({ createServer }) => {
            const server = createServer();
            server.once('error', () => { resolvePort(true); });
            server.once('listening', () => { server.close(() => { resolvePort(false); }); });
            server.listen(port, '127.0.0.1');
        }, () => { resolvePort(false); });
    });
}
/**
 * Diagnose the deployment without booting it.
 * @param options - plane override, target profile, and search directories.
 * @returns the complete report; never throws for a broken deployment.
 */
export async function runDoctor(options = {}) {
    const cwd = options.cwd ?? process.cwd();
    const planes = planeCandidates(options.plane, options.packageDir, cwd);
    const usable = planes.find(plane => plane.usable);
    const schema = await loadEntrySchema(usable?.root);
    const findings = [];
    for (const plane of planes) {
        if (plane.usable) {
            findings.push({
                code: 'plane-usable',
                level: 'info',
                title: `deployment plane usable (${plane.origin})`,
                detail: `${plane.root} carries the packages needed to boot a rescue tree${plane.version === undefined ? '' : ` (dsh-base ${plane.version})`}`,
                evidence: plane.root,
            });
        }
        else {
            findings.push({
                code: 'plane-unusable',
                level: 'warn',
                title: `deployment plane incomplete (${plane.origin})`,
                detail: `${plane.root} is missing: ${plane.missing.join(', ') || 'nothing listed'}`,
                evidence: plane.root,
            });
        }
    }
    if (usable === undefined) {
        findings.push({
            code: 'no-usable-plane',
            level: 'error',
            title: 'no node_modules root carries a complete harness package set',
            detail: 'The rescue cannot boot an agent; only this static diagnosis is available.',
            fix: 'Reinstall the harness (npm i -g @deepseek-ai/dsh) or pass --plane <node_modules dir> pointing at an intact install.',
        });
    }
    const profileDirs = listProfileDirs();
    if (profileDirs.length === 0) {
        findings.push({
            code: 'no-profiles',
            level: 'warn',
            title: 'no profile directory found',
            detail: `${homePath('profiles')} holds no profile, so nothing has been configured to boot.`,
            evidence: homePath('profiles'),
        });
    }
    const homePatch = homePath('cordis.patch.yml');
    const homeLayer = existsSync(homePatch) ? readLayer(homePatch, 'home', usable?.root, schema) : undefined;
    const profiles = [];
    for (const dir of profileDirs) {
        const name = basename(dir);
        const manifestParsed = readJson(join(dir, 'package.json'));
        const manifest = asRecord(manifestParsed.value) ?? {};
        const rawBundles = asRecord(asRecord(manifest.dsh)?.profile)?.bundles;
        const bundles = Array.isArray(rawBundles) ? rawBundles.filter((entry) => typeof entry === 'string') : [];
        const bundleInfos = bundles.map(bundle => readBundle(bundle, bundleAnchors(dir, usable?.root, options.packageDir)));
        const layers = [];
        for (const bundle of bundleInfos) {
            if (bundle.resolved && bundle.patch !== undefined)
                layers.push(readLayer(bundle.patch, 'bundle', usable?.root, schema));
        }
        const profilePatch = join(dir, 'cordis.patch.yml');
        layers.push(readLayer(profilePatch, 'profile', usable?.root, schema));
        if (homeLayer !== undefined)
            layers.push(homeLayer);
        const insertCounts = new Map();
        for (const layer of layers) {
            for (const id of layer.inserts)
                insertCounts.set(id, (insertCounts.get(id) ?? 0) + 1);
        }
        const duplicateIds = [...insertCounts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
        const inserted = new Set(insertCounts.keys());
        const orphanTargets = [...new Set(layers.flatMap(layer => layer.targets))].filter(id => !inserted.has(id));
        const disabledRows = [...new Set(layers.flatMap(layer => layer.disables))];
        const unresolvedInserts = layers
            .flatMap(layer => layer.insertRows
            .filter(row => row.name !== undefined && !row.disabled)
            .filter(row => !resolvesRowName(row.name, layer.path, dir, usable?.root, options.packageDir))
            .map(row => ({ id: row.id, name: row.name, layer: layer.path, role: layer.role })))
            .filter(row => !disabledRows.includes(row.id));
        const info = {
            name,
            dir,
            manifestOk: manifestParsed.ok,
            manifestError: manifestParsed.error,
            bundles: bundleInfos,
            links: readLinks(manifest, dir),
            layers,
            duplicateIds,
            unresolvedInserts,
            orphanTargets,
            disabledRows,
            patchReload: str(asRecord(asRecord(manifest.dsh)?.profile)?.patchReload),
        };
        profiles.push(info);
        if (!manifestParsed.ok) {
            findings.push({
                code: 'profile-manifest-unreadable',
                level: 'error',
                title: `profile "${name}" has an unreadable package.json`,
                detail: manifestParsed.error ?? 'unknown',
                evidence: join(dir, 'package.json'),
                fix: `Repair or restore ${join(dir, 'package.json')}; the launcher cannot compose a profile without it.`,
            });
        }
        for (const bundle of bundleInfos) {
            if (bundle.resolved)
                continue;
            // The three failures need different fixes, so each names its own: an
            // unresolvable package is a broken install or link, a manifest without
            // `dsh.bundle.patch` is not a bundle at all, and a declared-but-absent
            // patch file is a damaged package. All three refuse the entire tree.
            const code = bundle.code ?? 'unresolved';
            const tailored = code === 'unresolved'
                ? `Reinstall it (\`dsh plugin --profile ${name} add ${bundle.name}\`) or run \`dsh-rescue fix\` to drop it from dsh.profile.bundles. The bundle layer cannot be disabled, so removing the list entry is the mechanical repair.`
                : code === 'patch-missing'
                    ? `Reinstall ${bundle.name} so its patch file is restored, or run \`dsh-rescue fix\` to drop it from dsh.profile.bundles.`
                    : code === 'no-patch'
                        ? `${bundle.name} is installed but is not a dsh bundle. Remove it from dsh.profile.bundles (that is what \`dsh-rescue fix\` does), or install the package that does declare one.`
                        : `Repair ${bundle.dir ?? bundle.name}'s package.json, or run \`dsh-rescue fix\` to drop it from dsh.profile.bundles.`;
            findings.push({
                code: `bundle-${code}`,
                level: 'error',
                title: `profile "${name}" lists bundle ${bundle.name}, which the launcher cannot mount`,
                detail: bundle.error ?? 'unknown bundle failure',
                evidence: join(dir, 'package.json'),
                fix: tailored,
            });
        }
        for (const link of info.links) {
            if (!link.targetExists) {
                findings.push({
                    code: 'link-target-missing',
                    level: 'error',
                    title: `profile "${name}" links ${link.name} to a missing path`,
                    detail: `declared target ${link.target} does not exist`,
                    evidence: join(dir, 'package.json'),
                    fix: `Restore ${link.target}, or remove the dependency and its bundle entry, or disable its rows in ${profilePatch}.`,
                });
                continue;
            }
            if (!link.installed || !link.consistent) {
                findings.push({
                    code: 'link-dangling',
                    level: 'error',
                    title: `profile "${name}" has a dangling or stale link for ${link.name}`,
                    detail: `installed=${link.installed ? link.pointsTo ?? 'yes' : 'no'}, declared=${link.target}`,
                    evidence: join(dir, 'node_modules', link.name),
                    fix: `Run: dsh plugin --profile ${name} add ${link.name} (recreates the junction), or delete ${join(dir, 'node_modules', link.name)} and re-add.`,
                });
            }
        }
        for (const layer of layers) {
            for (const problem of layer.problems)
                findings.push(problem);
        }
        if (info.unresolvedInserts.length > 0) {
            findings.push({
                code: 'insert-unresolvable',
                level: 'error',
                title: `profile "${name}" inserts ${String(info.unresolvedInserts.length)} row(s) whose package cannot be resolved`,
                detail: info.unresolvedInserts.map(row => `${row.id} -> ${row.name} (from ${row.role} layer ${row.layer})`).join('\n'),
                evidence: info.unresolvedInserts.map(row => row.layer).join('\n'),
                fix: `Run \`dsh-rescue fix\` to append a disable patch for each row, or install the missing package and restart.`,
            });
        }
        if (info.duplicateIds.length > 0) {
            findings.push({
                code: 'patch-duplicate-id',
                level: 'error',
                title: `profile "${name}" inserts the same loader entry id more than once`,
                detail: `duplicated ids: ${info.duplicateIds.join(', ')}`,
                evidence: layers.map(layer => layer.path).join('\n'),
                fix: `Keep the last insert per id and delete the earlier one; the Loader rejects duplicate entry ids with "duplicate loader entry id".`,
            });
        }
        if (info.orphanTargets.length > 0) {
            findings.push({
                code: 'patch-orphan-target',
                level: 'warn',
                title: `profile "${name}" patches ids no layer inserts`,
                detail: `unmatched ids: ${info.orphanTargets.join(', ')}`,
                evidence: profilePatch,
                fix: 'A patch that matches no row is a silent no-op; fix the id or remove the patch.',
            });
        }
        const profileLayer = layers.find(layer => layer.role === 'profile');
        if (profileLayer !== undefined && profileLayer.disables.length > 0) {
            findings.push({
                code: 'rows-disabled',
                level: 'info',
                title: `profile "${name}" disables ${String(profileLayer.disables.length)} row(s)`,
                detail: profileLayer.disables.join(', '),
                evidence: profilePatch,
            });
        }
        if (info.patchReload === 'live') {
            findings.push({
                code: 'patch-reload-live',
                level: 'info',
                title: `profile "${name}" reloads its patch layer live`,
                detail: 'an edit to cordis.patch.yml applies without restarting the process',
                evidence: profilePatch,
            });
        }
    }
    const model = readModelRoute(usable?.root);
    if (model !== undefined) {
        if (model.error !== undefined) {
            findings.push({
                code: 'settings-unreadable',
                level: 'error',
                title: 'settings.yaml cannot be parsed',
                detail: model.error,
                evidence: model.source,
                fix: 'Repair or move settings.yaml aside; the harness reads it at every boot.',
            });
        }
        else if (model.catalog !== undefined && model.catalog.length > 0 && !model.catalog.includes(model.model)) {
            findings.push({
                code: 'model-not-in-catalog',
                level: 'error',
                title: `configured default model "${model.model}" is not in the configured catalog`,
                detail: `settings.yaml lists: ${model.catalog.join(', ')}`,
                evidence: model.source,
                fix: 'Set agent-default-model.model to one of the listed ids, or pass --model <id> to the rescue.',
            });
        }
        else {
            findings.push({
                code: 'model-route',
                level: 'info',
                title: `default model route is ${model.provider}/${model.model}`,
                detail: `read from ${model.source}`,
                evidence: model.source,
            });
        }
    }
    const credentials = readCredentials();
    findings.push(credentials.deepseekKey
        ? { code: 'credentials-present', level: 'info', title: 'a DeepSeek API key is resolvable', detail: `source: ${credentials.source}` }
        : {
            code: 'credentials-missing',
            level: 'warn',
            title: 'no DeepSeek API key is resolvable',
            detail: `source: ${credentials.source}`,
            fix: 'Export DEEPSEEK_API_KEY, or add it to $DSH_HOME/.credentials.yaml, before asking the rescue agent to reason about the failure.',
        });
    if (profiles.some(profile => profile.name === 'web') && await portState(3080)) {
        findings.push({
            code: 'web-port-in-use',
            level: 'info',
            title: 'port 3080 is already accepting connections',
            detail: 'a web surface is probably still running; a second one would fail with EADDRINUSE',
            fix: 'Stop the running surface, or start the rescue with --profile <other> to inspect without touching it.',
        });
    }
    const incident = readIncident();
    if (incident !== undefined) {
        findings.push({
            code: 'incident-captured',
            level: 'error',
            title: `captured boot failure at ${incident.at}`,
            detail: `${incident.command} exited ${incident.exitCode === null ? 'on a signal' : String(incident.exitCode)} after ${String(incident.durationMs)}ms`,
            evidence: incident.signals.slice(-6).join('\n') || incident.output.slice(-2000),
            fix: 'The repair agent reads this incident; re-run `dsh-rescue supervise` to capture a fresh one.',
        });
    }
    // The boot handshake: nobody has to be watching when the harness dies, because
    // the run that died left the record open and this run reads it.
    const boot = readBootReport();
    if (boot.crashed) {
        findings.push({
            code: 'boot-crashed',
            level: 'error',
            title: 'the previous harness run did not reach its ready state',
            detail: [
                `started at ${boot.state?.startedAt ?? 'unknown'}${boot.state?.pid === undefined ? '' : ` (pid ${String(boot.state.pid)})`}`,
                `last run that did reach readiness: ${boot.state?.lastGoodAt ?? 'none recorded'}`,
                boot.state?.tornDown === true
                    ? 'the tree was torn down before readiness without a signal asking for it, which is the signature of a failed load'
                    : 'the process ended before readiness',
                `classified as: ${boot.reason ?? 'unknown'}`,
            ].join('\n'),
            ...boot.evidence === undefined ? {} : { evidence: boot.evidence },
            ...boot.advice === undefined ? {} : { fix: boot.advice },
        });
    }
    else if (boot.state?.lastGoodAt !== undefined && boot.state.lastGoodAt !== null) {
        findings.push({
            code: 'boot-last-good',
            level: 'info',
            title: 'the last harness run reached its ready state',
            detail: `last good boot: ${boot.state.lastGoodAt}`,
            evidence: bootStatePath(),
        });
    }
    else if (boot.state === undefined) {
        findings.push({
            code: 'boot-state-absent',
            level: 'info',
            title: 'no boot history recorded yet',
            detail: `nothing has written ${bootStatePath()}, so a crash cannot be attributed to a previous run. Mounting the dsh-rescue bundle in the profile starts recording it.`,
        });
    }
    const checkout = findCheckout(cwd);
    if (checkout !== undefined) {
        findings.push({
            code: 'checkout-found',
            level: 'info',
            title: 'harness source checkout found',
            detail: checkout,
            evidence: checkout,
        });
    }
    return {
        generatedAt: new Date().toISOString(),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cwd,
        dshHome: dshHome(),
        planes,
        checkout,
        targetProfile: options.profile,
        profiles,
        incident,
        boot,
        model: model === undefined || model.error !== undefined ? undefined : { provider: model.provider, model: model.model, source: model.source },
        credentials,
        findings,
    };
}
/** The highest severity present in a report, for exit codes and banners. */
export function worstLevel(report) {
    if (report.findings.some(finding => finding.level === 'error'))
        return 'error';
    if (report.findings.some(finding => finding.level === 'warn'))
        return 'warn';
    return 'info';
}
/**
 * Whether a path is a directory holding at least one entry.
 * @param path - the directory to test.
 * @returns true when it is a non-empty directory.
 */
export function hasEntries(path) {
    try {
        return statSync(path).isDirectory() && readdirSync(path).length > 0;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=doctor.js.map