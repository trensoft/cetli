// SPDX-License-Identifier: GPL-3.0-or-later
// Headless test of the RENDERED formatting bar (app/format-bar.js): the note window is drawn to a PNG and the pixels of a button are
// measured on several kinds of notes in the light and the dark theme: the "a" against the note (>= 4.5:1 off, >= 4.1:1 on, the
// lower value is the 16 % tone of a pressed button on RHEL red, Wanda's spec 7), the 1 px outline of a button that is on (>= 3:1),
// no outline when it is off. Run it like gtk-smoke.js, inside a headless Wayland compositor:
// headless.sh 1920x1080 -- gjs -m app-tests/format-bar-render-smoke.js
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import GdkPixbuf from 'gi://GdkPixbuf';
import Graphene from 'gi://Graphene';

import {createApp} from '../app/application.js';

const base = GLib.dir_make_tmp('cetli-fmtrender-XXXXXX');
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
const lin = c => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const hex = c => `#${c.map(v => v.toString(16).padStart(2, '0')).join('')}`;

function shoot(widget, path) {
    const w = widget.get_width(), h = widget.get_height();
    const snap = new Gtk.Snapshot();
    new Gtk.WidgetPaintable({widget}).snapshot(snap, w, h);
    widget.get_native().get_renderer().render_texture(snap.to_node(), new Graphene.Rect().init(0, 0, w, h)).save_to_png(path);
    const pb = GdkPixbuf.Pixbuf.new_from_file(path);
    const px = pb.get_pixels(), n = pb.get_n_channels(), stride = pb.get_rowstride();
    const at = (x, y) => { const o = Math.floor(y) * stride + Math.floor(x) * n; return [px[o], px[o + 1], px[o + 2]]; };
    return {w, h, at};
}

const ctl = createApp({dirs});

// The buttons are put into the state to be drawn by hand: the selection of a headless window collapses within 40 ms by itself
// (also in the tree without a formatting bar), and without a selection the bar would switch the buttons off again.
async function drawn(w, name, on) {
    w.bar.refresh = () => {};
    w.bar.syncing = true;
    for (const button of w.bar.buttons.values()) {
        button.set_sensitive(true);
        button.set_active(false);
    }
    w.bar.buttons.get(1).set_active(on);
    w.bar.syncing = false;
    await sleep(500);                          // the theme animates a button's tone for 200 ms
    const shot = shoot(w.win, `${base}/${name}.png`);
    const bold = w.bar.buttons.get(1);
    return {shot, sensitive: bold.get_sensitive(), active: bold.get_active()};
}

async function scenario() {
    await ctl.ready;
    const [, w] = [...ctl.windows][0];
    w.buffer.set_text('hello world', -1);
    const bold = w.bar.buttons.get(1);
    for (const scheme of ['light', 'dark']) {
        Adw.StyleManager.get_default().set_color_scheme(scheme === 'dark' ? Adw.ColorScheme.FORCE_DARK : Adw.ColorScheme.FORCE_LIGHT);
        for (const color of ['yellow', 'pink', 'gray', '#ee0000', '#3f3d3c', '#ffffff', '#336699']) {
            w.setColor(color);
            w.bar.setRanges([]);
            await sleep(500);
            const [ok, r] = bold.compute_bounds(w.win);
            if (!ok) {
                check(false, `${scheme} ${color}: the bold button has bounds`);
                continue;
            }
            const x0 = Math.floor(r.get_x()), y0 = Math.floor(r.get_y()), x1 = Math.ceil(r.get_x() + r.get_width()), y1 = Math.ceil(r.get_y() + r.get_height());
            for (const on of [false, true]) {
                const {shot, sensitive, active} = await drawn(w, `${scheme}-${color.replace('#', '')}-${on ? 'on' : 'off'}`, on);
                const bg = shot.at(x0 - 4, (y0 + y1) / 2);                       // the bar, left of the first button
                const edge = shot.at(x0 + 0.5, (y0 + y1) / 2);                   // the outline of a button that is on
                let best = 0;
                for (let y = y0 + 4; y < y1 - 4; y++) {
                    for (let x = x0 + 4; x < x1 - 4; x++)
                        best = Math.max(best, contrast(shot.at(x, y), bg));
                }
                const label = `${scheme} ${color} ${on ? 'on' : 'off'}`;
                if (!sensitive || active !== on) {
                    check(false, `${label}: the button is enabled and ${on ? 'on' : 'off'} while drawn (sensitive ${sensitive}, active ${active})`);
                    continue;
                }
                check(best >= (on ? 4.1 : 4.5), `${label}: the "a" is ${best.toFixed(2)}:1 against the note (>= ${on ? 4.1 : 4.5})`);
                if (on)
                    check(contrast(edge, bg) >= 3, `${label}: the outline is ${contrast(edge, bg).toFixed(2)}:1 (${hex(edge)} on ${hex(bg)}, >= 3)`);
                else
                    check(near(edge, bg, 6), `${label}: no outline when off (${hex(edge)} on ${hex(bg)})`);
            }
        }
    }
    Adw.StyleManager.get_default().set_color_scheme(Adw.ColorScheme.DEFAULT);
}

scenario().then(() => {}, e => { failed++; print(`FAIL exception ${e}\n${e.stack}`); }).finally(() => {
    print(`${checks - failed}/${checks} checks passed`);
    print(failed === 0 ? 'RESULT PASS' : 'RESULT FAIL');
    GLib.spawn_command_line_async(`rm -rf ${base}`);
    ctl.gtkApp.quit();
});
const status = ctl.run([]);
imports.system.exit(failed === 0 ? status : 1);
