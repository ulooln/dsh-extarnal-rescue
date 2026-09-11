/**
 * The package version as a literal.
 *
 * It has more than one reader — the boot record stamps which rescue version
 * assessed a failure, and `dsh-rescue doctor` prints it — and a reader that
 * cannot load `package.json` still needs it. `tools/check-version.mjs` proves
 * this literal, `package.json`, the README version line, and the newest
 * CHANGELOG heading all agree, so the duplication cannot drift.
 * @module @dsh-external/dsh-rescue/version
 */
/** The version this build reports. Keep in step with `package.json`. */
export const PACKAGE_VERSION = '0.2.0';
//# sourceMappingURL=version.js.map