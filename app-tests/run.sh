#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Tests of the GTK app. The node tests (pure modules) always run. The gjs tests need gjs, GTK 4, libadwaita and a Wayland
# compositor: set CETLI_GTKENV to a directory with gjsenv.sh and headless.sh (in the fleet container: workdir/gtkenv).
# msgfmt (gettext) is needed for the i18n check; without it that check is skipped and said so.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
rc=0
node --test "$here"/app-tests/*.test.js 2>&1 | grep -E '^(not ok|ok) |^# (tests|pass|fail)' || true
node --test "$here"/app-tests/*.test.js >/dev/null 2>&1 || rc=1
if [ -z "${CETLI_GTKENV:-}" ]; then
    echo 'SKIPPED: gjs tests (CETLI_GTKENV not set)'
    exit $rc
fi
. "$CETLI_GTKENV/gjsenv.sh"
# CETLI_BULK=1 adds the 50-note list test (it starts the program with 50 files in the folder).
smokes="gtk-smoke.js allnotes-smoke.js synced-start-deleted-smoke.js synced-start-empty-smoke.js unsynced-start-smoke.js conflict-resolve-smoke.js new-note-guard-smoke.js preview-marks-smoke.js marks-gjs-smoke.js color-picker-smoke.js color-render-smoke.js color-start-render-smoke.js red-render-smoke.js sync-wizard-smoke.js link-poll-smoke.js color-grid-render-smoke.js format-bar-smoke.js format-bar-render-smoke.js"
[ "${CETLI_BULK:-}" = 1 ] && smokes="$smokes allnotes-bulk-smoke.js"
for smoke in $smokes; do
    echo "== $smoke"
    # the bulk test is run under a ceiling: a run that prints its result and then does not end is a failure (rc 124), not a wait
    limit=()
    [ "$smoke" = allnotes-bulk-smoke.js ] && limit=(timeout 120)
    out="$("${limit[@]+"${limit[@]}"}" "$CETLI_GTKENV/headless.sh" 1920x1080 -- gjs -m "$here/app-tests/$smoke" 2>&1)"
    st=$?
    printf '%s\n' "$out" | grep -E '^(ok|FAIL|info) |checks passed|RESULT' || true
    [ "$st" -eq 0 ] || rc=1
done
if command -v msgfmt >/dev/null 2>&1; then
    tmp="$(mktemp -d)"
    mkdir -p "$tmp/hu/LC_MESSAGES"
    cat > "$tmp/hu.po" <<'PO'
msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\n"
"Plural-Forms: nplurals=2; plural=(n != 1);\n"

msgid "New note"
msgstr "Új jegyzet"

msgid "About cetli"
msgstr "A cetli névjegye"

msgid "%d unresolved"
msgstr "%d megoldatlan"
PO
    msgfmt -o "$tmp/hu/LC_MESSAGES/cetli.mo" "$tmp/hu.po"
    LANG=C.UTF-8 LANGUAGE=hu CETLI_LOCALEDIR="$tmp" gjs -m "$here/app-tests/i18n-smoke.js" 2>&1 | grep -E '^(ok|FAIL) |RESULT' || rc=1
    LANG=C.UTF-8 LANGUAGE=hu CETLI_LOCALEDIR="$tmp" gjs -m "$here/app-tests/i18n-smoke.js" >/dev/null 2>&1 || rc=1
    rm -rf "$tmp"
else
    echo 'SKIPPED: i18n check (no msgfmt)'
fi
exit $rc
