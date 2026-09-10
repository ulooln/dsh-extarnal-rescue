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
import type { PlaneInfo } from './types.ts';
/** Packages a plane must carry before the rescue can boot a tree from it. */
export declare const REQUIRED_PLANE_PACKAGES: readonly ["@deepseek-ai/cordis", "@deepseek-ai/cordis-plugin-loader", "@deepseek-ai/cordis-plugin-include", "@deepseek-ai/cordis-plugin-timer", "@deepseek-ai/dsh-app-boot", "@deepseek-ai/dsh-base"];
/** Extra packages the rescue composition adds on top of the base plane. */
export declare const OPTIONAL_PLANE_PACKAGES: readonly ["@deepseek-ai/dsh-cordis-host-runner", "@deepseek-ai/dsh-tool-cordis", "@deepseek-ai/dsh-skill-filesystem", "@deepseek-ai/dsh-agent-presets"];
/**
 * Resolve the harness home exactly as the product does: `$DSH_HOME`, else
 * `~/.dsh`. Kept local so the doctor can run before any package loads.
 * @returns the absolute harness home path.
 */
export declare function dshHome(): string;
/**
 * Resolve a harness-home path the way config `!!js` expressions see it.
 * @param segments - path segments under the harness home.
 * @returns the absolute path.
 */
export declare function homePath(...segments: string[]): string;
/**
 * Walk upward from `from` looking for the harness checkout root, identified by
 * a `pnpm-workspace.yaml` beside `apps/cli/src/bin.ts`.
 * @param from - directory to start from.
 * @returns the absolute checkout root, or `undefined`.
 */
export declare function findCheckout(from?: string): string | undefined;
/** The boot glue a plane exposes, typed by the members this package calls. */
export interface AppBootModule {
    /**
     * Mount a Loader tree over a config file and return only after it settles.
     * @param binName - diagnostic prefix.
     * @param absoluteConfigPath - the include root.
     * @param patches - composed patch layers.
     * @param prepare - host setup run before any config row mounts.
     * @param bareModuleBaseUrl - base for bare package names.
     */
    boot(binName: string, absoluteConfigPath: string, patches?: unknown[], prepare?: (ctx: AppBootContext) => Promise<void> | void, bareModuleBaseUrl?: string): Promise<AppBootContext>;
    /**
     * Parse a required patch list file.
     * @param binName - diagnostic prefix.
     * @param file - absolute path of the overlay file.
     */
    loadOverlayPatches(binName: string, file: string): unknown[];
    /**
     * Parse an optional patch list file.
     * @param binName - diagnostic prefix.
     * @param file - absolute path of the patch file.
     */
    loadOptionalPatches(binName: string, file: string): unknown[] | undefined;
}
/** The slice of a settled Cordis context this package touches. */
export interface AppBootContext {
    fiber: {
        state: number;
        dispose(): Promise<void>;
    };
    provide(name: string, value: unknown): void;
    get(name: string): unknown;
}
/**
 * Probe one node_modules root for a complete, importable harness package set.
 * @param root - absolute node_modules directory.
 * @param origin - why this root was considered, recorded in the report.
 * @returns the plane description, usable or not.
 */
export declare function probePlane(root: string, origin: string): PlaneInfo;
/**
 * Every plane candidate, best first: explicit choice, `$DSH_RESCUE_PLANE`, the
 * deployment's flat install, this package's own links, and the checkout's CLI
 * install. Duplicates collapse to their first, most authoritative mention.
 * @param explicit - `--plane` value, when given.
 * @param packageDir - this package's directory, for its own node_modules.
 * @param cwd - directory used to find the checkout.
 * @returns ordered candidates, usable ones first.
 */
export declare function planeCandidates(explicit?: string, packageDir?: string, cwd?: string): PlaneInfo[];
/**
 * Pick the first usable plane.
 * @param candidates - ordered planes from {@link planeCandidates}.
 * @returns the first usable plane, or `undefined` when none can boot.
 */
export declare function firstUsablePlane(candidates: readonly PlaneInfo[]): PlaneInfo | undefined;
/**
 * Turn a plane-relative path into a file URL the Include can import.
 * @param root - the plane's node_modules root.
 * @param segments - path segments under that root.
 * @returns the absolute file URL.
 */
export declare function planeUrl(root: string, ...segments: string[]): string;
/**
 * The trailing-slash base URL bare package names resolve against.
 * @param root - the plane's node_modules root.
 * @returns the absolute base URL.
 */
export declare function planeBaseUrl(root: string): string;
/**
 * Import a module from a plane by relative path, bypassing this process's own
 * module resolution so a broken package link here cannot break the rescue.
 * @param root - the plane's node_modules root.
 * @param segments - path segments under that root.
 * @returns the imported module namespace.
 */
export declare function importFromPlane(root: string, ...segments: string[]): Promise<unknown>;
/**
 * Load the boot glue from a plane.
 * @param root - the plane's node_modules root.
 * @returns the boot module.
 * @throws when the boot glue cannot be imported.
 */
export declare function loadAppBoot(root: string): Promise<AppBootModule>;
/**
 * Resolve a CommonJS package from a plane. Used for the YAML parser, which the
 * doctor needs before any harness package is loaded.
 * @param root - the plane's node_modules root.
 * @param name - the package name.
 * @returns the required value, or `undefined` when it cannot be resolved.
 */
export declare function requireFromPlane(root: string, name: string): unknown;
/** Where the rescue tree's own module scope lives inside the state root. */
export interface RescueRuntime {
    /** File URL of the compiled runner row to mount. */
    runnerUrl: string;
    /** Absolute path of the include root the tree is anchored at. */
    rootConfig: string;
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
export declare function prepareRuntime(stateRoot: string, planeRoot: string): RescueRuntime;
/**
 * Describe a path for diagnostics without failing when it is missing.
 * @param path - the path to describe.
 * @returns `directory`, `file`, `link -> target`, or `missing`.
 */
export declare function describePath(path: string): string;
/**
 * Whether a path exists and is a directory.
 * @param path - the path to test.
 * @returns true when it is an existing directory.
 */
export declare function isDirectory(path: string): boolean;
/**
 * The directory this package's compiled files live in.
 * @returns the absolute `lib` directory.
 */
export declare function packageLibDir(): string;
/**
 * The package root directory.
 * @returns the absolute package directory.
 */
export declare function packageRootDir(): string;
