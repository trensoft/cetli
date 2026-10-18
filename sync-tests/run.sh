#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Tests of the sync wizard's engine and contract (sync/). Pure node: no Gio, no Syncthing, no display.
#   sync-tests/run.sh        the node tests of sync-tests/*.test.js
# The mutants of the engine (M1-M10) are a separate file, sync-tests/mutants.js, run only when the gate asks for them.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node --test "$here"/sync-tests/*.test.js 2>&1 | grep -E '^(not ok|ok) |^# (tests|pass|fail|skipped|todo)'
node --test "$here"/sync-tests/*.test.js >/dev/null 2>&1
# the real ports (processes, files, a main.js run) need gjs but no display: CETLI_GTKENV points at the directory with gjsenv.sh
if [ -n "${CETLI_GTKENV:-}" ]; then
    echo '== gio-ports-smoke.js'
    ( . "$CETLI_GTKENV/gjsenv.sh"; gjs -m "$here/sync-tests/gio-ports-smoke.js" 2>&1 | grep -E '^(FAIL|[0-9]+/[0-9]+ checks|RESULT)' ) || exit 1
else
    echo 'SKIPPED: gio-ports-smoke.js (CETLI_GTKENV not set)'
fi
