// SPDX-License-Identifier: GPL-3.0-or-later
// Headless smoke test of the custom colour picker of a note window (app/window.js). Run it like gtk-smoke.js, inside a headless
// Wayland compositor: headless.sh 1920x1080 -- gjs -m app-tests/color-picker-smoke.js
// On GTK 4.8 (the Debian 12 test environment) the picker is the older Gtk.ColorButton; Gtk.ColorDialogButton (GTK 4.10 and
// later, RHEL 10) is NOT exercised here: this run says which one it used.
import GLib from 'gi://GLib';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';

import {createApp} from '../app/application.js';

const base = GLib.dir_make_tmp('cetli-picker-XXXXXX');
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
const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE; }));
// The save runs in the core's queue; wait (up to 8 s) for what the file should say instead of guessing a fixed time.
const waitFor = async cond => {
    for (let i = 0; i < 80 && !cond(); i++)
        await sleep(100);
};
const fileRec = id => JSON.parse(new TextDecoder().decode(GLib.file_get_contents(`${dirs.notes}/${id}.json`)[1]));
const rgba = (r, g, b) => new Gdk.RGBA({red: r / 255, green: g / 255, blue: b / 255, alpha: 1});
const channels = c => [c.red, c.green, c.blue].map(v => Math.round(v * 255));

const ctl = createApp({dirs});

async function scenario() {
    await ctl.ready;
    const [id, w] = [...ctl.windows][0];
    const dialogButton = typeof Gtk.ColorDialogButton === 'function' && typeof Gtk.ColorDialog === 'function';
    print(`GTK ${Gtk.get_major_version()}.${Gtk.get_minor_version()}: picker is ${dialogButton ? 'Gtk.ColorDialogButton' : 'Gtk.ColorButton (fallback)'}`);
    check(w.customPicker instanceof (dialogButton ? Gtk.ColorDialogButton : Gtk.ColorButton), 'the picker is the one this GTK has');
    check(w.win.has_css_class(`cetli-${w.color}`), `a new note starts on a palette colour (${w.color}, picked by the core)`);

    const first = w.color;
    // The user chooses a colour: set it, then the signal that the widget gives for a choice by the user.
    const choose = c => {
        w.customPicker.set_rgba(c);
        if (!dialogButton)
            w.customPicker.emit('color-set');   // set_rgba alone does not emit it; notify::rgba does the job on the dialog button
    };
    choose(rgba(0x33, 0x66, 0x99));
    await waitFor(() => fileRec(id).color === '#336699');
    check(w.color === '#336699', `chosen colour is #rrggbb in lower case (${w.color})`);
    check(fileRec(id).color === '#336699', 'and is saved in the note file through the normal save path');
    check(w.win.has_css_class('cetli-x-336699') && !w.win.has_css_class(`cetli-${first}`), 'the window has the custom class, the old one is gone');
    const rev = fileRec(id).rev;

    choose(rgba(0xaa, 0xbb, 0xcc));
    await waitFor(() => fileRec(id).color === '#aabbcc');
    check(fileRec(id).color === '#aabbcc' && w.win.has_css_class('cetli-x-aabbcc') && !w.win.has_css_class('cetli-x-336699'), 'a second custom colour replaces the first (lower case hex)');

    // The button shows the current custom colour, also when the colour was set in code (and that is not a choice by the user).
    w.setColor('#336699');
    await waitFor(() => fileRec(id).color === '#336699');
    const shown = channels(w.customPicker.get_rgba());
    check(shown.join() === '51,102,153', `the button shows the current custom colour (${shown})`);
    const revNow = fileRec(id).rev;
    await sleep(500);
    check(fileRec(id).rev === revNow && w.color === '#336699', 'showing it did not loop back into another save');

    // A palette colour takes the custom class away, a bad value is refused.
    w.setColor('pink');
    await waitFor(() => fileRec(id).color === 'pink');
    check(fileRec(id).color === 'pink' && w.win.has_css_class('cetli-pink') && !w.win.has_css_class('cetli-x-336699'), 'a palette colour replaces the custom one');
    for (const bad of ['#ABCDEF', '#12345', '#1234567', 'red', '#gg0000', '', null, '#336699\n']) {
        w.setColor(bad);
        check(w.color === 'pink', `refused: ${JSON.stringify(bad)}`);
    }

    // The colour popover builds its palette from COLORS (gray is not in it) and holds the picker.
    check(w.customPicker.get_ancestor(Gtk.Popover) !== null, 'the picker is inside the colour popover');
    check(rev > 0, 'sane revision numbers');
}

scenario().then(() => {}, e => { failed++; print(`FAIL exception ${e}\n${e.stack}`); }).finally(() => {
    print(`${checks - failed}/${checks} checks passed`);
    print(failed === 0 ? 'RESULT PASS' : 'RESULT FAIL');
    GLib.spawn_command_line_async(`rm -rf ${base}`);
    ctl.gtkApp.quit();
});
const status = ctl.run([]);
imports.system.exit(failed === 0 ? status : 1);
