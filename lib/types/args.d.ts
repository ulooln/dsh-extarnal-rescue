/**
 * Command-line parsing for `dsh-rescue`.
 *
 * Kept apart from the self-executing entry point so the grammar can be tested
 * directly: importing the CLI would otherwise run it.
 * @module @dsh-external/dsh-rescue/args
 */
import type { PermissionMode } from './launcher.ts';
/** Parsed command line. */
export interface Invocation {
    command: 'doctor' | 'verify' | 'fix' | 'repair' | 'supervise' | 'shim' | 'spare' | 'help';
    plane?: string;
    profile: string;
    task?: string;
    provider?: string;
    model?: string;
    permissionMode: PermissionMode;
    workspace?: string;
    stateRoot: string;
    json: boolean;
    noLlm: boolean;
    dryRun: boolean;
    timeoutMs: number;
    args: string[];
    /** `spare`: the plane to build the spare from. */
    from?: string;
    /** `spare`: where the spare lives. */
    dest: string;
    /** `spare`: copy the packages instead of linking them. */
    copy: boolean;
    /** `spare`: report the existing spare instead of building one. */
    check: boolean;
}
/** The commands the parser accepts. */
export declare const COMMANDS: ReadonlySet<string>;
export declare const USAGE = "dsh-rescue \u2014 repair a DeepSeek Harness deployment that will not start\n\nUsage\n  dsh-rescue doctor [--json]             diagnose without booting or calling a model\n  dsh-rescue verify                      boot the target profile once and report the result\n  dsh-rescue fix [--dry-run]             apply the mechanically provable repairs\n  dsh-rescue repair [task...]            boot a minimal creation-mode agent and repair\n  dsh-rescue supervise [-- <dsh args>]   run the target profile; on failure, fix it\n  dsh-rescue shim                        install a short launcher under the harness home\n  dsh-rescue spare [--check]             keep a second plane for use while upgrading\n\nOptions\n  --plane <dir>            node_modules root to boot from (default: first usable)\n  --profile <name>         profile to inspect, boot, or repair (default: web)\n  --state-root <dir>       where rescue artifacts and redirected state live\n                           (default: $DSH_HOME/rescue)\n  --permission-mode <m>    read-only | workspace-write | danger-full-access\n                           (default: danger-full-access \u2014 the repair target lies outside any workspace)\n  --workspace <dir>        workspace root used by workspace-write\n  --model <id>             model for the repair agent (default: the deployment's own route)\n  --provider <id>          provider for the repair agent\n  --no-llm                 stop after the deterministic pass; never call a model\n  --dry-run                report what fix would change without writing\n  --json                   machine-readable doctor output\n  --timeout <ms>           how long a boot attempt may run before it counts as up (default: 25000)\n  --from <dir>             spare: the plane to build from (default: first usable)\n  --dest <dir>             spare: where the spare lives (default: <state-root>/plane)\n  --copy                   spare: copy the packages instead of linking them\n  -h, --help               this help\n\nExit codes\n  0 ok    1 the repair agent reported a failure    2 no usable deployment plane\n  3 the rescue tree could not boot                 4 the target profile did not come up\n  5 nothing was mechanically fixable               6 the spare plane is missing or incomplete\n";
/**
 * Parse the command line.
 * @param args - `process.argv.slice(2)`.
 * @returns the resolved invocation.
 * @throws when an option is malformed.
 */
export declare function parseArgs(args: readonly string[]): Invocation;
