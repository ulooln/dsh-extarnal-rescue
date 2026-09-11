/**
 * Deterministic diagnosis of a harness deployment.
 *
 * The doctor never boots a plugin tree and never calls a model, so it still
 * produces an answer when the thing it is diagnosing cannot start at all. Every
 * finding carries the observation that produced it, and the report as a whole is
 * the input the repair agent reasons over.
 * @module @dsh-external/dsh-rescue/doctor
 */
import type { BootReport, BootState, CrashReason, DoctorReport, Incident } from './types.ts';
/** Options for {@link runDoctor}. */
export interface DoctorOptions {
    /** `--plane` value, when given. */
    plane?: string;
    /** Profile the run targets, when named. */
    profile?: string;
    /** Directory used to find the harness checkout. */
    cwd?: string;
    /** This package's directory, for its own node_modules candidate. */
    packageDir?: string;
}
/** Recognise the lines of captured boot output that name the failure. */
export declare function extractBootSignals(output: string): string[];
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
export declare function packageOfSpecifier(specifier: string): string | undefined;
/** Read the most recent captured incident, if any. */
export declare function readIncident(root?: string): Incident | undefined;
/** The file the boot handshake reads and writes inside the rescue state root. */
export declare function bootStatePath(stateRoot?: string): string;
/**
 * Read the previous run's outcome.
 * @param stateRoot - the rescue state root.
 * @returns the record, or `undefined` when none was ever written.
 */
export declare function readBootState(stateRoot?: string): BootState | undefined;
/**
 * Write the boot handshake's current outcome. A failure here must never break a
 * boot: the record is an observation, not a precondition.
 * @param stateRoot - the rescue state root.
 * @param state - the record to persist.
 * @returns the write failure, or `undefined` when it landed.
 */
export declare function writeBootState(stateRoot: string, state: BootState): string | undefined;
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
export declare function classifyCrash(text: string): CrashReason;
/**
 * The concrete next step for one crash class.
 * @param reason - the class from {@link classifyCrash}.
 * @returns one line naming what to do, or an empty string when nothing is known.
 */
export declare function crashAdvice(reason: CrashReason): string;
/**
 * Read the boot history and classify a failure from whatever captured output
 * exists, preferring the most recent incident over the last raw boot log.
 * @param stateRoot - the rescue state root.
 * @returns the boot report, with `crashed` false when the last run finished.
 */
export declare function readBootReport(stateRoot?: string): BootReport;
/**
 * Diagnose the deployment without booting it.
 * @param options - plane override, target profile, and search directories.
 * @returns the complete report; never throws for a broken deployment.
 */
export declare function runDoctor(options?: DoctorOptions): Promise<DoctorReport>;
/** The highest severity present in a report, for exit codes and banners. */
export declare function worstLevel(report: DoctorReport): 'error' | 'warn' | 'info';
/**
 * Whether a path is a directory holding at least one entry.
 * @param path - the directory to test.
 * @returns true when it is a non-empty directory.
 */
export declare function hasEntries(path: string): boolean;
