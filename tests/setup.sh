#!/usr/bin/env bash
# Set up node_modules symlinks so the e2e tests can resolve @earendil-works/pi-coding-agent.
# The package is globally installed; bun test doesn't respect NODE_PATH.
#
# Also installs the extensions/ workspace dependencies (see the "extensions/"
# section below), so a fresh worktree is test-ready after a single run.
#
# Run once before the first test:
#   bash tests/setup.sh
#
# IMPORTANT: a dangling symlink here makes `bun test` hang forever — bun's
# module resolver spins at 100% CPU when a second test file imports the same
# broken specifier (the first ENOENT poisons the shared resolution). We
# therefore resolve the real global location, repair stale links, and fail
# loudly instead of ever leaving a link that points at nothing.
set -euo pipefail

# GLOBAL_MODULES may be overridden via the environment (useful for tests and
# for pointing at a different global install); defaults to Homebrew's location.
GLOBAL_MODULES="${GLOBAL_MODULES:-/opt/homebrew/lib/node_modules/@earendil-works}"
LOCAL_MODULES="$(cd "$(dirname "$0")/.." && pwd)/node_modules/@earendil-works"

mkdir -p "$LOCAL_MODULES"

# Resolve the real global location for a package. pi-agent-core / pi-ai /
# pi-tui are dependencies of pi-coding-agent, so on a typical global install
# they live nested inside `pi-coding-agent/node_modules/@earendil-works/`
# rather than directly under the global @earendil-works scope. Check the flat
# location first, then the nested dependency tree.
resolve_global_pkg() {
  local pkg="$1"
  if [ -e "$GLOBAL_MODULES/$pkg" ]; then
    printf "%s" "$GLOBAL_MODULES/$pkg"
  elif [ -e "$GLOBAL_MODULES/pi-coding-agent/node_modules/@earendil-works/$pkg" ]; then
    printf "%s" "$GLOBAL_MODULES/pi-coding-agent/node_modules/@earendil-works/$pkg"
  fi
}

# extensions/ has its own package.json + committed bun.lock (picomatch,
# turndown, linkedom, @mozilla/readability, puppeteer-core, ...). A fresh
# worktree starts without extensions/node_modules, so extensions/rules.ts et al.
# fail with "Cannot find package 'picomatch'" until they are installed. Install
# them here so setup.sh leaves the tree test-ready.
#
# Existence-only check: setup.sh runs once per worktree and must stay fast, so
# we deliberately do NOT detect staleness (e.g. a bun.lock newer than the
# installed tree). To force a fresh install, remove extensions/node_modules and
# re-run.
EXTENSIONS_DIR="$(cd "$(dirname "$0")/.." && pwd)/extensions"
if [ -d "$EXTENSIONS_DIR/node_modules" ]; then
  echo "Already installed: extensions/node_modules"
else
  echo "Installing extensions/ dependencies (bun install --frozen-lockfile)..."
  if ! ( cd "$EXTENSIONS_DIR" && bun install --frozen-lockfile ); then
    # Never leave a half-set-up tree behind: a partially populated
    # node_modules would make the existence check above skip the install on the
    # next run (and the suite would fail with a confusing missing-package
    # error). Remove it so a re-run retries from scratch.
    rm -rf "$EXTENSIONS_DIR/node_modules"
    echo "ERROR: bun install --frozen-lockfile failed in $EXTENSIONS_DIR" >&2
    exit 1
  fi
  echo "Installed extensions/ dependencies"
fi

# Pass 1: remove any stale dangling links FIRST — never leave broken state
# behind, even if global resolution fails partway through pass 2.
for pkg in pi-coding-agent pi-agent-core pi-ai pi-tui; do
  if [ -L "$LOCAL_MODULES/$pkg" ] && [ ! -e "$LOCAL_MODULES/$pkg" ]; then
    rm -f "$LOCAL_MODULES/$pkg"
  fi
done

# Pass 2: resolve the real global location and link.
for pkg in pi-coding-agent pi-agent-core pi-ai pi-tui; do
  target="$(resolve_global_pkg "$pkg")"
  if [ -z "$target" ]; then
    echo "ERROR: cannot find a global install of $pkg (looked at $GLOBAL_MODULES/$pkg" \
         "and $GLOBAL_MODULES/pi-coding-agent/node_modules/@earendil-works/$pkg)" >&2
    exit 1
  fi

  if [ ! -e "$LOCAL_MODULES/$pkg" ]; then
    ln -s "$target" "$LOCAL_MODULES/$pkg"
    # Belt-and-braces: verify the link actually resolves; if it doesn't,
    # remove it again so the error never leaves a dangling link behind.
    if [ ! -e "$LOCAL_MODULES/$pkg" ]; then
      rm -f "$LOCAL_MODULES/$pkg"
      echo "ERROR: $LOCAL_MODULES/$pkg does not resolve to $target" >&2
      exit 1
    fi
    echo "Linked $pkg -> $target"
  else
    echo "Already linked: $pkg"
  fi
done

# typebox is a transitive dep of pi-coding-agent that some extensions
# (e.g. checkpoint.ts) value-import bare — `import { Type } from "typebox"`. Unlike
# the @earendil-works/* packages it lives at top-level node_modules (not under
# a scope), so it needs a separate link target dir. Without it, tests that
# import such extensions fail to resolve 'typebox'.
TYPEBOX_TARGET="$GLOBAL_MODULES/pi-coding-agent/node_modules/typebox"
if [ ! -e "$TYPEBOX_TARGET" ]; then
  echo "ERROR: cannot find typebox at $TYPEBOX_TARGET" >&2
  exit 1
fi
ROOT_MODULES="$(cd "$(dirname "$0")/.." && pwd)/node_modules"
mkdir -p "$ROOT_MODULES"
# Repair stale link first (same never-leave-dangling rule as above).
if [ -L "$ROOT_MODULES/typebox" ] && [ ! -e "$ROOT_MODULES/typebox" ]; then
  rm -f "$ROOT_MODULES/typebox"
fi
if [ ! -e "$ROOT_MODULES/typebox" ]; then
  ln -s "$TYPEBOX_TARGET" "$ROOT_MODULES/typebox"
  if [ ! -e "$ROOT_MODULES/typebox" ]; then
    rm -f "$ROOT_MODULES/typebox"
    echo "ERROR: $ROOT_MODULES/typebox does not resolve to $TYPEBOX_TARGET" >&2
    exit 1
  fi
  echo "Linked typebox -> $TYPEBOX_TARGET"
else
  echo "Already linked: typebox"
fi
