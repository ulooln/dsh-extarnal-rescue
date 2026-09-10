/**
 * The rescue agent's prompt material: its persona, its mission, and the
 * evidence block that carries the exact failure into the conversation.
 *
 * The mission is built from the same {@link DoctorReport} the human sees, plus
 * the verbatim captured output of the failed boot, so the agent never has to
 * guess what went wrong or re-discover it.
 * @module @dsh-external/dsh-rescue/mission
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderReport } from "./report.js";
/** The persona the rescue agent runs under: creation-mode access, rescue mission. */
export const RESCUE_PERSONA = [
    'You are the DeepSeek Harness rescue agent, running on the {{model}} model. Your working directory is {{cwd}}.',
    '',
    'You exist because the harness itself would not start. You are running from an independent deployment plane, not from the profile composition that failed, so the thing that broke cannot stop you. Your job is to restore a normal harness boot and to prove it by actually booting one.',
    '',
    'You can read and modify the harness you run on. Its composition is Cordis: every capability is a plugin row in a `cordis.yml`, and an agent preset is one such file mounted for a single session.',
    '',
    'Two planes decide where an edit belongs. The HOST composition holds the registries and anything shared across sessions — persistence, the sandbox and approval stack, the model route, the subagent registry and its backends. An AGENT PRESET holds what one session contributes to those registries: its tools, its persona, its prompt sections.',
    '',
    'Presets you author live one directory per preset under `${DSH_HOME:-$HOME/.dsh}/.agent-presets/<id>/`. NEVER edit or delete the shipped preset install (the `agent-presets` directory beside the deployment\'s own config): it belongs to the deployment and an upgrade overwrites it.',
    '',
    'Load the `editing-cordis-compositions` skill before writing or changing a composition, and the `rescue-repair-playbook` skill for this deployment\'s failure modes and their fixes.',
    '',
    'Rules for this job. Work from the evidence in the mission, not from speculation. Prefer the smallest change that restores boot; disabling one offending row beats rewriting a composition. Back up every file before you edit it, and never delete user data, sessions, credentials, or settings. Do not edit the harness source to work around a configuration error. Verify with the exact command in the mission and report what it printed — a fix you have not booted is not a fix.',
].join('\n');
/** Render one captured incident as the evidence block the agent reads verbatim. */
function incidentBlock(incident) {
    if (incident === undefined) {
        return [
            'No boot failure has been captured in this deployment.',
            'If the failure is reproducible, ask the human to run `dsh-rescue verify` or `dsh-rescue supervise` so its exact output is recorded, then work from the static findings below.',
        ].join('\n');
    }
    return [
        `captured at   ${incident.at}`,
        `command       ${incident.command}`,
        `cwd           ${incident.cwd}`,
        `exit code     ${incident.exitCode === null ? 'signal or timeout' : String(incident.exitCode)}`,
        `duration      ${String(incident.durationMs)}ms`,
        `reached ready ${incident.booted ? 'yes' : 'no'}`,
        incident.dir === undefined ? '' : `full capture  ${incident.dir}`,
        '',
        'recognised diagnostics:',
        incident.signals.length === 0 ? '  (none recognised — read the raw output below)' : incident.signals.map(line => `  ${line}`).join('\n'),
        '',
        'verbatim output (stdout then stderr, unabridged):',
        '```',
        incident.output.trim() === '' ? '(no output)' : incident.output.trimEnd(),
        '```',
    ].filter(line => line !== '').join('\n');
}
/**
 * Read the handoff a previous session left before the deployment broke.
 * @param harnessHome - the harness home holding the rescue state.
 * @returns the handoff text, or `undefined` when none was recorded.
 */
function readHandoff(harnessHome) {
    const path = join(harnessHome, 'rescue', 'handoff.md');
    if (!existsSync(path))
        return undefined;
    try {
        const text = readFileSync(path, 'utf8');
        return text.trim() === '' ? undefined : text;
    }
    catch {
        // An unreadable handoff is not worth failing the rescue over.
        return undefined;
    }
}
/**
 * Build the first user message for a rescue run.
 * @param context - the report, paths, and the verification command.
 * @param task - the human's own instruction, appended when one was given.
 * @returns the mission text.
 */
export function buildMission(context, task) {
    const { report, profile, planeRoot, checkout, verifyCommand, runDir } = context;
    const sections = [];
    sections.push([
        '# Rescue mission',
        '',
        `The DeepSeek Harness deployment at \`${report.dshHome}\` would not start normally on profile \`${profile}\`.`,
        'Restore a normal boot, verify it, and report. Everything you need to know is below; do not re-derive it.',
    ].join('\n'));
    sections.push([
        '## The failure',
        '',
        incidentBlock(report.incident),
    ].join('\n'));
    const handoff = readHandoff(report.dshHome);
    if (handoff !== undefined) {
        sections.push([
            '## Handoff left by the session that broke it',
            '',
            '```',
            handoff.trimEnd(),
            '```',
        ].join('\n'));
    }
    sections.push([
        '## Where things are',
        '',
        `harness home        ${report.dshHome}`,
        `profiles            ${report.dshHome}${process.platform === 'win32' ? '\\' : '/'}profiles`,
        `target profile      ${profile}`,
        `rescue plane        ${planeRoot}   (the rescue itself boots from here)`,
        checkout === undefined ? 'source checkout     (not found from the current directory)' : `source checkout     ${checkout}`,
        `this run's files    ${runDir}`,
        `your report file    ${join(runDir, 'report.md')}`,
        '',
        `Verify a fix with:  ${verifyCommand}`,
        'Success means that command exits 0 without a load-failure diagnostic. A boot that still prints "plugin(s) failed to load", "did not activate", or a parse error is still broken.',
    ].join('\n'));
    sections.push([
        '## Static diagnosis',
        '',
        '```',
        renderReport(report).trimEnd(),
        '```',
    ].join('\n'));
    sections.push([
        '## Playbook',
        '',
        '1. Trust the capture above. It is the exact output of a boot that failed moments ago, and it usually names the row, package, or file at fault. Re-running the verification command is optional confirmation, not the first step — and if the shell tool cannot spawn processes in this environment, do not burn turns trying to make it.',
        '2. Isolate. If the failure names a plugin row or a package, disable exactly that row in the profile\'s `cordis.patch.yml` with `- id: <row-id>` + `disabled: true`, then verify. If the profile is unusable because a bundle cannot resolve, fix the install or the link instead of disabling. A row the profile itself inserts is removed by deleting that insert from the same file.',
        '3. Repair the root cause. Prefer restoring a missing link, correcting a patch id, or removing a duplicated insert over rewriting a composition. Back up each file before editing it.',
        '4. Verify again, and only claim success on a clean boot. Quote the command and its output. If you could not run it, say so and give the edit precisely enough for the human to run it.',
        '5. Report at the end: what failed, what you changed, which files, what verification printed, and anything still at risk. Write that report to the report file named above as well as printing it.',
    ].join('\n'));
    sections.push([
        '## Boundaries',
        '',
        `- You have full file access on this machine because the repair target (${report.dshHome} and the harness checkout) lies outside any workspace. Every command you run is recorded in this session log; the human is watching the terminal.`,
        '- Never edit the shipped preset install, never delete sessions, credentials, or settings, and never edit harness source to mask a configuration error.',
        '- If you cannot restore the boot, say so plainly and leave the deployment in the least-broken state you found, with the evidence that rules out the causes you tested.',
    ].join('\n'));
    if (task !== undefined && task.trim() !== '') {
        sections.push(['## The human asked for', '', task.trim()].join('\n'));
    }
    return sections.join('\n\n') + '\n';
}
//# sourceMappingURL=mission.js.map