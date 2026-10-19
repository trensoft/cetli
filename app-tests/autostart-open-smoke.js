// SPDX-License-Identifier: GPL-3.0-or-later
// 0.2.8: the start at login (`cetli --autostart`) on a synchronised folder with three notes: A left open, B closed, C without a layout entry (the extension
// has not seen it yet; it opens as at any start). Exactly A and C open; no new note, no list of notes, no sync window; the start-up check of the sync program
// runs once; the layout file is not touched.
import {ID_A, ID_B, ID_C, layoutText, seedNotes} from './autostart-support.js';
import {fakeBridge, runStartGate} from './start-gate-support.js';

const bridge = fakeBridge();
let before = null;

runStartGate({marker: true, bridge, argv: ['cetli', '--autostart'], seed: dirs => { seedNotes({[ID_A]: true, [ID_B]: false})(dirs); before = layoutText(dirs); }},
    async ({app, windows, files, dirs, check, tick, waitFor}) => {
        await app.ready;
        check(await waitFor(() => windows.size === 2), 'two windows open');
        check(windows.has(ID_A) && windows.has(ID_C) && !windows.has(ID_B), 'the note left open and the note without an entry open, the closed note does not');
        await tick(700);
        check(windows.size === 2 && files().length === 3, 'no new note, no more windows');
        check(app.allNotes === null, 'no list of notes');
        check(app.syncWindow === null, 'no sync window');
        check(bridge.calls.join() === 'ensure', 'the start-up check of the sync program ran once (and nothing else)');
        check(layoutText(dirs) === before, 'layout.json is not changed by the start');
    });
