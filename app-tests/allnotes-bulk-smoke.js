// SPDX-License-Identifier: GPL-3.0-or-later
// 1000 notes in the folder before the program starts: the core loads at most MAX_NOTES (1.4), the rest stay on disk. What
// the "All notes" list costs with that many rows. Run inside a headless Wayland compositor, see app-tests/run.sh. The figures
// are printed as `info` lines (they depend on the machine); the checks only bound them generously and test the behaviour.
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {createApp} from '../app/application.js';
import {COLORS} from '../app/data.js';
import {MAX_NOTES} from '../src/constants.js';

const base = GLib.dir_make_tmp('cetli-bulk-XXXXXX');
const dirs = {notes: `${base}/data/notes`, tmp: `${base}/data/tmp`, state: `${base}/state`};
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
const info = text => print(`info ${text}`);
const now = () => GLib.get_monotonic_time() / 1000;
const tick = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE; }));
async function waitFor(cond, limit = 8000) {
    const t0 = now();
    for (;;) {
        if (cond())
            return true;
        if (now() - t0 > limit)
            return false;
        await tick(40);
    }
}

// The files are in place BEFORE the application is created. All but a few notes are marked closed in layout.json, so that
// the start does not open 500 note windows (that case is measured by hand and reported; here the list is the subject).
GLib.mkdir_with_parents(dirs.notes, 0o700);
GLib.mkdir_with_parents(dirs.state, 0o700);
const T = Date.now() + 60000;
const layout = {};
for (let i = 0; i < 1000; i++) {
    const id = GLib.uuid_string_random();
    layout[id] = {x: 0, y: 0, w: 300, h: 260, monitor: 'test', open: i < 3};
    const t = new Date(T + i).toISOString();
    // every 7th note is long, every 11th empty, every 13th a custom colour
    const text = i % 11 === 0 ? '' : i % 7 === 0 ? `long ${i}\n${'y'.repeat(60000)}` : `note ${i}\nsecond line ${i}`;
    const color = i % 13 === 0 ? `#${(0x100000 + i * 997).toString(16).slice(-6).padStart(6, '0')}` : COLORS[i % COLORS.length];
    GLib.file_set_contents(`${dirs.notes}/${id}.json`, `${JSON.stringify({schema: 1, id, rev: 1, updated: t, created: t, device: 'b5b5b5b5', color, text, deleted: false, conflict_of: null})}\n`);
}

GLib.file_set_contents(`${dirs.state}/layout.json`, `${JSON.stringify(layout)}\n`);
const ctl = createApp({dirs});
const {gtkApp, windows} = ctl;

async function scenario() {
    const t0 = now();
    await ctl.ready;
    const alive = () => ctl.store.listNotes().filter(n => !n.deleted);
    const loaded = await waitFor(() => alive().length >= MAX_NOTES, 120000);
    info(`start to ${alive().length} notes in the core: ${(now() - t0).toFixed(0)} ms; note windows opened: ${windows.size} (3 by layout.json)`);
    check(loaded && alive().length === MAX_NOTES, `of 1000 files the core holds ${alive().length} (limit ${MAX_NOTES})`);

    const tops0 = Gtk.Window.list_toplevels().length;
    const t1 = now();
    gtkApp.activate_action('all-notes', null);
    const list = ctl.allNotes;
    const built = now() - t1;
    info(`"All notes": ${list.rows.size} rows built in ${built.toFixed(0)} ms`);
    check(list !== null && list.rows.size === alive().length, `the list has one row per note of the core (${list?.rows.size})`);
    check(await waitFor(() => Gtk.Window.list_toplevels().length === tops0 + 1), 'one window');
    const t2 = now();
    await tick(1);
    // let the window map and be laid out once
    await waitFor(() => list.win.get_mapped(), 20000);
    info(`mapped ${(now() - t2).toFixed(0)} ms after the rows were built`);
    check(built < 5000, `building ${list.rows.size} rows takes ${built.toFixed(0)} ms (limit 5000)`);
    const t3 = now();
    list.refresh();
    const idle = now() - t3;
    info(`a refresh over ${list.rows.size} unchanged rows: ${idle.toFixed(1)} ms`);
    check(idle < 500, `a refresh over unchanged rows is cheap (${idle.toFixed(1)} ms, limit 500)`);

    // the long notes: every label is small
    const maxLabel = Math.max(...[...list.rows.values()].map(r => r.label.get_label().length));
    check(maxLabel <= 3 * 81 + 2, `no row label is longer than 3 cut lines (${maxLabel} chars) although some notes are 60 KB`);

    info(`${windows.size} note windows are open`);
    list.win.close();
    check(await waitFor(() => ctl.allNotes === null), 'closing the big list works');
    check(windows.size >= 1 && [...windows.values()].every(x => x.win.get_visible()), 'and closes no note window');
    // a click on a row of a closed note among 500 opens it
    const target = alive().find(n => !windows.has(n.id));
    gtkApp.activate_action('all-notes', null);
    ctl.allNotes.list.emit('row-activated', ctl.allNotes.rows.get(target.id).row);
    check(await waitFor(() => windows.has(target.id), 20000), 'a click on a row among 500 opens that note');
}

scenario().then(() => {}, e => { failed++; print(`FAIL exception ${e}\n${e.stack}`); }).finally(() => {
    print(`${checks - failed}/${checks} checks passed`);
    print(failed === 0 ? 'RESULT PASS' : 'RESULT FAIL');
    GLib.spawn_command_line_async(`rm -rf ${base}`);
    // 500 note windows: a graceful quit would flush and close each of them; the result is already printed
    imports.system.exit(failed === 0 ? 0 : 1);
});
ctl.run([]);
