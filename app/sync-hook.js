// SPDX-License-Identifier: GPL-3.0-or-later
// The Gio side of the first-start hook (PLAN-WIZARD 2.2, 0H.11): reads the window's own state file, asks about the `.stfolder` markers
// (existence queries only, nothing opened, nothing listed), and writes the "Later" answer. The decision is app/sync-start.js (pure).
// Nothing foreign is read, nothing is started.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {DISMISSED_TEXT, shouldShowFirstStart} from './sync-start.js';

const STATE_FILE = 'sync-wizard.json';
const UNREADABLE = '\u0000unreadable';                 // a text that is not JSON: shouldShowFirstStart reads it as "do not show"

const statePath = stateDir => GLib.build_filenamev([stateDir, STATE_FILE]);

// null = no file; the text; or UNREADABLE when the file is there and cannot be read.
export function readWizardState(stateDir) {
    const file = Gio.File.new_for_path(statePath(stateDir));
    if (!file.query_exists(null))
        return null;
    try {
        const [, bytes] = file.load_contents(null);
        return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    } catch {
        return UNREADABLE;
    }
}

// Exactly {"version":1,"dismissed":true}, mode 0600, in the state directory (0700 when it has to be made).
export function writeDismissed(stateDir) {
    GLib.mkdir_with_parents(stateDir, 0o700);
    GLib.file_set_contents_full(statePath(stateDir), new TextEncoder().encode(DISMISSED_TEXT), GLib.FileSetContentsFlags.CONSISTENT, 0o600);
}

export function wantsFirstStart({dirs, homeDir = GLib.get_home_dir(), markerExists = p => Gio.File.new_for_path(p).query_exists(null)}) {
    return shouldShowFirstStart({stateText: readWizardState(dirs.state), markerExists, notesDir: dirs.notes, homeDir});
}
