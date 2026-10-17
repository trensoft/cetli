// SPDX-License-Identifier: GPL-3.0-or-later
// The colour layer of app/data.js: the palette (measured contrast and distance), the custom colour `#rrggbb` that arrives from a
// note FILE (untrusted: strict parse, CSS built from numbers, injection vectors) and the automatic text colour.
// The measuring code here is independent of data.js (WCAG 2.x contrast, CIELAB dE76), so that a wrong formula there is caught.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    COLORS, KNOWN_COLORS, PALETTE, TEXT_DARK, TEXT_LIGHT, buildCss, cssClassOf, customColorStyle, isCustomColor, parseCustomColor,
    textColorFor,
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

test('palette: the menu is yellow, pink, green, purple, orange, blue, mint, peach; gray is known but not offered', () => {
    assert.deepEqual([...COLORS], ['yellow', 'pink', 'green', 'purple', 'orange', 'blue', 'mint', 'peach']);
    assert.deepEqual([...COLORS], [...NOTE_COLOR_IDS]);
    assert.equal(COLORS.includes('gray'), false);
    assert.equal(KNOWN_COLORS.includes('gray'), true);
    assert.ok(PALETTE.gray);
    assert.ok(buildCss().includes('window.cetli-gray {'));
    assert.equal(buildCss().includes('cetli-swatch-gray'), false);
    for (const name of KNOWN_COLORS)
        assert.equal(cssClassOf(name), `cetli-${name}`);
});

test('palette: the yellow is paler than the old #f6e58d', () => {
    assert.ok(lum(PALETTE.yellow.light) > lum('#f6e58d'));
});

test('palette: all 8 menu fills (and their strips) have contrast >= 7:1 against the light text, and against black', () => {
    for (const name of COLORS) {
        for (const key of ['light', 'lightHeader']) {
            assert.ok(contrast(PALETTE[name][key], TEXT_LIGHT) >= 7, `${name}.${key} vs TEXT_LIGHT ${contrast(PALETTE[name][key], TEXT_LIGHT)}`);
            assert.ok(contrast(PALETTE[name][key], '#000000') >= 7, `${name}.${key} vs black`);
        }
    }
});

test('palette: dark theme: every dark fill and strip has contrast >= 7:1 against the light text colour', () => {
    for (const name of KNOWN_COLORS.filter(n => n !== 'gray')) {
        for (const key of ['dark', 'darkHeader'])
            assert.ok(contrast(PALETTE[name][key], TEXT_DARK) >= 7, `${name}.${key} ${contrast(PALETTE[name][key], TEXT_DARK)}`);
    }
});

test('palette: any two menu colours are >= 15 apart (CIELAB dE76, light fills); peach is >= 20 from orange', () => {
    for (const a of COLORS) {
        for (const b of COLORS) {
            if (a < b)
                assert.ok(dE(PALETTE[a].light, PALETTE[b].light) >= 15, `${a}/${b} ${dE(PALETTE[a].light, PALETTE[b].light)}`);
        }
    }
    assert.ok(dE(PALETTE.peach.light, PALETTE.orange.light) >= 20);
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
