// SPDX-License-Identifier: GPL-3.0-or-later
// Headless test of what the RED note DRAWS (0.2.4): the bold text, the "Important" title of a window that is not active, and the title
// on the smallest window. The pixels and the sizes are measured, not the CSS: a rule can be in the stylesheet and not be drawn (the bold
// rule of the 0.2.4 candidate was on the `text` subnode and the text was drawn in the normal weight). Run it like gtk-smoke.js, inside
// a headless Wayland compositor:
// headless.sh 1920x1080 -- gjs -m app-tests/red-render-smoke.js
//
// "Not active" is made by showing a second window, not read from `is_active`: the headless compositor does not report it. What the test
// relies on is the dimming of the buttons of a bar (libadwaita draws them at 50 %), which only a window that is not active gets.
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import GdkPixbuf from 'gi://GdkPixbuf';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';

import {createApp} from '../app/application.js';
import {DEFAULT_HEIGHT, DEFAULT_WIDTH, MIN_SIZE, NOTE_BLACK, NOTE_RHEL_RED} from '../app/data.js';
import {NoteWindow} from '../app/window.js';

const base = GLib.dir_make_tmp('cetli-red-XXXXXX');
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
const info = label => print(`info ${label}`);
const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE; }));

// Independent of data.js: WCAG 2.x contrast.
const lin = c => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
const hex = c => `#${c.map(v => v.toString(16).padStart(2, '0')).join('')}`;
const grey = c => (c[0] + c[1] + c[2]) / 3;

// A loaded machine can draw the first frame late: the snapshot of a window that is not drawn yet is empty (to_node() is null, the
// "Argument root may not be null" of render_texture). Wait for a drawn window, at most 10 s.
async function drawn(win) {
    for (let i = 0; i < 50; i++) {
        if (win.get_width() > 0 && win.get_height() > 0) {
            const snap = new Gtk.Snapshot();
            new Gtk.WidgetPaintable({widget: win}).snapshot(snap, win.get_width(), win.get_height());
            if (snap.to_node() !== null)
                return;
        }
        await sleep(200);
    }
}

// drawn() and shot() run in the same turn of the main loop (no frame in between), so a snapshot that was not empty a moment ago is not empty
// now: every picture of the test is taken through here. A window whose size, label or activity just changed has no frame for a while
// on a loaded machine (the "Argument root may not be null" of 0.2.4 came from the title tests, not from the first frame).
async function shotOf(win) {
    await drawn(win);
    return shot(win);
}

let shots = 0;
// The window drawn to a PNG and read back: at(x, y) -> [r, g, b].
function shot(win) {
    const width = win.get_width(), height = win.get_height();
    const snap = new Gtk.Snapshot();
    new Gtk.WidgetPaintable({widget: win}).snapshot(snap, width, height);
    const path = `${base}/shot-${shots++}.png`;
    win.get_native().get_renderer().render_texture(snap.to_node(), new Graphene.Rect().init(0, 0, width, height)).save_to_png(path);
    const pb = GdkPixbuf.Pixbuf.new_from_file(path);
    const px = pb.get_pixels(), n = pb.get_n_channels(), stride = pb.get_rowstride();
    return {width, height, at: (x, y) => [px[y * stride + x * n], px[y * stride + x * n + 1], px[y * stride + x * n + 2]]};
}

// The area of a widget in the window, in whole pixels.
function area(widget, win, width, height) {
    const [, b] = widget.compute_bounds(win);
    return {x0: Math.max(0, Math.floor(b.get_x())), y0: Math.max(0, Math.floor(b.get_y())),
        x1: Math.min(width, Math.ceil(b.get_x() + b.get_width())), y1: Math.min(height, Math.ceil(b.get_y() + b.get_height()))};
}

// The pixel of an area that is farthest in luminance from `bg`, how many pixels differ clearly from it, and their bounding box.
function ink({at}, a, bg) {
    let far = bg, n = 0, x0 = 1e9, x1 = -1;
    for (let y = a.y0; y < a.y1; y++) {
        for (let x = a.x0; x < a.x1; x++) {
            const c = at(x, y);
            const d = Math.abs(lum(c) - lum(bg));
            if (d > 0.2) {
                n++;
                x0 = Math.min(x0, x);
                x1 = Math.max(x1, x);
            }
            if (d > Math.abs(lum(far) - lum(bg)))
                far = c;
        }
    }
    return {far, n, x0, x1};
}

// The ink of the FIRST text line of the note (the caret is on the second), as a mass: every pixel counts by how much of the way from the
// background to the text colour it has (the text colour is the pixel farthest from the background), so the colours do not matter, only
// how much is drawn. Bold text has more of it than normal text of the same size.
function textMass(s, w) {
    const r = w.buffer.get_iter_at_line(0);
    const loc = w.view.get_iter_location(Array.isArray(r) ? r[1] : r);
    const [, pt] = w.view.compute_point(w.win, new Graphene.Point({x: 0, y: loc.y}));
    const y0 = Math.max(48, Math.floor(pt.y)), y1 = Math.min(s.height - 2, Math.ceil(pt.y + loc.height));
    const bg = s.at(s.width - 4, y0);
    const dist = c => Math.hypot(c[0] - bg[0], c[1] - bg[1], c[2] - bg[2]);
    let fg = bg;
    for (let y = y0; y < y1; y++)
        for (let x = 2; x < s.width - 2; x++)
            if (dist(s.at(x, y)) > dist(fg))
                fg = s.at(x, y);
    const v = [fg[0] - bg[0], fg[1] - bg[1], fg[2] - bg[2]], vv = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    let mass = 0;
    for (let y = y0; y < y1; y++) {
        for (let x = 2; x < s.width - 2; x++) {
            const c = s.at(x, y);
            mass += Math.max(0, Math.min(1, ((c[0] - bg[0]) * v[0] + (c[1] - bg[1]) * v[1] + (c[2] - bg[2]) * v[2]) / vv));
        }
    }
    return mass;
}

const ctl = createApp({dirs});
const now = new Date().toISOString();
const record = (n, color, text = 'Milk and bread and eggs\nButter') => ({schema: 1, id: `00000000-0000-4000-8000-00000000000${n}`, rev: 1, updated: now, created: now, device: 'b5b5b5b5', color, text, deleted: false, conflict_of: null});
const open = async (n, color, size, text) => {
    const w = new NoteWindow({ctl: ctl.ctl, record: record(n, color, text), size});
    w.present();
    await sleep(900);
    await drawn(w.win);
    return w;
};
const DEFAULT = {width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT};

// 1. the bold text of the red: the weight of the text view and the ink of the first line, against the colours that must NOT be bold
async function bold(scheme) {
    const mass = new Map();
    for (const [n, color] of [[1, NOTE_RHEL_RED], [2, 'yellow'], [3, NOTE_BLACK], [4, '#ed0000']]) {
        const w = await open(n, color, DEFAULT);
        const weight = w.view.get_pango_context().get_font_description().get_weight();
        const m = textMass(await shotOf(w.win), w);
        mass.set(color, m);
        info(`${scheme} ${color}: the text view draws weight ${weight}, ink of the first line ${m.toFixed(1)}`);
        check(color === NOTE_RHEL_RED ? weight >= Pango.Weight.BOLD : weight === Pango.Weight.NORMAL,
            `${scheme} ${color}: the text is drawn in the ${color === NOTE_RHEL_RED ? 'bold' : 'normal'} weight (${weight})`);
        w.win.destroy();
    }
    const ref = mass.get('#ed0000');
    check(mass.get(NOTE_RHEL_RED) >= ref * 1.15, `${scheme}: the ink of the red text is ${(mass.get(NOTE_RHEL_RED) / ref).toFixed(2)} x that of the near red #ed0000, the same text (>= 1.15 x)`);
    for (const color of ['yellow', NOTE_BLACK])
        check(Math.abs(mass.get(color) / ref - 1) <= 0.12, `${scheme}: ${color} draws ${(mass.get(color) / ref).toFixed(2)} x the ink of #ed0000, not bold (within 12 %)`);
}

// 2. the title in a window that is not active, and the buttons of the bar: still dimmed to 50 % there
async function backdrop(scheme) {
    // the farthest pixel of the buttons of a bar and the strip colour of that bar
    const buttons1 = async w => {
        const s = await shotOf(w.win), strip = s.at(Math.floor(s.width / 2), 3);
        const a = ink(s, area(w.addButton, w.win, s.width, s.height), strip), b = ink(s, area(w.menuButton, w.win, s.width, s.height), strip);
        const t = ink(s, area(w.titleLabel, w.win, s.width, s.height), strip);
        return {s, strip, add: a.far, menu: b.far, title: t.far, titleN: t.n};
    };
    // A window that has just become (in)active is redrawn a frame or more later, later still on a loaded machine: take pictures until two in
    // a row agree (at most 10 s), the title included. The thresholds below are unchanged; only the moment of measuring waits for the picture to settle.
    const buttons = async w => {
        let prev = await buttons1(w);
        for (let i = 0; i < 50; i++) {
            await sleep(200);
            const cur = await buttons1(w);
            if (hex(cur.add) === hex(prev.add) && hex(cur.menu) === hex(prev.menu) && hex(cur.strip) === hex(prev.strip)
                && hex(cur.title) === hex(prev.title) && cur.titleN === prev.titleN)
                return cur;
            prev = cur;
        }
        info(`${scheme}: the picture of a bar did not settle after 50 rounds of 200 ms (10 s): measuring the last one`);
        return prev;
    };
    const alpha = (now, active, strip) => Math.abs(grey(now) - grey(strip)) / Math.abs(grey(active) - grey(strip));
    const y = await open(1, 'yellow', DEFAULT);
    const yActive = await buttons(y);
    const r = await open(2, NOTE_RHEL_RED, DEFAULT);                 // the yellow window is not active now
    const yBack = await buttons(y);
    const rActive = await buttons(r);
    const rTitle = ink(rActive.s, area(r.titleLabel, r.win, rActive.s.width, rActive.s.height), rActive.strip);
    const z = await open(3, 'yellow', DEFAULT);                      // the red window is not active now
    const rBack = await buttons(r);
    const rTitleBack = ink(rBack.s, area(r.titleLabel, r.win, rBack.s.width, rBack.s.height), rBack.strip);

    const ay = alpha(yBack.add, yActive.add, yActive.strip), am = alpha(yBack.menu, yActive.menu, yActive.strip);
    const ra = alpha(rBack.add, rActive.add, rActive.strip), rm = alpha(rBack.menu, rActive.menu, rActive.strip);
    info(`${scheme} yellow (not changed by 0.2.4) in the backdrop: + at ${ay.toFixed(2)}, menu at ${am.toFixed(2)} of the active`);
    info(`${scheme} red in the backdrop: + at ${ra.toFixed(2)}, menu at ${rm.toFixed(2)} of the active`);
    info(`${scheme} red title: active ${hex(rTitle.far)} on ${hex(rActive.strip)} = ${contrast(rTitle.far, rActive.strip).toFixed(2)}:1; backdrop ${hex(rTitleBack.far)} on ${hex(rBack.strip)} = ${contrast(rTitleBack.far, rBack.strip).toFixed(2)}:1`);
    check(ay > 0.4 && ay < 0.6 && am > 0.4 && am < 0.6, `${scheme}: a window that is not active is made so (the buttons of a yellow one are at ${ay.toFixed(2)} and ${am.toFixed(2)} of their colour)`);
    check(ra > 0.4 && ra < 0.6 && rm > 0.4 && rm < 0.6, `${scheme}: the buttons of the red note are dimmed to about 50 % there too (${ra.toFixed(2)}, ${rm.toFixed(2)}), as without the title`);
    check(Math.abs(ra - ay) <= 0.06 && Math.abs(rm - am) <= 0.06, `${scheme}: the dimming of the red buttons equals that of the yellow ones (+ ${ra.toFixed(2)} / ${ay.toFixed(2)}, menu ${rm.toFixed(2)} / ${am.toFixed(2)})`);
    check(contrast(rTitle.far, rActive.strip) >= 5.5, `${scheme}: the title is ${contrast(rTitle.far, rActive.strip).toFixed(2)}:1 on the strip in the active window (>= 5.5)`);
    check(rTitleBack.n > 0 && contrast(rTitleBack.far, rBack.strip) >= 5.5, `${scheme}: the title is ${contrast(rTitleBack.far, rBack.strip).toFixed(2)}:1 on the strip in a window that is not active (>= 5.5)`);
    check(Math.abs(rTitleBack.n - rTitle.n) <= 0.05 * rTitle.n, `${scheme}: and it has as many pixels as in the active one (${rTitleBack.n} / ${rTitle.n})`);
    for (const w of [y, r, z])
        w.win.destroy();
}

// 3. the title on the smallest window, with the longest translation of the table and a text far longer than any
async function smallest(scheme) {
    const measureMin = w => w.win.measure(Gtk.Orientation.HORIZONTAL, -1)[0];
    const plain = await open(1, NOTE_RHEL_RED, {width: MIN_SIZE, height: 200});
    plain.titleLabel.set_label('');
    await sleep(300);
    const minPlain = measureMin(plain), addPlain = plain.addButton.get_width(), menuPlain = plain.menuButton.get_width();
    info(`${scheme} red without a title: minimum width ${minPlain}, window ${plain.win.get_width()} (MIN_SIZE ${MIN_SIZE}), buttons ${addPlain} and ${menuPlain} wide`);
    plain.win.destroy();
    for (const [n, label] of [[2, 'Tábhachtach'], [3, 'Wichtig'], [4, 'Dieser Titel ist viel länger als jede Übersetzung']]) {
        const w = await open(n, NOTE_RHEL_RED, {width: MIN_SIZE, height: 200});
        w.titleLabel.set_label(label);
        await sleep(300);
        const s = await shotOf(w.win);
        const min = measureMin(w), W = w.win.get_width();
        const t = ink(s, area(w.titleLabel, w.win, s.width, s.height), s.at(Math.floor(W / 2), 3));
        const [, ab] = w.addButton.compute_bounds(w.win), [, mb] = w.menuButton.compute_bounds(w.win);
        info(`${scheme} "${label}": minimum width ${min}, window ${W}, label ${w.titleLabel.get_width()} wide, ellipsized ${w.titleLabel.get_layout().is_ellipsized()}, ${t.n} text pixels, buttons ${w.addButton.get_width()} and ${w.menuButton.get_width()} wide`);
        check(min === minPlain, `${scheme} "${label}": the title does not widen the minimum width of the window (${min}, without a title ${minPlain})`);
        check(W === Math.max(MIN_SIZE, minPlain), `${scheme} "${label}": the window is as small as it can be (${W})`);
        check(w.addButton.get_width() === addPlain && w.menuButton.get_width() === menuPlain, `${scheme} "${label}": the buttons keep their width (${w.addButton.get_width()}, ${w.menuButton.get_width()})`);
        check(ab.get_x() >= 0 && mb.get_x() + mb.get_width() <= W && ab.get_x() + ab.get_width() <= mb.get_x(), `${scheme} "${label}": both buttons are inside the window and do not overlap`);
        check(w.titleLabel.get_width() > 0 && t.n > 0, `${scheme} "${label}": the title is still visible (${t.n} text pixels)`);
        if (label !== 'Wichtig')
            check(w.titleLabel.get_layout().is_ellipsized(), `${scheme} "${label}": it is cut with an ellipsis, not squeezed`);
        w.win.destroy();
    }
    // the normal window: the title is whole and in the middle, as before
    const w = await open(5, NOTE_RHEL_RED, DEFAULT);
    const s = await shotOf(w.win);
    const t = ink(s, area(w.titleLabel, w.win, s.width, s.height), s.at(Math.floor(s.width / 2), 3));
    check(!w.titleLabel.get_layout().is_ellipsized(), `${scheme}: on the normal window "${w.titleLabel.get_label()}" is not cut`);
    check(Math.abs((t.x0 + t.x1) / 2 - s.width / 2) <= 2, `${scheme}: and it stays in the middle (centre ${((t.x0 + t.x1) / 2).toFixed(1)} of ${s.width / 2})`);
    w.win.destroy();
}

async function scenario() {
    await ctl.ready;
    const [, first] = [...ctl.windows][0];
    first.win.set_visible(false);       // the window of the first run is not measured
    for (const scheme of ['light', 'dark']) {
        Adw.StyleManager.get_default().set_color_scheme(scheme === 'dark' ? Adw.ColorScheme.FORCE_DARK : Adw.ColorScheme.FORCE_LIGHT);
        await sleep(300);
        await bold(scheme);
        await backdrop(scheme);
        await smallest(scheme);
    }
}

scenario().then(() => {}, e => { failed++; print(`FAIL exception ${e}\n${e.stack}`); }).finally(() => {
    print(`${checks - failed}/${checks} checks passed`);
    print(failed === 0 ? 'RESULT PASS' : 'RESULT FAIL');
    GLib.spawn_command_line_async(`rm -rf ${base}`);
    ctl.gtkApp.quit();
});
const status = ctl.run([]);
imports.system.exit(failed === 0 ? status : 1);
