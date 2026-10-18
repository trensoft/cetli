// SPDX-License-Identifier: GPL-3.0-or-later
// 0.2.6 (Petra 9045): "New note" is one creation at a time (the button of the empty list and the menu / Ctrl+N alike), and a refusal of the core is shown.
// A synchronised, empty notes folder: the list opens with the button.
import GLib from 'gi://GLib';

import * as S from '../app/strings.js';
import {NOTE_RHEL_RED, runStartGate} from './start-gate-support.js';

runStartGate({marker: true}, async ({app, windows, files, records, check, tick, waitFor}) => {
    await app.ready;
    check(await waitFor(() => app.allNotes?.win.get_visible() === true && app.allNotes.stack.get_visible_child_name() === 'none'), 'the list opens with the empty page');
    const button = app.allNotes.newNoteButton;
    await waitFor(() => button.get_mapped());

    // two presses in the same instant: ONE note, and it is the red first one
    button.emit('clicked');
    check(button.get_sensitive() === false, 'the button is insensitive while the note is being made');
    button.emit('clicked');
    check(await waitFor(() => windows.size >= 1 && files().length >= 1), 'a note is made');
    await tick(600);
    let live = records().filter(r => !r.deleted);
    check(live.length === 1 && windows.size === 1 && live[0].color === NOTE_RHEL_RED, 'two quick presses make ONE note, the red first one');
    check(button.get_sensitive() === true, 'and the button is sensitive again when it is done');

    // the menu action (Ctrl+N): two activations in the same instant make one more note, not two
    app.gtkApp.activate_action('new-note', null);
    app.gtkApp.activate_action('new-note', null);
    check(await waitFor(() => files().length >= 2), 'the menu action makes a note');
    await tick(600);
    live = records().filter(r => !r.deleted);
    check(live.length === 2 && windows.size === 2, 'two quick activations of the menu action make ONE note');
    check(app.gtkApp.lookup_action('new-note').get_enabled() === true, 'and the action is enabled again');

    // a refusal of the core is shown in the open list (a toast), not swallowed: the notes folder is read-only
    const shown = [];
    app.allNotes.showError = text => shown.push(text);
    const notes = app.store.dirs.notes;
    GLib.chmod(notes, 0o555);
    try {
        app.gtkApp.activate_action('new-note', null);
        check(await waitFor(() => shown.length === 1), 'a note that cannot be saved is reported in the list');
        check(shown[0]?.startsWith(S.markNotSaved('NO_SUCH_CAUSE')), `with the text of the cause (${shown[0]})`);
    } finally {
        GLib.chmod(notes, 0o755);
    }
    await tick(300);
    check(records().filter(r => !r.deleted).length === 2, 'and no note was made');
    check(app.gtkApp.lookup_action('new-note').get_enabled() === true, 'the action is enabled again after a refusal');
});
