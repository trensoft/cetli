// SPDX-License-Identifier: GPL-3.0-or-later
// PLAN.md sections 8 and 9.3/9.4: the constants and the colour table of the app. No Gtk import and no text for the
// user (those are in strings.js), so that a test can check them without a display. Colours are applied ONLY as the fixed
// CSS classes below, chosen through this table, never built from the content of a note file (PLAN section 7/8).

export const APP_ID = 'io.github.trensoft.cetli';
export const APP_NAME = 'cetli';
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

export const COLORS = Object.freeze(['yellow', 'green', 'blue', 'pink', 'purple', 'gray']);
export const DEFAULT_COLOR = 'yellow';

export const TEXT_LIGHT = '#2b2b2b';
export const TEXT_DARK = '#f2f2f2';

// PLAN 8: the six fills (ours). `header` is the slim strip, "one step darker" (light: 90 %, dark: 80 % of the fill).
export const PALETTE = Object.freeze({
    yellow: {light: '#f6e58d', lightHeader: '#ddce7f', dark: '#6b5b12', darkHeader: '#56490e'},
    green: {light: '#c8e6b0', lightHeader: '#b4cf9e', dark: '#2f5a2a', darkHeader: '#264822'},
    blue: {light: '#b8d8f0', lightHeader: '#a6c2d8', dark: '#244a6b', darkHeader: '#1d3b56'},
    pink: {light: '#f4c6d4', lightHeader: '#dcb2bf', dark: '#6b2c44', darkHeader: '#562336'},
    purple: {light: '#d8c8f0', lightHeader: '#c2b4d8', dark: '#43306b', darkHeader: '#362656'},
    gray: {light: '#dcdcdc', lightHeader: '#c6c6c6', dark: '#3a3a3a', darkHeader: '#2e2e2e'},
});

export const cssClassOf = color => `cetli-${COLORS.includes(color) ? color : DEFAULT_COLOR}`;

// The one stylesheet. Built from the constants above only.
export function buildCss() {
    const rules = [
        'window.cetli-note { border-radius: 6px; }',
        'window.cetli-note headerbar.cetli-header { min-height: 28px; box-shadow: none; border-radius: 6px 6px 0 0; }',
        'window.cetli-note textview.cetli-text, window.cetli-note textview.cetli-text text { background: transparent; color: inherit; }',
        'window.cetli-note label.cetli-mark { font-size: smaller; padding: 2px 8px; opacity: 0.85; }',
        'window.cetli-note label.cetli-unresolved { font-size: smaller; opacity: 0.7; }',
    ];
    for (const name of COLORS) {
        const p = PALETTE[name];
        rules.push(
            `window.cetli-${name} { background-color: ${p.light}; color: ${TEXT_LIGHT}; }`,
            `window.cetli-${name} headerbar.cetli-header { background-color: ${p.lightHeader}; color: ${TEXT_LIGHT}; }`,
            `window.cetli-dark.cetli-${name} { background-color: ${p.dark}; color: ${TEXT_DARK}; }`,
            `window.cetli-dark.cetli-${name} headerbar.cetli-header { background-color: ${p.darkHeader}; color: ${TEXT_DARK}; }`,
            `button.cetli-swatch-${name} { background-color: ${p.light}; min-width: 20px; min-height: 20px; border-radius: 10px; }`,
        );
    }
    return `${rules.join('\n')}\n`;
}
