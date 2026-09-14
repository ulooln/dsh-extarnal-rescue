/**
 * Compatibility between the rescue composition and the deployment it is rescuing.
 *
 * The rescue layer overrides rows of the deployment's own `dsh-base` bundle by id.
 * A patch that targets a row the deployment no longer provides is not an error in
 * the Loader: it warns and applies nothing. That is the dangerous case, because
 * the rescue would still start, and would quietly lose the permissions it needs
 * to write outside any workspace while its approval policy fell back to one that
 * fails closed with no answerer attached. An agent that cannot write cannot
 * repair, and nothing in its output would say why.
 *
 * This module turns that silence into a named finding, before the tree boots, and
 * a hard check, after it does.
 * @module @dsh-external/dsh-rescue/compat
 */
import type { CompositionDiff, RescueCompatibility } from './types.ts';
/** Row ids this rescue layer overrides in the deployment's base bundle. */
export declare const RESCUE_OVERRIDES: readonly ["system-prompt", "sandbox-policy", "approval", "session-telemetry-otel", "session-persistence-jsonl", "storage-json", "attachment-local", "skill-filesystem"];
/** Row ids this rescue layer inserts. */
export declare const RESCUE_INSERTS: readonly ["cordis-host-runner", "tool-cordis"];
/**
 * Overrides whose disappearance stops the rescue from being able to repair.
 * Losing a permission row is not a cosmetic degradation: with the base defaults
 * the agent is confined to the working directory and its approval requests have
 * no answerer, so every write fails.
 */
export declare const CRITICAL_OVERRIDES: readonly string[];
/**
 * Compare the rows a rescue layer addresses with the rows the deployment provides.
 *
 * Pure on purpose: the judgement is what needs testing, and it does not need a
 * harness install to be exercised.
 * @param baseRowIds - every row id the deployment's base bundle provides.
 * @param rescueTargets - the ids the rescue layer patches.
 * @param rescueInserts - the ids the rescue layer inserts.
 * @returns the differences, with the repair-blocking ones called out.
 */
export declare function diffComposition(baseRowIds: readonly string[], rescueTargets: readonly string[], rescueInserts: readonly string[]): CompositionDiff;
/**
 * Check the rescue composition against a deployment plane.
 *
 * Returns a result even when it cannot run the comparison (a plane without the
 * boot glue), because "cannot tell" is itself something the doctor must report.
 * @param planeRoot - the plane's node_modules root.
 * @param packageDir - this package's directory, holding `rescue.cordis.yml`.
 * @returns the compatibility picture.
 */
export declare function checkRescueCompatibility(planeRoot: string, packageDir?: string): Promise<RescueCompatibility>;
/**
 * Verify that the overrides the rescue depends on actually took effect.
 *
 * Runs after the tree boots, because the preflight compares text and this
 * compares the mounted tree. The resolved config lives on the fiber — an entry's
 * `options.config` still holds the unevaluated `!!js` expressions — so both are
 * read, fiber first.
 *
 * The rule for refusing is deliberately narrow: a row that is absent, or a
 * resolved scalar that differs from what was asked for, is a definite failure. A
 * value this code cannot interpret means the Loader's internals differ from what
 * this check assumes, which is a reason to warn rather than to deny a working
 * deployment its rescue.
 * @param loaderEntries - the settled Loader's entries.
 * @param expectations - the config values the rescue asked for.
 * @returns the rows whose override definitely did not take effect, and the ones
 * whose state could not be confirmed.
 */
export declare function verifyMountedOverrides(loaderEntries: readonly MountedEntry[], expectations: {
    permissionMode: string;
    approvalPolicy: string;
}): {
    blocking: string[];
    cosmetic: string[];
};
/** One Loader entry, as far as this check reads it. */
export interface MountedEntry {
    options?: {
        id?: unknown;
        config?: unknown;
    };
    fiber?: {
        config?: unknown;
    };
}
