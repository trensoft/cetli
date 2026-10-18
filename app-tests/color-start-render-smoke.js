// SPDX-License-Identifier: GPL-3.0-or-later
// Headless test of the RENDERED text colour of a note window that is BUILT from a saved note (the way a note starts from its file),
// as opposed to color-render-smoke.js, which changes the colour of a window that is already shown. 0.2.3 drew black text on every
// custom colour (the red, #3f3d3c, #336699 ...) when a window was built from a record: the computed `color` of the text view was
// right and the drawn text was not, so only the pixels tell. The text colour is measured on the first line (the caret is on the
// last one). Run it like gtk-smoke.js, inside a headless Wayland compositor:
// headless.sh 1920x1080 -- gjs -m app-tests/color-start-render-smoke.js
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import GdkPixbuf from 'gi://GdkPixbuf';
import Graphene from 'gi://Graphene';

import {createApp} from '../app/application.js';
import {NOTE_BLACK, NOTE_RHEL_RED, NOTE_WHITE} from '../app/data.js';
import {NoteWindow} from '../app/window.js';

// The text of a custom colour of the grid, by the measurement of THIS file: black or white, whichever contrasts more; the red
// of the grid gets white (Attila's choice, white on #ee0000 is 4.53:1).
const expectedCustomText = c => (hex(c) === '#ee0000' || contrast(c, [255, 255, 255]) > contrast(c, [0, 0, 0]) ? [255, 255, 255] : [0, 0, 0]);

const base = GLib.dir_make_tmp('cetli-render-XXXXXX');
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

// Independent of data.js: WCAG 2.x contrast and CIELAB (D65).
const lin = c => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
const lab = c => {
    const [r, g, b] = c.map(lin);
    const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    const f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
};
const dE = (a, b) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]));
const chroma = c => Math.hypot(lab(c)[1], lab(c)[2]);
const hex = c => `#${c.map(v => v.toString(16).padStart(2, '0')).join('')}`;

// The note window drawn to a PNG and read back: the most frequent colour of the body, and the pixel farthest in luminance from it
// within the y band of the FIRST text line (the core of a letter; the caret is on the second line).
function measure(w, path) {
    const win = w.win, width = win.get_width(), height = win.get_height();
    const snap = new Gtk.Snapshot();
    new Gtk.WidgetPaintable({widget: win}).snapshot(snap, width, height);
    win.get_native().get_renderer().render_texture(snap.to_node(), new Graphene.Rect().init(0, 0, width, height)).save_to_png(path);
    const pb = GdkPixbuf.Pixbuf.new_from_file(path);
    const px = pb.get_pixels(), n = pb.get_n_channels(), stride = pb.get_rowstride();
    const at = (x, y) => [px[y * stride + x * n], px[y * stride + x * n + 1], px[y * stride + x * n + 2]];
    const count = new Map();
    for (let y = 45; y < height - 2; y++) {
        for (let x = 2; x < width - 2; x++) {
            const k = at(x, y).join();
            count.set(k, (count.get(k) ?? 0) + 1);
        }
    }
    const body = [...count].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number);
    const r = w.buffer.get_iter_at_line(0);
    const loc = w.view.get_iter_location(Array.isArray(r) ? r[1] : r);
    const [, pt] = w.view.compute_point(win, new Graphene.Point({x: 0, y: loc.y}));
    const y0 = Math.max(45, Math.floor(pt.y)), y1 = Math.min(height - 2, Math.ceil(pt.y + loc.height));
    let text = body;
    for (let y = y0; y < y1; y++) {
        for (let x = 2; x < width - 2; x++) {
            const c = at(x, y);
            if (Math.abs(lum(c) - lum(body)) > Math.abs(lum(text) - lum(body)))
                text = c;
        }
    }
    return {body, text};
}

const ctl = createApp({dirs});

async function scenario() {
    await ctl.ready;
    const [, first] = [...ctl.windows][0];
    first.win.set_visible(false);       // the window of the first run is not measured; the ones below are built from records
    const now = new Date().toISOString();
    const record = (n, color) => ({schema: 1, id: `00000000-0000-4000-8000-00000000000${n}`, rev: 1, updated: now, created: now, device: 'b5b5b5b5', color, text: 'Milk\nBread', deleted: false, conflict_of: null});
    // every kind of colour a file can carry: the red, the black and the white of the grid, a free custom colour, a name
    const colors = [NOTE_RHEL_RED, NOTE_BLACK, NOTE_WHITE, '#336699', 'yellow', 'blue'];
    for (const scheme of ['light', 'dark']) {
        Adw.StyleManager.get_default().set_color_scheme(scheme === 'dark' ? Adw.ColorScheme.FORCE_DARK : Adw.ColorScheme.FORCE_LIGHT);
        await sleep(300);
        for (const [n, color] of colors.entries()) {
            const w = new NoteWindow({ctl: ctl.ctl, record: record(n + 1, color), size: {width: 300, height: 260}});
            w.present();
            await sleep(700);
            const {body, text} = measure(w, `${base}/${scheme}-${color.replace('#', 'x')}.png`);
            const custom = color.startsWith('#');
            // a name: the text colour of the theme as measured on the pixels (#2b2b2b light, #f2f2f2 dark)
            const want = custom ? expectedCustomText([1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16))) : (scheme === 'dark' ? [242, 242, 242] : [43, 43, 43]);
            check(w.win.has_css_class('cetli-dark') === (scheme === 'dark'), `${scheme} ${color}: the window follows the colour scheme`);
            check(!custom || hex(body) === color, `${scheme} ${color}: a window built from a record has the fill ${hex(body)}`);
            check(text.every((v, i) => Math.abs(v - want[i]) <= 3), `${scheme} ${color}: a window built from a record draws the text in ${hex(want)} (measured ${hex(text)})`);
            w.win.destroy();
        }
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
