// Size gate: what ships stays small enough to read and to fetch.
//
// A rescue tool that grows without bound stops being usable exactly when it is
// needed: it is cloned by someone whose harness will not start, and it is read
// by someone deciding whether to trust it. The ceiling is deliberately far above
// the current size — this gate exists to catch an accidental commit of a build
// tree or an attachment, not to force micro-optimisation.
//
// Usage: node tools/check-size.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** Ceiling for every tracked file this package ships, in bytes. */
const MAX_BYTES = 2 * 1024 * 1024
/** No single shipped file may exceed this, in bytes. */
const MAX_FILE_BYTES = 512 * 1024

// The same set `files` in package.json ships, plus the documents npm always
// includes, minus anything a developer left behind.
const ROOTS = ['lib', 'src', 'tools', 'skills', 'scripts']
const ALWAYS = ['package.json', 'cordis.patch.yml', 'rescue.cordis.yml', 'README.md', 'CHANGELOG.md']
const EXCLUDE_DIRS = new Set(['node_modules', '.git', '.smoke'])

const files = []
const walk = (absolute) => {
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (EXCLUDE_DIRS.has(entry.name)) continue
    const child = join(absolute, entry.name)
    if (entry.isDirectory()) walk(child)
    else if (entry.isFile()) files.push({ path: relative(root, child), size: statSync(child).size })
  }
}
for (const dir of ROOTS) {
  try {
    walk(join(root, dir))
  } catch {
    // A root that does not exist yet (tools/, before the first gate lands) is
    // simply not part of the measurement.
  }
}
for (const name of ALWAYS) {
  const absolute = join(root, name)
  try {
    files.push({ path: name, size: statSync(absolute).size })
  } catch {
    console.error(`check-size: FAIL - required file ${name} is missing`)
    process.exit(1)
  }
}

const total = files.reduce((sum, file) => sum + file.size, 0)
const largest = [...files].sort((left, right) => right.size - left.size).slice(0, 5)
const fmt = (bytes) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`)

const failures = []
if (total > MAX_BYTES) failures.push(`shipped total ${fmt(total)} exceeds the ${fmt(MAX_BYTES)} ceiling`)
for (const file of files) {
  if (file.size > MAX_FILE_BYTES) failures.push(`${file.path} is ${fmt(file.size)}, over the ${fmt(MAX_FILE_BYTES)} per-file ceiling`)
}

if (failures.length > 0) {
  console.error('check-size: FAIL')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`check-size: ok (${files.length} files, ${fmt(total)} of ${fmt(MAX_BYTES)}; largest ${largest.map(f => `${f.path.split(sep).join('/')} ${fmt(f.size)}`).join(', ')})`)
