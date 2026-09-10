/**
 * The rescue runner row.
 *
 * One plugin row, mounted by the rescue composition, that creates a single agent
 * through the core registry and drives it — one-shot for a mission string, or as
 * a line-oriented REPL when the human is sitting at the terminal. It streams the
 * assistant's text so the human can watch the repair happen, and prints a compact
 * tool-activity list after every turn so a silent model cannot look productive.
 *
 * Loaded by absolute file URL, so its bare imports resolve through the rescue
 * package's own `@deepseek-ai` scope link to the deployment plane.
 * @module @dsh-external/dsh-rescue/runner
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Stable Cordis plugin name. */
export declare const name = "rescue-runner";
/** Core services required before a rescue turn can start. */
export declare const inject: string[];
/** Plugin config, supplied by the launcher per run. */
export interface Config {
    /** One-shot mission text; when absent the runner opens a REPL. */
    task?: string;
    /** Provider override for the repair agent. */
    provider?: string;
    /** Model override for the repair agent. */
    model?: string;
    /** Directory this run writes its transcript and report into. */
    runDir: string;
    /** Command the human can run to verify a repair, quoted in the banner. */
    verifyCommand: string;
    /** Absolute path of the mission text, for the REPL `/mission` command. */
    missionPath: string;
    /** The exact mission text, handed to the agent as its first user message. */
    mission: string;
}
export declare const Config: z<Config>;
/**
 * Mount the rescue runner.
 * @param ctx - plugin context carrying the core services and the launcher's exit request.
 * @param config - validated run configuration.
 */
export declare function apply(ctx: Context, config: Config): void;
