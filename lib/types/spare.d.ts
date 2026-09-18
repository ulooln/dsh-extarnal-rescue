/**
 * A spare deployment plane: a second, independent module root that can boot the
 * rescue when the deployment's own install is the thing that broke.
 *
 * An upgrade is the case this exists for. Upgrading rewrites the very
 * `node_modules` the rescue would boot from, so a rescue that only ever reads the
 * install under repair can be taken down by the same upgrade it is meant to
 * survive. A spare plane is built while the install is still healthy and is then
 * pointed at with `--plane`.
 *
 * Two modes, and the difference is the whole point: links follow the source
 * packages, so they survive profile and composition damage but not the packages
 * themselves being replaced; a copy is physically independent and costs the
 * source's full size.
 * @module @dsh-external/dsh-rescue/spare
 */
import type { PlaneInfo } from './types.ts';
/** How a spare plane is materialized. */
export type SpareMode = 'links' | 'copy';
/** What building a spare plane produced. */
export interface SpareResult {
    /** The spare plane's own path. */
    dest: string;
    /** Where the packages came from. */
    source: string;
    /** How the spare was materialized. */
    mode: SpareMode;
    /** Entries linked or copied into the spare. */
    entries: number;
    /** Source entries that could not be materialized, with the reason. */
    skipped: string[];
    /** The spare as the rest of the rescue sees it. */
    plane: PlaneInfo;
}
/** What an existing spare plane looks like now. */
export interface SpareInspection {
    /** Whether the directory exists at all. */
    exists: boolean;
    /** Whether the spare still carries a complete package set. */
    plane: PlaneInfo;
    /** Entries the spare lists. */
    entries: number;
    /** Entries whose target no longer resolves. */
    dangling: string[];
}
/**
 * Materialize a spare plane from an existing one.
 *
 * Every scope is walked one level deep and every package is linked individually:
 * linking a whole scope directory would make one unreadable package hide all its
 * siblings, and the point of a spare is that it works when something else did not.
 *
 * Refreshing is idempotent. An entry already pointing where it should is left
 * alone, because replacing a link that still resolves would rewrite the spare for
 * no reason, and a spare that is being rebuilt is often the one currently booting
 * a rescue.
 * @param source - the plane to copy or link from.
 * @param dest - the spare plane's path.
 * @param mode - `links` to follow the source packages, `copy` to be independent.
 * @returns what the spare now holds.
 * @throws when the destination cannot be created.
 */
export declare function buildSparePlane(source: string, dest: string, mode?: SpareMode): SpareResult;
/**
 * Report what a spare plane looks like now, without repairing it.
 * @param dest - the spare plane's path.
 * @returns its usability, size in entries, and any entry that no longer resolves.
 */
export declare function inspectSparePlane(dest: string): SpareInspection;
/**
 * Total bytes of a spare plane's packages, for reporting what a copy costs.
 * Symlinked entries are measured through the link, so a linked spare reports the
 * size it borrows rather than the size it owns.
 * @param root - the plane or spare plane to measure.
 * @param limit - stop counting past this many entries, to bound the walk.
 * @returns the byte total and whether the walk stopped early.
 */
export declare function planeSize(root: string, limit?: number): {
    bytes: number;
    truncated: boolean;
};
