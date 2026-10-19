// SPDX-License-Identifier: GPL-3.0-or-later
// 0.2.8: the start at login on a synchronised folder where every note was left closed. Nothing opens: no note (no fall-back to all), no list of notes, no new
// note, no sync window. The program ends by itself, but only after the start-up check of the sync program is over (its shutdown stops the sync bridge, which
// would cut the check in the middle).
import {ID_A, ID_B, ID_C, layoutText, seedNotes} from './autostart-support.js';
import {fakeBridge, runStartGate} from './start-gate-support.js';

let release;
const check1 = new Promise(res => { release = res; });
const bridge = fakeBridge({ensure: () => check1});
let before = null;

runStartGate({marker: true, bridge, ownExit: true, argv: ['cetli', '--autostart'], seed: dirs => { seedNotes({[ID_A]: false, [ID_B]: false, [ID_C]: false})(dirs); before = layoutText(dirs); }},
    async ({app, windows, files, dirs, check, tick}) => {
        await app.ready;
        await tick(800);                                                                  // a program that left would not get here
        check(bridge.calls.join() === 'ensure', 'the start-up check is running');
        check(windows.size === 0 && files().length === 3, 'no note window, no new note');
        check(app.allNotes === null && app.syncWindow === null, 'no list of notes, no sync window');
        check(layoutText(dirs) === before, 'layout.json is not changed');
        release({ok: true, result: {event: 'result', state: 'running'}});                // the check is over: the program may leave
    });
