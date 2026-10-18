// SPDX-License-Identifier: GPL-3.0-or-later
// Headless smoke test of the start gate of 0.2.5.1 in the real application.js (Petra 8766): a notes folder with a `.stfolder` marker and no
// note makes NO note at the start and NO note at a second launch; the window that opens is the list of notes, and its "New note" button
// makes the first note. Run it inside a headless Wayland compositor, see app-tests/run.sh. One program per process, so the folder WITHOUT a
// marker (a note at the start) is covered by gtk-smoke.js.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';

import {createApp} from '../app/application.js';
import * as S from '../app/strings.js';

const base = GLib.dir_make_tmp('cetli-synced-XXXXXX');
const dirs = {notes: `${base}/data/notes`, tmp: `${base}/data/tmp`, state: `${base}/state`};
GLib.mkdir_with_parents(dirs.notes, 0o755);
GLib.mkdir_with_parents(`${dirs.notes}/.stfolder`, 0o755);                       // the marker Syncthing makes
let failed = 0;
let checks = 0;
const check = (cond, label) => {
    checks++;
    if (cond) {
        print(`ok   ${label}`);
    } else {
        failed++;
        print(`FAIL ${label}`);
    }
};
const tick = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE; }));
async function waitFor(cond, limit = 8000) {
    const t0 = GLib.get_monotonic_time();
    for (;;) {
        if (cond())
            return true;
        if ((GLib.get_monotonic_time() - t0) / 1000 > limit)
            return false;
        await tick(40);
    }
}
const files = () => {
    const out = [];
    const en = Gio.File.new_for_path(dirs.notes).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    for (let i = en.next_file(null); i !== null; i = en.next_file(null))
        if (i.get_name().endsWith('.json'))
            out.push(i.get_name());
    return out;
};

const ctl = createApp({dirs, homeDir: base});
const {gtkApp, windows} = ctl;

async function scenario() {
    await ctl.ready;
    check(windows.size === 0 && files().length === 0, 'synchronised folder, no note: the start makes no note and opens no note window');
    check(await waitFor(() => ctl.allNotes?.win.get_visible() === true), 'the start opens the list of notes (a window, so GTK does not quit)');
    check(ctl.allNotes.stack.get_visible_child_name() === 'none', 'the list shows the "no notes" page');
    check(ctl.allNotes.newNoteButton.get_label() === S.menuNewNote() && ctl.allNotes.newNoteButton.get_mapped(), 'the empty list has a "New note" button');

    gtkApp.activate();                                                            // a second launch while no note exists
    await tick(600);
    check(windows.size === 0 && files().length === 0, 'a second launch makes no note either (showAll)');

    ctl.allNotes.newNoteButton.emit('clicked');
    check(await waitFor(() => windows.size === 1 && files().length === 1), 'the button makes the first note and opens its window');
    const [id] = [...windows.keys()];

    await ctl.ctl.deleteNote(id);
    check(await waitFor(() => windows.size === 0), 'the note is deleted again: no note window');
    const before = files().length;
    gtkApp.activate();
    await tick(600);
    check(windows.size === 0 && files().length === before, 'a second launch with only a deleted note makes no new note');
}

scenario().then(() => {}, e => { failed++; print(`FAIL exception ${e}\n${e.stack}`); }).finally(() => {
    print(`${checks - failed}/${checks} checks passed`);
    print(failed === 0 ? 'RESULT PASS' : 'RESULT FAIL');
    GLib.spawn_command_line_async(`rm -rf ${base}`);
    gtkApp.quit();
});
const status = ctl.run([]);
imports.system.exit(failed === 0 ? status : 1);
