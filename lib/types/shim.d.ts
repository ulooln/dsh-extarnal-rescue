/**
 * The short launcher a person runs when the harness will not start.
 *
 * A launcher nobody can invoke is not a launcher. Its directory is normally not
 * on PATH, and a shell then reports the bare name as unknown, which reads exactly
 * like the tool does not exist. Writing the files and saying how to reach them is
 * one job, so both callers that can install them (`dsh-rescue shim` and the
 * in-process mount) share this module rather than keeping two copies that drift.
 *
 * No harness package is imported here: the CLI has to be able to install its own
 * launcher while the rest of the deployment is broken.
 * @module @dsh-external/dsh-rescue/shim
 */
/** What writing the launcher produced. */
export interface ShimResult {
    /** The files that were written. */
    files: string[];
    /** Whether the launcher's directory is on the search path. */
    onPath: boolean;
    /** How to reach the launcher meanwhile, when it is not a command yet. */
    pathAdvice?: string;
    /** Why nothing could be written. */
    error?: string;
}
/**
 * Write the launcher into the rescue state root.
 * @param stateRoot - the rescue state root.
 * @returns the written paths, whether they are reachable as a command, and the
 * advice to show when they are not.
 */
export declare function writeShim(stateRoot: string): ShimResult;
/**
 * Whether the PATH notice is worth printing again.
 *
 * The mount runs on every boot, and the default layout keeps the launcher off
 * PATH, so printing the same advice each time turns advice into noise the reader
 * learns to skip. The answer is remembered per state root and shown again only
 * when it changes, which is the only time it carries information.
 * @param stateRoot - the rescue state root.
 * @param onPath - whether the launcher's directory is on the search path now.
 * @returns true when this differs from the last recorded state.
 */
export declare function pathNoticeIsNews(stateRoot: string, onPath: boolean): boolean;
