// SPDX-License-Identifier: GPL-3.0-or-later
// The one-time notice of the Flatpak (the sync engine cannot run inside the sandbox): sync needs Syncthing on the computer, and this is the
// folder to give it. It starts nothing and talks to nothing. Closing it, by the button or the window, is the answer: ctl.dismissSync() writes
// the same "Later" state as the sync window does, so it does not come back. Every text is from strings.js; the path is shown as plain text.
import Gtk from 'gi://Gtk?version=4.0';

import * as S from './strings.js';

export class SyncNotice {
    // ctl: {gtkApp, dismissSync(), onNoticeClosed(win)}; notesDir: the folder the user adds in Syncthing (the path as this program sees it,
    // which in the Flatpak is the computer's own path, see src/dirs.js).
    constructor({ctl, notesDir}) {
        this.ctl = ctl;
        this.closed = false;
        this.win = new Gtk.ApplicationWindow({application: ctl.gtkApp, title: S.syncTitle(), default_width: 460, resizable: false});
        this.win.add_css_class('cetli-sync-notice');
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12, margin_top: 18, margin_bottom: 18, margin_start: 18, margin_end: 18});
        const heading = new Gtk.Label({label: S.syncNoticeHeading(), xalign: 0, wrap: true});
        heading.add_css_class('title-2');
        const label = text => new Gtk.Label({label: text, xalign: 0, wrap: true, max_width_chars: 52});
        this.textLabel = label(S.syncNoticeText());
        this.folderLabel = label(S.syncNoticeFolder());
        this.pathLabel = new Gtk.Label({label: notesDir, xalign: 0, wrap: true, selectable: true, use_markup: false});
        this.pathLabel.add_css_class('monospace');
        this.button = new Gtk.Button({label: S.syncClose(), halign: Gtk.Align.END});
        this.button.add_css_class('suggested-action');
        this.button.connect('clicked', () => this.win.close());
        for (const w of [heading, this.textLabel, this.folderLabel, this.pathLabel, this.button])
            box.append(w);
        this.win.set_child(box);
        this.win.connect('close-request', () => {
            this._onClose();
            return false;
        });
    }

    present() {
        this.win.present();
    }

    _onClose() {
        if (this.closed)
            return;
        this.closed = true;
        this.ctl.dismissSync?.();
        this.ctl.onNoticeClosed?.(this);
    }
}
