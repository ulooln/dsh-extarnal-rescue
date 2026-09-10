---
name: rescue-repair-playbook
description: Use when the DeepSeek Harness will not start — a profile that fails to boot, a plugin row that throws during load, a bundle or link that does not resolve, a patch layer that will not parse, or a web surface that never comes up. Maps each observed boot diagnostic to the file that causes it, the smallest safe fix, and the command that proves the fix.
---

# Repairing a harness that will not start

You are the rescue agent. The deployment already failed to boot; the mission carries the verbatim output of that failure. Work from that evidence, change as little as possible, and verify by booting.

## Read the failure before touching anything

The launch path is fixed, so the failure's shape tells you where it is.

| What the output says | Where it comes from | What to do |
| --- | --- | --- |
| `plugin(s) failed to load: <name>` | `assertEntriesLoaded` — the entry's module did not resolve | The package named is missing or its link is dangling. Check `<profile>/node_modules/<name>`; re-add it with `dsh plugin --profile <p> add <name>`. |
| `<name>: <error>` under `did not activate` | `assertEntriesActivated` — the plugin's `apply()` threw or it is waiting for a service | Fix the plugin's config first; if the row is optional, disable it. A `pending (waiting for services: x)` line means a provider row is missing or disabled. |
| `duplicate loader entry id: <id>` | the composed tree inserts the same id twice | Two layers insert one id. Delete the earlier insert — usually a `cordis.patch.yml` row duplicated by an earlier manual edit. |
| `failed to parse patches <file>` / `must be a top-level YAML array` | `loadOptionalPatches` — the patch file is invalid | The whole tree is refused. Repair the YAML; an empty file must be `[]`. |
| `Cannot find package '@deepseek-ai/...'` | bundle or row resolution | The bundle is not installed in the profile or the plane. `dsh plugin --profile <p> add <pkg>`, or remove it from `dsh.profile.bundles`. |
| `EADDRINUSE` | the web surface could not bind | Another surface owns the port. Stop it, or boot with `--port <other>`. |
| `fatal load failure: <stack>` | `installFailLoud` — a late unhandled rejection | The stack names the plugin. Disable that row, then fix it. |

## The two layers you may edit

- `<DSH_HOME>/profiles/<name>/package.json` — `dsh.profile.bundles` (ordered bundle list) and `dependencies` (out-of-tree plugins, usually `link:` entries).
- `<DSH_HOME>/profiles/<name>/cordis.patch.yml` — id-targeted overrides and disables, plus `insert:` lists. This is the layer you normally change.

The profile's `cordis.yml` is deliberately an empty list and is rewritten at every boot; editing it does nothing. `$DSH_HOME/cordis.patch.yml` applies to every profile — check it when a breakage follows no profile edit.

## The smallest safe fix, in order of preference

1. **Restore a missing referent.** A `link:` target that was moved, renamed, or deleted is a one-line fix. Prefer restoring the path over removing the plugin.
2. **Disable exactly one row.** Append to the profile patch layer:
   ```yaml
   - id: <row-id>
     disabled: true
   ```
   Then boot. This proves the row is the cause without deleting anything. Record the row id in your report so the user can decide later.
3. **Correct a patch id.** A patch that targets an id no layer inserts is a silent no-op; the id is usually a typo or a renamed row.
4. **Remove a duplicate insert.** Keep the last one; earlier layers already contributed it.
5. **Only then edit the plugin's own config**, and only the keys that failed validation.

Never edit the harness source to work around a configuration error. Never delete sessions, credentials, or settings. Back up every file you change, next to the original, as `<file>.rescue-bak-<timestamp>`.

## Verify with the real boot

The mission carries the exact command. Run it. Success is a clean exit or a surface that stays up; a boot that still prints `failed to load`, `did not activate`, or a parse error is still broken. Quote the command and its output in your report — a fix you have not booted is not a fix.

## When you cannot fix it

Leave the deployment in the least-broken state you found, and report: the exact diagnostic, the files you inspected, which causes you ruled out and how, and the single next thing a human should try. That is a useful outcome; a silent failure is not.
