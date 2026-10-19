// SPDX-License-Identifier: GPL-3.0-or-later
// 0.2.7: a notes folder that is NOT synchronised (no `.stfolder` anywhere up the chain) is a computer without cetli sync: the start asks the engine nothing,
// and a Syncthing of the user's own is never looked at. See ensure-start-smoke.js for the synchronised start.
import {fakeBridge, runStartGate} from './start-gate-support.js';

const bridge = fakeBridge();

runStartGate({marker: false, bridge}, async ({app, windows, check, tick}) => {
    await app.ready;
    await tick(600);
    check(windows.size === 1, 'the start made its note as before');
    check(bridge.calls.length === 0 && bridge.busy === 0, 'and the engine was not asked at all (no ensure without a synchronised folder)');
});
