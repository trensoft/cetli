#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Runs every test of the cetli core on a CLEAN COPY of src/ and tests/ (nothing else of the folder is used).
#   tests/run.sh            all tests, then the tag check
#   tests/run.sh --mutants  additionally the negative control (tests/mutants.js)
# Needs: node >= 22 (node:test). Optional: python3 and the plan's model (evidence/model/resolve_model.py) for the
# convergence comparison; CETLI_MODEL may point to the model file; without it that test is SKIPPED and says so.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/cetli-run.XXXXXX")"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/src" "$work/tests"
cp -r "$here/src/." "$work/src/"
cp -r "$here/tests/." "$work/tests/"
cp "$here/package.json" "$work/"
if [ -z "${CETLI_MODEL:-}" ]; then
    model="$here/../evidence/model/resolve_model.py"
    [ -f "$model" ] && export CETLI_MODEL="$model"
fi
echo "node $(node --version), clean copy: $work"
echo "model: ${CETLI_MODEL:-none}"
cd "$work" || exit 2
out="$(node --test tests/*.test.js 2>&1)"
status=$?
printf '%s\n' "$out" | grep -E '^(not ok|ok) ' | sed -E 's/^(not ok|ok) [0-9]+ - /\1  /' | cut -c1-150
echo '----'
printf '%s\n' "$out" | grep -E '^# (tests|pass|fail|skipped|todo)'
printf '%s\n' "$out" | grep -E '^ok .* # SKIP' | sed 's/^/SKIPPED: /'
printf '%s\n' "$out" | grep -E -A12 '^not ok' | grep -E 'error:|expected|actual' | head -20
echo '----'
tags="$(grep -rhoE '\[P2-T[0-9]+\]' tests/*.test.js | sort -u | wc -l)"
echo "distinct [P2-Tn] tags in test names: $tags (expected 14)"
for n in $(seq 1 14); do
    c="$(grep -rhE "^test\(.*\[P2-T$n\]" tests/*.test.js | wc -l)"
    printf 'P2-T%-2s %s test(s)\n' "$n" "$c"
done
[ "$tags" -eq 14 ] || status=1
if [ "${1:-}" = "--mutants" ]; then
    echo '---- negative control'
    node tests/mutants.js || status=1
fi
exit "$status"
