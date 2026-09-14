/**
 * Shared types for the rescue surfaces. Kept free of runtime imports so the
 * standalone CLI can use them without resolving any harness package.
 * @module @dsh-external/dsh-rescue/types
 */

/** Severity of one diagnosis finding, ordered most to least urgent. */
export type FindingLevel = 'error' | 'warn' | 'info'

/** One concrete thing the doctor observed, with the evidence it observed it from. */
export interface Finding {
  /** Stable machine-readable identifier, e.g. `patch-duplicate-id`. */
  code: string
  level: FindingLevel
  /** One line naming what is wrong. */
  title: string
  /** What was observed, including the exact values involved. */
  detail: string
  /** File, command, or log excerpt that proves the finding. */
  evidence?: string
  /** The concrete next action, when one exists. */
  fix?: string
}

/** A deployment plane: a node_modules root whose packages can boot a harness tree. */
export interface PlaneInfo {
  /** Absolute node_modules directory. */
  root: string
  /** Why this root was considered: `explicit`, `env`, `profiles`, `package`, or `checkout`. */
  origin: string
  /** Whether the packages needed to boot a rescue tree are all present. */
  usable: boolean
  /** Version of `@deepseek-ai/dsh-base` found there, when readable. */
  version?: string
  /** Missing package names that make {@link PlaneInfo.usable} false. */
  missing: string[]
}

/** One loader patch layer as the doctor reads it. */
export interface PatchLayerInfo {
  /** Absolute path of the file. */
  path: string
  /** Which composition layer this file is: a bundle, the profile, or the harness home. */
  role: 'bundle' | 'profile' | 'home'
  /** Entry ids the layer targets with an id-only patch. */
  targets: string[]
  /** Entry ids the layer inserts. */
  inserts: string[]
  /** Every row the layer inserts, with the specifier it mounts. */
  insertRows: Array<{ id: string; name?: string; disabled: boolean }>
  /** Inserted row ids the layer disables. */
  disables: string[]
  /** Parse or shape problems found while reading the file. */
  problems: Finding[]
}

/** One inserted row whose package specifier cannot be resolved. */
export interface UnresolvedInsert {
  /** Loader entry id the row declares. */
  id: string
  /** The specifier that did not resolve. */
  name: string
  /** Absolute path of the layer that inserts it. */
  layer: string
  /** Which composition layer the insert came from. */
  role: PatchLayerInfo['role']
}

/** Why one bundle is unusable, if it is. */
export type BundleCode = 'unresolved' | 'manifest-invalid' | 'no-patch' | 'patch-missing'

/** One bundle listed in a profile manifest, resolved or not. */
export interface BundleInfo {
  name: string
  resolved: boolean
  /** Absolute package directory when resolved. */
  dir?: string
  /** Patch file the bundle contributes, when declared. */
  patch?: string
  /** Which check failed, when {@link BundleInfo.resolved} is false. */
  code?: BundleCode
  error?: string
}

/** One link dependency of a profile manifest. */
export interface LinkInfo {
  /** Dependency name as written in package.json. */
  name: string
  /** The declared `link:`/`file:` target, already made absolute. */
  target: string
  /** Whether the declared target exists on disk. */
  targetExists: boolean
  /** Whether the profile's node_modules entry exists. */
  installed: boolean
  /** Absolute path the installed entry points at, when it is a link. */
  pointsTo?: string
  /** Whether the installed entry and the declared target agree. */
  consistent: boolean
}

/** Everything the doctor learned about one profile directory. */
export interface ProfileInfo {
  name: string
  dir: string
  /** Whether package.json parsed. */
  manifestOk: boolean
  manifestError?: string
  /** Ordered bundle list from `dsh.profile.bundles`. */
  bundles: BundleInfo[]
  /** `link:`/`file:` dependencies with their installation state. */
  links: LinkInfo[]
  /** Patch layers that apply to this profile, in application order. */
  layers: PatchLayerInfo[]
  /** Inserted row ids that appear in more than one layer — a duplicate-entry crash. */
  duplicateIds: string[]
  /** Inserted rows whose module specifier cannot be resolved. */
  unresolvedInserts: UnresolvedInsert[]
  /** Id-targeted patches whose target no layer inserts and no bundle declares. */
  orphanTargets: string[]
  /** Loader row ids this profile disables, with the layer that disabled them. */
  disabledRows: string[]
  /** Whether `patchReload` is `live`, so a bad edit takes effect without a restart. */
  patchReload?: string
}

/** Why a boot run is believed to have failed, from the signatures in its output. */
export type CrashReason = 'session-corrupt' | 'bundle-check' | 'patch-tree' | 'port-bind' | 'settings' | 'unknown'

/** How this rescue's own composition differs from the deployment's base bundle. */
export interface CompositionDiff {
  /** Overrides the rescue applies that the deployment does not provide. */
  missingTargets: string[]
  /** Rescue inserts whose id the deployment already uses. */
  collisions: string[]
  /** Missing overrides that stop the rescue from repairing at all. */
  criticalMissing: string[]
}

/** The full compatibility picture for one deployment plane. */
export interface RescueCompatibility extends CompositionDiff {
  /** The plane the comparison ran against. */
  planeRoot: string
  /** The deployment base bundle's patch file. */
  basePatch: string
  /** `@deepseek-ai/dsh-base` version found in that plane. */
  baseVersion?: string
  /** Inserted rows whose package the plane cannot resolve. */
  unresolvedRows: string[]
  /** Whether every override and insert still applies. */
  ok: boolean
}

/**
 * The last boot's outcome, written by whoever ran it.
 *
 * A crash cannot write its own record, so the handshake runs the other way: a
 * run marks itself unfinished before it knows it will survive, and only marks
 * itself finished once it reaches its ready state. The next run therefore infers
 * the crash, and {@link BootState.lastGoodAt} survives it as the rollback anchor.
 */
export interface BootState {
  /** Whether the run that wrote this record reached its ready state. */
  ok: boolean
  /** ISO timestamp this record was opened. */
  startedAt?: string
  /** ISO timestamp readiness was committed. */
  okAt?: string
  /** ISO timestamp of the most recent run that did reach readiness. */
  lastGoodAt?: string | null
  /** Process id of the run that opened the record. */
  pid?: number
  /**
   * Whether the run that opened this record exited on purpose before reaching
   * readiness. Only an interrupt or termination signal sets this: a run whose
   * tree was torn down for any other reason never reached readiness, which is
   * the signature of a failed load rather than of a deliberate stop.
   */
  cleanExit?: boolean
  /** Whether the tree was unloaded before readiness without a signal asking for it. */
  tornDown?: boolean
  /** Signatures read out of the failing run's captured output. */
  crashReason?: CrashReason | null
  /** Which captured artifact the signatures came from. */
  crashEvidence?: string
  /** Version of the rescue package that wrote the record. */
  version?: string
}

/** The boot history as the doctor reports it. */
export interface BootReport {
  /** The record left by the previous run, absent on a first-ever run. */
  state?: BootState
  /** Whether the previous run failed to reach readiness without exiting on purpose. */
  crashed: boolean
  /** Signatures classified from the failing run's output. */
  reason?: CrashReason
  /** The concrete next step for {@link BootReport.reason}. */
  advice?: string
  /** Where the classified output came from. */
  evidence?: string
}

/** The captured output of one failed boot attempt. */
export interface Incident {
  /** ISO timestamp of the attempt. */
  at: string
  /** Exact command line that was run. */
  command: string
  /** Working directory of the attempt. */
  cwd: string
  /** Exit code, or `null` when the attempt was killed by a signal or timeout. */
  exitCode: number | null
  /** Milliseconds the attempt ran before exiting or timing out. */
  durationMs: number
  /** Whether the harness reached its ready signal. */
  booted: boolean
  /** Combined stdout and stderr, verbatim and unabridged. */
  output: string
  /** Lines the doctor recognised as boot diagnostics, most relevant first. */
  signals: string[]
  /** Absolute path of the incident directory holding this record and its state snapshot. */
  dir?: string
}

/** The complete diagnosis handed to the human and to the repair agent. */
export interface DoctorReport {
  generatedAt: string
  node: string
  platform: string
  arch: string
  cwd: string
  dshHome: string
  /** Ordered candidate planes, best first. */
  planes: PlaneInfo[]
  /** Absolute harness source checkout, when one was found. */
  checkout?: string
  /** The profile the run targets, when one was named. */
  targetProfile?: string
  profiles: ProfileInfo[]
  /** The most recent captured boot failure, when one exists. */
  incident?: Incident
  /** The previous run's outcome, inferred from the boot handshake. */
  boot: BootReport
  /** Whether this rescue's own composition still matches the deployment. */
  compatibility?: RescueCompatibility
  /** Resolved model route for the repair agent. */
  model?: { provider: string; model: string; source: string }
  /** Credential availability, never a credential value. */
  credentials: { deepseekKey: boolean; source: string }
  findings: Finding[]
}
