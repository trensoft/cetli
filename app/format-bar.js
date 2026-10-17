// SPDX-License-Identifier: GPL-3.0-or-later
// The formatting bar of a note window (bold, italic, underline, strikethrough) and the glue between the text buffer and the
// stored `extra.marks` (formatting contract, marks.js). The formatting lives in the buffer as Gtk.TextTags; it is turned into
// ranges (marks.js) when the note is saved and back into tags when the note is shown. It never changes the text.
//
// First version: a button works on a SELECTION only (no "typing style"), a paste is plain text, Ctrl+Z does not undo a
// formatting step (a tag change is not on the undo stack of Gtk.TextBuffer, measured on GTK 4.8).
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';

import {BOLD, ITALIC, MAX_RANGES, STRIKE, UNDERLINE, decodeMarks, encodeMarks, flagsAt, normalizeRanges} from './marks.js';
import * as S from './strings.js';

const encoder = new TextEncoder();

// The first 16 lower case hex digits of the sha256 of the UTF-8 text: the `h` of the marks (formatting contract 1).
export function sha16(text) {
    return GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, encoder.encode(text)).slice(0, 16);
}

// The ranges a record's marks give for the record's own text, or [] (shown plain): no marks, malformed marks, or a hash that is
// not the hash of the text (an older cetli rewrote the text). Never throws.
export function rangesOfRecord(record) {
    const marks = record?.extra instanceof Map ? record.extra.get('marks') : undefined;
    if (marks === undefined)
        return [];
    return decodeMarks(record.text, {marks}, sha16) ?? [];
}

// The `extra` of a save for this text and these ranges: the marks, or null (the core removes the key) for a plain note.
export const marksExtra = (text, ranges) => ({marks: encodeMarks(text, ranges, sha16)});

// Two lists of ranges are the same when they store the same (normalized, cut to MAX_RANGES, like encodeMarks does).
const stored = ranges => JSON.stringify(normalizeRanges(ranges).slice(0, MAX_RANGES));
export const sameRanges = (a, b) => stored(a) === stored(b);

// One entry per button, in the order of the bar.
const FORMATS = [
    {flag: BOLD, tag: 'cetli-bold', action: 'fmt-bold', accel: '<Control>b', markup: '<b>a</b>', name: S.formatBold, tip: S.formatBoldTooltip,
        props: () => ({weight: Pango.Weight.BOLD})},
    {flag: ITALIC, tag: 'cetli-italic', action: 'fmt-italic', accel: '<Control>i', markup: '<i>a</i>', name: S.formatItalic, tip: S.formatItalicTooltip,
        props: () => ({style: Pango.Style.ITALIC})},
    {flag: UNDERLINE, tag: 'cetli-underline', action: 'fmt-underline', accel: '<Control>u', markup: '<u>a</u>', name: S.formatUnderline, tip: S.formatUnderlineTooltip,
        props: () => ({underline: Pango.Underline.SINGLE})},
    {flag: STRIKE, tag: 'cetli-strike', action: 'fmt-strike', accel: '<Control><Shift>x', markup: '<s>a</s>', name: S.formatStrikethrough, tip: S.formatStrikethroughTooltip,
        props: () => ({strikethrough: true})},
];
export const FORMAT_ACTIONS = FORMATS.map(f => ({name: f.action, accel: f.accel, flag: f.flag}));

// Button look (Wanda's spec): 36 px, 8 px corner, a 16 px "a" in the colour of the note text (currentColor), a 7 % tone on hover,
// 16 % and a 1 px outline when on (a tone alone is 1.1:1 to 1.6:1 on the note), a 2 px ring for the keyboard focus.
const BAR_CSS = [
    'box.cetli-fmt-bar { padding: 4px 8px; }',
    'button.cetli-fmt { min-width: 36px; min-height: 36px; padding: 0; border-radius: 8px; border: none; background-image: none; background-color: transparent; box-shadow: none; color: inherit; outline-offset: 2px; }',
    'button.cetli-fmt label { font-size: 16px; opacity: 1; }',
    'button.cetli-fmt:hover { background-color: alpha(currentColor, 0.07); }',
    'button.cetli-fmt:active { background-color: alpha(currentColor, 0.16); }',
    'button.cetli-fmt:checked { background-color: alpha(currentColor, 0.16); box-shadow: inset 0 0 0 1px currentColor; }',
    'button.cetli-fmt:checked:hover { background-color: alpha(currentColor, 0.20); }',
    'button.cetli-fmt:focus-visible { outline: 2px solid currentColor; }',
    'button.cetli-fmt:disabled { opacity: 0.4; }',
];
let barStyleAdded = false;

function ensureBarStyle() {
    if (barStyleAdded)
        return;
    const css = `${BAR_CSS.join('\n')}\n`;
    const provider = new Gtk.CssProvider();
    if (typeof provider.load_from_string === 'function')
        provider.load_from_string(css);
    else
        provider.load_from_data(css);
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    barStyleAdded = true;
}

export class FormatBar {
    // view/buffer: the note's text; onChange(): called when the USER changed a formatting (not when setRanges did).
    constructor({view, buffer, onChange}) {
        this.view = view;
        this.buffer = buffer;
        this.onChange = onChange;
        this.syncing = false;             // set while setRanges or refresh change the tags or the buttons
        ensureBarStyle();

        const table = buffer.get_tag_table();
        this.tags = new Map();
        for (const f of FORMATS) {
            const tag = new Gtk.TextTag({name: f.tag, ...f.props()});
            table.add(tag);
            this.tags.set(f.flag, tag);
        }

        this.widget = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 4, halign: Gtk.Align.START});
        this.widget.add_css_class('cetli-fmt-bar');
        this.widget.update_property([Gtk.AccessibleProperty.LABEL], [S.formatBarLabel()]);
        this.buttons = new Map();
        for (const f of FORMATS) {
            const button = new Gtk.ToggleButton({focus_on_click: false, child: new Gtk.Label({use_markup: true, label: f.markup})});
            button.add_css_class('cetli-fmt');
            // The names: the screen reader must not read the "a"; the tooltip also says that Ctrl+Z does not undo a formatting.
            button.set_tooltip_text(`${f.tip()}\n${S.formatUndoNote()}`);
            button.update_property([Gtk.AccessibleProperty.LABEL, Gtk.AccessibleProperty.DESCRIPTION], [f.name(), S.formatUndoNote()]);
            button.connect('toggled', () => {
                if (!this.syncing)
                    this.toggle(f.flag);
            });
            this.widget.append(button);
            this.buttons.set(f.flag, button);
        }

        // A tag change raises apply-tag / remove-tag, NOT `changed` and not `modified` (measured, GTK 4.8).
        const tagChanged = () => {
            this.refresh();
            if (!this.syncing)
                this.onChange?.();
        };
        buffer.connect_after('apply-tag', tagChanged);
        buffer.connect_after('remove-tag', tagChanged);
        buffer.connect_after('mark-set', (_b, _iter, mark) => {
            const name = mark.get_name();
            if (name === 'insert' || name === 'selection_bound')
                this.refresh();
        });
        buffer.connect_after('changed', () => this.refresh());
        this._plainPaste();
        this.refresh();
    }

    // The formatting of the whole text as normalized ranges, in code points (Gtk.TextBuffer offsets), from the tags.
    ranges() {
        const out = [];
        const end = this.buffer.get_char_count();
        for (const f of FORMATS) {
            const tag = this.tags.get(f.flag);
            const it = this.buffer.get_start_iter();
            let start = it.has_tag(tag) ? 0 : -1;
            while (it.forward_to_tag_toggle(tag)) {
                const at = it.get_offset();
                if (start >= 0 && !it.has_tag(tag)) {
                    if (at > start)
                        out.push([start, at, f.flag]);
                    start = -1;
                } else if (start < 0 && it.has_tag(tag)) {
                    start = at;
                }
            }
            if (start >= 0 && end > start)
                out.push([start, end, f.flag]);
        }
        return normalizeRanges(out);
    }

    // Replaces ALL formatting by these ranges (a record was read: another computer's version, or the first show). Raises no onChange.
    setRanges(ranges) {
        const wasSyncing = this.syncing;
        this.syncing = true;
        try {
            const length = this.buffer.get_char_count();
            const start = this.buffer.get_start_iter();
            const end = this.buffer.get_end_iter();
            for (const tag of this.tags.values())
                this.buffer.remove_tag(tag, start, end);
            for (const [s, e, flags] of normalizeRanges(ranges)) {
                if (s >= length)
                    continue;
                for (const f of FORMATS) {
                    if (flags & f.flag)
                        this.buffer.apply_tag(this.tags.get(f.flag), this.buffer.get_iter_at_offset(s), this.buffer.get_iter_at_offset(Math.min(e, length)));
                }
            }
        } finally {
            this.syncing = wasSyncing;
        }
        this.refresh();
    }

    // The selection as code point offsets, or null when there is none.
    _selection() {
        const [has, start, end] = this.buffer.get_selection_bounds();
        return has ? {start, end, from: start.get_offset(), to: end.get_offset()} : null;
    }

    // Switches the format for the selection: all of it has it -> removed, otherwise added to all of it (marks.js toggleFlag).
    toggle(flag) {
        const sel = this._selection();
        if (sel === null || !this.view.get_editable()) {
            this.refresh();
            return;
        }
        const tag = this.tags.get(flag);
        if ((flagsAt(this.ranges(), sel.from, sel.to).all & flag) !== 0)
            this.buffer.remove_tag(tag, sel.start, sel.end);
        else
            this.buffer.apply_tag(tag, sel.start, sel.end);
        this.refresh();
    }

    // The buttons show the formats the whole selection has; without a selection they are off and cannot be pressed.
    refresh() {
        const sel = this._selection();
        const all = sel === null ? 0 : flagsAt(this.ranges(), sel.from, sel.to).all;
        const wasSyncing = this.syncing;
        this.syncing = true;
        try {
            for (const [flag, button] of this.buttons) {
                button.set_sensitive(sel !== null && this.view.get_editable());
                button.set_active((all & flag) !== 0);
            }
        } finally {
            this.syncing = wasSyncing;
        }
    }

    // The action for a key: window action `win.fmt-bold` and so on.
    activate(flag) {
        this.toggle(flag);
    }

    // A paste is plain text: the clipboard may hold the formatted contents of another note (GTK's own format); only the text is taken.
    _plainPaste() {
        this.view.connect('paste-clipboard', () => {
            GObject.signal_stop_emission_by_name(this.view, 'paste-clipboard');
            if (!this.view.get_editable())
                return;
            this.view.get_clipboard().read_value_async(GObject.TYPE_STRING, GLib.PRIORITY_DEFAULT, null, (clipboard, result) => {
                let text = null;
                try {
                    text = clipboard.read_value_finish(result);
                } catch (e) {
                    console.warn(`cetli: paste: ${e.message}`);
                    return;
                }
                if (typeof text !== 'string' || text === '')
                    return;
                this.buffer.begin_user_action();
                try {
                    this.buffer.delete_selection(true, true);
                    this.buffer.insert_interactive_at_cursor(text, -1, true);
                } finally {
                    this.buffer.end_user_action();
                }
                this.view.scroll_mark_onscreen(this.buffer.get_insert());
            });
        });
    }
}
