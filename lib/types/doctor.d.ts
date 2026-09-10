/**
 * Deterministic diagnosis of a harness deployment.
 *
 * The doctor never boots a plugin tree and never calls a model, so it still
 * produces an answer when the thing it is diagnosing cannot start at all. Every
 * finding carries the observation that produced it, and the report as a whole is
 * the input the repair agent reasons over.
 * @module @dsh-external/dsh-rescue/doctor
 */
import type { DoctorReport, Incident } from './types.ts';
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
