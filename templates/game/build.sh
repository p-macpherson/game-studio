#!/usr/bin/env bash
# Build, run and test {{name}}.
#
#   ./build.sh                    build (debug) into build/game
#   ./build.sh release            optimised build
#   ./build.sh run [-- args]      build and run from the project root (e.g. -- --mode=hidden --control)
#   ./build.sh check              type-check only
#   ./build.sh test [script]      headless scripted test (default: tests/smoke.jsonl); exit code = verdict
#
# ENGINE_DIR selects the engine checkout (default: the engine/ submodule). Engine sessions point it at
# their worktree to test an engine change against this game before merging it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
ENGINE_DIR="${ENGINE_DIR:-$ROOT/engine}"
COLLECTION="-collection:engine=$ENGINE_DIR/engine"
cd "$ROOT"

ensure_deps() {
	[[ -f "$ENGINE_DIR/engine/engine/app.odin" ]] || { echo "engine not found at $ENGINE_DIR (run: git submodule update --init)" >&2; exit 1; }
	for lib in libraylib.a libenet.a libbox3d.a; do
		if [[ ! -f "$ENGINE_DIR/third_party/lib/$lib" ]]; then
			echo ">> engine native libraries missing; building them once"
			"$ENGINE_DIR/third_party/deps.sh"
			return
		fi
	done
}

build() {
	ensure_deps
	mkdir -p build
	odin build game "$COLLECTION" -out:build/game "$@"
	echo ">> built build/game"
}

cmd="${1:-build}"
[[ $# -gt 0 ]] && shift
case "$cmd" in
	build) build -debug ;;
	release) build -o:speed -no-bounds-check ;;
	run)
		build -debug
		[[ "${1:-}" == "--" ]] && shift
		exec build/game "$@"
		;;
	check) odin check game "$COLLECTION" ;;
	test)
		build -debug
		build/game --mode=hidden --fixed-dt --script="${1:-tests/smoke.jsonl}"
		;;
	*) sed -n '2,10p' "$0"; exit 1 ;;
esac
