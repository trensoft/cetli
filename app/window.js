// SPDX-License-Identifier: GPL-3.0-or-later
// One note window (PLAN.md sections 3, 8, 9). It never reads or writes a file itself: every read and write goes through
// the core (`store`), and the window title is the contract with the GNOME Shell extension (`cetli-<uuid>`, set before
// the window is shown). Text for the user comes from strings.js only.
import Gtk from 'gi://Gtk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {SAVE_COALESCE_MS} from '../src/constants.js';
import {COLORS, REMOTE_QUIET_MS, WINDOW_TITLE_PREFIX, cssClassOf} from './data.js';
import {changedRegion} from './textdiff.js';
import * as S from './strings.js';

const nowMs = () => Math.floor(GLib.get_monotonic_time() / 1000);

function once(ms, fn) {
    return GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        fn();
        return GLib.SOURCE_REMOVE;
    });
}

export class NoteWindow {
    // ctl: {store, gtkApp, menu, dark, hold(), release(), newNote(win), showAbout(win), setOpen(id, open), closed(id), log}
    constructor({ctl, record, size}) {
        this.ctl = ctl;
        this.store = ctl.store;
        this.id = record.id;
        this.base = record;                 // the record the user started from (core 2.5)
        this.shownText = record.text;       // the text of the version last read from or written to disk (PLAN 3 (3))
        this.color = record.color;
        this.applying = false;              // PLAN 3 (2): set while a remote text is put into the buffer
        this.lastKey = -Infinity;
        this.pendingRemote = null;
        this.remoteDeleted = false;
        this.deleted = false;
        this.closing = false;
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
        header.pack_start(this.unresolved);

        const swatches = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 6, margin_top: 6, margin_bottom: 6, margin_start: 6, margin_end: 6});
        for (const name of COLORS) {
            const b = new Gtk.Button({
                action_name: 'win.color', action_target: GLib.Variant.new_string(name), tooltip_text: S.colorName(name),
            });
            b.add_css_class(`cetli-swatch-${name}`);
            b.add_css_class('circular');
            swatches.append(b);
        }
        const colorButton = new Gtk.MenuButton({icon_name: 'color-select-symbolic', tooltip_text: S.colorTooltip(), popover: new Gtk.Popover({child: swatches})});
        header.pack_end(new Gtk.MenuButton({icon_name: 'open-menu-symbolic', menu_model: this.ctl.menu, tooltip_text: S.menuTooltip()}));
        header.pack_end(colorButton);
        this.win.set_titlebar(header);
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
        const scroll = new Gtk.ScrolledWindow({child: this.view, hexpand: true, vexpand: true});
        this.markLabel = new Gtk.Label({visible: false, xalign: 0, wrap: true});
        this.markLabel.add_css_class('cetli-mark');
        box.append(scroll);
        box.append(this.markLabel);
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
    }

    // ---- look ------------------------------------------------------------------------------------------------

    _applyColorClass() {
        for (const name of COLORS)
            this.win.remove_css_class(cssClassOf(name));
        this.win.add_css_class(cssClassOf(this.color));
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
        return this._bufferText() !== this.shownText || this.color !== this.base.color;
    }

    _onChanged() {
        if (this.applying)
            return;                          // PLAN 3 (2): applying a remote text is not a user edit
        this.lastKey = nowMs();
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

    async _doSave(text = this._bufferText()) {
        if (this.deleted)
            return;
        if (text === this.shownText && this.color === this.base.color)
            return;                          // PLAN 3 (3): nothing differs from what is on disk
        this.ctl.hold();
        try {
            // The core's tmp write is one synchronous GLib call (CONSISTENT | DURABLE, which resolves to 2 under gjs with
            // glib 2.74) and DURABLE also fsyncs the tmp/ directory on every save, so the main loop stands still for its
            // duration. The cost on a real disk is not measured. It runs from the SAVE_COALESCE_MS timer, never from a key
            // handler.
            this._afterSave(await this.store.saveNote(this.id, this.base, {text, color: this.color, deleted: false}));
        } finally {
            this.ctl.release();
        }
    }

    // A result of saveNote or of the core's own retry ('save-retried').
    _afterSave(res) {
        if (res.ok) {
            this.base = res.record;
            this.shownText = res.record.text;
            this.pendingRemote = null;       // the local text won; the other version was kept as a copy (2.5)
            this.remoteDeleted = false;
            this._clearMark();
        } else {
            this._setMark('refused', S.markNotSaved(res.cause.code));
        }
    }

    onSaveRetried(result) {
        if (!this.deleted)
            this._afterSave(result);
    }

    setColor(name) {
        if (!COLORS.includes(name) || name === this.color)
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
            // Ctrl+Z must not bring back the other computer's text: the replacement is an irreversible action.
            this.buffer.begin_irreversible_action();
            try {
                const start = this.buffer.get_iter_at_offset(region.start);
                const end = this.buffer.get_iter_at_offset(region.start + region.deleteCount);
                this.buffer.delete(start, end);
                this.buffer.insert(this.buffer.get_iter_at_offset(region.start), region.insert, -1);
            } finally {
                this.buffer.end_irreversible_action();
                this.applying = false;
            }
        }
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
        this.closing = true;
        this._cancelSaveTimer();
        if (this._quietTimer !== null) {
            GLib.source_remove(this._quietTimer);
            this._quietTimer = null;
        }
        const text = this._bufferText();
        // The last text and the "closed" flag are written even if this was the last window (the app is held meanwhile).
        this._queue(async () => {
            await this._doSave(text);
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
