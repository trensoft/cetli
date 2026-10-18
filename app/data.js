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

// The named colours of the menu, in this order (src/colors.js is the single list of names, shared with the core's colour picker).
export const COLORS = NOTE_COLOR_IDS;
export const DEFAULT_COLOR = 'yellow';
// Not offered any more but still known values: old notes carry them (an unknown name would show as yellow).
export const LEGACY_COLORS = Object.freeze(['orange', 'mint', 'peach']);
export const KNOWN_COLORS = Object.freeze([...COLORS, ...LEGACY_COLORS]);
// The three fixed custom colours of the grid, ONE line each (the menu, strings.js and the tests read these names). The black is the
// Sticky Notes charcoal header (white text 10.80:1; its body #5e5e5e would give 6.48:1, below the 7:1 gate, so the one stored value
// is the header); the white is the measured value of the Sticky Notes sample ("window" is a system colour, not storable as #rrggbb).
// Lower case only: an upper case `#EE0000` shows as yellow in the 0.1.0 and the 0.2.0 client (see normalizeCustomColor).
export const NOTE_BLACK = '#3f3d3c';
export const NOTE_WHITE = '#ffffff';
export const NOTE_RHEL_RED = '#ee0000';
// The colour grid, 9 values in this order: the red first (0.2.4), then six names (a note file keeps the NAME, no migration), then
// black and white; the red, the black and the white are custom `#rrggbb`. A new NAME is forbidden: an old client would show it as
// yellow. The order lives only here: a note file keeps the colour VALUE, never the place in the grid.
export const GRID_COLORS = Object.freeze([NOTE_RHEL_RED, 'yellow', 'pink', 'green', 'purple', 'blue', 'gray', NOTE_BLACK, NOTE_WHITE]);

export const TEXT_LIGHT = '#2b2b2b';
export const TEXT_DARK = '#f2f2f2';

// PLAN 8: the fills (ours). `lightHeader` is the slim strip, one step darker (90 % of the fill's channels); the dark
// fills are the same hue at about half the brightness, `darkHeader` 80 % of that.
// The LIGHT side of the six named colours is Sticky Notes (MIT, vixalien/sticky commit 235efbaf, data/stylus/colors.styl, see
// evidence/sticky-notes-colors.md): bg -> light (the body), header -> lightHeader (the strip, and the circle of the grid). The DARK
// side stays as in 0.2.1: the Sticky Notes dark fills are mid-tones (white text 4.77:1 to 5.65:1), below the 7:1 gate, and the gate
// is not loosened silently. orange, mint and peach are the cetli's own legacy values.
// Measured (tests / app-tests/color.test.js): every light fill and lightHeader >= 7:1 against TEXT_LIGHT (so against black too);
// every dark fill and darkHeader >= 7:1 against TEXT_DARK; every two circles of the grid (lightHeader, and the three custom values)
// >= MIN_DELTA_E apart in CIELAB (dE76), except the named pair of DELTA_E_EXCEPTIONS; text/fill >= 4.5:1 (WCAG AA) for every colour
// of GRID_COLORS in both themes, on the fill and on the strip.
export const MIN_CONTRAST = 7;
export const MIN_DELTA_E = 15;
// The one named exception of the distance rule: gray and white are 12.9 apart in the Sticky Notes sample itself.
export const DELTA_E_EXCEPTIONS = Object.freeze([Object.freeze(['gray', NOTE_WHITE])]);
export const PALETTE = Object.freeze({
    yellow: {light: '#fff6cb', lightHeader: '#ffee92', dark: '#524e3c', darkHeader: '#423e30'},
    pink: {light: '#ffe3f1', lightHeader: '#ffc5e1', dark: '#564f53', darkHeader: '#443f42'},
    green: {light: '#e7f6e4', lightHeader: '#d1ebcb', dark: '#47513f', darkHeader: '#394132'},
    purple: {light: '#f2e5ff', lightHeader: '#e2d0f5', dark: '#514c5b', darkHeader: '#413d49'},
    orange: {light: '#fbcf94', lightHeader: '#e2ba85', dark: '#5a4b35', darkHeader: '#483c2a'},
    blue: {light: '#e7f3ff', lightHeader: '#cce7ff', dark: '#444f58', darkHeader: '#363f46'},
    mint: {light: '#bfeadd', lightHeader: '#acd3c7', dark: '#42514c', darkHeader: '#35413d'},
    peach: {light: '#fbd5c4', lightHeader: '#e2c0b0', dark: '#584b45', darkHeader: '#463c37'},
    gray: {light: '#edebe9', lightHeader: '#dddad8', dark: '#3a3a3a', darkHeader: '#2e2e2e'},
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

// Any `#rrggbb` (either case) -> the lower case `#rrggbb` that is stored; anything else -> null. A colour chooser value goes
// through this before it is written to a note file.
export const normalizeCustomColor = s => (typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : null);

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

// Backgrounds that get WHITE text although black measures slightly higher (Attila's choice): the red of the grid. White on
// #ee0000 is 4.53:1 (AA is 4.5:1), black is 4.64:1.
const WHITE_TEXT_ON = Object.freeze([NOTE_RHEL_RED]);

// Text colour for a custom background: black or white, whichever has the higher measured contrast, except WHITE_TEXT_ON.
export const textColorFor = rgb => {
    if (WHITE_TEXT_ON.includes(hexOf(rgb)))
        return '#ffffff';
    return contrastRatio(rgb, BLACK) >= contrastRatio(rgb, WHITE) ? '#000000' : '#ffffff';
};

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
// contrast. The red (NOTE_RHEL_RED) has bold text by style: a look of the colour, nothing is stored (not a mark). Everything in the
// string comes from three integers.
export function customColorStyle(s) {
    const rgb = parseCustomColor(s);
    if (!rgb)
        return null;
    const cls = cssClassOf(s);
    const fill = hexOf(rgb), strip = hexOf(darker(rgb)), text = textColorFor(rgb), stripText = textColorFor(darker(rgb));
    const rules = [
        `window.${cls}, window.cetli-dark.${cls} { background-color: ${fill}; color: ${text}; }`,
        `window.${cls} headerbar.cetli-header, window.cetli-dark.${cls} headerbar.cetli-header { background-color: ${strip}; color: ${stripText}; }`,
    ];
    if (fill === NOTE_RHEL_RED)
        rules.push(`window.${cls} textview.cetli-text text { font-weight: 700; }`);
    const css = rules.join('\n');
    return {cls, css: `${css}\n`};
}

// The CSS of the row of ONE custom colour in the "All notes" list: null or {cls, css}, same rules as customColorStyle.
export function customRowStyle(s) {
    const rgb = parseCustomColor(s);
    if (!rgb)
        return null;
    const cls = cssClassOf(s);
    return {cls, css: `window.cetli-list row.cetli-row.${cls}, window.cetli-list.cetli-dark row.cetli-row.${cls} { background-color: ${hexOf(rgb)}; color: ${textColorFor(rgb)}; }\n`};
}

// The one stylesheet of the named colours. Built from the constants above only.
export function buildCss() {
    const rules = [
        'window.cetli-note { border-radius: 6px; }',
        'window.cetli-note headerbar.cetli-header { min-height: 28px; box-shadow: none; border-radius: 6px 6px 0 0; }',
        'window.cetli-note textview.cetli-text, window.cetli-note textview.cetli-text text { background: transparent; color: inherit; }',
        // the title of the red note ("Important", shown by the window, not stored): bold and larger than the text, in the colour of the strip
        'window.cetli-note headerbar.cetli-header label.cetli-title { font-weight: 700; font-size: larger; }',
        'window.cetli-note label.cetli-mark { font-size: smaller; padding: 2px 8px; }',
        'window.cetli-note label.cetli-unresolved { font-size: smaller; }',
        // the "All notes" list: a row is the note in miniature (same fills and texts as the windows)
        'window.cetli-list listbox.cetli-rows { background: transparent; }',
        'window.cetli-list row.cetli-row { border-radius: 6px; margin: 3px 6px; padding: 2px 4px; }',
        'window.cetli-list row.cetli-row:hover { box-shadow: inset 0 0 0 2px rgba(128, 128, 128, 0.8); }',
        'window.cetli-list row.cetli-row label.cetli-empty { font-style: italic; }',
    ];
    for (const name of KNOWN_COLORS) {
        const p = PALETTE[name];
        rules.push(
            `window.cetli-${name} { background-color: ${p.light}; color: ${TEXT_LIGHT}; }`,
            `window.cetli-${name} headerbar.cetli-header { background-color: ${p.lightHeader}; color: ${TEXT_LIGHT}; }`,
            `window.cetli-dark.cetli-${name} { background-color: ${p.dark}; color: ${TEXT_DARK}; }`,
            `window.cetli-dark.cetli-${name} headerbar.cetli-header { background-color: ${p.darkHeader}; color: ${TEXT_DARK}; }`,
            `window.cetli-list row.cetli-row.cetli-${name} { background-color: ${p.light}; color: ${TEXT_LIGHT}; }`,
            `window.cetli-list.cetli-dark row.cetli-row.cetli-${name} { background-color: ${p.dark}; color: ${TEXT_DARK}; }`,
        );
        if (COLORS.includes(name))
            rules.push(`button.cetli-swatch-${name} { background-color: ${p.light}; min-width: 20px; min-height: 20px; border-radius: 10px; }`);
    }
    return `${rules.join('\n')}\n`;
}
