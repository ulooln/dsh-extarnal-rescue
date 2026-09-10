/**
 * Rendering of a {@link DoctorReport} for a terminal and for the repair agent.
 * Both views come from the same report, so the human and the model never
 * disagree about what was observed.
 * @module @dsh-external/dsh-rescue/report
 */
import type { DoctorReport } from './types.ts';
/**
 * Render the report as the text a human reads after `dsh-rescue doctor`.
 * @param report - the diagnosis.
 * @returns a multi-line report ending in one newline.
 */
export declare function renderReport(report: DoctorReport): string;
/**
 * Render the same report as the machine-readable JSON a script or the repair
 * agent consumes.
 * @param report - the diagnosis.
 * @returns pretty-printed JSON ending in one newline.
 */
export declare function renderJson(report: DoctorReport): string;
