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

import { createRequire } from 'node:module'
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { PlaneInfo } from './types.ts'

/** Packages a plane must carry before the rescue can boot a tree from it. */
export const REQUIRED_PLANE_PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/cordis-plugin-include',
  '@deepseek-ai/cordis-plugin-timer',
  '@deepseek-ai/dsh-app-boot',
  '@deepseek-ai/dsh-base',
] as const

/** Extra packages the rescue composition adds on top of the base plane. */
export const OPTIONAL_PLANE_PACKAGES = [
  '@deepseek-ai/dsh-cordis-host-runner',
  '@deepseek-ai/dsh-tool-cordis',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-agent-presets',
] as const

/**
 * Resolve the harness home exactly as the product does: `$DSH_HOME`, else
 * `~/.dsh`. Kept local so the doctor can run before any package loads.
 * @returns the absolute harness home path.
 */
export function dshHome(): string {
  const configured = process.env.DSH_HOME
  if (configured !== undefined && configured.trim() !== '') return resolve(configured.trim())
  return join(homedir(), '.dsh')
}

/**
 * Resolve a harness-home path the way config `!!js` expressions see it.
 * @param segments - path segments under the harness home.
 * @returns the absolute path.
 */
export function homePath(...segments: string[]): string {
  return join(dshHome(), ...segments)
}

/**
 * Walk upward from `from` looking for the harness checkout root, identified by
 * a `pnpm-workspace.yaml` beside `apps/cli/src/bin.ts`.
 * @param from - directory to start from.
 * @returns the absolute checkout root, or `undefined`.
 */
export function findCheckout(from: string = process.cwd()): string | undefined {
  let current = resolve(from)
  while (true) {
    if (existsSync(join(current, 'pnpm-workspace.yaml')) && existsSync(join(current, 'apps', 'cli', 'src', 'bin.ts'))) {
      return current
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

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
  boot(
    binName: string,
    absoluteConfigPath: string,
    patches?: unknown[],
    prepare?: (ctx: AppBootContext) => Promise<void> | void,
    bareModuleBaseUrl?: string,
  ): Promise<AppBootContext>
  /**
   * Parse a required patch list file.
   * @param binName - diagnostic prefix.
   * @param file - absolute path of the overlay file.
   */
  loadOverlayPatches(binName: string, file: string): unknown[]
  /**
   * Parse an optional patch list file.
   * @param binName - diagnostic prefix.
   * @param file - absolute path of the patch file.
   */
  loadOptionalPatches(binName: string, file: string): unknown[] | undefined
}

/** The slice of a settled Cordis context this package touches. */
export interface AppBootContext {
  fiber: { state: number; dispose(): Promise<void> }
  provide(name: string, value: unknown): void
  get(name: string): unknown
}

/**
 * Probe one node_modules root for a complete, importable harness package set.
 * @param root - absolute node_modules directory.
 * @param origin - why this root was considered, recorded in the report.
 * @returns the plane description, usable or not.
 */
export function probePlane(root: string, origin: string): PlaneInfo {
  const missing: string[] = []
  for (const name of REQUIRED_PLANE_PACKAGES) {
    if (!existsSync(join(root, name, 'package.json'))) missing.push(name)
  }
  let version: string | undefined
  try {
    const manifest = JSON.parse(readFileSync(join(root, '@deepseek-ai/dsh-base/package.json'), 'utf8')) as { version?: unknown }
    if (typeof manifest.version === 'string') version = manifest.version
  } catch {
    // A missing or unreadable base manifest is already reported through `missing`.
    version = undefined
  }
  return { root, origin, usable: missing.length === 0, version, missing }
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
export function planeCandidates(explicit?: string, packageDir?: string, cwd?: string): PlaneInfo[] {
  const candidates: PlaneInfo[] = []
  const add = (root: string | undefined, origin: string): void => {
    if (root === undefined || root === '') return
    const absolute = resolve(root)
    if (candidates.some(candidate => candidate.root === absolute)) return
    candidates.push(probePlane(absolute, origin))
  }
  add(explicit, 'explicit')
  add(process.env.DSH_RESCUE_PLANE, 'env')
  add(homePath('profiles', 'node_modules'), 'profiles')
  add(packageDir === undefined ? undefined : join(packageDir, 'node_modules'), 'package')
  const checkout = findCheckout(cwd ?? process.cwd())
  if (checkout !== undefined) add(join(checkout, 'apps', 'cli', 'node_modules'), 'checkout')
  return [...candidates.filter(candidate => candidate.usable), ...candidates.filter(candidate => !candidate.usable)]
}

/**
 * Pick the first usable plane.
 * @param candidates - ordered planes from {@link planeCandidates}.
 * @returns the first usable plane, or `undefined` when none can boot.
 */
export function firstUsablePlane(candidates: readonly PlaneInfo[]): PlaneInfo | undefined {
  return candidates.find(candidate => candidate.usable)
}

/**
 * Turn a plane-relative path into a file URL the Include can import.
 * @param root - the plane's node_modules root.
 * @param segments - path segments under that root.
 * @returns the absolute file URL.
 */
export function planeUrl(root: string, ...segments: string[]): string {
  return pathToFileURL(join(root, ...segments)).href
}

/**
 * The trailing-slash base URL bare package names resolve against.
 * @param root - the plane's node_modules root.
 * @returns the absolute base URL.
 */
export function planeBaseUrl(root: string): string {
  return pathToFileURL(root).href + '/'
}

/**
 * Import a module from a plane by relative path, bypassing this process's own
 * module resolution so a broken package link here cannot break the rescue.
 * @param root - the plane's node_modules root.
 * @param segments - path segments under that root.
 * @returns the imported module namespace.
 */
export async function importFromPlane(root: string, ...segments: string[]): Promise<unknown> {
  return await import(planeUrl(root, ...segments))
}

/**
 * Load the boot glue from a plane.
 * @param root - the plane's node_modules root.
 * @returns the boot module.
 * @throws when the boot glue cannot be imported.
 */
export async function loadAppBoot(root: string): Promise<AppBootModule> {
  return await importFromPlane(root, '@deepseek-ai/dsh-app-boot', 'lib', 'index.js') as AppBootModule
}

/**
 * Resolve a CommonJS package from a plane. Used for the YAML parser, which the
 * doctor needs before any harness package is loaded.
 * @param root - the plane's node_modules root.
 * @param name - the package name.
 * @returns the required value, or `undefined` when it cannot be resolved.
 */
export function requireFromPlane(root: string, name: string): unknown {
  try {
    return createRequire(join(root, 'noop.cjs'))(name)
  } catch {
    // Absence is a reportable finding, not a crash: YAML checks then degrade.
    return undefined
  }
}

/** Where the rescue tree's own module scope lives inside the state root. */
export interface RescueRuntime {
  /** File URL of the compiled runner row to mount. */
  runnerUrl: string
  /** Absolute path of the include root the tree is anchored at. */
  rootConfig: string
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
export function prepareRuntime(stateRoot: string, planeRoot: string): RescueRuntime {
  const runtimeDir = join(stateRoot, 'runtime')
  mkdirSync(runtimeDir, { recursive: true })
  const runner = join(runtimeDir, 'runner.mjs')
  copyFileSync(join(packageLibDir(), 'runner.js'), runner)
  const rootConfig = join(runtimeDir, 'rescue.root.cordis.yml')
  writeFileSync(rootConfig, `# Written by dsh-rescue for one run: the Loader anchors the rescue tree here,
# and node_modules beside this file links the deployment plane, so every bare
# row name resolves without reading the profile that failed.
[]
`)
  const link = join(runtimeDir, 'node_modules')
  const wanted = pathToFileURL(planeRoot).href
  let current: string | undefined
  try {
    const stat = lstatSync(link)
    if (stat.isSymbolicLink()) current = pathToFileURL(resolve(dirname(link), readlinkSync(link))).href
  } catch {
    current = undefined
  }
  if (current !== wanted) {
    rmSync(link, { recursive: true, force: true })
    symlinkSync(planeRoot, link, process.platform === 'win32' ? 'junction' : 'dir')
  }
  return { runnerUrl: pathToFileURL(runner).href, rootConfig }
}

/**
 * Describe a path for diagnostics without failing when it is missing.
 * @param path - the path to describe.
 * @returns `directory`, `file`, `link -> target`, or `missing`.
 */
export function describePath(path: string): string {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return `link -> ${readlinkSync(path)}`
    if (stat.isDirectory()) return 'directory'
    return `file (${String(stat.size)} bytes)`
  } catch {
    return 'missing'
  }
}

/**
 * Whether a path exists and is a directory.
 * @param path - the path to test.
 * @returns true when it is an existing directory.
 */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * The directory this package's compiled files live in.
 * @returns the absolute `lib` directory.
 */
export function packageLibDir(): string {
  return dirname(fileURLToPath(import.meta.url))
}

/**
 * The package root directory.
 * @returns the absolute package directory.
 */
export function packageRootDir(): string {
  return dirname(packageLibDir())
}
