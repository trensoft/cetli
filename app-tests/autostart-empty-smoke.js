// SPDX-License-Identifier: GPL-3.0-or-later
// 0.2.8: the start at login on a folder that is not synchronised and has no note, with the first-start sync window ON as in the product (main.js): no new
// empty note, no sync window (it would come back at every login until somebody answers it), the sync program is not asked, the program ends by itself.
// A start by hand makes its note (unsynced-start-smoke.js) and opens the window (sync-wizard-smoke.js).
import {fakeBridge, runStartGate} from './start-gate-support.js';

const bridge = fakeBridge();

runStartGate({marker: false, bridge, ownExit: true, firstStartSync: true, argv: ['cetli', '--autostart']}, async ({app, windows, files, check}) => {
    await app.ready;
    check(windows.size === 0 && files().length === 0, 'no note window and no new note');
    check(app.allNotes === null && app.syncWindow === null, 'no list of notes and no first-start sync window');
    check(bridge.calls.length === 0, 'the sync program was not asked');
});
