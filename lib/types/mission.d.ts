/**
 * The rescue agent's prompt material: its persona, its mission, and the
 * evidence block that carries the exact failure into the conversation.
 *
 * The mission is built from the same {@link DoctorReport} the human sees, plus
 * the verbatim captured output of the failed boot, so the agent never has to
 * guess what went wrong or re-discover it.
 * @module @dsh-external/dsh-rescue/mission
 */
import type { DoctorReport } from './types.ts';
/** Where the rescue run's paths point, quoted verbatim into the mission. */
export interface MissionContext {
    report: DoctorReport;
    /** Profile the run targets. */
    profile: string;
    /** Absolute node_modules root the rescue booted from. */
    planeRoot: string;
    /** Absolute harness checkout, when one was found. */
    checkout?: string;
    /** Exact command that restores a healthy boot, for the agent to verify with. */
    verifyCommand: string;
    /** Directory holding this run's artifacts. */
    runDir: string;
}
/** The persona the rescue agent runs under: creation-mode access, rescue mission. */
export declare const RESCUE_PERSONA: string;
/**
 * Build the first user message for a rescue run.
 * @param context - the report, paths, and the verification command.
 * @param task - the human's own instruction, appended when one was given.
 * @returns the mission text.
 */
export declare function buildMission(context: MissionContext, task?: string): string;
