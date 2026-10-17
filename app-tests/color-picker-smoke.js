// SPDX-License-Identifier: GPL-3.0-or-later
// Headless smoke test of the custom colour picker of a note window (app/window.js). Run it like gtk-smoke.js, inside a headless
// Wayland compositor: headless.sh 1920x1080 -- gjs -m app-tests/color-picker-smoke.js
// On GTK 4.8 (the Debian 12 test environment) the picker is the older Gtk.ColorButton; Gtk.ColorDialogButton (GTK 4.10 and
// later, RHEL 10) is NOT exercised here: this run says which one it used.
import GLib from 'gi://GLib';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';

import {GRID_COLORS, NOTE_BLACK, isCustomColor, parseCustomColor} from '../app/data.js';
import {createApp} from '../app/application.js';
import * as S from '../app/strings.js';

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

    // The picker is inside the hamburger menu (the popover of the menu button), not in a popover of its own.
    check(w.customPicker.get_ancestor(Gtk.PopoverMenu) !== null, 'the picker is inside the hamburger menu');
    check(rev > 0, 'sane revision numbers');

    // ---- the menu: the colour grid on top, then the entries (0.2.2)
    const flat = [];
    const walk = (m, depth) => {
        for (let i = 0; i < m.get_n_items(); i++) {
            const custom = m.get_item_attribute_value(i, 'custom', null)?.get_string()[0];
            const action = m.get_item_attribute_value(i, 'action', null)?.get_string()[0];
            const label = m.get_item_attribute_value(i, 'label', null)?.get_string()[0];
            const sec = m.get_item_link(i, 'section');
            if (sec) {
                flat.push('|');
                walk(sec, depth + 1);
            } else {
                flat.push(custom ? `custom:${custom}` : `${action}:${label}`);
            }
        }
    };
    walk(ctl.ctl.menu, 0);
    check(flat.join(' ') === `| custom:colors | app.all-notes:${S.menuAllNotes()} win.delete:${S.menuDeleteNote()} | win.about:${S.menuAbout()}`,
        `menu order: the grid, a separator, All notes, Delete note, then About (${flat.join(' ')})`);
    check(!flat.some(e => e.startsWith('app.new-note')), 'New note is not in the menu');
    check(ctl.gtkApp.get_accels_for_action('app.all-notes').join() === '<Control>h', 'All notes has Ctrl+H');
    check(ctl.gtkApp.get_accels_for_action('app.new-note').join() === '<Control>n', 'New note keeps Ctrl+N');
    // New note: a + button in the header of the note window
    check(w.addButton.get_ancestor(Gtk.HeaderBar) !== null && w.addButton.get_action_name() === 'app.new-note' && w.addButton.get_icon_name() === 'list-add-symbolic',
        'the + button is in the header and runs app.new-note');
    check(w.addButton.get_tooltip_text() === S.menuNewNote(), 'the + button has the tooltip of New note');
    const before = ctl.windows.size;
    w.addButton.emit('clicked');
    await waitFor(() => ctl.windows.size > before);
    check(ctl.windows.size === before + 1, `a click on + opens a new note window (${before} -> ${ctl.windows.size})`);
    for (const [otherId, other] of [...ctl.windows])
        if (otherId !== id)
            other.win.close();
    await sleep(300);

    // ---- the colour grid: 9 circles in the order of GRID_COLORS, 2 rows of 5, and the custom one last
    check(GRID_COLORS.length === 9 && [...w.dots.keys()].join() === GRID_COLORS.join(), `the nine circles are GRID_COLORS in order (${[...w.dots.keys()]})`);
    const grid = w.dots.get(GRID_COLORS[0]).button.get_ancestor(Gtk.Grid);
    check(grid instanceof Gtk.Grid && w.customPicker.get_ancestor(Gtk.Grid) === grid, 'the circles and the picker are in one grid');
    const cell = child => { const [col, row] = grid.query_child(child.get_parent() instanceof Gtk.Overlay ? child.get_parent() : child); return `${col},${row}`; };
    check(GRID_COLORS.every((v, i) => cell(w.dots.get(v).button) === `${i % 5},${Math.floor(i / 5)}`), 'two rows of five: the nine circles fill them in order');
    check(grid.get_row_spacing() === 10 && grid.get_column_spacing() === 10 && grid.get_margin_start() === 12 && grid.get_margin_end() === 12 && grid.get_margin_top() === 12,
        'the grid has 10 px gaps and 12 px margins');
    check(cell(w.customDot.button) === '4,1', 'the custom circle is the tenth, last of the second row');
    check(w.customPicker.get_opacity() === 0 && w.customDot.button.get_child_visible(), 'the picker lies invisible over the custom circle');
    check(w.customPicker.get_parent() === w.customDot.button.get_parent() && w.customDot.button.get_child() instanceof Gtk.Image && w.customDot.button.get_child().get_icon_name() === 'list-add-symbolic',
        'the custom circle has a + and the picker lies over it');
    check(w.customPicker.get_tooltip_text() === S.customColorTooltip(), 'the invisible picker has a name as tooltip');
    check(GRID_COLORS.every(v => w.dots.get(v).button.get_tooltip_text() === S.colorName(v)) && !GRID_COLORS.some(v => S.colorName(v) === v),
        'every circle has a name as tooltip (no raw #rrggbb)');

    // a click on a circle sets that colour and saves it in the colour field; the tick is on that circle only
    const marked = d => d.badge.get_visible() && d.button.has_css_class('cetli-selected');
    const ticks = () => GRID_COLORS.filter(v => marked(w.dots.get(v))).concat(marked(w.customDot) ? ['custom'] : []);
    const half = () => [...w.dots.values(), w.customDot].some(d => d.badge.get_visible() !== d.button.has_css_class('cetli-selected'));
    for (const v of GRID_COLORS) {
        w.dots.get(v).button.emit('clicked');
        await waitFor(() => fileRec(id).color === v);
        check(w.color === v && fileRec(id).color === v, `the circle ${v} sets and saves that colour (${fileRec(id).color})`);
        check(ticks().join() === v && !half(), `and only that circle has the ring and the badge (${ticks()})`);
        check(!w.customDot.button.has_css_class('cetli-selected') && w.customDot.fill === null, 'the custom circle stays neutral');
        check(!w.win.has_css_class('cetli-fixed') === !isCustomColor(v), `the window is "fixed" only for a #rrggbb colour (${v})`);
    }
    // a colour from the picker that no circle has: the tick moves to the rainbow circle; one that a circle has: to that circle
    choose(rgba(0x12, 0x34, 0x56));
    await waitFor(() => fileRec(id).color === '#123456');
    check(ticks().join() === 'custom' && !half(), `a colour of the picker that no circle has: the ring and the badge are on the custom circle (${ticks()})`);
    check(w.customDot.button.has_css_class('cetli-fill-123456') && w.win.has_css_class('cetli-fixed'), 'the custom circle takes that colour, the window is fixed');
    const black = parseCustomColor(NOTE_BLACK);
    choose(rgba(black.r, black.g, black.b));
    await waitFor(() => fileRec(id).color === NOTE_BLACK);
    check(fileRec(id).color === NOTE_BLACK && ticks().join() === NOTE_BLACK, `the picker's black is the black circle's colour: the mark is there (${ticks()})`);
    check(w.customDot.fill === null && !w.customDot.button.has_css_class(`cetli-fill-${NOTE_BLACK.slice(1)}`), 'and the custom circle is neutral again');
    w.setColor('#336699');
    check(ticks().join() === 'custom' && w.customDot.button.has_css_class('cetli-fill-336699'), 'a colour set in code shows the same mark');
    w.setColor('green');
    check(ticks().join() === 'green' && w.customDot.fill === null, 'and a name takes it away from the custom circle');
    await sleep(500);
    check(w.color === 'green', 'nothing came back by itself');
}

scenario().then(() => {}, e => { failed++; print(`FAIL exception ${e}\n${e.stack}`); }).finally(() => {
    print(`${checks - failed}/${checks} checks passed`);
    print(failed === 0 ? 'RESULT PASS' : 'RESULT FAIL');
    GLib.spawn_command_line_async(`rm -rf ${base}`);
    ctl.gtkApp.quit();
});
const status = ctl.run([]);
imports.system.exit(failed === 0 ? status : 1);
