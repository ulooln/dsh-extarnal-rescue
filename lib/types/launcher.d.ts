/**
 * The rescue launcher: compose a host plane that does not depend on the failed
 * profile, boot it, and hand it the diagnosis.
 *
 * The launcher is the part that must survive a broken deployment, so it touches
 * as little of it as possible: it reads the plane's own `dsh-base` patch, its own
 * `rescue.cordis.yml`, and appends one runner row. Every failure path prints the
 * diagnosis it already computed instead of a bare stack.
 * @module @dsh-external/dsh-rescue/launcher
 */
/** Permission presets the rescue can run under. */
export type PermissionMode = 'read-only' | 'workspace-write' | 'danger-full-access';
/** Options for one rescue run. */
export interface RescueOptions {
    /** Explicit deployment plane root. */
    plane?: string;
    /** Profile to repair, used for the diagnosis and the verification command. */
    profile: string;
    /** Arguments the supervising boot used, so verification repeats them exactly. */
    bootArgs?: string[];
    /** One-shot mission; absent opens an interactive REPL. */
    task?: string;
    /** Model override for the repair agent. */
    provider?: string;
    model?: string;
    /** File-effect boundary for the repair agent. */
    permissionMode: PermissionMode;
    /** Workspace root for `workspace-write`. */
    workspace?: string;
    /** Root for rescue artifacts and redirected durable state. */
    stateRoot?: string;
    /** Directory used to find the harness checkout. */
    cwd?: string;
}
/** Where one rescue run writes its artifacts. */
export interface RunPaths {
    runDir: string;
    doctorText: string;
    doctorJson: string;
    missionPath: string;
    transcript: string;
}
/**
 * The exact command that proves a repair worked, run against the same plane the
 * rescue itself uses so the agent verifies the deployment rather than a guess.
 *
 * Extra arguments carry through deliberately: a supervisor that booted on a
 * non-default port must hand the agent that same port, or the agent's own
 * verification fails on an unrelated bind error.
 * @param planeRoot - the plane's node_modules root.
 * @param profile - profile name.
 * @param extraArgs - arguments the supervising boot used, in order.
 * @returns a copy-pasteable command line.
 */
export declare function verifyCommand(planeRoot: string, profile: string, extraArgs?: readonly string[]): string;
/**
 * Run one rescue: diagnose, write the artifacts, then boot the repair agent.
 * @param options - run options.
 * @returns the process exit code.
 */
export declare function launchRescue(options: RescueOptions): Promise<number>;
/**
 * The default state root, exposed for the CLI's help and the in-process tools.
 * @returns the absolute rescue state directory under the harness home.
 */
export declare function defaultStateRoot(): string;
