/**
 * Deployment-plane resolution.
 *
 * A "plane" is a node_modules root that carries a complete, importable set of
 * harness packages. The rescue boots from a plane instead of from the profile
 * composition that just failed, which is what makes it usable when that
 * composition, its bundles, or its patch layers are the broken thing.
 *
 * This module deliberately imports no harness package at module scope: the CLI
 * has to start with nothing but Node, then find and load the plane at runtime.
 * @module @dsh-external/dsh-rescue/plane
 */
var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync, } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
/** Packages a plane must carry before the rescue can boot a tree from it. */
export const REQUIRED_PLANE_PACKAGES = [
    '@deepseek-ai/cordis',
    '@deepseek-ai/cordis-plugin-loader',
    '@deepseek-ai/cordis-plugin-include',
    '@deepseek-ai/cordis-plugin-timer',
    '@deepseek-ai/dsh-app-boot',
    '@deepseek-ai/dsh-base',
];
/** Extra packages the rescue composition adds on top of the base plane. */
export const OPTIONAL_PLANE_PACKAGES = [
    '@deepseek-ai/dsh-cordis-host-runner',
    '@deepseek-ai/dsh-tool-cordis',
    '@deepseek-ai/dsh-skill-filesystem',
    '@deepseek-ai/dsh-agent-presets',
];
/**
 * Resolve the harness home exactly as the product does: `$DSH_HOME`, else
 * `~/.dsh`. Kept local so the doctor can run before any package loads.
 * @returns the absolute harness home path.
 */
export function dshHome() {
    const configured = process.env.DSH_HOME;
    if (configured !== undefined && configured.trim() !== '')
        return resolve(configured.trim());
    return join(homedir(), '.dsh');
}
/**
 * Resolve a harness-home path the way config `!!js` expressions see it.
 * @param segments - path segments under the harness home.
 * @returns the absolute path.
 */
export function homePath(...segments) {
    return join(dshHome(), ...segments);
}
/**
 * Walk upward from `from` looking for the harness checkout root, identified by
 * a `pnpm-workspace.yaml` beside `apps/cli/src/bin.ts`.
 * @param from - directory to start from.
 * @returns the absolute checkout root, or `undefined`.
 */
export function findCheckout(from = process.cwd()) {
    let current = resolve(from);
    while (true) {
        if (existsSync(join(current, 'pnpm-workspace.yaml')) && existsSync(join(current, 'apps', 'cli', 'src', 'bin.ts'))) {
            return current;
        }
        const parent = dirname(current);
        if (parent === current)
            return undefined;
        current = parent;
    }
}
/**
 * Probe one node_modules root for a complete, importable harness package set.
 * @param root - absolute node_modules directory.
 * @param origin - why this root was considered, recorded in the report.
 * @returns the plane description, usable or not.
 */
export function probePlane(root, origin) {
    const missing = [];
    for (const name of REQUIRED_PLANE_PACKAGES) {
        if (!existsSync(join(root, name, 'package.json')))
            missing.push(name);
    }
    let version;
    try {
        const manifest = JSON.parse(readFileSync(join(root, '@deepseek-ai/dsh-base/package.json'), 'utf8'));
        if (typeof manifest.version === 'string')
            version = manifest.version;
    }
    catch {
        // A missing or unreadable base manifest is already reported through `missing`.
        version = undefined;
    }
    return { root, origin, usable: missing.length === 0, version, missing };
}
/**
 * Every plane candidate, best first: explicit choice, `$DSH_RESCUE_PLANE`, the
 * deployment's flat install, this package's own links, and the checkout's CLI
 * install. Duplicates collapse to their first, most authoritative mention.
 * @param explicit - `--plane` value, when given.
 * @param packageDir - this package's directory, for its own node_modules.
 * @param cwd - directory used to find the checkout.
 * @returns ordered candidates, usable ones first.
 */
export function planeCandidates(explicit, packageDir, cwd) {
    const candidates = [];
    const add = (root, origin) => {
        if (root === undefined || root === '')
            return;
        const absolute = resolve(root);
        if (candidates.some(candidate => candidate.root === absolute))
            return;
        candidates.push(probePlane(absolute, origin));
    };
    add(explicit, 'explicit');
    add(process.env.DSH_RESCUE_PLANE, 'env');
    add(homePath('profiles', 'node_modules'), 'profiles');
    add(packageDir === undefined ? undefined : join(packageDir, 'node_modules'), 'package');
    const checkout = findCheckout(cwd ?? process.cwd());
    if (checkout !== undefined)
        add(join(checkout, 'apps', 'cli', 'node_modules'), 'checkout');
    return [...candidates.filter(candidate => candidate.usable), ...candidates.filter(candidate => !candidate.usable)];
}
/**
 * Pick the first usable plane.
 * @param candidates - ordered planes from {@link planeCandidates}.
 * @returns the first usable plane, or `undefined` when none can boot.
 */
export function firstUsablePlane(candidates) {
    return candidates.find(candidate => candidate.usable);
}
/**
 * Turn a plane-relative path into a file URL the Include can import.
 * @param root - the plane's node_modules root.
 * @param segments - path segments under that root.
 * @returns the absolute file URL.
 */
export function planeUrl(root, ...segments) {
    return pathToFileURL(join(root, ...segments)).href;
}
/**
 * Import a module from a plane by relative path, bypassing this process's own
 * module resolution so a broken package link here cannot break the rescue.
 * @param root - the plane's node_modules root.
 * @param segments - path segments under that root.
 * @returns the imported module namespace.
 */
export async function importFromPlane(root, ...segments) {
    return await import(__rewriteRelativeImportExtension(planeUrl(root, ...segments)));
}
/**
 * Load the boot glue from a plane.
 * @param root - the plane's node_modules root.
 * @returns the boot module.
 * @throws when the boot glue cannot be imported.
 */
export async function loadAppBoot(root) {
    return await importFromPlane(root, '@deepseek-ai/dsh-app-boot', 'lib', 'index.js');
}
/**
 * Resolve a CommonJS package from a plane. Used for the YAML parser, which the
 * doctor needs before any harness package is loaded.
 * @param root - the plane's node_modules root.
 * @param name - the package name.
 * @returns the required value, or `undefined` when it cannot be resolved.
 */
export function requireFromPlane(root, name) {
    try {
        return createRequire(join(root, 'noop.cjs'))(name);
    }
    catch {
        // Absence is a reportable finding, not a crash: YAML checks then degrade.
        return undefined;
    }
}
/**
 * Materialize the rescue tree's runtime directory inside the state root.
 *
 * The tree needs two things from one directory: the runner row's bare imports
 * must resolve through a plane, and the Loader anchors the tree's base URL at
 * the include root's directory, which is also what several host rows resolve
 * their own bare package names against. Putting both the root config and a
 * `node_modules` link to the plane in `<stateRoot>/runtime` satisfies both, and
 * keeps the rescue independent of this package's build-time links.
 * @param stateRoot - the rescue state root.
 * @param planeRoot - the plane's node_modules root.
 * @returns the runner URL and the include root to boot.
 * @throws when the runtime directory cannot be materialized.
 */
export function prepareRuntime(stateRoot, planeRoot) {
    const runtimeDir = join(stateRoot, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    const runner = join(runtimeDir, 'runner.mjs');
    copyFileSync(join(packageLibDir(), 'runner.js'), runner);
    const rootConfig = join(runtimeDir, 'rescue.root.cordis.yml');
    writeFileSync(rootConfig, `# Written by dsh-rescue for one run: the Loader anchors the rescue tree here,
# and node_modules beside this file links the deployment plane, so every bare
# row name resolves without reading the profile that failed.
[]
`);
    const link = join(runtimeDir, 'node_modules');
    const wanted = pathToFileURL(planeRoot).href;
    let current;
    try {
        const stat = lstatSync(link);
        if (stat.isSymbolicLink())
            current = pathToFileURL(resolve(dirname(link), readlinkSync(link))).href;
    }
    catch {
        current = undefined;
    }
    if (current !== wanted) {
        rmSync(link, { recursive: true, force: true });
        symlinkSync(planeRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return { runnerUrl: pathToFileURL(runner).href, rootConfig, rootDir: runtimeDir };
}
/**
 * Whether a directory is one of the entries on a PATH-style search path.
 *
 * The rescue's own launcher is only a command once its directory is on PATH, and
 * a directory that is not there fails in the most confusing way possible: the
 * shell reports the name as unknown, as if the tool did not exist. Comparing
 * entries means resolving case and separator differences, because the value the
 * user set and the value this process reads are not always spelled the same.
 * @param dir - the directory to look for.
 * @param searchPath - the PATH value; defaults to this process's.
 * @returns true when the directory is on the search path.
 */
export function isOnSearchPath(dir, searchPath = process.env.PATH) {
    if (searchPath === undefined || searchPath === '')
        return false;
    const normalize = (value) => {
        const trimmed = value.trim().replace(/^"|"$/g, '').replace(/[\\/]+$/, '');
        return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
    };
    const wanted = normalize(resolve(dir));
    return searchPath.split(process.platform === 'win32' ? ';' : ':').some(entry => normalize(entry) === wanted);
}
/**
 * Describe a path for diagnostics without failing when it is missing.
 * @param path - the path to describe.
 * @returns `directory`, `file`, `link -> target`, or `missing`.
 */
export function describePath(path) {
    try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink())
            return `link -> ${readlinkSync(path)}`;
        if (stat.isDirectory())
            return 'directory';
        return `file (${String(stat.size)} bytes)`;
    }
    catch {
        return 'missing';
    }
}
/**
 * Whether a path exists and is a directory.
 * @param path - the path to test.
 * @returns true when it is an existing directory.
 */
export function isDirectory(path) {
    try {
        return statSync(path).isDirectory();
    }
    catch {
        return false;
    }
}
/**
 * The directory this package's compiled files live in.
 * @returns the absolute `lib` directory.
 */
export function packageLibDir() {
    return dirname(fileURLToPath(import.meta.url));
}
/**
 * The package root directory.
 * @returns the absolute package directory.
 */
export function packageRootDir() {
    return dirname(packageLibDir());
}
//# sourceMappingURL=plane.js.map