// SPDX-License-Identifier: GPL-3.0-or-later
// The colour layer of app/data.js: the palette (measured contrast and distance), the custom colour `#rrggbb` that arrives from a
// note FILE (untrusted: strict parse, CSS built from numbers, injection vectors) and the automatic text colour.
// The measuring code here is independent of data.js (WCAG 2.x contrast, CIELAB dE76), so that a wrong formula there is caught.
import test from 'node:test';
import assert from 'node:assert/strict';

import * as data from '../app/data.js';
import {
    COLORS, DELTA_E_EXCEPTIONS, GRID_COLORS, KNOWN_COLORS, LEGACY_COLORS, MIN_DELTA_E, NOTE_BLACK, NOTE_RHEL_RED, NOTE_WHITE, PALETTE,
    TEXT_DARK, TEXT_LIGHT, buildCss, cssClassOf, customColorStyle, isCustomColor, normalizeCustomColor, parseCustomColor, textColorFor,
} from '../app/data.js';
import {NOTE_COLOR_IDS} from '../src/colors.js';

const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const lin = c => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const lum = h => {
    const [r, g, b] = hex(h).map(lin);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
const lab = h => {
    const [r, g, b] = hex(h).map(lin);
    const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    const f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
};
const dE = (a, b) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]));
const toHex = ({r, g, b}) => `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;

test('palette: the menu names are yellow, pink, green, purple, blue, gray; orange, mint, peach are known but not offered', () => {
    assert.deepEqual([...COLORS], ['yellow', 'pink', 'green', 'purple', 'blue', 'gray']);
    assert.deepEqual([...COLORS], [...NOTE_COLOR_IDS]);
    assert.deepEqual([...LEGACY_COLORS], ['orange', 'mint', 'peach']);
    for (const old of LEGACY_COLORS) {
        assert.equal(COLORS.includes(old), false, old);
        assert.equal(KNOWN_COLORS.includes(old), true, old);
        assert.ok(PALETTE[old], old);
        assert.ok(buildCss().includes(`window.cetli-${old} {`), old);
        assert.equal(buildCss().includes(`cetli-swatch-${old}`), false, old);
    }
    assert.ok(buildCss().includes('cetli-swatch-gray'));
    for (const name of KNOWN_COLORS)
        assert.equal(cssClassOf(name), `cetli-${name}`, `${name} stays a known value (an old note must not turn yellow)`);
});

test('grid: GRID_COLORS are these 9 values in this order: six names, then black, white and red as custom #rrggbb', () => {
    assert.deepEqual([...GRID_COLORS], ['yellow', 'pink', 'green', 'purple', 'blue', 'gray', '#3f3d3c', '#ffffff', '#ee0000']);
    assert.ok(Object.isFrozen(GRID_COLORS));
    assert.deepEqual(GRID_COLORS.slice(0, 6), [...COLORS]);
    for (const c of GRID_COLORS.slice(6))
        assert.equal(isCustomColor(c), true, `${c}: no new NAME (an old client would show it as yellow)`);
    assert.equal(new Set(GRID_COLORS).size, 9);
});

// The menu (app/window.js, strings.js) imports these three names: a missing export would stop the module from loading.
test('grid: NOTE_BLACK, NOTE_WHITE and NOTE_RHEL_RED are exported, one line each, and GRID_COLORS is built from them', () => {
    for (const name of ['NOTE_BLACK', 'NOTE_WHITE', 'NOTE_RHEL_RED'])
        assert.equal(typeof data[name], 'string', `${name} missing from app/data.js`);
    assert.deepEqual([NOTE_BLACK, NOTE_WHITE, NOTE_RHEL_RED], ['#3f3d3c', '#ffffff', '#ee0000']);
    assert.deepEqual([...GRID_COLORS.slice(6)], [NOTE_BLACK, NOTE_WHITE, NOTE_RHEL_RED]);
    // the black is the Sticky Notes charcoal header: white text 10.80:1
    assert.ok(contrast(NOTE_BLACK, '#ffffff') >= 10.8 && contrast(NOTE_BLACK, '#ffffff') < 10.9, `${contrast(NOTE_BLACK, '#ffffff')}`);
});

test('custom colour: normalizeCustomColor writes lower case only (an upper case #EE0000 shows as yellow in 0.1.0 and 0.2.0)', () => {
    assert.equal(normalizeCustomColor('#EE0000'), '#ee0000');
    assert.equal(normalizeCustomColor('#AaBbCc'), '#aabbcc');
    assert.equal(normalizeCustomColor('#ee0000'), '#ee0000');
    assert.equal(isCustomColor(normalizeCustomColor('#EE0000')), true);
    // positive control: the input itself is NOT a valid stored colour, so without the normalisation the test would see the difference
    assert.equal(isCustomColor('#EE0000'), false);
    for (const bad of ['#EE000', '#EE00000', 'EE0000', '#GG0000', '#ee0000\n', ' #ee0000', '', null, undefined, 42, {}, ['#ee0000']])
        assert.equal(normalizeCustomColor(bad), null, JSON.stringify(bad));
});

test('palette: the yellow is paler than the old #f6e58d', () => {
    assert.ok(lum(PALETTE.yellow.light) > lum('#f6e58d'));
});

test('palette: all 6 named menu fills (and their strips) have contrast >= 7:1 against the light text, and against black', () => {
    for (const name of COLORS) {
        for (const key of ['light', 'lightHeader']) {
            assert.ok(contrast(PALETTE[name][key], TEXT_LIGHT) >= 7, `${name}.${key} vs TEXT_LIGHT ${contrast(PALETTE[name][key], TEXT_LIGHT)}`);
            assert.ok(contrast(PALETTE[name][key], '#000000') >= 7, `${name}.${key} vs black`);
        }
    }
});

// The dark side is the 0.2.1 values (not Sticky Notes: its mid-tone dark fills measure 4.77:1 to 5.65:1, below the gate): 7:1 holds.
test('palette: dark theme: every dark fill and strip has contrast >= 7:1 against the light text colour', () => {
    for (const name of KNOWN_COLORS) {
        for (const key of ['dark', 'darkHeader'])
            assert.ok(contrast(PALETTE[name][key], TEXT_DARK) >= 7, `${name}.${key} ${contrast(PALETTE[name][key], TEXT_DARK)}`);
    }
});

const circleFill = c => (isCustomColor(c) ? c : PALETTE[c].lightHeader);
const isException = (a, b) => DELTA_E_EXCEPTIONS.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

// The circles of the grid are the strips (lightHeader) of the names and the three custom values. The general floor is 15; the one
// named exception is gray/white (12.9 apart in the Sticky Notes sample itself), not a global loosening.
test('grid: any two circles are >= 15 apart (CIELAB dE76), except the one named pair gray/white', t => {
    assert.equal(MIN_DELTA_E, 15);
    assert.deepEqual(DELTA_E_EXCEPTIONS.map(p => [...p]), [['gray', '#ffffff']]);
    const rows = [];
    for (const a of GRID_COLORS) {
        for (const b of GRID_COLORS) {
            if (a >= b)
                continue;
            const d = dE(circleFill(a), circleFill(b));
            rows.push(`${a}/${b} ${d.toFixed(1)}${isException(a, b) ? ' (named exception)' : ''}`);
            if (!isException(a, b))
                assert.ok(d >= 15, `${a}/${b} ${d}`);
        }
    }
    t.diagnostic(`\n${rows.join('\n')}`);
});

test('grid: the named exception is exact: gray/white is below 15 and above 12; a made-up too close pair still fails the rule', () => {
    const d = dE(circleFill('gray'), circleFill(NOTE_WHITE));
    assert.ok(d > 12 && d < 15, `${d}`);
    assert.equal(isException('gray', NOTE_WHITE), true);
    assert.equal(isException(NOTE_WHITE, 'gray'), true);
    assert.equal(isException('gray', 'yellow'), false);
    assert.equal(isException('pink', NOTE_WHITE), false);
    // positive control for the rule itself: a near-duplicate of the gray would be flagged
    assert.ok(dE('#dddad8', '#e0dddb') < 15 && !isException('#dddad8', '#e0dddb'));
});

// ---- WCAG AA (4.5:1) of text/fill for EVERY colour of the grid, in both themes, read from the CSS that the app really applies ----

// {fill, text, strip, stripText} of one grid colour in one theme, parsed from buildCss() (names) or customColorStyle() (custom).
function appliedPair(color, dark) {
    const rules = new Map();
    const css = isCustomColor(color) ? customColorStyle(color).css : buildCss();
    for (const m of css.matchAll(/^(.+?) \{ background-color: (#[0-9a-f]{6}); color: (#[0-9a-f]{6}); \}$/gm))
        for (const sel of m[1].split(', '))
            rules.set(sel, {bg: m[2], fg: m[3]});
    const cls = cssClassOf(color);
    const win = rules.get(dark ? `window.cetli-dark.${cls}` : `window.${cls}`);
    const strip = rules.get(dark ? `window.cetli-dark.${cls} headerbar.cetli-header` : `window.${cls} headerbar.cetli-header`);
    assert.ok(win && strip, `${color} ${dark ? 'dark' : 'light'}: rules found`);
    return {fill: win.bg, text: win.fg, strip: strip.bg, stripText: strip.fg};
}

test('grid: WCAG AA (>= 4.5:1) text/fill and text/strip for all 9 grid colours, light and dark (the table is in the diagnostics)', t => {
    const rows = [];
    for (const dark of [false, true]) {
        for (const color of GRID_COLORS) {
            const p = appliedPair(color, dark);
            for (const [part, bg, fg] of [['fill', p.fill, p.text], ['strip', p.strip, p.stripText]]) {
                const c = contrast(bg, fg);
                rows.push(`${dark ? 'dark ' : 'light'} ${color.padEnd(8)} ${part.padEnd(5)} bg ${bg} text ${fg} ${c.toFixed(2)}:1 AA ${c >= 4.5 ? 'yes' : 'NO'}`);
                assert.ok(c >= 4.5, `${dark ? 'dark' : 'light'} ${color} ${part}: ${bg} / ${fg} = ${c}`);
            }
        }
    }
    t.diagnostic(`\n${rows.join('\n')}`);
});

test('grid: the text of a named colour is the theme text (light #2b2b2b, dark #f2f2f2); a custom one is the same in both themes', () => {
    for (const color of GRID_COLORS) {
        const light = appliedPair(color, false), dark = appliedPair(color, true);
        if (isCustomColor(color)) {
            assert.deepEqual(light, dark, color);
        } else {
            assert.equal(light.text, TEXT_LIGHT, color);
            assert.equal(dark.text, TEXT_DARK, color);
        }
    }
});

test('grid: black (charcoal #3f3d3c) has white text, white has black text, red (#ee0000) has WHITE text (Attila; 4.53:1, AA limit 4.5)', () => {
    for (const dark of [false, true]) {
        assert.equal(appliedPair(NOTE_BLACK, dark).text, '#ffffff');
        assert.equal(appliedPair(NOTE_WHITE, dark).text, '#000000');
        const red = appliedPair('#ee0000', dark);
        assert.equal(red.text, '#ffffff');
        assert.equal(red.stripText, '#ffffff');
        assert.ok(contrast('#ee0000', '#ffffff') >= 4.5 && contrast('#ee0000', '#ffffff') < 4.6, `${contrast('#ee0000', '#ffffff')}`);
        assert.ok(contrast('#ee0000', '#000000') > contrast('#ee0000', '#ffffff'), 'black measures higher: the white is the exception');
    }
    assert.equal(textColorFor({r: 238, g: 0, b: 0}), '#ffffff');
    // the exception is the one colour only: its neighbours follow the measurement
    assert.equal(textColorFor({r: 239, g: 0, b: 0}), '#000000');
    assert.equal(textColorFor({r: 255, g: 0, b: 0}), '#000000');
    assert.equal(textColorFor({r: 220, g: 0, b: 0}), '#ffffff');
});

test('custom colour: strict whole-string #rrggbb, lower-case hex only', () => {
    assert.equal(isCustomColor('#aabbcc'), true);
    assert.equal(isCustomColor('#000000'), true);
    assert.deepEqual(parseCustomColor('#0a1b2c'), {r: 10, g: 27, b: 44});
    assert.deepEqual(parseCustomColor('#ffffff'), {r: 255, g: 255, b: 255});
    for (const bad of ['#AABBCC', '#aabbCc', '#abc', '#aabbccdd', '#aabbc', 'aabbcc', '#gghhii', ' #aabbcc', '#aabbcc ', '#aabbcc\n',
        '\n#aabbcc', '#aabb\ncc', '', '#', 'yellow', null, undefined, 42, {}, ['#aabbcc'], true]) {
        assert.equal(isCustomColor(bad), false, JSON.stringify(bad));
        assert.equal(parseCustomColor(bad), null);
        assert.equal(customColorStyle(bad), null);
    }
});

test('custom colour: injection vectors are unknown -> shown as yellow, and produce no CSS', () => {
    const vectors = [
        '#aabbcc;}', '#aabbcc}', '#aabbcc; } window { display: none', '#aabbcc{}', 'url(http://x/y.png)', '#aabbcc url(x)',
        '@import "x.css";', '#aabbcc\n@import "x.css";', '#aabbcc\n.cetli-note { }', '#aabbcc\r\n', '#aabbcc ', '#aabbcc\0',
        '#aabbcc/*', '#aabbcc*/', "#aabbcc'", '#aabbcc"', 'expression(1)', 'a'.repeat(100000), `#${'a'.repeat(100000)}`,
        `#aabbcc${'0'.repeat(100000)}`, '#AABBCC', '#ＡＡＢＢＣＣ', '#aabbcс',
    ];
    for (const v of vectors) {
        assert.equal(isCustomColor(v), false, v.slice(0, 40));
        assert.equal(customColorStyle(v), null);
        assert.equal(cssClassOf(v), 'cetli-yellow', v.slice(0, 40));
    }
});

test('custom colour: the CSS is built from the parsed numbers: class cetli-x-rrggbb and nothing else', () => {
    const st = customColorStyle('#1a2b3c');
    assert.equal(st.cls, 'cetli-x-1a2b3c');
    assert.equal(cssClassOf('#1a2b3c'), 'cetli-x-1a2b3c');
    const lines = st.css.trimEnd().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^window\.cetli-x-1a2b3c, window\.cetli-dark\.cetli-x-1a2b3c \{ background-color: #1a2b3c; color: #(000000|ffffff); \}$/);
    assert.match(lines[1], /^window\.cetli-x-1a2b3c headerbar\.cetli-header, window\.cetli-dark\.cetli-x-1a2b3c headerbar\.cetli-header \{ background-color: #[0-9a-f]{6}; color: #(000000|ffffff); \}$/);
    assert.ok(st.css.endsWith('\n'));
});

test('custom colour: the strip is a step darker (85 % of every channel, rounded down)', () => {
    const m = /headerbar\.cetli-header \{ background-color: (#[0-9a-f]{6});/.exec(customColorStyle('#c8a064').css);
    assert.equal(m[1], toHex({r: Math.floor(200 * 0.85), g: Math.floor(160 * 0.85), b: Math.floor(100 * 0.85)}));
    for (const c of ['#ffffff', '#808080', '#ff0000'])
        assert.ok(lum(/headerbar\.cetli-header \{ background-color: (#[0-9a-f]{6});/.exec(customColorStyle(c).css)[1]) < lum(c));
});

test('custom colour: the text colour is black or white, whichever has the higher measured contrast', () => {
    assert.equal(textColorFor({r: 0, g: 0, b: 0}), '#ffffff');
    assert.equal(textColorFor({r: 255, g: 255, b: 255}), '#000000');
    assert.equal(textColorFor({r: 255, g: 255, b: 0}), '#000000');
    assert.equal(textColorFor({r: 0, g: 0, b: 255}), '#ffffff');
    let min = Infinity;
    for (let r = 0; r < 256; r += 15) {
        for (let g = 0; g < 256; g += 15) {
            for (let b = 0; b < 256; b += 15) {
                const bg = toHex({r, g, b});
                const chosen = textColorFor({r, g, b});
                const other = chosen === '#000000' ? '#ffffff' : '#000000';
                assert.ok(contrast(bg, chosen) >= contrast(bg, other), bg);
                min = Math.min(min, contrast(bg, chosen));
            }
        }
    }
    assert.ok(min >= 4.5, `worst chosen contrast ${min}`);      // measured worst case is about 4.58 (mid grey), AA for normal text
});

test('custom colour: the stylesheet of the named colours does not contain a custom one', () => {
    assert.equal(buildCss().includes('cetli-x-'), false);
});
