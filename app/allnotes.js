// SPDX-License-Identifier: GPL-3.0-or-later
// The "All notes" window: a search field above one card per note that is not deleted (colour, eye, time of the last change,
// trash, first lines), the most recently changed first. A click on a card opens the note's window, or brings it to the front;
// a closed note is opened again. The eye shows whether the note window is open and hides or shows it. The cards come from the
// core's public API (`store.listNotes()`), never from a file. Text for the user comes from strings.js only. The window is a
// window of its own: closing it closes no note window (they are not its children).
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

import {cssClassOf, customRowStyle} from './data.js';
import {decodeMarks} from './marks.js';
import {matchesQuery, previewMarkup, previewOf, timeLabel} from './preview.js';
import * as S from './strings.js';

export const REFRESH_MS = 120;                 // a burst of changes (typing saves every 250 ms) is one refresh

// One provider per custom colour shown in a row, added the first time a row shows it (CSS from data.js, built from three
// integers). A note file can name as many colours as there are notes (at most 500).
const customProviders = new Set();

function ensureCustomRowStyle(color) {
    const style = customRowStyle(color);
    if (style === null || customProviders.has(style.cls))
        return;
    customProviders.add(style.cls);
    const provider = new Gtk.CssProvider();
    if (typeof provider.load_from_string === 'function')
        provider.load_from_string(style.css);
    else
        provider.load_from_data(style.css);
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
}

// The first 16 lowercase hex of the sha256 of the text as UTF-8: the `h` of the stored formatting marks (decodeMarks compares it).
const sha16 = text => GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, new TextEncoder().encode(text)).slice(0, 16);

// The Pango markup of the card of a note, or null (plain text): the stored formatting must be intact (decodeMarks: the hash of the
// text matches, the ranges are well-formed), the markup must parse (a text Pango refuses is shown plain, never as an empty card).
// `extra` of a record from the core is a Map; a plain object is accepted too. Never throws.
export function cardMarkup(text, extra) {
    try {
        const marks = extra instanceof Map ? (extra.has('marks') ? {marks: extra.get('marks')} : null) : extra;
        const ranges = decodeMarks(text, marks, sha16);
        const markup = ranges === null ? null : previewMarkup(text, ranges);
        if (markup === null)
            return null;
        Pango.parse_markup(markup, -1, '\0');          // throws when Pango would refuse it
        return markup;
    } catch {
        return null;
    }
}

// The note changed last comes first (`updated`); the id breaks a tie, so the order is the same on every computer.
export const newestFirst = (a, b) => (a.updated === b.updated ? (a.id < b.id ? 1 : -1) : (a.updated < b.updated ? 1 : -1));

// The small static style of the card (eye, time, trash, a 1 px outline), added once. The colours of the cards are data.js's.
// Nothing here is see-through: the 70 % text of a faded icon is 2.6:1 on the red (UX review, Wanda); the outline keeps the white card
// (1.04:1 on the window) apart from its background.
export const CARD_CSS = 'window.cetli-list .cetli-card-head button { min-height: 24px; min-width: 24px; padding: 0 4px; }\n' +
    'window.cetli-list .cetli-card-head label.cetli-time { font-size: smaller; }\n' +
    'window.cetli-list row.cetli-row { border: 1px solid rgba(0, 0, 0, 0.18); }\n' +
    'window.cetli-list.cetli-dark row.cetli-row { border-color: rgba(255, 255, 255, 0.12); }\n';

let cardStyleAdded = false;
function ensureCardStyle() {
    if (cardStyleAdded)
        return;
    cardStyleAdded = true;
    const css = CARD_CSS;
    const provider = new Gtk.CssProvider();
    if (typeof provider.load_from_string === 'function')
        provider.load_from_string(css);
    else
        provider.load_from_data(css);
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
}

export class AllNotesWindow {
    // ctl: {store, gtkApp, dark(), openNote(id) (a promise), isOpen(id), closeNote(id), deleteNote(id) (a promise; optional:
    // without it the trash button is not shown), onAllNotesClosed(win), log}
    constructor({ctl}) {
        this.ctl = ctl;
        this.rows = new Map();               // id -> {id, row, label, eye, time, text, v, cls, updated, open}
        this.query = '';
        this._timer = null;
        ensureCardStyle();
        this.win = new Gtk.ApplicationWindow({application: ctl.gtkApp, title: S.allNotesTitle(), default_width: 340, default_height: 460});
        this.win.add_css_class('cetli-list');
        this.list = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, activate_on_single_click: true});
        this.list.add_css_class('cetli-rows');
        this.list.update_property([Gtk.AccessibleProperty.LABEL], [S.allNotesTitle()]);
        this.list.set_sort_func((a, b) => newestFirst(a._cetli, b._cetli));
        this.list.connect('row-activated', (_l, row) => this.ctl.openNote(row._cetli.id).catch(e => this.ctl.log(`All notes: ${e?.message ?? e}`)));
        this.list.set_filter_func(row => matchesQuery(row._cetli.text, this.query));
        this.search = new Gtk.SearchEntry({placeholder_text: S.searchPlaceholder(), hexpand: true, margin_top: 6, margin_bottom: 6, margin_start: 6, margin_end: 6});
        this.search.connect('search-changed', () => {
            this.query = this.search.get_text();
            this.list.invalidate_filter();
            this._updatePage();
        });
        this.stack = new Gtk.Stack({vexpand: true, hexpand: true});
        this.stack.add_named(new Gtk.ScrolledWindow({child: this.list, hexpand: true, vexpand: true}), 'list');
        // 0.2.5.1: a synchronised folder with no note opens this list at the start; the way to a first note is on the page itself.
        this.newNoteButton = new Gtk.Button({label: S.menuNewNote(), halign: Gtk.Align.CENTER});
        this.newNoteButton.add_css_class('suggested-action');
        this.newNoteButton.add_css_class('pill');
        this.newNoteButton.connect('clicked', () => this.ctl.newNote(null).catch(e => this.ctl.log(`All notes: ${e?.message ?? e}`)));
        this.stack.add_named(new Adw.StatusPage({title: S.noNotesTitle(), description: S.noNotesText(), icon_name: 'document-edit-symbolic', vexpand: true, child: this.newNoteButton}), 'none');
        this.stack.add_named(new Adw.StatusPage({title: S.noResultsTitle(), description: S.noResultsText(), icon_name: 'system-search-symbolic', vexpand: true}), 'nores');
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        box.append(this.search);
        box.append(this.stack);
        this.toasts = new Adw.ToastOverlay({child: box});
        this.win.set_child(this.toasts);
        this.setDark(ctl.dark());
        this.win.connect('close-request', () => {
            this.cancelRefresh();
            this.ctl.onAllNotesClosed(this);
            return false;
        });
        this.refresh();
    }

    present() {
        this.win.present();
    }

    // A message that stays until read: a refused delete must not pass unseen.
    showError(text) {
        this.toasts.add_toast(new Adw.Toast({title: text, timeout: 0}));
    }

    setDark(dark) {
        if (dark)
            this.win.add_css_class('cetli-dark');
        else
            this.win.remove_css_class('cetli-dark');
    }

    // A change of a note somewhere: look again shortly (one refresh for a burst).
    scheduleRefresh() {
        if (this._timer !== null)
            return;
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH_MS, () => {
            this._timer = null;
            this.refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    cancelRefresh() {
        if (this._timer !== null) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
    }

    // Adds, updates and removes rows to match the core's list; a row whose note did not change (same `v`) is left alone.
    refresh() {
        const notes = this.ctl.store.listNotes().filter(n => !n.deleted);
        const seen = new Set();
        for (const n of notes) {
            seen.add(n.id);
            const have = this.rows.get(n.id);
            if (have === undefined)
                this.rows.set(n.id, this._makeRow(n));
            else if (have.v !== n.v)
                this._fill(have, n);
        }
        for (const [id, info] of [...this.rows]) {
            if (!seen.has(id)) {
                this.list.remove(info.row);
                this.rows.delete(id);
            }
        }
        for (const info of this.rows.values())
            this._setEye(info);
        this.list.invalidate_sort();
        this._updatePage();
    }

    // The page of the stack: the cards; "no notes" when there are none; "no results" when the search leaves none. The search
    // field is shown with the cards and with "no results", not above "no notes".
    _updatePage() {
        let shown = 0;
        for (const info of this.rows.values()) {
            if (matchesQuery(info.text, this.query))
                shown++;
        }
        const page = this.rows.size === 0 ? 'none' : (shown === 0 ? 'nores' : 'list');
        this.stack.set_visible_child_name(page);
        this.search.set_visible(page !== 'none');
    }

    // The eye follows the state of the note window.
    _setEye(info) {
        const open = this.ctl.isOpen(info.id);
        if (info.open === open)
            return;
        info.open = open;
        info.eye.set_icon_name(open ? 'view-reveal-symbolic' : 'view-conceal-symbolic');
        info.eye.set_tooltip_text(open ? S.hideNoteTooltip() : S.showNoteTooltip());
    }

    _toggleNote(id) {
        if (this.ctl.isOpen(id))
            this.ctl.closeNote(id);
        else
            this.ctl.openNote(id).catch(e => this.ctl.log(`All notes: ${e?.message ?? e}`));
    }

    // A confirmation first (a deleted note cannot be brought back from here); `ask` is a method so that a test can answer it.
    _askDelete(id) {
        const dialog = new Adw.MessageDialog({transient_for: this.win, modal: true, heading: S.deleteConfirmTitle(), body: S.deleteConfirmBody()});
        dialog.add_response('cancel', S.cancelButton());
        dialog.add_response('delete', S.deleteButton());
        dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');
        const handler = dialog.connect('response', (_d, response) => {
            dialog.disconnect(handler);                  // a dialog that is gone still holding a handler makes gjs warn at exit
            this.dialog = null;
            GLib.idle_add(GLib.PRIORITY_LOW, () => { dialog.destroy(); return GLib.SOURCE_REMOVE; });   // else gjs warns about it when the program ends
            if (response === 'delete')
                this.ctl.deleteNote(id).catch(e => this.ctl.log(`All notes: ${e?.message ?? e}`));
        });
        this.dialog = dialog;
        dialog.present();
    }

    _makeRow(n) {
        const row = new Gtk.ListBoxRow({activatable: true});
        row.add_css_class('cetli-row');
        const label = new Gtk.Label({xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END, max_width_chars: 36});
        const head = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 6});
        head.add_css_class('cetli-card-head');
        const eye = new Gtk.Button({icon_name: 'view-conceal-symbolic', valign: Gtk.Align.CENTER});
        eye.add_css_class('flat');
        head.append(eye);
        head.append(new Gtk.Box({hexpand: true}));
        const time = new Gtk.Label({xalign: 1});
        time.add_css_class('cetli-time');
        head.append(time);
        const card = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 2, margin_top: 4, margin_bottom: 6, margin_start: 8, margin_end: 8});
        card.append(head);
        card.append(label);
        row.set_child(card);
        const info = {id: n.id, row, label, eye, time, text: '', v: null, cls: null, updated: '', open: null};
        eye.connect('clicked', () => this._toggleNote(info.id));
        if (typeof this.ctl.deleteNote === 'function') {
            const trash = new Gtk.Button({icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER, tooltip_text: S.menuDeleteNote()});
            trash.add_css_class('flat');
            trash.connect('clicked', () => this._askDelete(info.id));
            head.append(trash);
            info.trash = trash;
        }
        row._cetli = info;                   // the sort function and the click handler find the note from the row
        this._fill(info, n);
        this.list.append(row);
        return info;
    }

    _fill(info, n) {
        const p = previewOf(n.text);
        const markup = p.empty ? null : cardMarkup(String(n.text ?? ''), n.extra);
        if (markup !== null) {
            info.label.set_markup(markup);               // text and mode together: the old text is never read in the new mode
        } else {
            info.label.set_use_markup(false);            // set_markup left it on: a plain text would be read as markup
            info.label.set_label(p.empty ? S.emptyNotePreview() : p.text);
        }
        if (p.empty)
            info.label.add_css_class('cetli-empty');
        else
            info.label.remove_css_class('cetli-empty');
        ensureCustomRowStyle(n.color);
        const cls = cssClassOf(n.color);
        if (info.cls !== cls) {
            if (info.cls)
                info.row.remove_css_class(info.cls);
            info.row.add_css_class(cls);
            info.cls = cls;
        }
        info.v = n.v;
        info.text = String(n.text ?? '');
        info.updated = String(n.updated ?? '');
        info.time.set_label(timeLabel(info.updated));
        this._setEye(info);
    }
}
