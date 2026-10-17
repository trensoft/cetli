// SPDX-License-Identifier: GPL-3.0-or-later
// gettext check under gjs: with a compiled catalog in CETLI_LOCALEDIR and LANGUAGE=hu the texts of strings.js are the
// Hungarian ones; an untranslated msgid stays English. Called by run.sh with a throw-away catalog.
import * as S from '../app/strings.js';

const want = {
    menuNewNote: 'Új jegyzet',
    menuAbout: 'A cetli névjegye',
    unresolved: '3 megoldatlan',
    untranslated: 'Main menu',
};
const got = {
    menuNewNote: S.menuNewNote(),
    menuAbout: S.menuAbout(),
    unresolved: S.unresolvedText(3),
    untranslated: S.menuTooltip(),
};
let bad = 0;
for (const k of Object.keys(want)) {
    const ok = want[k] === got[k];
    if (!ok)
        bad++;
    print(`${ok ? 'ok  ' : 'FAIL'} ${k}: ${got[k]}`);
}
print(bad === 0 ? 'RESULT PASS' : 'RESULT FAIL');
imports.system.exit(bad === 0 ? 0 : 1);
