// Version gate: one version, agreed by every place that states it.
//
// The rule this enforces is that a released version number is a fact with one
// value. Four files state it independently — the manifest, the source literal
// the boot record stamps, the README header, and the newest CHANGELOG section —
// and a release where any two disagree ships a lie to whoever reads the other
// one. Three numeric segments only: `0.3.3.1` is not semver, and a package
// manager will reject the install that depends on it.
//
// Usage: node tools/check-version.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const failures = []
const read = (relative) => readFileSync(join(root, relative), 'utf8')

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

const manifest = JSON.parse(read('package.json'))
const version = manifest.version

if (typeof version !== 'string' || !SEMVER.test(version)) {
  failures.push(`package.json version ${JSON.stringify(version)} is not MAJOR.MINOR.PATCH semver`)
}
if (typeof version === 'string' && /^\d+\.\d+\.\d+\./.test(version)) {
  failures.push(`package.json version ${version} has four segments; a package manager will reject it`)
}

const literal = /PACKAGE_VERSION\s*=\s*'([^']+)'/.exec(read('src/version.ts'))
if (literal === null) failures.push('src/version.ts does not export a PACKAGE_VERSION literal')
else if (literal[1] !== version) failures.push(`src/version.ts says ${literal[1]} but package.json says ${version}`)

const readme = read('README.md')
if (!readme.includes(`版本 ${version}`)) {
  failures.push(`README.md does not state "版本 ${version}" in its header block`)
}

const changelog = read('CHANGELOG.md')
const heading = /^##\s*\[?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?/m.exec(changelog)
if (heading === null) failures.push('CHANGELOG.md has no "## [X.Y.Z]" version heading')
else if (heading[1] !== version) failures.push(`CHANGELOG.md's newest section is ${heading[1]} but package.json says ${version}`)

// The CHANGELOG is newest-first, so the first heading must be the released one,
// not merely present somewhere below an older entry.
const firstHeadingIndex = changelog.search(/^##\s/m)
if (heading !== null && firstHeadingIndex !== heading.index) {
  failures.push(`CHANGELOG.md lists ${JSON.stringify(changelog.slice(firstHeadingIndex).split('\n')[0])} above the current version`)
}

if (failures.length > 0) {
  console.error('check-version: FAIL')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`check-version: ok (${version} in package.json, src/version.ts, README.md, CHANGELOG.md)`)
