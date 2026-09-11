/**
 * The mechanically provable repairs.
 *
 * Two failure classes have an unambiguous minimal fix, and both are repairs the
 * launcher itself makes unavoidable:
 *
 * - an **inserted row** whose package does not resolve — disabling that row in
 *   the profile's own patch layer removes it from the tree without deleting
 *   anything, and works whether the insert came from the profile or a bundle
 *   below it;
 * - a **bundle** the launcher cannot mount — the bundle layer has no disable
 *   switch at all, so the only mechanical repair is dropping its name from
 *   `dsh.profile.bundles`. The package stays installed and its dependency entry
 *   stays in place, so reinstalling or repairing it later is a one-line restore.
 *
 * Everything else needs a human decision — which duplicate insert to keep, which
 * package to reinstall — so it is reported, not guessed at.
 *
 * Two invariants hold for every write: the candidate text is proved parseable
 * before it lands (a patch layer or manifest that cannot be parsed refuses the
 * whole tree), and each overwritten file is backed up beside itself. The caller
 * can roll every write of one run back as a unit.
 * @module @dsh-external/dsh-rescue/repair
 */
/** This package's own name: the one bundle a mechanical repair must never drop. */
export declare const RESCUE_PACKAGE_NAME = "@dsh-external/dsh-rescue";
/** What one mechanical pass did. */
export interface RepairOutcome {
    /** One line per applied change. */
    applied: string[];
    /** One line per change the pass refused to make, with the reason. */
    skipped: string[];
    /** Restore every file this pass wrote, as a unit. */
    rollback: () => void;
}
/** Options for {@link applyMechanicalFixes}. */
export interface RepairOptions {
    /** Profile to repair. */
    profile: string;
    /** Explicit deployment plane, from `--plane`. */
    plane?: string;
    /** Report what would change without writing. */
    dryRun: boolean;
}
/**
 * Parse a candidate patch file with the Loader's own dialect.
 * @param plane - explicit plane from the command line, when given.
 * @param content - the candidate file text.
 * @returns true when the text parses as a top-level array of patch entries.
 */
export declare function patchListParses(plane: string | undefined, content: string): boolean;
/**
 * Apply every repair this package can prove is correct.
 * @param options - target profile, optional plane, and dry-run flag.
 * @returns what was applied, what was refused, and a unit rollback.
 */
export declare function applyMechanicalFixes(options: RepairOptions): Promise<RepairOutcome>;
