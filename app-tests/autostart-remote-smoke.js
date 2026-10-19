// SPDX-License-Identifier: GPL-3.0-or-later
// 0.2.8: the program already runs (the user started it by hand, or a second autostart) and the autostart entry starts it again: `cetli --autostart` must do
// nothing at all, in particular it must not activate the running one (an activation brings every note back, closed ones too). The control is the same
// second start WITHOUT --autostart, which does activate the running program and opens the closed note. The second program is the real app/main.js, in a
// temporary XDG tree, on the session bus of this test (the headless script starts one); it never starts a core of its own, because it finds the first.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ID_A, ID_B, ID_C, seedNotes} from './autostart-support.js';
import {fakeBridge, runStartGate} from './start-gate-support.js';

const main = GLib.build_filenamev([GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]), '..', 'app', 'main.js']);

function second(base, args) {
    const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE});
    launcher.setenv('XDG_DATA_HOME', `${base}/other-data`, true);
    launcher.setenv('XDG_STATE_HOME', `${base}/other-state`, true);
    launcher.setenv('XDG_CONFIG_HOME', `${base}/other-config`, true);
    const sub = launcher.spawnv(['gjs', '-m', main, ...args]);
    return new Promise(res => {
        const kill = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 20, () => { sub.force_exit(); return GLib.SOURCE_REMOVE; });
        sub.wait_async(null, (s, r) => { s.wait_finish(r); GLib.source_remove(kill); res(s.get_if_exited() ? s.get_exit_status() : -1); });
    });
}

runStartGate({marker: true, bridge: fakeBridge(), seed: seedNotes({[ID_A]: true, [ID_B]: false, [ID_C]: true})}, async ({app, windows, base, check, tick, waitFor}) => {
    await app.ready;
    check(await waitFor(() => windows.size === 2) && !windows.has(ID_B), 'the program runs with the notes A and C open, B closed');
    check(await waitFor(() => Gio.DBus.session.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'NameHasOwner',
        GLib.Variant.new('(s)', ['io.github.trensoft.cetli']), null, Gio.DBusCallFlags.NONE, -1, null).deepUnpack()[0] === true, 3000), 'it owns its name on the session bus');
    const rc = await second(base, ['--autostart']);
    await tick(700);
    check(rc === 0, `the autostart start of a running program ends with 0 (got ${rc})`);
    check(windows.size === 2 && !windows.has(ID_B), 'and it did nothing to the running one: the closed note stays closed');
    const rc2 = await second(base, []);
    check(rc2 === 0, `control: a start by hand of a running program ends with 0 (got ${rc2})`);
    check(await waitFor(() => windows.has(ID_B)), 'control: and it brings the closed note back (the channel to the running program works)');
});
