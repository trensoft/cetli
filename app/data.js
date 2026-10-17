// SPDX-License-Identifier: GPL-3.0-or-later
// PLAN.md sections 8 and 9.3/9.4: the constants and the colour table of the app. No Gtk import and no text for the
// user (those are in strings.js), so that a test can check them without a display. A colour from a note file is NOT
// trusted: a name is looked up in the table below; a custom `#rrggbb` is parsed STRICTLY into three numbers and the CSS is
// built from those numbers only, never from the raw string; anything else is shown as yellow (the file is not changed).

import {NOTE_COLOR_IDS} from '../src/colors.js';

export const APP_ID = 'io.github.trensoft.cetli';
export const APP_NAME = 'Cetli';
export const DEVELOPER = 'TrenSoft';
export const COPYRIGHT = '© 2026 TrenSoft';
export const WEBSITE = 'https://github.com/trensoft/cetli';
export const ISSUE_URL = `${WEBSITE}/issues`;

// The title of a note window is `cetli-<uuid>`: the contract with the GNOME Shell extension (extension/README.md).
export const WINDOW_TITLE_PREFIX = 'cetli-';

export const DEFAULT_WIDTH = 300;
export const DEFAULT_HEIGHT = 260;
export const MIN_SIZE = 120;
export const MAX_SIZE = 4000;
export const REMOTE_QUIET_MS = 2000;          // PLAN 3: a remote version replaces the text only after 2 s without a key

// The menu, in this order (src/colors.js is the single list of names, shared with the core's colour picker).
export const COLORS = NOTE_COLOR_IDS;
export const DEFAULT_COLOR = 'yellow';
// `gray` is not offered but stays a known value: old notes carry it.
export const LEGACY_COLORS = Object.freeze(['gray']);
export const KNOWN_COLORS = Object.freeze([...COLORS, ...LEGACY_COLORS]);

export const TEXT_LIGHT = '#2b2b2b';
export const TEXT_DARK = '#f2f2f2';

// PLAN 8: the fills (ours). `lightHeader` is the slim strip, one step darker (90 % of the fill's channels); the dark
// fills are the same hue at about half the brightness, `darkHeader` 80 % of that.
// Measured (tests / app-tests/color.test.js): every light fill and lightHeader >= 7:1 against TEXT_LIGHT (so against black too);
// every dark fill and darkHeader >= 7:1 against TEXT_DARK; every two menu colours >= 15 apart in CIELAB (dE76, light fills).
export const MIN_CONTRAST = 7;
export const MIN_DELTA_E = 15;
export const PALETTE = Object.freeze({
    yellow: {light: '#fbf1b8', lightHeader: '#e2d9a6', dark: '#524e3c', darkHeader: '#423e30'},
    pink: {light: '#f7c9d8', lightHeader: '#deb5c2', dark: '#5a494f', darkHeader: '#483a3f'},
    green: {light: '#cdebb6', lightHeader: '#b9d4a4', dark: '#47513f', darkHeader: '#394132'},
    purple: {light: '#dccdf5', lightHeader: '#c6b9dd', dark: '#514c5b', darkHeader: '#413d49'},
    orange: {light: '#fbcf94', lightHeader: '#e2ba85', dark: '#5a4b35', darkHeader: '#483c2a'},
    blue: {light: '#bddcf5', lightHeader: '#aac6dd', dark: '#444f58', darkHeader: '#363f46'},
    mint: {light: '#bfeadd', lightHeader: '#acd3c7', dark: '#42514c', darkHeader: '#35413d'},
    peach: {light: '#fbd5c4', lightHeader: '#e2c0b0', dark: '#584b45', darkHeader: '#463c37'},
    gray: {light: '#dcdcdc', lightHeader: '#c6c6c6', dark: '#3a3a3a', darkHeader: '#2e2e2e'},
});

// ---- custom colour: `#rrggbb` in the `color` field of a note file (untrusted input) ----

// Whole-string match, lower-case hex only, no `m` flag (so a trailing newline does not match either).
const CUSTOM_RE = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/;

export const isCustomColor = s => typeof s === 'string' && s.length === 7 && CUSTOM_RE.test(s);

// -> {r, g, b} (integers 0..255) or null
export function parseCustomColor(s) {
    if (!isCustomColor(s))
        return null;
    const m = s.match(CUSTOM_RE);
    return {r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16)};
}

const hex2 = n => n.toString(16).padStart(2, '0');
const hexOf = ({r, g, b}) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

// WCAG 2.x relative luminance and contrast ratio of two {r, g, b}.
const lin = c => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
export const luminance = ({r, g, b}) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export function contrastRatio(a, b) {
    const x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const BLACK = {r: 0, g: 0, b: 0};
const WHITE = {r: 255, g: 255, b: 255};

// Text colour for a custom background: black or white, whichever has the higher measured contrast.
export const textColorFor = rgb => (contrastRatio(rgb, BLACK) >= contrastRatio(rgb, WHITE) ? '#000000' : '#ffffff');

// The strip: a step darker, 85 % of every channel (rounded down).
const darker = ({r, g, b}) => ({r: Math.floor(r * 0.85), g: Math.floor(g * 0.85), b: Math.floor(b * 0.85)});

// The CSS class of a window for any `color` value from a file: a known name -> `cetli-<name>`; a valid custom colour ->
// `cetli-x-rrggbb` (built from the parsed numbers); anything else -> `cetli-yellow`.
export function cssClassOf(color) {
    const rgb = parseCustomColor(color);
    if (rgb)
        return `cetli-x-${hex2(rgb.r)}${hex2(rgb.g)}${hex2(rgb.b)}`;
    return `cetli-${KNOWN_COLORS.includes(color) ? color : DEFAULT_COLOR}`;
}

// The CSS of ONE custom colour, for a Gtk.CssProvider added when a window shows that colour: null if `s` is not a valid
// custom colour, else {cls, css}. Same fill in the light and the dark theme (the user chose it), the text black/white by
// contrast. Everything in the string comes from three integers.
export function customColorStyle(s) {
    const rgb = parseCustomColor(s);
    if (!rgb)
        return null;
    const cls = cssClassOf(s);
    const fill = hexOf(rgb), strip = hexOf(darker(rgb)), text = textColorFor(rgb), stripText = textColorFor(darker(rgb));
    const css = [
        `window.${cls}, window.cetli-dark.${cls} { background-color: ${fill}; color: ${text}; }`,
        `window.${cls} headerbar.cetli-header, window.cetli-dark.${cls} headerbar.cetli-header { background-color: ${strip}; color: ${stripText}; }`,
    ].join('\n');
    return {cls, css: `${css}\n`};
}

// The one stylesheet of the named colours. Built from the constants above only.
export function buildCss() {
    const rules = [
        'window.cetli-note { border-radius: 6px; }',
        'window.cetli-note headerbar.cetli-header { min-height: 28px; box-shadow: none; border-radius: 6px 6px 0 0; }',
        'window.cetli-note textview.cetli-text, window.cetli-note textview.cetli-text text { background: transparent; color: inherit; }',
        'window.cetli-note label.cetli-mark { font-size: smaller; padding: 2px 8px; opacity: 0.85; }',
        'window.cetli-note label.cetli-unresolved { font-size: smaller; }',
    ];
    for (const name of KNOWN_COLORS) {
        const p = PALETTE[name];
        rules.push(
            `window.cetli-${name} { background-color: ${p.light}; color: ${TEXT_LIGHT}; }`,
            `window.cetli-${name} headerbar.cetli-header { background-color: ${p.lightHeader}; color: ${TEXT_LIGHT}; }`,
            `window.cetli-dark.cetli-${name} { background-color: ${p.dark}; color: ${TEXT_DARK}; }`,
            `window.cetli-dark.cetli-${name} headerbar.cetli-header { background-color: ${p.darkHeader}; color: ${TEXT_DARK}; }`,
        );
        if (COLORS.includes(name))
            rules.push(`button.cetli-swatch-${name} { background-color: ${p.light}; min-width: 20px; min-height: 20px; border-radius: 10px; }`);
    }
    return `${rules.join('\n')}\n`;
}
