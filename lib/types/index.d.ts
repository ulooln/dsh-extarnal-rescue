/**
 * The in-process half of the rescue: three model-callable tools that let a
 * healthy session inspect the deployment, record a handoff for a future rescue,
 * and launch the standalone rescue agent as a separate process.
 *
 * This half cannot help when the harness is already down — that is what
 * `lib/cli.js` is for. What it does is make the rescue reachable *before* the
 * damage: check the deployment, write down what you were doing, and start a
 * repair agent that outlives this process.
 * @module @dsh-external/dsh-rescue
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Stable Cordis plugin name. */
export declare const name = "@dsh-external/dsh-rescue";
/** The tool registry is the only hard dependency. */
export declare const inject: string[];
/** Bundle configuration. */
export interface Config {
    /** Profile these tools inspect and hand off to. */
    profile: string;
    /** Where rescue artifacts live; defaults to `$DSH_HOME/rescue`. */
    stateRoot?: string;
    /** Write the short launcher shim under the state root on mount. */
    installShim: boolean;
}
export declare const Config: z<Config>;
/**
 * Mount the rescue tools.
 * @param ctx - plugin context carrying the tool registry.
 * @param config - bundle configuration.
 */
export declare function apply(ctx: Context, config: Config): void;
