// SPDX-License-Identifier: GPL-3.0-or-later
// Negative control of the app tests: each mutant breaks ONE rule of app/ in a throwaway copy; the tests must then FAIL.
// The node tests run first; a mutant they do not kill goes to the gjs smoke test when CETLI_GTKENV is set (see run.sh),
// else it is reported as SKIPPED (not as survived). A search text not found exactly once is BROKEN.
// usage: node app-tests/mutants.js [A01 A02 ...]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const gtkenv = process.env.CETLI_GTKENV ?? '';

const MUTANTS = [
    {id: 'A01', rule: 'PLAN 8: the text of the dark header strip is dark', file: 'data.js',
        find: "headerbar.cetli-header { background-color: ${p.darkHeader}; color: ${TEXT_DARK}; }", repl: "headerbar.cetli-header { background-color: ${p.darkHeader}; color: ${TEXT_LIGHT}; }"},
    {id: 'A02', rule: 'PLAN 8: the text of the light note is light', file: 'data.js',
        find: "`window.cetli-${name} { background-color: ${p.light}; color: ${TEXT_LIGHT}; }`", repl: "`window.cetli-${name} { background-color: ${p.light}; color: ${TEXT_DARK}; }`"},
    {id: 'A03', rule: 'PLAN 8: the "unresolved" label is faded to 0.7 (3.8-4.2:1 on the light header strips)', file: 'data.js',
        find: "label.cetli-unresolved { font-size: smaller; }", repl: "label.cetli-unresolved { font-size: smaller; opacity: 0.7; }"},
    {id: 'A04', rule: 'PLAN 8: the mark label is faded to 0.5', file: 'data.js',
        find: "label.cetli-mark { font-size: smaller; padding: 2px 8px; }", repl: "label.cetli-mark { font-size: smaller; padding: 2px 8px; opacity: 0.5; }"},
    {id: 'A05', rule: 'layout.json: setOpen calls overlap (no queue)', file: 'layoutfile.js',
        find: "(queues.get(store) ?? Promise.resolve()).then(", repl: "Promise.resolve().then("},
    {id: 'A06', rule: '3: a remote text replaces UNSAVED typing once the window has been quiet', file: 'window.js', gjs: true,
        find: "if (!this._dirty() && quietFor >= REMOTE_QUIET_MS) {", repl: "if (quietFor >= REMOTE_QUIET_MS) {"},
    {id: 'A07', rule: '3: the 2 s quiet rule is gone (a clean window takes a remote text at once)', file: 'window.js', gjs: true,
        find: "if (!this._dirty() && quietFor >= REMOTE_QUIET_MS) {", repl: "if (!this._dirty()) {"},
    {id: 'A08', rule: '3: the colour of a remote version is not applied', file: 'window.js', gjs: true,
        find: "this.color = rec.color;\n        this._applyColorClass();", repl: "this._applyColorClass();"},
    {id: 'A09', rule: '3: saves are not coalesced (0 ms)', file: 'window.js', gjs: true,
        find: "this._saveTimer = once(SAVE_COALESCE_MS, () => {", repl: "this._saveTimer = once(0, () => {"},
    {id: 'A10', rule: '2.5: the result of the core\'s own retry is dropped', file: 'application.js', gjs: true,
        find: "w?.onSaveRetried(ev.result);", repl: ""},
    {id: 'A11', rule: 'strings: BAD_INPUT has no text of its own', file: 'strings.js', gjs: true,
        find: "    case 'BAD_INPUT': return _('Not saved: this note cannot be saved');\n", repl: ""},
    {id: 'A12', rule: 'PLAN 8: the dark theme never gets its class', file: 'window.js', gjs: true,
        find: "if (dark)\n            this.win.add_css_class('cetli-dark');", repl: "if (dark)\n            this.win.add_css_class('cetli-dark-unused');"},
    {id: 'A13', rule: '2.5: closing a window with a refused, unsaved text closes at once', file: 'window.js', gjs: true,
        find: "if (this.mark?.kind === 'refused' && this._dirty() && !this.closeWarned) {", repl: "if (false) {"},
    {id: 'A14', rule: '3: a cursor at the start of the changed region jumps behind the new text', file: 'window.js', gjs: true,
        find: "for (const m of atStart)\n                    this.buffer.move_mark(m, this.buffer.get_iter_at_offset(region.start));", repl: ""},
    {id: 'A16', rule: 'A5: the About text has no authorship sentence', file: 'strings.js', gjs: true,
        find: "export const aboutComments = () => `${aboutDescription()}\\n\\n${aboutAuthorship()}`;", repl: "export const aboutComments = () => aboutDescription();"},
    {id: 'A24', rule: '0.2.1 preview: the number of lines is 30', file: 'preview.js',
        find: "export const PREVIEW_LINES = 3;", repl: "export const PREVIEW_LINES = 30;"},
    {id: 'A25', rule: '0.2.1 preview: a cut that falls inside a surrogate pair is kept (a lone surrogate reaches the label)', file: 'preview.js',
        find: "    if (last >= 0xd800 && last <= 0xdbff)\n        head = head.slice(0, -1);                     // the cut fell inside a surrogate pair\n", repl: ""},
    {id: 'A26', rule: '0.2.1 preview: blank lines at the start use up the head', file: 'preview.js',
        find: "String(text ?? '').trimStart().slice(0, HEAD_CHARS)", repl: "String(text ?? '').slice(0, HEAD_CHARS)"},
    {id: 'A27', rule: '0.2.1 preview: a line is not cut (a 64 KB line reaches the label)', file: 'preview.js',
        find: "return cps.length <= max ? s : `${cps.slice(0, max).join('')}…`;", repl: "return s;"},
    {id: 'A29', rule: '0.2.1 i18n: the hu catalog lacks the "All notes" text', file: 'po/hu.po', dir: '.',
        find: 'msgid "All notes"\nmsgstr "Összes jegyzet"', repl: 'msgid "All notes"\nmsgstr ""'},
    {id: 'A30', rule: '0.2.1 i18n: the hu catalog lacks the "(empty note)" text', file: 'po/hu.po', dir: '.',
        find: 'msgid "(empty note)"\nmsgstr "(üres jegyzet)"', repl: 'msgid "(empty note)"\nmsgstr ""'},
    {id: 'A31', rule: '0.2.1 list: a deleted note keeps its row', file: 'allnotes.js', gjs: true,
        find: "this.ctl.store.listNotes().filter(n => !n.deleted)", repl: "this.ctl.store.listNotes()"},
    {id: 'A32', rule: '0.2.1 list: a click on a closed note does not open it', file: 'application.js', gjs: true,
        find: "        await openWindow(rec, await store.loadLayout());\n        ctl.setOpen(id, true);", repl: "        ctl.setOpen(id, true);"},
    {id: 'A33', rule: '0.2.1 list: our own save does not tell the list', file: 'window.js', gjs: true,
        find: "            this.ctl.notesChanged?.();       // our own saves raise no store event: the \"All notes\" list is told here\n", repl: ""},
    {id: 'A34', rule: '0.2.1 list: the window title of the list is a note window title', file: 'strings.js',
        find: "export const allNotesTitle = () => _('All notes');", repl: "export const allNotesTitle = () => 'cetli-all';"},
    {id: 'A35', rule: '0.2.1 list: the row text of a custom colour is always black (no text colour from the contrast)', file: 'data.js',
        find: "background-color: ${hexOf(rgb)}; color: ${textColorFor(rgb)}; }\\n`};", repl: "background-color: ${hexOf(rgb)}; color: #000000; }\\n`};"},
    {id: 'A36', rule: '0.2.1 list: the dark rows get the dark theme text of the light theme', file: 'data.js',
        find: "`window.cetli-list.cetli-dark row.cetli-row.cetli-${name} { background-color: ${p.dark}; color: ${TEXT_DARK}; }`,", repl: "`window.cetli-list.cetli-dark row.cetli-row.cetli-${name} { background-color: ${p.dark}; color: ${TEXT_LIGHT}; }`,"},
    {id: 'A37', rule: '0.2.1 list: the list ignores the old gray (rows of gray notes get no fill)', file: 'data.js',
        find: "            `window.cetli-list row.cetli-row.cetli-${name} { background-color: ${p.light}; color: ${TEXT_LIGHT}; }`,", repl: "            ...(name === 'gray' ? [] : [`window.cetli-list row.cetli-row.cetli-${name} { background-color: ${p.light}; color: ${TEXT_LIGHT}; }`]),"},
    {id: 'A38', rule: '0.2.1 list: the rows are not sorted (insertion order)', file: 'allnotes.js', gjs: true,
        find: "this.list.set_sort_func((a, b) => newestFirst(a._cetli, b._cetli));", repl: ""},
    {id: 'A39', rule: '0.2.1 list: a second request opens a second list window', file: 'application.js', gjs: true,
        find: "        if (allNotes === null)\n            allNotes = new AllNotesWindow({ctl});", repl: "        allNotes = new AllNotesWindow({ctl});"},
    {id: 'A40', rule: '0.2.1 list: a remote tombstone / removal leaves the row', file: 'allnotes.js', gjs: true,
        find: "                this.list.remove(info.row);\n", repl: ""},
    {id: 'A41', rule: '0.2.1 list: events of the other computer do not refresh the list', file: 'application.js', gjs: true,
        find: "        allNotes?.scheduleRefresh();\n        const w = windows.get(ev.id);", repl: "        const w = windows.get(ev.id);"},
    {id: 'A42', rule: '0.2.1 list: closing the list does not forget it (the next request finds a dead window)', file: 'allnotes.js', gjs: true,
        find: "            this.ctl.onAllNotesClosed(this);\n", repl: ""},
    {id: 'A43', rule: '0.2.1 list: closing the list leaves its refresh timer armed', file: 'allnotes.js', gjs: true,
        find: "            this.cancelRefresh();\n            this.ctl.onAllNotesClosed(this);", repl: "            this.ctl.onAllNotesClosed(this);"},
    {id: 'A44', rule: '0.2.1 list: closing the list closes the note windows too', file: 'allnotes.js', gjs: true,
        find: "            this.ctl.onAllNotesClosed(this);\n", repl: "            this.ctl.onAllNotesClosed(this);\n            for (const w of [...this.ctl.windows.values()]) w.win.close();\n"},
    {id: 'A45', rule: '0.2.1 list: the row shows the whole text, not the preview', file: 'allnotes.js', gjs: true,
        find: "info.label.set_label(p.empty ? S.emptyNotePreview() : p.text);", repl: "info.label.set_label(p.empty ? S.emptyNotePreview() : String(n.text));"},
    {id: 'A46', rule: '0.2.1 list: an empty note shows an empty row (no placeholder)', file: 'allnotes.js', gjs: true,
        find: "info.label.set_label(p.empty ? S.emptyNotePreview() : p.text);", repl: "info.label.set_label(p.text);"},
    {id: 'A47', rule: '0.2.1 list: the style of a custom colour is never added (the row keeps the default text colour)', file: 'allnotes.js', gjs: true,
        find: "        ensureCustomRowStyle(n.color);\n", repl: ""},
    {id: 'A48', rule: '0.2.1 list: a new note does not tell the list', file: 'application.js', gjs: true,
        find: "        allNotes?.scheduleRefresh();\n        const existing = windows.get(res.record.id);", repl: "        const existing = windows.get(res.record.id);"},
    {id: 'A50', rule: '0.2.1 list: the dark class of the list is never removed', file: 'allnotes.js', gjs: true,
        find: "            this.win.remove_css_class('cetli-dark');", repl: ""},
    {id: 'A51', rule: '0.2.1 list: a click on an open note opens a second window for it', file: 'application.js', gjs: true,
        find: "        if (w) {\n            w.win.present();\n            return;\n        }\n        await openWindow(rec,", repl: "        await openWindow(rec,"},
    {id: 'A52', rule: '0.2.2 list: a refused delete of a closed note is silent', file: 'application.js', gjs: true,
        find: "                allNotes?.showError(S.deleteRefused(res.cause?.code));\n", repl: ""},
    {id: 'A53', rule: '0.2.2 list: a deleted closed note keeps its card (the list is not told)', file: 'application.js', gjs: true,
        find: "            if (res.ok) {\n                ctl.notesChanged?.();\n            } else {", repl: "            if (res.ok) {\n            } else {"},
    {id: 'A54', rule: '0.2.2 list: the card has no outline (white card on the white window)', file: 'allnotes.js', gjs: true,
        find: "    'window.cetli-list row.cetli-row { border: 1px solid rgba(0, 0, 0, 0.18); }\\n' +\n", repl: ""},
    {id: 'A55', rule: '0.2.2 list: the time on the card is faded to 70 % (2.6:1 on the red)', file: 'allnotes.js', gjs: true,
        find: "label.cetli-time { font-size: smaller; }", repl: "label.cetli-time { font-size: smaller; opacity: 0.7; }"},
    {id: 'A15', rule: 'start(): a second activation before the core is up starts it again', file: 'application.js', gjs: true,
        find: "const first = startPromise === null;", repl: "const first = true;"},
    {id: 'A90', rule: 'palette: the pink is the saturated 0.2.0 pink again (killed by the rendered-colour test only)', file: 'data.js', gjs: true,
        find: "pink: {light: '#ffe3f1', lightHeader: '#ffc5e1', dark: '#564f53', darkHeader: '#443f42'},", repl: "pink: {light: '#f7c9d8', lightHeader: '#deb5c2', dark: '#5a494f', darkHeader: '#483a3f'},"},
    {id: 'A91', rule: 'PLAN 8: the text of the note does not follow the colour of the window (killed by the rendered-colour test only)', file: 'data.js', gjs: true,
        find: "textview.cetli-text text { background: transparent; color: inherit; }", repl: "textview.cetli-text text { background: transparent; }"},
    {id: 'A92', rule: '0.2.2 menu: no circle ever shows the ring and the badge', file: 'window.js', gjs: true,
        find: "this._select(dot, this.color === value);", repl: "this._select(dot, false);"},
    {id: 'A93', rule: '0.2.2 menu: the circles fill columns first, not rows (wrong grid order)', file: 'window.js', gjs: true,
        find: "grid.attach(overlay, i % GRID_COLUMNS, Math.floor(i / GRID_COLUMNS), 1, 1);", repl: "grid.attach(overlay, Math.floor(i / 2), i % 2, 1, 1);"},
    {id: 'A94', rule: '0.2.2 menu: every circle sets yellow (wrong action target)', file: 'window.js', gjs: true,
        find: "action_target: GLib.Variant.new_string(value), tooltip_text: S.colorName(value)});", repl: "action_target: GLib.Variant.new_string('yellow'), tooltip_text: S.colorName(value)});"},
    {id: 'A96', rule: '0.2.2 menu: All notes has no Ctrl+H', file: 'application.js', gjs: true,
        find: "        gtkApp.set_accels_for_action('app.all-notes', ['<Control>h']);\n", repl: ""},
    {id: 'A97', rule: '0.2.2 menu: Delete note before All notes', file: 'application.js', gjs: true,
        find: "    notes.append(S.menuAllNotes(), 'app.all-notes');\n    notes.append(S.menuDeleteNote(), 'win.delete');", repl: "    notes.append(S.menuDeleteNote(), 'win.delete');\n    notes.append(S.menuAllNotes(), 'app.all-notes');"},
    {id: 'A98', rule: '0.2.2 menu: a custom colour no circle has shows no ring and badge on the custom circle', file: 'window.js', gjs: true,
        find: "this._select(this.customDot, other);", repl: "this._select(this.customDot, false);"},
    {id: 'A99', rule: '0.2.2 menu: the picker is not over the custom circle (shown beside it, visible)', file: 'window.js', gjs: true,
        find: "picker.set_opacity(0);", repl: ""},
    {id: 'A100', rule: '0.2.2 menu: the colour grid is not put into the menu (no custom item)', file: 'application.js', gjs: true,
        find: "    menu.append_section(null, colors);\n", repl: ""},
    {id: 'A101', rule: '0.2.2 menu: the picker choice is not saved (setColor call gone)', file: 'window.js', gjs: true,
        find: "                this.setColor(hexOfRgba(rgba));", repl: "                hexOfRgba(rgba);"},
    {id: 'A102', rule: '0.2.2 menu: the selected circle has no ring (killed by the rendered grid only)', file: 'window.js', gjs: true,
        find: "        'button.cetli-dot.cetli-selected { box-shadow: 0 0 0 2px @popover_bg_color, 0 0 0 4px @accent_bg_color; }',\n", repl: ""},
    {id: 'A103', rule: '0.2.2 menu: the selected circle has no badge (ring only)', file: 'window.js', gjs: true,
        find: "dot.badge.set_visible(on);", repl: "dot.badge.set_visible(false);"},
    {id: 'A104', rule: '0.2.2 menu: the circles have no border (killed by the rendered grid only)', file: 'window.js', gjs: true,
        find: "border: 1px solid rgba(0, 0, 0, 0.5); background-image: none; }`,", repl: "border: none; background-image: none; }`,"},
    {id: 'A105', rule: '0.2.2 menu: the border of the circles in the dark theme is the light theme one (killed by the rendered grid only)', file: 'window.js', gjs: true,
        find: "        'window.cetli-dark button.cetli-dot { border-color: rgba(255, 255, 255, 0.5); }',\n", repl: ""},
    {id: 'A106', rule: '0.2.2 menu: the circles are filled with the body colour, not the header colour (killed by the rendered grid only)', file: 'window.js', gjs: true,
        find: "PALETTE[value]?.lightHeader ?? null", repl: "PALETTE[value]?.light ?? null"},
    {id: 'A107', rule: '0.2.2 menu: the + button is not in the header', file: 'window.js', gjs: true,
        find: "        header.pack_start(add);\n", repl: ""},
    {id: 'A108', rule: '0.2.2 menu: About is above Delete note, not the last entry', file: 'application.js', gjs: true,
        find: "    notes.append(S.menuDeleteNote(), 'win.delete');", repl: "    notes.append(S.menuAbout(), 'win.about');\n    notes.append(S.menuDeleteNote(), 'win.delete');"},
    {id: 'A109', rule: '0.2.2 menu: New note is still in the menu (next to the + button)', file: 'application.js', gjs: true,
        find: "    more.append(S.menuAbout(), 'win.about');", repl: "    more.append(S.menuNewNote(), 'app.new-note');\n    more.append(S.menuAbout(), 'win.about');"},
    {id: 'A110', rule: '0.2.2 menu: New note has no Ctrl+N', file: 'application.js', gjs: true,
        find: "        gtkApp.set_accels_for_action('app.new-note', ['<Control>n']);\n", repl: ""},
    {id: 'A111', rule: '0.2.2 menu: the mark label is faded on a fixed (custom) colour (killed by the rendered grid test only)', file: 'window.js', gjs: true,
        find: "'window.cetli-note.cetli-fixed label.cetli-mark { opacity: 1; }',", repl: "'window.cetli-note.cetli-fixed label.cetli-mark { opacity: 0.85; }',"},
    {id: 'A112', rule: '0.2.2 menu: the invisible picker is not reachable by keyboard (focusable off)', file: 'window.js', gjs: true,
        find: "        picker.set_opacity(0);\n", repl: "        picker.set_opacity(0);\n        picker.set_can_focus(false);\n        picker.set_focusable(false);\n"},
    {id: 'A113', rule: '0.2.2 menu: the + circle does not show the keyboard focus of the picker', file: 'window.js', gjs: true,
        find: "                circle.add_css_class('cetli-dot-focus');", repl: "                circle.add_css_class('cetli-dot-focus-unused');"},
    {id: 'A120', rule: '0.2.2 grid: the red of the grid gets black text again (the white exception is gone)', file: 'data.js',
        find: "const WHITE_TEXT_ON = Object.freeze([NOTE_RHEL_RED]);", repl: "const WHITE_TEXT_ON = Object.freeze([]);"},
    {id: 'A121', rule: '0.2.2 grid: every custom colour gets white text (the white exception is not limited to the red)', file: 'data.js',
        find: "if (WHITE_TEXT_ON.includes(hexOf(rgb)))", repl: "if (true)"},
    {id: 'A122', rule: '0.2.2 grid: the red of the grid is #ff0000, not #ee0000', file: 'data.js',
        find: "export const NOTE_RHEL_RED = '#ee0000';", repl: "export const NOTE_RHEL_RED = '#ff0000';"},
    {id: 'A123', rule: '0.2.2 legacy: mint is no longer a known name (an old note would turn yellow)', file: 'data.js',
        find: "Object.freeze(['orange', 'mint', 'peach']);", repl: "Object.freeze(['orange', 'peach']);"},
    {id: 'A124', rule: '0.2.2 names: gray is replaced by orange in the six (a new note can get orange, gray is not offered)', file: 'colors.js', dir: 'src',
        find: "'blue', 'gray']);", repl: "'blue', 'orange']);"},
    {id: 'A125', rule: '0.2.2 dark theme: a named colour in the dark theme gets the LIGHT text', file: 'data.js',
        find: "`window.cetli-dark.cetli-${name} { background-color: ${p.dark}; color: ${TEXT_DARK}; }`,", repl: "`window.cetli-dark.cetli-${name} { background-color: ${p.dark}; color: ${TEXT_LIGHT}; }`,"},
    {id: 'A126', rule: '0.2.2 custom colour: the text is always black (no contrast choice)', file: 'data.js',
        find: "return contrastRatio(rgb, BLACK) >= contrastRatio(rgb, WHITE) ? '#000000' : '#ffffff';", repl: "return '#000000';"},
    {id: 'A127', rule: '0.2.2 custom colour: the fill is only for the light theme (the dark theme loses it)', file: 'data.js',
        find: "`window.${cls}, window.cetli-dark.${cls} { background-color: ${fill}; color: ${text}; }`,", repl: "`window.${cls} { background-color: ${fill}; color: ${text}; }`,"},
    {id: 'A128', rule: '0.2.2 grid: the black is #000000 again, not the Sticky Notes charcoal header #3f3d3c (Jenna 7174)', file: 'data.js',
        find: "export const NOTE_BLACK = '#3f3d3c';", repl: "export const NOTE_BLACK = '#000000';"},
    {id: 'A129', rule: '0.2.2 custom colour: a chooser value is not lower-cased (an upper case #EE0000 shows as yellow in 0.1.0/0.2.0)', file: 'data.js',
        find: "/^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : null", repl: "/^#[0-9a-fA-F]{6}$/.test(s) ? s : null"},
    {id: 'A130', rule: '0.2.2 grid: the distance floor is loosened globally (15 -> 8) instead of the one named gray/white exception', file: 'data.js',
        find: "export const MIN_DELTA_E = 15;", repl: "export const MIN_DELTA_E = 8;"},
    {id: 'A131', rule: '0.2.2 dark theme: the Sticky Notes dark pink is taken over (white text far below the 7:1 gate)', file: 'data.js',
        find: "dark: '#564f53', darkHeader: '#443f42'", repl: "dark: '#7c606e', darkHeader: '#7c425e'"},
    {id: 'A132', rule: '0.2.2 grid: the NOTE_WHITE export is missing (the menu would not load)', file: 'data.js',
        find: "export const NOTE_WHITE = '#ffffff';", repl: "const NOTE_WHITE = '#ffffff';"},
    {id: "A160", rule: "0.2.2 marks: a hash that is not the hash of the text is accepted (the old-client defence is gone)", file: 'marks.js',
        find: "        if (sha16(text) !== h)\n            return null;\n", repl: ""},
    {id: "A161", rule: "0.2.2 marks: the offsets count UTF-16 units, not code points", file: 'marks.js',
        find: "const codePointLength = text => Array.from(text).length;", repl: "const codePointLength = text => text.length;"},
    {id: "A162", rule: "0.2.2 marks: overlapping / unsorted ranges are accepted", file: 'marks.js',
        find: "t.length !== 3 || t[0] < prevEnd || ", repl: "t.length !== 3 || "},
    {id: "A163", rule: "0.2.2 marks: a range that ends past the text is accepted", file: 'marks.js',
        find: " || t[1] > len)", repl: ")"},
    {id: "A164", rule: "0.2.2 marks: flags 0 is accepted", file: 'marks.js',
        find: "Number.isSafeInteger(v) && v >= 1 && v <= ALL_FLAGS", repl: "Number.isSafeInteger(v) && v >= 0 && v <= ALL_FLAGS"},
    {id: "A165", rule: "0.2.2 marks: 257 ranges are accepted", file: 'marks.js',
        find: "r.length > MAX_RANGES)", repl: "r.length > MAX_RANGES + 1)"},
    {id: "A166", rule: "0.2.2 marks: a negative offset is accepted", file: 'marks.js',
        find: "const isOffset = v => Number.isSafeInteger(v) && v >= 0;", repl: "const isOffset = v => Number.isSafeInteger(v);"},
    {id: "A167", rule: "0.2.2 marks: a non-integer offset is accepted", file: 'marks.js',
        find: "const isOffset = v => Number.isSafeInteger(v) && v >= 0;", repl: "const isOffset = v => Number.isFinite(v) && v >= 0;"},
    {id: "A168", rule: "0.2.2 marks: encode does not cut the ranges to the text", file: 'marks.js',
        find: "            if (s < len)\n                cut.push([s, Math.min(e, len), f]);", repl: "            cut.push([s, e, f]);"},
    {id: "A169", rule: "0.2.2 marks: encode of a plain note gives an empty r instead of null", file: 'marks.js',
        find: "        if (r.length === 0)\n            return null;\n        const h = sha16(text);", repl: "        const h = sha16(text);"},
    {id: "A170", rule: "0.2.2 marks: touching ranges with different flags are merged", file: 'marks.js',
        find: "last[1] === start && last[2] === flags", repl: "last[1] === start"},
    {id: "A171", rule: "0.2.2 marks: toggle removes the flag when ANY of the selection has it", file: 'marks.js',
        find: "(flagsAt(norm, start, end).all & flag) !== 0", repl: "(flagsAt(norm, start, end).any & flag) !== 0"},
    {id: "A172", rule: "0.2.2 marks: flagsAt does not see a gap inside the selection", file: 'marks.js',
        find: "        if (s > pos)\n            all = 0;                         // a gap of unformatted text inside the selection\n", repl: ""},
    {id: "A173", rule: "0.2.2 marks: flagsAt does not see unformatted text after the last range", file: 'marks.js',
        find: "    if (pos < end)\n        all = 0;\n", repl: ""},
    {id: "A174", rule: "0.2.2 marks: the boundaries are sorted as strings", file: 'marks.js',
        find: "const positions = [...at.keys()].sort((a, b) => a - b);", repl: "const positions = [...at.keys()].sort();"},
    {id: "A175", rule: "0.2.2 marks: the marks key of the prototype is read", file: 'marks.js',
        find: "!Object.hasOwn(extra, 'marks')", repl: "!('marks' in extra)"},
    {id: "A176", rule: "0.2.2 marks: decode throws on a hostile object", file: 'marks.js',
        find: "        return normalizeRanges(r);\n    } catch {\n        return null;\n    }", repl: "        return normalizeRanges(r);\n    } catch (err) {\n        throw err;\n    }"},
    {id: "A177", rule: "0.2.2 marks: decode returns the stored list as it is (not normalized, not a copy)", file: 'marks.js',
        find: "        return normalizeRanges(r);\n    } catch", repl: "        return r;\n    } catch"},
    {id: "A178", rule: "0.2.2 marks: encode stores whatever the hash function answers", file: 'marks.js',
        find: "return typeof h === 'string' && HASH_RE.test(h) ? {h, r} : null;", repl: "return {h, r};"},
    {id: "A179", rule: "0.2.2 marks: toggle accepts a flag that is not a single bit", file: 'marks.js',
        find: "if (!isSelection(start, end) || !SINGLE_FLAGS.includes(flag))", repl: "if (!isSelection(start, end))"},
    {id: "A180", rule: "0.2.2 marks: an empty r is accepted", file: 'marks.js',
        find: "!Array.isArray(r) || r.length === 0 || r.length > MAX_RANGES", repl: "!Array.isArray(r) || r.length > MAX_RANGES"},
    {id: "A181", rule: "0.2.2 marks: normalize does not OR the flags of overlapping ranges (the last one wins)", file: 'marks.js',
        find: "                if (t[2] & bit)\n                    d[i] += sign;", repl: "                if (t[2] & bit && sign > 0)\n                    d[i] += sign;"},
    {id: "A190", rule: "0.2.2 marks hash: only 15 hex digits of the sha256 are kept", dir: 'app-tests', file: 'marks-gjs-smoke.js', gjs: true,
        find: "encoder.encode(text)).slice(0, 16);", repl: "encoder.encode(text)).slice(0, 15);"},
    {id: "A191", rule: "0.2.2 marks hash: the checksum of a string, which stops at the first NUL", dir: 'app-tests', file: 'marks-gjs-smoke.js', gjs: true,
        find: "GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, encoder.encode(text)).slice(0, 16);", repl: "GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, text, -1).slice(0, 16);"},
    {id: "A192", rule: "0.2.2 marks hash: the text is cut to one byte per UTF-16 unit instead of UTF-8", dir: 'app-tests', file: 'marks-gjs-smoke.js', gjs: true,
        find: "encoder.encode(text)).slice(0, 16);", repl: "Uint8Array.from(text, c => c.charCodeAt(0) & 0xff)).slice(0, 16);"},
    {id: "A193", rule: "0.2.2 marks hash: sha1 instead of sha256", dir: 'app-tests', file: 'marks-gjs-smoke.js', gjs: true,
        find: "GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, encoder.encode(text)).slice(0, 16);", repl: "GLib.compute_checksum_for_data(GLib.ChecksumType.SHA1, encoder.encode(text)).slice(0, 16);"},
    {id: "A194", rule: "0.2.2 marks hash: upper case hex", dir: 'app-tests', file: 'marks-gjs-smoke.js', gjs: true,
        find: "encoder.encode(text)).slice(0, 16);", repl: "encoder.encode(text)).slice(0, 16).toUpperCase();"},
    {id: "A195", rule: "0.2.2 marks hash: the text is hashed after a Unicode normalization (NFC), so a text written by another client hashes differently", dir: 'app-tests', file: 'marks-gjs-smoke.js', gjs: true,
        find: "encoder.encode(text)).slice(0, 16);", repl: "encoder.encode(text.normalize('NFC'))).slice(0, 16);"},
    {id: "A196", rule: "0.2.2 marks: offsets are UTF-16 units, not code points (Gtk.TextBuffer counts code points)", file: 'marks.js', gjs: true,
        find: "const codePointLength = text => Array.from(text).length;", repl: "const codePointLength = text => text.length;"},
    {id: 'A200', rule: '0.2.2 preview: the offset of a later line counts UTF-16 units (an emoji on an earlier line shifts the formatting)', file: 'preview.js',
        find: "const start = lead + Array.from(head.slice(0, a)).length;", repl: "const start = lead + a;"},
    {id: 'A201', rule: '0.2.2 preview: the blanks and blank lines before the text are not counted in the offsets', file: 'preview.js',
        find: "const lead = Array.from(whole.slice(0, whole.length - trimmed.length)).length;", repl: "const lead = 0;"},
    {id: 'A202', rule: '0.2.2 preview: "<" in the text of a note is not escaped (markup injection)', file: 'preview.js',
        find: "s.replace(/[&<>\"']/g,", repl: "s.replace(/[&>\"']/g,"},
    {id: 'A203', rule: '0.2.2 preview: a formatted range is not cut where its line is cut', file: 'preview.js',
        find: "i < Math.min(r[1], l.end); i++)", repl: "i < r[1]; i++)"},
    {id: 'A204', rule: '0.2.2 preview: overlapping ranges: the last one wins instead of the flags adding up', file: 'preview.js',
        find: "flags[i - l.start] |= f;", repl: "flags[i - l.start] = f;"},
    {id: 'A205', rule: '0.2.2 preview: no formatting on the shown lines still gives a markup card (it must stay plain)', file: 'preview.js',
        find: "return marked ? parts.join('\\n') : null;", repl: "return parts.join('\\n');"},
    {id: 'A206', rule: '0.2.2 preview: a range that is not three integers is used', file: 'preview.js',
        find: "!Number.isSafeInteger(r[0]) || !Number.isSafeInteger(r[1]) || !Number.isSafeInteger(r[2])", repl: "false"},
    {id: 'A207', rule: '0.2.2 preview: a lone surrogate in a shown line goes to the markup', file: 'preview.js',
        find: "if (lines.some(l => LONE_SURROGATE.test(l.chars.join(''))))", repl: "if (false)"},
    {id: 'A208', rule: '0.2.2 list: marks of another text (an old client rewrote it) are drawn: the hash is not checked', file: 'allnotes.js', gjs: true,
        find: "decodeMarks(text, marks, sha16)", repl: "decodeMarks(text, marks, () => marks?.marks?.h)"},
    {id: 'A209', rule: '0.2.2 list: a card that turns plain stays in markup mode (its text is then read as markup)', file: 'allnotes.js', gjs: true,
        find: "            info.label.set_use_markup(false);            // set_markup left it on: a plain text would be read as markup\n", repl: ""},
    // ---- 0.2.2 formatting bar (format-bar.js, window.js hooks): killed by format-bar-smoke.js unless said otherwise
    {id: 'A210', rule: 'formatting: a formatting step does not make the window dirty', file: 'window.js', gjs: true, tests: ['format-bar-smoke.js'],
        find: " || !sameRanges(this.bar.ranges(), this.shownRanges);", repl: ";"},
    {id: 'A211', rule: 'formatting: a save with the same text and colour is skipped even if the formatting changed', file: 'window.js', gjs: true, tests: ['format-bar-smoke.js'],
        find: "this.color === this.base.color && sameRanges(ranges, this.shownRanges))", repl: "this.color === this.base.color)"},
    {id: 'A212', rule: 'formatting: the save does not send the marks', file: 'window.js', gjs: true, tests: ['format-bar-smoke.js'],
        find: ", extra: marksExtra(text, ranges)}", repl: "}"},
    {id: 'A213', rule: 'formatting: closing reads the formatting late (the window is gone when the queued save runs)', file: 'window.js', gjs: true, tests: ['format-bar-smoke.js'],
        find: "await this._doSave(text, ranges);", repl: "await this._doSave(text);"},
    {id: 'A214', rule: 'formatting: a remote version does not re-apply its marks', file: 'window.js', gjs: true, tests: ['format-bar-smoke.js'],
        find: "        this.bar.setRanges(this.shownRanges);\n        this.base = rec;", repl: "        this.base = rec;"},
    {id: 'A215', rule: 'formatting: our own save does not update the formatting on disk (the window stays dirty)', file: 'window.js', gjs: true, tests: ['format-bar-smoke.js'],
        find: "            this.shownRanges = rangesOfRecord(res.record);\n", repl: ""},
    {id: 'A216', rule: 'formatting: a window opened on a record with marks does not apply them', file: 'window.js', gjs: true, tests: ['format-bar-smoke.js'],
        find: "        this.bar.setRanges(this.shownRanges);\n        const scroll", repl: "        const scroll"},
    {id: 'A217', rule: 'formatting: the hash of the marks is not checked (an old client\'s edit shows stale formatting)', file: 'format-bar.js', gjs: true, tests: ['format-bar-smoke.js'],
        find: "return decodeMarks(record.text, {marks}, sha16) ?? [];", repl: "return decodeMarks(record.text, {marks}, () => marks?.h) ?? [];"},
    {id: 'A218', rule: 'formatting: offsets are UTF-16 units, not code points (an emoji shifts them)', file: 'format-bar.js', gjs: true, tests: ['format-bar-smoke.js'],
        find: "const at = it.get_offset();", repl: "const at = this.buffer.get_text(this.buffer.get_start_iter(), it, false).length;"},
    {id: 'A219', rule: 'formatting: a button never takes a format away', file: 'format-bar.js', gjs: true, tests: ['format-bar-smoke.js'],
        find: "if ((flagsAt(this.ranges(), sel.from, sel.to).all & flag) !== 0)", repl: "if (false)"},
    {id: 'A220', rule: 'formatting: the buttons can be pressed without a selection', file: 'format-bar.js', gjs: true, tests: ['format-bar-smoke.js'],
        find: "button.set_sensitive(sel !== null && this.view.get_editable());", repl: "button.set_sensitive(true);"},
    {id: 'A221', rule: 'formatting: a click on a button takes the focus (and the selection look) from the text', file: 'format-bar.js', gjs: true, tests: ['format-bar-smoke.js'],
        find: "focus_on_click: false", repl: "focus_on_click: true"},
    {id: 'A222', rule: 'formatting: the paste is not replaced by the plain one', file: 'format-bar.js', gjs: true, tests: ['format-bar-smoke.js'],
        find: "            GObject.signal_stop_emission_by_name(this.view, 'paste-clipboard');\n", repl: ""},
    {id: 'A223', rule: 'formatting: the tooltip does not say that Ctrl+Z does not undo a formatting', file: 'format-bar.js', gjs: true, tests: ['format-bar-smoke.js'],
        find: "button.set_tooltip_text(`${f.tip()}\\n${S.formatUndoNote()}`);", repl: "button.set_tooltip_text(f.tip());"},
    {id: 'A224', rule: 'formatting: taking a format away raises no change (no save)', file: 'format-bar.js', gjs: true, tests: ['format-bar-smoke.js'],
        find: "        buffer.connect_after('remove-tag', tagChanged);\n", repl: ""},
    {id: 'A225', rule: 'formatting: putting a format on raises no change (no save)', file: 'format-bar.js', gjs: true, tests: ['format-bar-smoke.js'],
        find: "        buffer.connect_after('apply-tag', tagChanged);\n", repl: ""},
    {id: 'A226', rule: 'formatting: re-applying the marks of a version from the other computer counts as a user change', file: 'format-bar.js', gjs: true, tests: ['format-bar-smoke.js'],
        find: "        this.syncing = true;\n        try {\n            const length = this.buffer.get_char_count();", repl: "        try {\n            const length = this.buffer.get_char_count();"},
    {id: 'A227', rule: 'formatting: Ctrl+B is not the accelerator of bold', file: 'format-bar.js', gjs: true, tests: ['format-bar-smoke.js'],
        find: "accel: '<Control>b'", repl: "accel: '<Control>d'"},
    {id: 'A228', rule: 'formatting: the strikethrough tag does not strike through', file: 'format-bar.js', gjs: true, tests: ['format-bar-smoke.js'],
        find: "props: () => ({strikethrough: true})", repl: "props: () => ({})"},
    {id: 'A229', rule: 'formatting: the bold tag is not bold', file: 'format-bar.js', gjs: true, tests: ['format-bar-smoke.js'],
        find: "props: () => ({weight: Pango.Weight.BOLD})", repl: "props: () => ({})"},
    {id: 'A230', rule: 'formatting i18n: the hu catalog lacks the Bold button name', file: 'po/hu.po', dir: '.',
        find: 'msgid "Bold"\nmsgstr "Félkövér"', repl: 'msgid "Bold"\nmsgstr ""'},
    {id: 'A231', rule: 'formatting: the "a" of the buttons takes another colour than the note text', file: 'format-bar.js', gjs: true, tests: ['format-bar-smoke.js'],
        find: "box-shadow: none; color: inherit; outline-offset: 2px; }", repl: "box-shadow: none; color: #777777; outline-offset: 2px; }"},
    {id: 'A232', rule: 'formatting: the selection state of the buttons is not refreshed when the selection moves', file: 'format-bar.js', gjs: true, tests: ['format-bar-smoke.js'],
        find: "            if (name === 'insert' || name === 'selection_bound')\n                this.refresh();", repl: ""},
    {id: 'A233', rule: 'formatting: a button that is on has no outline (a tone alone is 1.1:1 to 1.6:1 on the note)', file: 'format-bar.js', gjs: true, tests: ['format-bar-render-smoke.js'],
        find: " box-shadow: inset 0 0 0 1px currentColor; }", repl: " }"},
    {id: 'A234', rule: 'formatting: the "a" of the buttons is faded to 0.6', file: 'format-bar.js', gjs: true, tests: ['format-bar-render-smoke.js'],
        find: "'button.cetli-fmt label { font-size: 16px; opacity: 1; }'", repl: "'button.cetli-fmt label { font-size: 16px; opacity: 0.6; }'"},
    {id: 'A235', rule: 'formatting: every button has a tone also when it is off', file: 'format-bar.js', gjs: true, tests: ['format-bar-render-smoke.js'],
        find: "background-image: none; background-color: transparent; box-shadow: none;", repl: "background-image: none; background-color: alpha(currentColor, 0.16); box-shadow: none;"},
];

const copyTree = (from, to) => fs.cpSync(from, to, {recursive: true, filter: p => !p.includes('node_modules')});

function runNode(dir) {
    const files = fs.readdirSync(path.join(dir, 'app-tests')).filter(f => f.endsWith('.test.js')).map(f => `app-tests/${f}`);
    const r = spawnSync(process.execPath, ['--test', ...files], {cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 120000, killSignal: 'SIGKILL'});
    const failed = [...r.stdout.matchAll(/^not ok \d+ - (.*)$/gm)].map(m => m[1]);
    return {failed, status: r.status};
}

// The gjs tests, one after the other; the first one with a failure ends the run (a mutant is killed once).
// CETLI_GJS_TESTS=a.js,b.js runs only those (for a mutant of one area, and while gtk-smoke.js is timing-flaky on a loaded machine).
const GJS_TESTS = process.env.CETLI_GJS_TESTS?.split(',') ?? ['marks-gjs-smoke.js', 'preview-marks-smoke.js', 'allnotes-smoke.js', 'gtk-smoke.js', 'color-picker-smoke.js', 'color-render-smoke.js', 'color-grid-render-smoke.js', 'format-bar-smoke.js', 'format-bar-render-smoke.js'];

function runGjs(dir, tests = GJS_TESTS) {
    let last = {failed: [], status: 0};
    for (const file of tests) {
        const cmd = `. "${gtkenv}/gjsenv.sh" && "${gtkenv}/headless.sh" 1920x1080 -- gjs -m app-tests/${file} 2>&1`;
        const r = spawnSync('bash', ['-c', cmd], {cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28, timeout: Number(process.env.CETLI_MUTANT_TIMEOUT_MS) || 180000, killSignal: 'SIGKILL'});
        const out = r.stdout ?? '';
        const failed = [...out.matchAll(/^FAIL (.*)$/gm)].map(m => `${file}: ${m[1]}`);
        if (!/RESULT PASS/.test(out))
            failed.push(`${file}: (no RESULT PASS)`);
        last = {failed, status: r.status};
        if (failed.length > 0)
            return last;
    }
    return last;
}

const only = process.argv.slice(2).filter(a => /^A\d+$/.test(a));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cetli-appmut-'));
let killed = 0;
let survived = 0;
let broken = 0;
let skipped = 0;
try {
    const clone = to => {
        fs.mkdirSync(to);
        for (const d of ['app', 'app-tests', 'po', 'src', 'tests'])
            copyTree(path.join(root, d), path.join(to, d));
        fs.copyFileSync(path.join(root, 'package.json'), path.join(to, 'package.json'));
    };
    const clean = path.join(base, 'clean');
    clone(clean);
    const ref = runNode(clean);
    const refGjs = gtkenv ? runGjs(clean) : {failed: [], status: 0};
    console.log(`unmutated: node ${ref.failed.length} failed; gjs ${gtkenv ? `${refGjs.failed.length} failed` : 'not run (CETLI_GTKENV not set)'}`);
    if (ref.failed.length > 0 || ref.status !== 0 || refGjs.failed.length > 0) {
        console.log('the unmutated tests are not green; mutants make no sense');
        process.exit(2);
    }
    for (const m of MUTANTS.filter(x => only.length === 0 || only.includes(x.id))) {
        const dir = path.join(base, m.id);
        clone(dir);
        const file = path.join(dir, m.dir ?? 'app', m.file);
        const text = fs.readFileSync(file, 'utf8');
        const count = text.split(m.find).length - 1;
        if (count !== 1) {
            broken++;
            console.log(`${m.id} BROKEN MUTANT (search text found ${count} times): ${m.rule}`);
            continue;
        }
        fs.writeFileSync(file, text.replace(m.find, () => m.repl));
        let r = runNode(dir);
        let by = 'node';
        if (r.failed.length === 0 && m.gjs) {
            if (!gtkenv) {
                skipped++;
                console.log(`${m.id} SKIPPED  needs the gjs smoke test (CETLI_GTKENV): ${m.rule}`);
                continue;
            }
            r = runGjs(dir, m.tests);
            by = 'gjs';
        }
        if (r.failed.length > 0) {
            killed++;
            console.log(`${m.id} KILLED   (${by}) ${m.rule}\n         ${r.failed.length} fail, e.g. "${r.failed[0].slice(0, 80)}"`);
        } else {
            survived++;
            console.log(`${m.id} SURVIVED ${m.rule}`);
        }
    }
} finally {
    fs.rmSync(base, {recursive: true, force: true});
}
console.log(`mutants: ${killed} killed, ${survived} survived, ${broken} broken, ${skipped} skipped`);
process.exit(survived + broken > 0 ? 1 : 0);
