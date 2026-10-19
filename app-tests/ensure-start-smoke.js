// SPDX-License-Identifier: GPL-3.0-or-later
// 0.2.7 (the `pkill -f cetli` case): on a computer whose notes folder is synchronised, the app asks the engine's quiet `ensure` ONCE when it starts, in the
// background and without a window. A sync window opened while that check is still running waits for it (one engine run at a time): no E_BUSY, no second
// restart. A failed check shows nothing. Real application.js and sync window, a fake bridge that counts the runs (like the real runner, a second run
// at the same time is E_BUSY). The unsynchronised start is ensure-start-unsynced-smoke.js.
import {fakeBridge, runStartGate} from './start-gate-support.js';

let release;
const check1 = new Promise(res => { release = res; });
const notSetUp = {ok: true, result: {event: 'result', state: 'not-set-up', own_id: null, peers: [], computers: null, max_computers: 10, over_limit: false, revocation_open: false,
    harden_pending: 0, promote_pending: 0, removed: [], listener: null, up_to_date: null, notes: null, waiting: false}};
const bridge = fakeBridge({ensure: () => check1, status: notSetUp});

runStartGate({marker: true, bridge}, async ({app, check, tick, waitFor}) => {
    await app.ready;
    check(bridge.calls.join() === 'ensure', 'the start asks ensure, once, and nothing else');
    check(app.syncWindow === null, 'in the background: no sync window was opened for it');
    check(await waitFor(() => app.allNotes?.win.get_visible() === true), 'the notes start as before (the list opens on a synchronised, empty folder)');
    const w = app.showSync();
    await tick(500);
    check(bridge.calls.join() === 'ensure' && bridge.busy === 0 && w.page === 'checking', 'a sync window opened during the check waits: no status yet, no E_BUSY, the checking page');
    release({ok: false, error: {code: 'E_SERVICE_TIMEOUT', step: 'service'}});            // the check ends with an error: nothing is shown for it
    check(await waitFor(() => bridge.calls.includes('status')), 'when the check is over the first status runs');
    check(bridge.calls.join() === 'ensure,status' && bridge.busy === 0, 'ensure, then status: in this order, no E_BUSY');
    check(await waitFor(() => w.page !== 'checking') && w.page !== 'error', 'the failed check shows no error page');
    app.gtkApp.activate();                                                              // a second launch of the program
    await tick(400);
    check(bridge.calls.filter(v => v === 'ensure').length === 1, 'a second activation does not ask again (once per process)');
});
