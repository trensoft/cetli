// SPDX-License-Identifier: GPL-3.0-or-later
// The Flatpak's first start, but the notice was closed before ("Later" is written): it does not come again. The first start is app-tests/flatpak-notice-smoke.js.
import GLib from 'gi://GLib';

import {runStartGate} from './start-gate-support.js';

const seed = dirs => {
    GLib.mkdir_with_parents(dirs.state, 0o700);
    GLib.file_set_contents(`${dirs.state}/sync-wizard.json`, '{"version":1,"dismissed":true}');
};

runStartGate({marker: false, firstStartSync: true, seed, extra: {flatpak: true}}, async ({app, bridge, windows, check, tick, waitFor}) => {
    await app.ready;
    check(await waitFor(() => windows.size === 1), 'the start makes its note as before');
    await tick(500);
    check(app.syncNotice === null && app.syncWindow === null, 'no notice and no sync window');
    check(bridge.calls.length === 0, 'the engine is not asked for anything');
});
