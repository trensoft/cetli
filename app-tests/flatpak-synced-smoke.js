// SPDX-License-Identifier: GPL-3.0-or-later
// The Flatpak on a notes folder that Syncthing already syncs (the `.stfolder` marker): no notice (nothing to tell) and the start-up check of the sync program
// (the engine's `ensure`, which the sandbox cannot run) is skipped. Not a Flatpak, the same folder: ensure-start-smoke.js (the check runs, once).
import {runStartGate} from './start-gate-support.js';

runStartGate({marker: true, firstStartSync: true, extra: {flatpak: true}}, async ({app, bridge, check, tick, waitFor}) => {
    await app.ready;
    check(await waitFor(() => app.allNotes?.win.get_visible() === true), 'the notes start as on any synchronised folder (the list opens)');
    await tick(600);
    check(app.syncNotice === null && app.syncWindow === null, 'no notice, no sync window');
    check(bridge.calls.length === 0, `no start-up check of the sync program (${bridge.calls.join() || 'no run'})`);
});
