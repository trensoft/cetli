// SPDX-License-Identifier: GPL-3.0-or-later
// Headless test of the RENDERED colours of a note window (app/window.js + the stylesheet of app/data.js): every menu colour is
// drawn to a PNG in the light and in the dark theme and measured from the pixels (background, header strip, text), not from the
// constants of data.js. Run it like gtk-smoke.js, inside a headless Wayland compositor:
// headless.sh 1920x1080 -- gjs -m app-tests/color-render-smoke.js
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import GdkPixbuf from 'gi://GdkPixbuf';
import Graphene from 'gi://Graphene';

import {createApp} from '../app/application.js';
import {COLORS, GRID_COLORS, MIN_CONTRAST, MIN_DELTA_E, TEXT_DARK, TEXT_LIGHT} from '../app/data.js';

// The pink of 0.2.0 had a CIELAB chroma of 18.6 and was found too saturated; the limit for a pastel fill is below that. The pink of
// Sticky Notes (#ffe3f1, the 0.2.2 value) measures 12.3, so the limit is 13 (it was 12 for the 0.2.1 pink, chroma 9.2).
const MAX_PINK_CHROMA = 13;
// WCAG AA for normal text, the gate of the grid colours (the named pastels keep the stricter MIN_CONTRAST).
const AA = 4.5;
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

// The note window drawn to a PNG and read back: {body, header, text} as [r, g, b]. body and header are the most frequent
// colours of the body and of the top rows; text is the pixel farthest in luminance from the body (the core of a letter).
function measure(win, path) {
    const w = win.get_width(), h = win.get_height();
    const snap = new Gtk.Snapshot();
    new Gtk.WidgetPaintable({widget: win}).snapshot(snap, w, h);
    win.get_native().get_renderer().render_texture(snap.to_node(), new Graphene.Rect().init(0, 0, w, h)).save_to_png(path);
    const pb = GdkPixbuf.Pixbuf.new_from_file(path);
    const px = pb.get_pixels(), n = pb.get_n_channels(), stride = pb.get_rowstride();
    const at = (x, y) => [px[y * stride + x * n], px[y * stride + x * n + 1], px[y * stride + x * n + 2]];
    const mode = (x0, x1, y0, y1) => {
        const count = new Map();
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                const k = at(x, y).join();
                count.set(k, (count.get(k) ?? 0) + 1);
            }
        }
        return [...count].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number);
    };
    const header = mode(Math.floor(w / 3), Math.floor(2 * w / 3), 2, 10);
    const body = mode(2, w - 2, 45, h - 2);
    let text = body;
    for (let y = 45; y < h - 2; y++) {
        for (let x = 2; x < w - 2; x++) {
            const c = at(x, y);
            if (Math.abs(lum(c) - lum(body)) > Math.abs(lum(text) - lum(body)))
                text = c;
        }
    }
    return {body, header, text};
}

const ctl = createApp({dirs});

async function scenario() {
    await ctl.ready;
    const [, w] = [...ctl.windows][0];
    w.buffer.set_text('Milk\nBread\nCall the bank about the loan', -1);
    const lightFills = new Map();          // the strips: the circles of the grid (distance rule)
    const lightBodies = new Map();         // the bodies (pastel chroma rule)
    for (const [scheme, textColor] of [['light', TEXT_LIGHT], ['dark', TEXT_DARK]]) {
        Adw.StyleManager.get_default().set_color_scheme(scheme === 'dark' ? Adw.ColorScheme.FORCE_DARK : Adw.ColorScheme.FORCE_LIGHT);
        await sleep(300);
        check(w.win.has_css_class('cetli-dark') === (scheme === 'dark'), `${scheme}: the window follows the colour scheme`);
        const want = [1, 3, 5].map(i => parseInt(textColor.slice(i, i + 2), 16));
        for (const name of GRID_COLORS) {
            const custom = name.startsWith('#');
            w.setColor(name);
            await sleep(450);
            const {body, header, text} = measure(w.win, `${base}/${scheme}-${name.replace('#', 'x')}.png`);
            const label = `${scheme} ${name}: fill ${hex(body)}, strip ${hex(header)}, text ${hex(text)}`;
            const wantText = custom ? expectedCustomText([1, 3, 5].map(i => parseInt(name.slice(i, i + 2), 16))) : want;
            if (custom)
                check(hex(body) === name, `${label}: the fill is the custom colour ${name} in both themes`);
            check(text.every((v, i) => Math.abs(v - wantText[i]) <= 2), `${label}: the text pixels have the expected colour ${hex(wantText)}`);
            check(contrast(text, body) >= AA, `${label}: text/fill contrast ${contrast(text, body).toFixed(2)} >= ${AA} (AA)`);
            check(contrast(text, header) >= AA, `${label}: text/strip contrast ${contrast(text, header).toFixed(2)} >= ${AA} (AA)`);
            if (!custom) {
                const gate = MIN_CONTRAST;
                check(contrast(text, body) >= gate, `${label}: text/fill contrast ${contrast(text, body).toFixed(2)} >= ${gate}`);
                check(contrast(text, header) >= gate, `${label}: text/strip contrast ${contrast(text, header).toFixed(2)} >= ${gate}`);
            }
            if (scheme === 'light' && !custom)
                lightFills.set(name, header), lightBodies.set(name, body);
        }
    }
    for (const a of COLORS) {
        for (const b of COLORS) {
            if (a < b) {
                check(dE(lightFills.get(a), lightFills.get(b)) >= MIN_DELTA_E, `rendered light circle fills (the strips) ${a}/${b} are ${dE(lightFills.get(a), lightFills.get(b)).toFixed(1)} apart (>= ${MIN_DELTA_E})`);
            }
        }
    }
    const pink = lightBodies.get('pink');
    check(chroma(pink) <= MAX_PINK_CHROMA, `the rendered light pink ${hex(pink)} is a pastel: CIELAB chroma ${chroma(pink).toFixed(1)} <= ${MAX_PINK_CHROMA}`);
}

scenario().then(() => {}, e => { failed++; print(`FAIL exception ${e}\n${e.stack}`); }).finally(() => {
    print(`${checks - failed}/${checks} checks passed`);
    print(failed === 0 ? 'RESULT PASS' : 'RESULT FAIL');
    GLib.spawn_command_line_async(`rm -rf ${base}`);
    ctl.gtkApp.quit();
});
const status = ctl.run([]);
imports.system.exit(failed === 0 ? status : 1);
