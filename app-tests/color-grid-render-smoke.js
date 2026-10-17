// SPDX-License-Identifier: GPL-3.0-or-later
// Headless test of the RENDERED colour grid of the hamburger menu (app/window.js): the popover is opened, the grid is drawn to a
// PNG and measured from the pixels: the fill of every circle, its 1 px border (light and dark theme), the ring and the badge of
// the selected circle only, the size of the circles and of the grid. Also the keyboard: the invisible picker over the + circle is
// reached with Tab and the circle shows the focus. Run it like gtk-smoke.js, inside a headless Wayland compositor:
// headless.sh 1920x1080 -- gjs -m app-tests/color-grid-render-smoke.js
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import GdkPixbuf from 'gi://GdkPixbuf';
import Graphene from 'gi://Graphene';

import {createApp} from '../app/application.js';
import {GRID_COLORS, MIN_DELTA_E, NOTE_BLACK, PALETTE, parseCustomColor} from '../app/data.js';

const base = GLib.dir_make_tmp('cetli-gridrender-XXXXXX');
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
// CIELAB (D65), dE76, as in color-render-smoke.js
const lab = c => {
    const [r, g, b] = c.map(lin);
    const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    const f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
};
const dE = (a, b) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]));
// The ONE named exception to the minimum distance of two circles (the Sticky Notes sample has the same pair at 12.9): the gray and
// the white. It is not a general loosening: every other pair must reach MIN_DELTA_E.
const EXCEPTIONS = new Map([['gray|#ffffff', 12]]);
const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const hex = c => `#${c.map(v => v.toString(16).padStart(2, '0')).join('')}`;
const rgbOf = s => {
    const c = parseCustomColor(s);
    return [c.r, c.g, c.b];
};

// The popover (with its background) drawn to a PNG and read back: at(x, y) -> [r, g, b] in the coordinates of the popover.
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

// The centre of a circle in the coordinates of the popover (get_width() is the width inside the 1 px border).
const centre = (popover, button) => {
    const [ok, p] = button.compute_point(popover, new Graphene.Point().init(button.get_width() / 2, button.get_height() / 2));
    return ok ? {x: p.x, y: p.y} : null;
};

async function scenario() {
    await ctl.ready;
    const [, w] = [...ctl.windows][0];
    const grid = w.dots.get(GRID_COLORS[0]).button.get_ancestor(Gtk.Grid);
    const popover = w.menuPopover;
    const accent = (() => {
        const [ok, c] = w.win.get_style_context().lookup_color('accent_bg_color');
        return ok ? [c.red, c.green, c.blue].map(v => Math.round(v * 255)) : null;
    })();
    check(accent !== null, `the accent colour of the theme is known (${accent && hex(accent)})`);

    w.setColor('yellow');
    const fills = new Map();
    for (const scheme of ['light', 'dark']) {
        Adw.StyleManager.get_default().set_color_scheme(scheme === 'dark' ? Adw.ColorScheme.FORCE_DARK : Adw.ColorScheme.FORCE_LIGHT);
        await sleep(300);
        w.menuButton.popup();
        await sleep(700);
        check(grid.get_mapped(), `${scheme}: the popover is open and the grid is drawn`);
        const shot = shoot(popover, `${base}/grid-${scheme}.png`);
        const cellOf = v => w.dots.get(v).button.get_parent();
        check(grid.get_width() === 220 && GRID_COLORS.every(v => cellOf(v).get_width() === 36 && cellOf(v).get_height() === 36),
            `${scheme}: the circles are 36 px, the grid is ${grid.get_width()} px wide (want 220)`);
        const gap = centre(popover, w.dots.get('green').button);
        const bg = shot.at(gap.x + 23, gap.y);       // the popover between two circles

        GRID_COLORS.forEach((value, i) => {
            const button = w.dots.get(value).button;
            const c = centre(popover, button);
            if (c === null)
                return;
            const fill = shot.at(c.x, c.y + 8);
            const want = rgbOf(PALETTE[value] ? PALETTE[value].lightHeader : value);
            if (scheme === 'light')
                fills.set(value, fill);
            check(near(fill, want, 3), `${scheme}: circle ${i + 1} (${value}) is filled ${hex(fill)}, want ${hex(want)}`);
            // the 1 px border: the outermost ring of pixels is drawn over the popover: half black (light theme) or half white (dark theme)
            const edge = shot.at(c.x - 17.5, c.y);
            const wantEdge = scheme === 'light' ? bg.map(v => v * 0.5) : bg.map(v => (v + 255) / 2);
            // (GTK draws the border of the circle that has the ring over its own fill, not over the popover)
            const overFill = scheme === 'light' ? fill.map(v => v * 0.5) : fill.map(v => (v + 255) / 2);
            const wantNow = value === 'yellow' ? overFill : wantEdge;
            check(near(edge, wantNow, 14), `${scheme}: circle ${i + 1} (${value}) has its 1 px border: edge ${hex(edge)}, want about ${hex(wantNow.map(Math.round))}`);
            // the ring: only around the selected circle; the badge: only on the selected circle, in its bottom right corner
            const ring = shot.at(c.x + 21, c.y);
            const badge = shot.at(c.x + 3.5, c.y + 10);          // the badge is a 16 px circle at the bottom right; its tick is in the middle, this is beside it
            const selected = value === 'yellow';
            check(selected ? (accent !== null && near(ring, accent, 12)) : near(ring, bg, 4),
                `${scheme}: circle ${i + 1} (${value}) ${selected ? 'has' : 'has no'} ring (pixel ${hex(ring)}, ${selected ? 'accent' : 'background'} ${hex(selected ? accent ?? [0, 0, 0] : bg)})`);
            check(selected ? (accent !== null && near(badge, accent, 12)) : near(badge, fill, 12),
                `${scheme}: circle ${i + 1} (${value}) ${selected ? 'has' : 'has no'} badge (pixel ${hex(badge)})`);
        });
        // the custom circle: neutral with a +, no ring
        const cc = centre(popover, w.customDot.button);
        const cfill = shot.at(cc.x + 3.5, cc.y + 10);
        check(near(shot.at(cc.x + 21, cc.y), bg, 4) && !near(cfill, [255, 0, 0], 10), `${scheme}: the custom circle has no ring and is neutral (${hex(cfill)})`);
        w.menuPopover.popdown();
        await sleep(300);
    }

    // the circles are told apart from each other: every two rendered fills are MIN_DELTA_E apart, but the named pair
    for (const a of GRID_COLORS) {
        for (const b of GRID_COLORS) {
            if (a < b && fills.has(a) && fills.has(b)) {
                const limit = EXCEPTIONS.get(`${a}|${b}`) ?? EXCEPTIONS.get(`${b}|${a}`) ?? MIN_DELTA_E;
                const d = dE(fills.get(a), fills.get(b));
                check(d >= limit, `rendered circle fills ${a}/${b} are ${d.toFixed(1)} apart (>= ${limit}${limit === MIN_DELTA_E ? '' : ', named exception'})`);
            }
        }
    }
    // positive control: the same rule rejects a pair that is too close
    check(dE(rgbOf('#ffffff'), rgbOf('#f4f4f4')) < MIN_DELTA_E, 'control: white and #f4f4f4 are too close for the rule (it would fail)');

    // the custom circle takes the colour of a note that no circle has, with ring and badge
    Adw.StyleManager.get_default().set_color_scheme(Adw.ColorScheme.FORCE_LIGHT);
    await sleep(300);
    w.setColor('#336699');
    w.menuButton.popup();
    await sleep(700);
    const shot = shoot(popover, `${base}/grid-custom.png`);
    const cc = centre(popover, w.customDot.button);
    check(near(shot.at(cc.x - 12, cc.y - 8), [0x33, 0x66, 0x99], 3), `a #336699 note: the custom circle is filled ${hex(shot.at(cc.x - 12, cc.y - 8))}`);
    check(accent !== null && near(shot.at(cc.x + 21, cc.y), accent, 12) && near(shot.at(cc.x + 3.5, cc.y + 10), accent, 12), 'and it has the ring and the badge');
    for (const value of GRID_COLORS)
        check(near(shot.at(centre(popover, w.dots.get(value).button).x + 21, centre(popover, w.dots.get(value).button).y), shot.at(centre(popover, w.dots.get('green').button).x + 23, centre(popover, w.dots.get('green').button).y), 4), `and ${value} has no ring`);

    // the mark label ("deleted on the other computer", ...) on the fixed colours: full opacity (0.85 on the red is 3.47:1)
    w.menuPopover.popdown();
    await sleep(300);
    w.markLabel.set_label('MMMMMMMMMM');
    w.markLabel.set_visible(true);
    const contrast = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    for (const color of ['#ee0000', NOTE_BLACK, '#336699']) {
        w.setColor(color);
        await sleep(500);
        const win = shoot(w.win, `${base}/mark-${color.slice(1)}.png`);
        const [ok, r] = w.markLabel.compute_bounds(w.win);
        const back = win.at(r.get_x() + 1, r.get_y() + 1);
        let text = back;
        // (inset: the rounded corners and the border of the window are not text)
        for (let y = Math.floor(r.get_y()) + 4; y < r.get_y() + r.get_height() - 4; y++) {
            for (let x = Math.floor(r.get_x()) + 10; x < r.get_x() + r.get_width() - 10; x++) {
                const c = win.at(x, y);
                if (Math.abs(lum(c) - lum(back)) > Math.abs(lum(text) - lum(back)))
                    text = c;
            }
        }
        check(ok && contrast(text, back) >= 4.5, `a ${color} note: the mark text ${hex(text)} on ${hex(back)} is ${contrast(text, back).toFixed(2)}:1 (>= 4.5, full opacity)`);
    }

    w.markLabel.set_visible(false);
    w.menuButton.popup();
    await sleep(700);
    // the keyboard: Tab goes through the popover; the invisible picker must be reached and the circle must show it
    // the widget in the popover that has the focus: down the chain of focus children
    const focused = () => {
        let f = popover.get_focus_child();
        while (f?.get_focus_child?.())
            f = f.get_focus_child();
        return f ?? null;
    };
    const reached = [];
    let focusShown = false;
    for (let i = 0; i < 30; i++) {
        popover.child_focus(Gtk.DirectionType.TAB_FORWARD);
        const f = focused();
        if (f === null)
            continue;
        const inPicker = f.get_ancestor(Gtk.ColorButton) !== null || f === w.customPicker || f.get_ancestor(w.customPicker.constructor) !== null;
        reached.push(inPicker ? 'picker' : f.get_action_name?.() ?? f.constructor.name);
        if (inPicker) {
            focusShown = w.customDot.button.has_css_class('cetli-dot-focus');
            break;
        }
    }
    print(`info Tab order reached: ${reached.join(' > ')}`);
    check(reached.includes('picker'), 'the invisible picker over the + circle is reached with Tab');
    check(focusShown, 'while the picker has the focus, the + circle shows it (cetli-dot-focus)');
    popover.child_focus(Gtk.DirectionType.TAB_FORWARD);
    check(!w.customDot.button.has_css_class('cetli-dot-focus') || focused()?.get_ancestor(Gtk.ColorButton) !== null, 'the focus ring leaves with the focus');
    w.menuPopover.popdown();
}

scenario().then(() => {}, e => { failed++; print(`FAIL exception ${e}\n${e.stack}`); }).finally(() => {
    print(`${checks - failed}/${checks} checks passed`);
    print(failed === 0 ? 'RESULT PASS' : 'RESULT FAIL');
    GLib.spawn_command_line_async(`rm -rf ${base}`);
    ctl.gtkApp.quit();
});
const status = ctl.run([]);
imports.system.exit(failed === 0 ? status : 1);
