#!/bin/bash
# Build @dsh-external/dsh-rescue: compile src/ -> lib/ with the dsh checkout's tsc,
# then link the module scope the compiled runner resolves its bare imports through.
#
# The runner row is imported by absolute file URL, so its bare `@deepseek-ai/*`
# imports resolve from this package's own node_modules. The link below points the
# whole scope at one deployment plane, which is what lets the rescue boot when the
# profile that would normally supply those packages is itself broken.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CHECKOUT="${DSH_CHECKOUT:-}"
if [ -z "$CHECKOUT" ]; then
  for candidate in "$HOME/dsh-harness" "$HOME/dsh" "$HOME/deepseek-harness" "$HOME/.dsh/dsh-harness"; do
    if [ -d "$candidate/packages" ]; then CHECKOUT="$candidate"; break; fi
  done
fi
if [ -z "$CHECKOUT" ] || [ ! -d "$CHECKOUT/packages" ]; then
  echo "build: cannot locate the dsh checkout (set DSH_CHECKOUT)" >&2
  exit 1
fi

TSC="$CHECKOUT/node_modules/.bin/tsc"
if [ ! -x "$TSC" ] && [ ! -f "$TSC.cmd" ]; then
  echo "build: tsc not found at $TSC" >&2
  exit 1
fi

link() {
  local linkPath="$1" target="$2"
  if [ ! -e "$target" ]; then
    echo "build: dependency target missing: $target" >&2
    exit 1
  fi
  node -e "
    const fs = require('fs'), path = require('path');
    const link = path.resolve(process.argv[1]), target = path.resolve(process.argv[2]);
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  " "$linkPath" "$target"
}

echo "=== Linking compile-time dependencies (checkout: $CHECKOUT) ==="
mkdir -p node_modules/@deepseek-ai
link node_modules/@deepseek-ai/cordis "$CHECKOUT/vendor/cordis"
link node_modules/@deepseek-ai/cordis-plugin-loader "$CHECKOUT/vendor/loader"
link node_modules/@deepseek-ai/schemastery "$CHECKOUT/vendor/schemastery"
link node_modules/@deepseek-ai/dsh-agent "$CHECKOUT/packages/core/agent"
link node_modules/@deepseek-ai/dsh-brand "$CHECKOUT/packages/util/brand"
link node_modules/@deepseek-ai/dsh-llm "$CHECKOUT/packages/llm/llm"
link node_modules/@deepseek-ai/dsh-session "$CHECKOUT/packages/core/session"
link node_modules/@deepseek-ai/dsh-system-prompt "$CHECKOUT/packages/core/system-prompt"
link node_modules/@deepseek-ai/dsh-tools "$CHECKOUT/packages/core/tools"
link node_modules/@deepseek-ai/dsh-util-values "$CHECKOUT/packages/util/values"
link node_modules/@types/node "$CHECKOUT/node_modules/@types/node"

echo "=== Compiling src -> lib ==="
"$TSC" -p tsconfig.json
echo "=== Build complete: $ROOT/lib ==="
