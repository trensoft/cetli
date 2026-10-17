// SPDX-License-Identifier: GPL-3.0-or-later
// One note window (PLAN.md sections 3, 8, 9). It never reads or writes a file itself: every read and write goes through
// the core (`store`), and the window title is the contract with the GNOME Shell extension (`cetli-<uuid>`, set before
// the window is shown). Text for the user comes from strings.js only.
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {SAVE_COALESCE_MS} from '../src/constants.js';
import {COLORS, GRID_COLORS, PALETTE, REMOTE_QUIET_MS, WINDOW_TITLE_PREFIX, cssClassOf, customColorStyle, isCustomColor, parseCustomColor, textColorFor} from './data.js';
import {changedRegion} from './textdiff.js';
import {FORMAT_ACTIONS, FormatBar, marksExtra, rangesOfRecord, sameRanges} from './format-bar.js';
import * as S from './strings.js';

// A Gdk.RGBA as the lower case `#rrggbb` of the core's custom colour.
const hexOfRgba = c => `#${[c.red, c.green, c.blue].map(v => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0')).join('')}`;

// One provider per custom colour in use, added the first time a window shows it (the CSS comes from data.js, built from three
// integers). At most one per distinct colour, and a note file can only name as many colours as there are notes.
const customProviders = new Set();

function ensureCustomStyle(color) {
    const style = customColorStyle(color);
    if (style === null || customProviders.has(style.cls))
        return;
    const provider = new Gtk.CssProvider();
    if (typeof provider.load_from_string === 'function')
        provider.load_from_string(style.css);
    else
        provider.load_from_data(style.css);
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    customProviders.add(style.cls);
}

// The fill of a circle in the colour grid: a custom `#rrggbb` is itself, a name is the strip (header) colour of that colour, as
// in the Sticky Notes circles.
const dotFill = value => (isCustomColor(value) ? value : (PALETTE[value]?.lightHeader ?? null));

// The CSS of the circles, once for the program: one class per place in the grid, built from the fills (which are
// constants of data.js, `#rrggbb` only). A selected circle has a ring (an outer shadow, with a gap in the colour of the popover) and a
// badge in its corner, NOT a tick on the fill (a tick on the yellow fill is 1.17:1). Every circle has a 1 px border, so the white
// one can be seen on the white popover. `.cetli-fixed` (a custom colour on the note) puts the mark label at full opacity.
const DOT_SIZE = 36;                           // the circles of the grid, px with the 1 px border (the grid is 5 x 36 + 4 x 10 = 220 px wide)
let gridStyleAdded = false;

function ensureGridStyle() {
    if (gridStyleAdded)
        return;
    const rules = [
        `button.cetli-dot { min-width: ${DOT_SIZE - 2}px; min-height: ${DOT_SIZE - 2}px; padding: 0; border-radius: ${DOT_SIZE / 2}px; border: 1px solid rgba(0, 0, 0, 0.5); background-image: none; }`,
        'window.cetli-dark button.cetli-dot { border-color: rgba(255, 255, 255, 0.5); }',
        'button.cetli-dot.cetli-selected { box-shadow: 0 0 0 2px @popover_bg_color, 0 0 0 4px @accent_bg_color; }',
        'button.cetli-dot.cetli-dot-focus { outline: 2px solid @accent_bg_color; outline-offset: 2px; }',
        'button.cetli-dot-custom { background-color: rgba(128, 128, 128, 0.25); }',
        'image.cetli-badge { background-color: @accent_bg_color; color: @accent_fg_color; border-radius: 9px; padding: 3px; }',
        'window.cetli-note.cetli-fixed label.cetli-mark { opacity: 1; }',
    ];
    GRID_COLORS.forEach((value, i) => {
        const fill = dotFill(value);
        if (fill !== null && parseCustomColor(fill) !== null)
            rules.push(`button.cetli-dot-${i} { background-color: ${fill}; }`);
    });
    addProvider(rules);
    gridStyleAdded = true;
}

function addProvider(rules) {
    const css = `${rules.join('\n')}\n`;
    const provider = new Gtk.CssProvider();
    if (typeof provider.load_from_string === 'function')
        provider.load_from_string(css);
    else
        provider.load_from_data(css);
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
}

// The custom circle shows the colour of a note that no other circle has: one rule per colour (from three integers), once.
const fillProviders = new Set();

function ensureFillStyle(color) {
    const rgb = parseCustomColor(color);
    if (rgb === null)
        return null;
    const cls = `cetli-fill-${color.slice(1)}`;
    if (!fillProviders.has(cls)) {
        addProvider([`button.cetli-dot-custom.${cls} { background-color: ${color}; color: ${textColorFor(rgb)}; }`]);
        fillProviders.add(cls);
    }
    return cls;
}
const GRID_COLUMNS = 5;                       // 2 rows of 5: the 9 colours of GRID_COLORS and the custom colour

// A circle (a button) with the badge of the selection over its bottom right corner; -> {overlay, badge}.
function withBadge(button) {
    const badge = new Gtk.Image({icon_name: 'object-select-symbolic', pixel_size: 10, halign: Gtk.Align.END, valign: Gtk.Align.END, can_target: false, visible: false});
    badge.add_css_class('cetli-badge');
    const overlay = new Gtk.Overlay({child: button});
    overlay.add_overlay(badge);
    return {overlay, badge};
}

const nowMs = () => Math.floor(GLib.get_monotonic_time() / 1000);

function once(ms, fn) {
    return GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        fn();
        return GLib.SOURCE_REMOVE;
    });
}

export class NoteWindow {
    // ctl: {store, gtkApp, menu, dark, hold(), release(), newNote(win), showAbout(win), setOpen(id, open), closed(id), notesChanged(), log}
    constructor({ctl, record, size}) {
        this.ctl = ctl;
        this.store = ctl.store;
        this.id = record.id;
        this.base = record;                 // the record the user started from (core 2.5)
        this.shownText = record.text;       // the text of the version last read from or written to disk (PLAN 3 (3))
        this.shownRanges = rangesOfRecord(record);   // its formatting (stored marks, or none when they do not fit the text)
        this.color = record.color;
        this.colorClass = null;             // the CSS class of the colour now on the window
        this.applying = false;              // PLAN 3 (2): set while a remote text is put into the buffer
        this.lastKey = -Infinity;
        this.pendingRemote = null;
        this.remoteDeleted = false;
        this.deleted = false;
        this.closing = false;
        this.closeWarned = false;           // the first close of a window with an unsaved, refused text only warns
        this.mark = null;                   // {kind, text}
        this._saveTimer = null;
        this._quietTimer = null;
        this._chain = Promise.resolve();

        this.win = new Gtk.ApplicationWindow({
            application: ctl.gtkApp,
            title: `${WINDOW_TITLE_PREFIX}${this.id}`,            // BEFORE the first present()
            default_width: size.width,
            default_height: size.height,
        });
        this.win.add_css_class('cetli-note');
        this._buildHeader();
        this._buildBody(record.text);
        this._addActions();
        this._applyColorClass();
        this.setDark(ctl.dark());
        this.win.connect('close-request', () => this._onCloseRequest());
    }

    present() {
        this.win.present();
        this.view.grab_focus();
    }

    // ---- building --------------------------------------------------------------------------------------------

    _buildHeader() {
        const header = new Gtk.HeaderBar();
        header.add_css_class('cetli-header');
        header.set_title_widget(new Gtk.Label({label: ''}));    // the title is the contract name, not for the eye
        this.unresolved = new Gtk.Label({visible: false});
        this.unresolved.add_css_class('cetli-unresolved');
        // New note: a + in the header (not in the menu); Ctrl+N is the accelerator of the same action.
        const add = Gtk.Button.new_from_icon_name('list-add-symbolic');
        add.set_action_name('app.new-note');
        add.set_tooltip_text(S.menuNewNote());
        add.update_property([Gtk.AccessibleProperty.LABEL], [S.menuNewNote()]);
        this.addButton = add;
        header.pack_start(add);
        header.pack_start(this.unresolved);

        // The hamburger menu: the colour grid on top (a custom item of the menu model, filled in here), then the entries.
        const popover = Gtk.PopoverMenu.new_from_model(this.ctl.menu);
        popover.add_child(this._buildColorGrid(), 'colors');
        this.menuPopover = popover;
        this.menuButton = new Gtk.MenuButton({icon_name: 'open-menu-symbolic', popover, tooltip_text: S.menuTooltip()});
        header.pack_end(this.menuButton);
        this.win.set_titlebar(header);
    }

    // The colours of GRID_COLORS as circles (2 rows of 5), then a circle with a + for any other colour. A circle sets the
    // colour through the `win.color` action; the circle of the colour the note has shows a ring and a badge.
    _buildColorGrid() {
        ensureGridStyle();
        const grid = new Gtk.Grid({row_spacing: 10, column_spacing: 10, margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12, halign: Gtk.Align.CENTER});
        this.dots = new Map();               // colour value -> {button, badge}
        GRID_COLORS.forEach((value, i) => {
            const button = new Gtk.Button({action_name: 'win.color', action_target: GLib.Variant.new_string(value), tooltip_text: S.colorName(value)});
            button.add_css_class('cetli-dot');
            button.add_css_class(`cetli-dot-${i}`);
            button.update_property([Gtk.AccessibleProperty.LABEL], [S.colorName(value)]);
            const {overlay, badge} = withBadge(button);
            this.dots.set(value, {button, badge});
            grid.attach(overlay, i % GRID_COLUMNS, Math.floor(i / GRID_COLUMNS), 1, 1);
        });
        // The last circle: what the user sees is a neutral circle with a + (the colour of the note, if it is a custom one);
        // the picker (the same one as before, it opens the GTK colour chooser) lies over it, invisible, and takes the click
        // and the focus. As it is invisible, the circle shows the focus (cetli-dot-focus).
        const plus = new Gtk.Image({icon_name: 'list-add-symbolic', pixel_size: 16});
        const circle = new Gtk.Button({child: plus, can_target: false, focusable: false});
        circle.add_css_class('cetli-dot');
        circle.add_css_class('cetli-dot-custom');
        const picker = this._buildCustomPicker();
        picker.set_opacity(0);
        picker.update_property([Gtk.AccessibleProperty.LABEL], [S.customColorTooltip()]);
        const focus = new Gtk.EventControllerFocus();
        focus.connect('notify::contains-focus', () => {
            if (focus.contains_focus)
                circle.add_css_class('cetli-dot-focus');
            else
                circle.remove_css_class('cetli-dot-focus');
        });
        picker.add_controller(focus);
        const {overlay: custom, badge} = withBadge(circle);
        custom.add_overlay(picker);
        this.customDot = {button: circle, badge, fill: null};
        grid.attach(custom, GRID_COLUMNS - 1, 1, 1, 1);
        this._syncGrid();
        return grid;
    }

    // The ring and the badge: on the circle whose value is the colour of the note; a custom colour that no circle has: on the
    // custom one, which also takes that colour.
    _syncGrid() {
        if (!this.dots)
            return;
        for (const [value, dot] of this.dots)
            this._select(dot, this.color === value);
        const other = isCustomColor(this.color) && !this.dots.has(this.color);
        this._select(this.customDot, other);
        const cls = other ? ensureFillStyle(this.color) : null;
        if (this.customDot.fill !== cls) {
            if (this.customDot.fill)
                this.customDot.button.remove_css_class(this.customDot.fill);
            if (cls)
                this.customDot.button.add_css_class(cls);
            this.customDot.fill = cls;
        }
    }

    _select(dot, on) {
        dot.badge.set_visible(on);
        if (on)
            dot.button.add_css_class('cetli-selected');
        else
            dot.button.remove_css_class('cetli-selected');
    }

    // Any colour, next to the palette. Gtk.ColorDialogButton is GTK 4.10 and later (RHEL 10 has 4.16); GTK 4.8 (the Debian 12
    // test environment) has only the older Gtk.ColorButton. Chosen when the popover is built, never at module level, so the
    // missing class cannot stop the module from loading. The choice goes through setColor like a palette colour.
    _buildCustomPicker() {
        const picked = rgba => {
            if (!this.pickerSync)
                this.setColor(hexOfRgba(rgba));
        };
        if (typeof Gtk.ColorDialogButton === 'function' && typeof Gtk.ColorDialog === 'function') {
            this.customPicker = new Gtk.ColorDialogButton({dialog: new Gtk.ColorDialog({title: S.customColorTitle(), with_alpha: false})});
            this.customPicker.connect('notify::rgba', () => picked(this.customPicker.get_rgba()));
        } else {
            this.customPicker = new Gtk.ColorButton({title: S.customColorTitle(), use_alpha: false});
            this.customPicker.connect('color-set', () => picked(this.customPicker.get_rgba()));
        }
        this.customPicker.set_tooltip_text(S.customColorTooltip());
        this.pickerSync = false;
        return this.customPicker;
    }

    // The button shows the current custom colour (a palette colour leaves it as it was).
    _syncPicker() {
        const c = isCustomColor(this.color) ? parseCustomColor(this.color) : null;
        if (c === null || !this.customPicker)
            return;
        this.pickerSync = true;       // setting the colour is not a choice by the user
        try {
            this.customPicker.set_rgba(new Gdk.RGBA({red: c.r / 255, green: c.g / 255, blue: c.b / 255, alpha: 1}));
        } finally {
            this.pickerSync = false;
        }
    }

    _buildBody(text) {
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        this.view = new Gtk.TextView({wrap_mode: Gtk.WrapMode.WORD_CHAR, left_margin: 8, right_margin: 8, top_margin: 6, bottom_margin: 6});
        this.view.add_css_class('cetli-text');
        this.view.update_property([Gtk.AccessibleProperty.LABEL], [S.textViewLabel()]);
        this.buffer = this.view.get_buffer();
        this.applying = true;
        this.buffer.set_text(text, -1);
        this.applying = false;
        this.buffer.connect('changed', () => this._onChanged());
        this.bar = new FormatBar({view: this.view, buffer: this.buffer, onChange: () => this._onChanged(true)});
        this.bar.setRanges(this.shownRanges);
        const scroll = new Gtk.ScrolledWindow({child: this.view, hexpand: true, vexpand: true});
        this.markLabel = new Gtk.Label({visible: false, xalign: 0, wrap: true});
        this.markLabel.add_css_class('cetli-mark');
        box.append(scroll);
        box.append(this.markLabel);
        box.append(this.bar.widget);
        this.win.set_child(box);
    }

    _addActions() {
        const act = (name, fn, type = null) => {
            const a = new Gio.SimpleAction({name, parameter_type: type});
            a.connect('activate', (_a, param) => fn(param));
            this.win.add_action(a);
        };
        act('delete', () => this.deleteNote());
        act('about', () => this.ctl.showAbout(this.win));
        act('color', p => this.setColor(p.get_string()[0]), new GLib.VariantType('s'));
        // Formatting keys: the accelerators belong to the application (set once), the actions to each window.
        for (const f of FORMAT_ACTIONS) {
            act(f.name, () => this.bar.activate(f.flag));
            this.ctl.gtkApp.set_accels_for_action(`win.${f.name}`, [f.accel]);
        }
    }

    // ---- look ------------------------------------------------------------------------------------------------

    _applyColorClass() {
        if (this.colorClass)
            this.win.remove_css_class(this.colorClass);
        ensureCustomStyle(this.color);
        this.colorClass = cssClassOf(this.color);
        this.win.add_css_class(this.colorClass);
        if (isCustomColor(this.color))
            this.win.add_css_class('cetli-fixed');
        else
            this.win.remove_css_class('cetli-fixed');
        this._syncPicker();
        this._syncGrid();
    }

    setDark(dark) {
        if (dark)
            this.win.add_css_class('cetli-dark');
        else
            this.win.remove_css_class('cetli-dark');
    }

    setUnresolved(n) {
        this.unresolved.set_visible(n > 0);
        if (n > 0) {
            this.unresolved.set_label(S.unresolvedText(n));
            this.unresolved.set_tooltip_text(S.unresolvedTooltip());
        }
    }

    _setMark(kind, text) {
        this.mark = {kind, text};
        this.markLabel.set_label(text);
        this.markLabel.set_visible(true);
    }

    _clearMark(...kinds) {
        if (this.mark && (kinds.length === 0 || kinds.includes(this.mark.kind))) {
            this.mark = null;
            this.markLabel.set_visible(false);
        }
    }

    // ---- editing and saving (PLAN 2.5, 3) ----------------------------------------------------------------------

    _bufferText() {
        return this.buffer.get_text(this.buffer.get_start_iter(), this.buffer.get_end_iter(), false);
    }

    _dirty() {
        return this._bufferText() !== this.shownText || this.color !== this.base.color || !sameRanges(this.bar.ranges(), this.shownRanges);
    }

    // `format`: a formatting step (a tag change raises no `changed`, so the bar tells us).
    _onChanged(format = false) {
        if (this.applying && !format)
            return;                          // PLAN 3 (2): applying a remote text is not a user edit
        this.lastKey = nowMs();
        this.closeWarned = false;            // new text: a refused save is a new reason to ask before closing
        this._scheduleSave();
    }

    // At most one write per SAVE_COALESCE_MS (PLAN 3, save granularity).
    _scheduleSave() {
        if (this._saveTimer !== null || this.deleted)
            return;
        this._saveTimer = once(SAVE_COALESCE_MS, () => {
            this._saveTimer = null;
            this._queue(() => this._doSave());
        });
    }

    _cancelSaveTimer() {
        if (this._saveTimer !== null) {
            GLib.source_remove(this._saveTimer);
            this._saveTimer = null;
        }
    }

    _queue(fn) {
        const run = this._chain.then(fn);
        this._chain = run.catch(e => this.ctl.log(`window ${this.id}: ${e?.message ?? e}`));
        return run;
    }

    // `text` and `ranges` are read together: the text and its formatting of the same instant.
    async _doSave(text = this._bufferText(), ranges = this.bar.ranges()) {
        if (this.deleted)
            return;
        if (text === this.shownText && this.color === this.base.color && sameRanges(ranges, this.shownRanges))
            return;                          // PLAN 3 (3): nothing differs from what is on disk
        this.ctl.hold();
        try {
            // The core's tmp write is one synchronous GLib call (CONSISTENT | DURABLE, which resolves to 2 under gjs with
            // glib 2.74) and DURABLE also fsyncs the tmp/ directory on every save, so the main loop stands still for its
            // duration. The cost on a real disk is not measured. It runs from the SAVE_COALESCE_MS timer, never from a key
            // handler.
            this._afterSave(await this.store.saveNote(this.id, this.base, {text, color: this.color, deleted: false, extra: marksExtra(text, ranges)}));
        } finally {
            this.ctl.release();
        }
    }

    // A result of saveNote or of the core's own retry ('save-retried').
    _afterSave(res) {
        if (res.ok) {
            this.base = res.record;
            this.shownText = res.record.text;
            this.shownRanges = rangesOfRecord(res.record);
            this.pendingRemote = null;       // the local text won; the other version was kept as a copy (2.5)
            this.remoteDeleted = false;
            this._clearMark();
            this.ctl.notesChanged?.();       // our own saves raise no store event: the "All notes" list is told here
        } else {
            this._setMark('refused', S.markNotSaved(res.cause.code));
        }
    }

    onSaveRetried(result) {
        if (!this.deleted)
            this._afterSave(result);
    }

    setColor(name) {
        if (!(COLORS.includes(name) || GRID_COLORS.includes(name) || isCustomColor(name)) || name === this.color)
            return;
        this.color = name;
        this._applyColorClass();
        this._cancelSaveTimer();
        this._queue(() => this._doSave());
    }

    deleteNote() {
        this._cancelSaveTimer();
        this._queue(async () => {
            if (this.deleted)
                return;
            this.ctl.hold();
            try {
                const res = await this.store.deleteNote(this.id, this.base);
                if (res.ok) {
                    this.deleted = true;
                    this.ctl.notesChanged?.();
                    this.win.close();
                } else {
                    this._setMark('refused', S.markNotSaved(res.cause.code));
                }
            } finally {
                this.ctl.release();
            }
        });
    }

    // ---- a version from the other computer (PLAN 3) -------------------------------------------------------------

    onRemote(record) {
        if (this.deleted || record.v === this.base.v)
            return;
        if (record.deleted) {
            // The window is NOT closed and the unsaved text is not lost; typing or saving brings the note back (2.5).
            this.remoteDeleted = true;
            this.pendingRemote = null;
            this._setMark('deleted', S.markDeletedElsewhere());
            return;
        }
        this.pendingRemote = record;
        this._tryApplyRemote();
    }

    onRemoved() {
        if (!this.deleted)
            this._setMark('deleted', S.markFileGone());
    }

    _tryApplyRemote() {
        const rec = this.pendingRemote;
        if (rec === null || this.deleted)
            return;
        const quietFor = nowMs() - this.lastKey;
        if (!this._dirty() && quietFor >= REMOTE_QUIET_MS) {
            this._applyRemote(rec);
            return;
        }
        // Typing: leave the buffer alone and show a mark. A dirty buffer is saved by the pending save (local wins, the
        // other version is kept as a copy); a clean one is tried again when the 2 s are over.
        this._setMark('newer', S.markNewerVersion());
        if (!this._dirty() && this._quietTimer === null) {
            this._quietTimer = once(Math.max(1, REMOTE_QUIET_MS - quietFor + 10), () => {
                this._quietTimer = null;
                this._tryApplyRemote();
            });
        }
    }

    _applyRemote(rec) {
        const region = changedRegion(this._bufferText(), rec.text);
        if (region !== null) {
            this.applying = true;
            // A cursor (or the other end of a selection) exactly at the start of the region stays before the new text;
            // inserting at the mark would push it behind. Marks elsewhere move by themselves (textdiff.js).
            const marks = [this.buffer.get_insert(), this.buffer.get_selection_bound()];
            const atStart = marks.filter(m => this.buffer.get_iter_at_mark(m).get_offset() === region.start);
            // Ctrl+Z must not bring back the other computer's text: the replacement is an irreversible action.
            this.buffer.begin_irreversible_action();
            try {
                const start = this.buffer.get_iter_at_offset(region.start);
                const end = this.buffer.get_iter_at_offset(region.start + region.deleteCount);
                this.buffer.delete(start, end);
                this.buffer.insert(this.buffer.get_iter_at_offset(region.start), region.insert, -1);
                for (const m of atStart)
                    this.buffer.move_mark(m, this.buffer.get_iter_at_offset(region.start));
            } finally {
                this.buffer.end_irreversible_action();
                this.applying = false;
            }
        }
        // The formatting of that version (only when its marks fit its text), also when the text itself did not change.
        this.shownRanges = rangesOfRecord(rec);
        this.bar.setRanges(this.shownRanges);
        this.base = rec;
        this.shownText = rec.text;
        this.color = rec.color;
        this._applyColorClass();
        this.pendingRemote = null;
        this.remoteDeleted = false;
        this._clearMark();
    }

    // ---- closing ---------------------------------------------------------------------------------------------

    _onCloseRequest() {
        if (this.closing)
            return false;
        // A refused save leaves the typed text only in the window: the first close asks again (the mark says so), the
        // second one discards it.
        if (this.mark?.kind === 'refused' && this._dirty() && !this.closeWarned) {
            this.closeWarned = true;
            this._setMark('refused', S.markCloseUnsaved());
            return true;
        }
        this.closing = true;
        this._cancelSaveTimer();
        if (this._quietTimer !== null) {
            GLib.source_remove(this._quietTimer);
            this._quietTimer = null;
        }
        const text = this._bufferText();
        const ranges = this.bar.ranges();      // read now: the window is gone when the queued save runs
        // The last text and the "closed" flag are written even if this was the last window (the app is held meanwhile).
        this._queue(async () => {
            await this._doSave(text, ranges);
            if (!this.deleted) {
                this.ctl.hold();
                try {
                    await this.ctl.setOpen(this.id, false);
                } finally {
                    this.ctl.release();
                }
            }
        });
        this.ctl.closed(this.id);
        return false;
    }
}
