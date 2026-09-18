/**
 * Command-line parsing for `dsh-rescue`.
 *
 * Kept apart from the self-executing entry point so the grammar can be tested
 * directly: importing the CLI would otherwise run it.
 * @module @dsh-external/dsh-rescue/args
 */
import { resolve } from 'node:path';
import { defaultStateRoot } from "./launcher.js";
/** The commands the parser accepts. */
export const COMMANDS = new Set([
    'doctor', 'verify', 'fix', 'repair', 'supervise', 'shim', 'spare', 'help',
]);
export const USAGE = `dsh-rescue — repair a DeepSeek Harness deployment that will not start

Usage
  dsh-rescue doctor [--json]             diagnose without booting or calling a model
  dsh-rescue verify                      boot the target profile once and report the result
  dsh-rescue fix [--dry-run]             apply the mechanically provable repairs
  dsh-rescue repair [task...]            boot a minimal creation-mode agent and repair
  dsh-rescue supervise [-- <dsh args>]   run the target profile; on failure, fix it
  dsh-rescue shim                        install a short launcher under the harness home
  dsh-rescue spare [--check]             keep a second plane for use while upgrading

Options
  --plane <dir>            node_modules root to boot from (default: first usable)
  --profile <name>         profile to inspect, boot, or repair (default: web)
  --state-root <dir>       where rescue artifacts and redirected state live
                           (default: $DSH_HOME/rescue)
  --permission-mode <m>    read-only | workspace-write | danger-full-access
                           (default: danger-full-access — the repair target lies outside any workspace)
  --workspace <dir>        workspace root used by workspace-write
  --model <id>             model for the repair agent (default: the deployment's own route)
  --provider <id>          provider for the repair agent
  --no-llm                 stop after the deterministic pass; never call a model
  --dry-run                report what fix would change without writing
  --json                   machine-readable doctor output
  --timeout <ms>           how long a boot attempt may run before it counts as up (default: 25000)
  --from <dir>             spare: the plane to build from (default: first usable)
  --dest <dir>             spare: where the spare lives (default: <state-root>/plane)
  --copy                   spare: copy the packages instead of linking them
  -h, --help               this help

Exit codes
  0 ok    1 the repair agent reported a failure    2 no usable deployment plane
  3 the rescue tree could not boot                 4 the target profile did not come up
  5 nothing was mechanically fixable               6 the spare plane is missing or incomplete
`;
/** Read one option value, failing loudly on a missing operand. */
function value(args, index, name) {
    const next = args[index + 1];
    if (next === undefined || next.startsWith('--'))
        throw new Error(`${name} requires a value`);
    return next;
}
/**
 * Parse the command line.
 * @param args - `process.argv.slice(2)`.
 * @returns the resolved invocation.
 * @throws when an option is malformed.
 */
export function parseArgs(args) {
    const invocation = {
        command: 'help',
        profile: 'web',
        permissionMode: 'danger-full-access',
        stateRoot: defaultStateRoot(),
        json: false,
        noLlm: false,
        dryRun: false,
        timeoutMs: 25_000,
        args: [],
        dest: '',
        copy: false,
        check: false,
    };
    const rest = [];
    let command;
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === undefined)
            continue;
        if (arg === '--') {
            invocation.args = args.slice(index + 1);
            break;
        }
        if (arg === '-h' || arg === '--help')
            return { ...invocation, command: 'help' };
        if (arg === '--json') {
            invocation.json = true;
            continue;
        }
        if (arg === '--no-llm') {
            invocation.noLlm = true;
            continue;
        }
        if (arg === '--dry-run') {
            invocation.dryRun = true;
            continue;
        }
        if (arg === '--copy') {
            invocation.copy = true;
            continue;
        }
        if (arg === '--check') {
            invocation.check = true;
            continue;
        }
        if (arg === '--plane') {
            invocation.plane = value(args, index, arg);
            index++;
            continue;
        }
        if (arg === '--profile') {
            invocation.profile = value(args, index, arg);
            index++;
            continue;
        }
        if (arg === '--state-root') {
            invocation.stateRoot = resolve(value(args, index, arg));
            index++;
            continue;
        }
        if (arg === '--from') {
            invocation.from = resolve(value(args, index, arg));
            index++;
            continue;
        }
        if (arg === '--dest') {
            invocation.dest = resolve(value(args, index, arg));
            index++;
            continue;
        }
        if (arg === '--workspace') {
            invocation.workspace = resolve(value(args, index, arg));
            index++;
            continue;
        }
        if (arg === '--model') {
            invocation.model = value(args, index, arg);
            index++;
            continue;
        }
        if (arg === '--provider') {
            invocation.provider = value(args, index, arg);
            index++;
            continue;
        }
        if (arg === '--timeout') {
            const raw = value(args, index, arg);
            const ms = Number(raw);
            if (!Number.isFinite(ms) || ms <= 0)
                throw new Error(`--timeout must be a positive number of milliseconds (got ${raw})`);
            invocation.timeoutMs = ms;
            index++;
            continue;
        }
        if (arg === '--permission-mode') {
            const mode = value(args, index, arg);
            if (mode !== 'read-only' && mode !== 'workspace-write' && mode !== 'danger-full-access') {
                throw new Error(`--permission-mode must be read-only, workspace-write, or danger-full-access (got ${mode})`);
            }
            invocation.permissionMode = mode;
            index++;
            continue;
        }
        if (arg.startsWith('--'))
            throw new Error(`unknown option ${arg}`);
        if (command === undefined) {
            if (!COMMANDS.has(arg))
                throw new Error(`unknown command ${arg}; run dsh-rescue --help`);
            command = arg;
            continue;
        }
        rest.push(arg);
    }
    if (command === 'repair' && rest.length > 0)
        invocation.task = rest.join(' ');
    if (command === 'supervise' && invocation.args.length === 0 && rest.length > 0)
        invocation.args = rest;
    return { ...invocation, command: command ?? 'repair' };
}
//# sourceMappingURL=args.js.map