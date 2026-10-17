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
"$CETLI_GTKENV/headless.sh" 1920x1080 -- gjs -m "$here/app-tests/gtk-smoke.js" 2>&1 | grep -E '^(ok|FAIL) |checks passed|RESULT' || true
"$CETLI_GTKENV/headless.sh" 1920x1080 -- gjs -m "$here/app-tests/gtk-smoke.js" >/dev/null 2>&1 || rc=1
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
