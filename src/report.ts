/**
 * Rendering of a {@link DoctorReport} for a terminal and for the repair agent.
 * Both views come from the same report, so the human and the model never
 * disagree about what was observed.
 * @module @dsh-external/dsh-rescue/report
 */

import type { DoctorReport, Finding, FindingLevel } from './types.ts'

/** One-character tag per severity, so a long list stays scannable. */
const LEVEL_TAG: Record<FindingLevel, string> = { error: 'ERR ', warn: 'WARN', info: 'INFO' }

/** Order findings most urgent first, keeping insertion order inside a level. */
function rank(findings: readonly Finding[]): Finding[] {
  const order: FindingLevel[] = ['error', 'warn', 'info']
  return [...findings].sort((left, right) => order.indexOf(left.level) - order.indexOf(right.level))
}

/**
 * Render the report as the text a human reads after `dsh-rescue doctor`.
 * @param report - the diagnosis.
 * @returns a multi-line report ending in one newline.
 */
export function renderReport(report: DoctorReport): string {
  const lines: string[] = []
  lines.push('DSH RESCUE — deployment diagnosis')
  lines.push('='.repeat(72))
  lines.push(`generated   ${report.generatedAt}`)
  lines.push(`node        ${report.node} (${report.platform}/${report.arch})`)
  lines.push(`harness home ${report.dshHome}`)
  lines.push(`cwd         ${report.cwd}`)
  if (report.targetProfile !== undefined) lines.push(`target      profile ${report.targetProfile}`)
  lines.push(`credentials ${report.credentials.deepseekKey ? 'DeepSeek key present' : 'NO DeepSeek key'} (${report.credentials.source})`)
  if (report.model !== undefined) lines.push(`model       ${report.model.provider}/${report.model.model} (${report.model.source})`)

  lines.push('')
  lines.push(`PLANES (${String(report.planes.length)})`)
  for (const plane of report.planes) {
    lines.push(`  ${plane.usable ? 'USABLE  ' : 'UNUSABLE'} ${plane.root}  [${plane.origin}${plane.version === undefined ? '' : `, dsh-base ${plane.version}`}]`)
    if (!plane.usable) lines.push(`           missing: ${plane.missing.join(', ')}`)
  }

  lines.push('')
  lines.push(`PROFILES (${String(report.profiles.length)})`)
  for (const profile of report.profiles) {
    lines.push(`  ${profile.name}  ${profile.dir}`)
    lines.push(`    manifest      ${profile.manifestOk ? 'ok' : `BROKEN — ${profile.manifestError ?? ''}`}`)
    lines.push(`    bundles       ${profile.bundles.length === 0 ? '(none)' : profile.bundles.map(bundle => `${bundle.name}${bundle.resolved ? '' : ' [UNRESOLVED]'}`).join(', ')}`)
    if (profile.links.length > 0) {
      lines.push(`    links         ${profile.links.map(link => `${link.name}${link.targetExists && link.installed && link.consistent ? '' : ' [BROKEN]'}`).join(', ')}`)
    }
    lines.push(`    patch layers  ${profile.layers.map(layer => `${layer.role}:${String(layer.inserts.length)}ins/${String(layer.targets.length)}pat/${String(layer.disables.length)}dis`).join(' ')}`)
    if (profile.duplicateIds.length > 0) lines.push(`    DUPLICATE IDS ${profile.duplicateIds.join(', ')}`)
    if (profile.orphanTargets.length > 0) lines.push(`    ORPHAN PATCH  ${profile.orphanTargets.join(', ')}`)
    if (profile.disabledRows.length > 0) lines.push(`    disabled rows ${profile.disabledRows.join(', ')}`)
  }

  if (report.incident !== undefined) {
    const incident = report.incident
    lines.push('')
    lines.push('LAST CAPTURED BOOT FAILURE')
    lines.push(`  at          ${incident.at}`)
    lines.push(`  command     ${incident.command}`)
    lines.push(`  cwd         ${incident.cwd}`)
    lines.push(`  exit        ${incident.exitCode === null ? 'signal/timeout' : String(incident.exitCode)} after ${String(incident.durationMs)}ms`)
    lines.push(`  booted      ${incident.booted ? 'yes' : 'no'}`)
    if (incident.signals.length > 0) {
      lines.push('  signals')
      for (const signal of incident.signals) lines.push(`    ${signal}`)
    }
    if (incident.dir !== undefined) lines.push(`  full output ${incident.dir}`)
  }

  lines.push('')
  lines.push(`FINDINGS (${String(report.findings.length)})`)
  for (const finding of rank(report.findings)) {
    lines.push(`  ${LEVEL_TAG[finding.level]} ${finding.code}: ${finding.title}`)
    for (const detail of finding.detail.split(/\r?\n/)) lines.push(`        ${detail}`)
    if (finding.evidence !== undefined) {
      for (const evidence of finding.evidence.split(/\r?\n/).slice(0, 12)) lines.push(`        | ${evidence}`)
    }
    if (finding.fix !== undefined) lines.push(`        fix: ${finding.fix}`)
  }
  return lines.join('\n') + '\n'
}

/**
 * Render the same report as the machine-readable JSON a script or the repair
 * agent consumes.
 * @param report - the diagnosis.
 * @returns pretty-printed JSON ending in one newline.
 */
export function renderJson(report: DoctorReport): string {
  return JSON.stringify(report, undefined, 2) + '\n'
}
