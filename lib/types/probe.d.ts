/**
 * Boot capture: run the real harness in a child process, keep everything it
 * printed, and decide whether it actually came up.
 *
 * This is the only place that observes the failure from the outside. Its output
 * — command, exit code, duration, and the verbatim combined output — is what the
 * repair agent reads, so nothing here summarizes, filters, or truncates.
 *
 * The child writes straight to a log file rather than through pipes: the capture
 * then survives this process, needs no reader to drain it, and works in
 * environments that deny a child its own stdio pipes.
 * @module @dsh-external/dsh-rescue/probe
 */
import type { Incident } from './types.ts';
/** How one boot attempt is run. */
export interface CaptureOptions {
    /** Plane the harness binary is taken from. */
    planeRoot: string;
    /** Profile to boot. */
    profile: string;
    /** Working directory for the child. */
    cwd: string;
    /** Extra arguments appended after `--profile <name>`. */
    extraArgs?: string[];
    /** How long to wait before declaring a long-running surface booted. */
    timeoutMs: number;
    /** Absolute path the child's combined output is written to. */
    logPath: string;
    /**
     * Leave the child running when the boot window expires. A supervised boot
     * that came up must stay up; a verification boot is stopped instead.
     */
    keepAlive?: boolean;
    /** Echo the captured output to this process's streams once the attempt settles. */
    echo?: boolean;
}
/** The result of one boot attempt. */
export interface BootAttempt {
    at: string;
    command: string;
    cwd: string;
    exitCode: number | null;
    durationMs: number;
    booted: boolean;
    output: string;
    signals: string[];
    /** Absolute path of the raw combined output. */
    logPath: string;
    /** Process id of a child left running, when {@link CaptureOptions.keepAlive} applied. */
    pid?: number;
}
/** The harness binary inside a plane. */
export declare function harnessBin(planeRoot: string): string;
/** Build the exact command line a capture runs. */
export declare function captureCommand(planeRoot: string, profile: string, extraArgs: readonly string[]): string[];
/**
 * Run one boot attempt and capture it completely.
 * @param options - plane, profile, timeout, log path, and optional extra arguments.
 * @returns the attempt, including whether the surface came up.
 */
export declare function captureBoot(options: CaptureOptions): Promise<BootAttempt>;
/** How long a failing boot is given to finish dying so its exit code is captured. */
export declare const FAILURE_GRACE_MS = 20000;
/** How often the captured output is re-read while waiting for a boot. */
export declare const FAILURE_POLL_MS = 500;
/** How long a boot alive at its deadline is watched before being called up. */
export declare const SETTLE_MS = 4000;
/**
 * Whether captured output shows a boot that is failing.
 * @param text - the captured output so far.
 * @returns true when a failure signature is present.
 */
export declare function showsBootFailure(text: string): boolean;
/**
 * Decide what a boot attempt means, from its exit code and its output.
 *
 * Liveness alone is not evidence of success: a DSH that fails to load takes more
 * than ten seconds to die, so a process still running at the deadline may be a
 * corpse in progress. Exit code 0 is success, a non-zero exit is failure, and a
 * live process is only success when nothing in its output says otherwise.
 * @param exitCode - the process exit code, or `null` while it is still running.
 * @param output - everything the process printed.
 * @returns `up`, `down`, or `undecided` for a live process with a failure in flight.
 */
export declare function bootOutcome(exitCode: number | null, output: string): 'up' | 'down' | 'undecided';
/**
 * Persist one failed attempt, with the profile state that produced it.
 *
 * The snapshot matters: the repair agent may change these files, and the next
 * rescue must still be able to see what the failure actually looked like.
 * @param stateRoot - the rescue state root (`$DSH_HOME/rescue`).
 * @param attempt - the captured attempt.
 * @param context - profile directory and harness home to snapshot.
 * @returns the incident record, including its directory.
 */
export declare function writeIncident(stateRoot: string, attempt: BootAttempt, context: {
    profileDir?: string;
    dshHome: string;
}): Incident;
