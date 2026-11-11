// SPDX-License-Identifier: GPL-3.0-or-later
// The Flatpak's first start (no sync engine in the sandbox): no `.stfolder` marker and no "Later" written. The one-time notice opens, the sync window
// does NOT, the engine is not asked for anything; closing the notice writes the same state file as "Later" does, so it does not come again. Real
// application.js with `flatpak: true`, a fake bridge that records every run. The control (not a Flatpak: the sync window opens) is sync-wizard-smoke.js.
import GLib from 'gi://GLib';

import {runStartGate} from './start-gate-support.js';

runStartGate({marker: false, firstStartSync: true, extra: {flatpak: true}}, async ({app, bridge, dirs, check, tick, waitFor}) => {
    await app.ready;
    check(await waitFor(() => app.syncNotice !== null), 'the notice opens at the first start');
    const n = app.syncNotice;
    check(app.syncWindow === null, 'the sync window is not opened');
    check(n.win.get_visible() === true && n.win.get_title() === 'Sync with another computer', `a window of its own (${n.win.get_title()})`);
    check(n.pathLabel.get_label() === dirs.notes, `it shows the notes folder as the program sees it (${n.pathLabel.get_label()})`);
    check(n.textLabel.get_label().includes('Syncthing') && n.textLabel.get_label().includes('Flathub') && n.textLabel.get_label().includes('dnf install syncthing'), 'it says what to install and where from');
    check(!GLib.file_test(`${dirs.state}/sync-wizard.json`, GLib.FileTest.EXISTS), 'nothing is written before the user answers');
    await tick(400);
    check(bridge.calls.length === 0, `the engine is not asked for anything (${bridge.calls.join() || 'no run'})`);
    n.button.emit('clicked');
    check(await waitFor(() => app.syncNotice === null), 'closing it ends it');
    const text = new TextDecoder().decode(GLib.file_get_contents(`${dirs.state}/sync-wizard.json`)[1]);
    check(text === '{"version":1,"dismissed":true}', `and writes the "Later" answer (${text})`);
    check(bridge.calls.length === 0, 'still no engine run');
});
