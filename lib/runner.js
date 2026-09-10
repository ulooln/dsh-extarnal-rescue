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
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionSeq } from '@deepseek-ai/dsh-session';
import z from '@deepseek-ai/schemastery';
/** Stable Cordis plugin name. */
export const name = 'rescue-runner';
/** Core services required before a rescue turn can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions'];
export const Config = z.object({
    task: z.string(),
    provider: z.string(),
    model: z.string(),
    runDir: z.string().required(),
    verifyCommand: z.string().required(),
    missionPath: z.string().required(),
    mission: z.string().required(),
});
/** Where the runner writes its transcript. */
function transcriptPath(config) {
    return join(config.runDir, 'transcript.txt');
}
/** Append to the transcript and echo to the terminal. */
function say(config, text) {
    try {
        appendFileSync(transcriptPath(config), text);
    }
    catch {
        // A transcript that cannot be written must not stop the repair: the durable
        // session log under $DSH_HOME/sessions is the authoritative record.
    }
    process.stdout.write(text);
}
/** Report a runner failure on stderr and request a failing exit. */
function fail(exit, config, error) {
    const text = `dsh-rescue: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`;
    try {
        appendFileSync(transcriptPath(config), text);
    }
    catch {
        // See `say`.
    }
    process.stderr.write(text);
    exit(1);
}
/** First line of a raw tool-argument JSON string, clipped for display. */
function firstLine(raw) {
    const line = raw.split(/\r?\n/).find(candidate => candidate.trim() !== '') ?? '';
    return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}
/**
 * Summarize the tool calls committed between two log offsets.
 * @param session - the agent's session log.
 * @param from - first sequence number to read.
 * @returns one row per tool call, with failure state from its paired result.
 */
function readToolActivity(session, from) {
    const tools = [];
    const pending = new Map();
    for (let seq = from; seq < session.seq; seq++) {
        const event = session.eventAt(SessionSeq(seq));
        if (event === undefined)
            continue;
        if (event.type === 'tool/call') {
            pending.set(String(event.data.callId), tools.length);
            tools.push({ name: event.data.name, detail: firstLine(event.data.arguments), failed: false });
            continue;
        }
        if (event.type === 'tool/result') {
            const index = pending.get(String(event.data.message.content[0]?.toolCallId ?? ''));
            if (index === undefined)
                continue;
            const activity = tools[index];
            if (activity !== undefined) {
                activity.failed = event.data.error !== undefined || event.data.message.content[0]?.isError === true;
            }
        }
    }
    return tools;
}
/** Flatten an error and its cause chain into one line. */
function describeError(error) {
    const parts = [];
    let current = error;
    for (let depth = 0; depth < 6 && current !== undefined && current !== null; depth++) {
        if (current instanceof Error) {
            parts.push(current.message);
            current = current.cause;
            continue;
        }
        if (typeof current === 'object' && typeof current.message === 'string') {
            parts.push(current.message);
            current = current.cause;
            continue;
        }
        parts.push(String(current));
        break;
    }
    return parts.join(' <- ');
}
/** Read the last turn's end reason, including the error that ended it. */
function lastTurnOutcome(session) {
    for (let seq = session.seq - 1; seq >= 0; seq--) {
        const event = session.eventAt(SessionSeq(seq));
        if (event === undefined)
            continue;
        if (event.type !== 'turn/end')
            continue;
        const reason = event.data.reason;
        if (reason.kind === 'completed')
            return { kind: 'completed' };
        if (reason.kind === 'error') {
            return { kind: 'error', message: `${reason.error.code}: ${describeError(reason.error)}` };
        }
        return { kind: 'other' };
    }
    return { kind: 'other' };
}
/**
 * Stream what the agent is doing: assistant text on stdout as it arrives, and one
 * line per tool call the moment it is committed to the session log.
 *
 * A repair is a long, mostly silent stretch of tool calls; printing each one as
 * it starts is what keeps a human able to tell progress from a hang.
 * @param ctx - plugin context carrying the assistant stream and session firehose.
 * @param agent - the exact agent this run owns.
 * @param config - run configuration holding the transcript path.
 * @returns a disposer that closes an unterminated line.
 */
function streamActivity(ctx, agent, config) {
    let open = false;
    const close = () => {
        if (!open)
            return;
        say(config, '\n');
        open = false;
    };
    const disposeStream = ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
        if (subject !== agent)
            return;
        if (frame.type === 'start' || frame.type === 'end') {
            close();
            return;
        }
        const chunk = frame.chunk;
        if (chunk.type === 'text-delta') {
            if (chunk.text === '')
                return;
            open = true;
            say(config, chunk.text);
            return;
        }
        if (chunk.type === 'reasoning-delta') {
            // Reasoning stays on stderr so a redirected stdout transcript holds only
            // what the human and the final report need.
            process.stderr.write(chunk.text);
            return;
        }
        if (chunk.type === 'block-start' || chunk.type === 'block-end' || chunk.type === 'tool-call-delta')
            close();
    });
    const disposeEvents = ctx.on('session/event', (session, event) => {
        if (session !== agent.session)
            return;
        if (event.type !== 'tool/call')
            return;
        close();
        say(config, `  -> ${event.data.name}  ${firstLine(event.data.arguments)}\n`);
    });
    return () => {
        disposeStream();
        disposeEvents();
        close();
    };
}
/** Send one message, wait for quiescence, and report what the turn did. */
async function turn(agent, config, message, cursor) {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: message }], source: { kind: 'user' } }));
    await agent.whenIdle();
    // Successful calls already streamed as they started; only failures need a
    // second line, because a failure is the thing a reader must not miss.
    const failed = readToolActivity(agent.session, cursor).filter(activity => activity.failed);
    for (const activity of failed)
        say(config, `  FAIL ${activity.name}  ${activity.detail}\n`);
    const outcome = lastTurnOutcome(agent.session);
    if (outcome.kind === 'error')
        say(config, `\nturn failed — ${outcome.message ?? 'unknown error'}\n`);
    return outcome;
}
/** Print the banner the human reads before the first turn. */
function banner(agent, config, selection) {
    say(config, [
        '',
        '='.repeat(72),
        ' DSH RESCUE AGENT',
        '='.repeat(72),
        ` model       ${selection.provider}/${selection.model}`,
        ` session     ${String(agent.session.header.id)}`,
        ` workspace   ${agent.session.header.cwd ?? process.cwd()}`,
        ` mission     ${config.missionPath}`,
        ` transcript  ${transcriptPath(config)}`,
        ` verify with ${config.verifyCommand}`,
        '='.repeat(72),
        '',
    ].join('\n'));
}
/** Commands the interactive REPL understands. */
const REPL_HELP = 'commands: /mission  reprint the mission  |  /doctor  print the diagnosis path  |  /help  this list  |  /exit  leave\n';
/** Drive one interactive session until the human leaves or stdin closes. */
async function repl(agent, config, cursor) {
    const readline = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });
    say(config, REPL_HELP);
    let current = cursor;
    let code = 0;
    try {
        while (true) {
            const line = await new Promise((resolveLine) => {
                let answered = false;
                readline.question('rescue> ', (answer) => {
                    answered = true;
                    resolveLine(answer);
                });
                readline.once('close', () => {
                    if (!answered)
                        resolveLine(undefined);
                });
            });
            if (line === undefined)
                break;
            const trimmed = line.trim();
            if (trimmed === '')
                continue;
            if (trimmed === '/exit' || trimmed === '/quit')
                break;
            if (trimmed === '/help') {
                say(config, REPL_HELP);
                continue;
            }
            if (trimmed === '/mission') {
                say(config, `\n${config.mission}\n`);
                continue;
            }
            if (trimmed === '/doctor') {
                say(config, `diagnosis: ${join(config.runDir, 'doctor.txt')}\n`);
                continue;
            }
            const reason = await turn(agent, config, trimmed, current);
            current = agent.session.seq;
            if (reason.kind === 'error')
                code = 1;
        }
    }
    finally {
        readline.close();
    }
    return code;
}
/**
 * Verify that a model request can be assembled before the first turn.
 *
 * DeepSeek requests carry extension fields prepared from the live runtime, so a
 * deployment whose plugin inventory cannot resolve an active row fails every
 * request with an opaque `REQUEST_EXTENSION`. Running the same preparation once,
 * with no network traffic, turns that into a precise message the human can act
 * on and keeps the failure out of the middle of a repair.
 * @param ctx - plugin context carrying the extension registry.
 * @param config - run configuration holding the transcript path.
 */
async function preflight(ctx, config) {
    const extensions = ctx.get('deepseekLlmApiExtensions');
    if (extensions === undefined)
        return;
    try {
        await extensions.prepare({ body: { messages: [] }, signal: AbortSignal.timeout(30_000) });
    }
    catch (error) {
        say(config, `preflight: a model request cannot be assembled — ${describeError(error)}\n`);
        say(config, 'preflight: the repair agent will still run; expect every turn to fail until this is fixed.\n');
    }
}
/**
 * Mount the rescue runner.
 * @param ctx - plugin context carrying the core services and the launcher's exit request.
 * @param config - validated run configuration.
 */
export function apply(ctx, config) {
    const exit = ctx.get('appExit');
    if (exit === undefined)
        throw new Error('rescue-runner: the launcher must provide appExit before the tree mounts');
    try {
        mkdirSync(config.runDir, { recursive: true });
        writeFileSync(config.missionPath, config.mission);
    }
    catch (error) {
        fail(exit, config, error);
        return;
    }
    void run(ctx, config, exit).catch((error) => { fail(exit, config, error); });
}
/** Create the agent, run the mission, and request process exit. */
async function run(ctx, config, exit) {
    // Siblings mount concurrently; wait for the whole application before creating
    // an agent so its scoped tools and adapters are not half-composed.
    const loader = ctx.get('loader');
    await loader?.await();
    const agents = ctx.get('agents');
    const defaultModel = ctx.get('agentDefaultModel');
    const sessions = ctx.get('sessions');
    if (agents === undefined || defaultModel === undefined || sessions === undefined) {
        throw new Error('rescue-runner: the rescue tree is missing agents, agentDefaultModel, or sessions');
    }
    const base = defaultModel.currentSelection();
    const selection = { ...base, provider: config.provider ?? base.provider, model: config.model ?? base.model };
    const { agent } = await agents.create({
        sessionId: `session-${randomUUID()}`,
        meta: { cwd: process.cwd() },
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: (agentCtx) => {
            const selected = { current: selection, assembled: undefined };
            installModelSelection(agentCtx, selected);
        },
    });
    await agent.whenIdle();
    banner(agent, config, selection);
    await preflight(ctx, config);
    const firstSeq = agent.session.seq;
    const stopStream = streamActivity(ctx, agent, config);
    let code = 0;
    try {
        if (config.task !== undefined && config.task.trim() !== '') {
            if ((await turn(agent, config, config.task, firstSeq)).kind === 'error')
                code = 1;
        }
        else {
            say(config, `${config.mission}\n`);
            code = await repl(agent, config, firstSeq);
        }
    }
    finally {
        stopStream();
    }
    await sessions.flush(agent.session);
    exit(code);
}
//# sourceMappingURL=runner.js.map