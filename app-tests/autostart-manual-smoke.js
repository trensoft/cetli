// SPDX-License-Identifier: GPL-3.0-or-later
// 0.2.8, the control of autostart-*.js: the same folder started by hand (no --autostart). When every note is marked closed, a start by hand opens all of
// them (as before 0.2.8); a start at login does not (autostart-none-smoke.js).
import {ID_A, ID_B, ID_C, seedNotes} from './autostart-support.js';
import {runStartGate} from './start-gate-support.js';

runStartGate({marker: true, seed: seedNotes({[ID_A]: false, [ID_B]: false, [ID_C]: false})}, async ({app, windows, check, waitFor}) => {
    await app.ready;
    check(await waitFor(() => windows.size === 3), 'a start by hand with every note marked closed opens all of them');
});
