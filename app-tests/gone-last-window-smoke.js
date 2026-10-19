// SPDX-License-Identifier: GPL-3.0-or-later
// 0.2.6: the other computer deletes the notes that are open here (a synchronised folder, nothing typed). A clean window closes by itself; the one that
// is the LAST window leaves the list of notes open instead, so the program does not leave without a word (GTK quits when the last window is gone).
import * as S from '../app/strings.js';
import {runStartGate} from './start-gate-support.js';
import GLib from 'gi://GLib';

const ID_A = '00000000-0000-4000-8000-0000000000a1';
const ID_B = '00000000-0000-4000-8000-0000000000b2';
const ago = min => new Date(Date.now() - min * 60000).toISOString();
const note = (id, text, updated, rev, deleted = false) => ({schema: 1, id, rev, updated, created: ago(500), device: 'b5b5b5b5', color: 'yellow', text, deleted, conflict_of: null});
const put = (dirs, name, obj) => GLib.file_set_contents(`${dirs.notes}/${name}`, `${JSON.stringify(obj)}\n`);

let dirsOf = null;
runStartGate({marker: true, seed: dirs => {
    dirsOf = dirs;
    put(dirs, `${ID_A}.json`, note(ID_A, 'first note', ago(100), 2));
    put(dirs, `${ID_B}.json`, note(ID_B, 'second note', ago(90), 2));
}}, async ({app, windows, check, tick, waitFor}) => {
    await app.ready;
    check(await waitFor(() => windows.size === 2), 'the start opens the two notes');
    check(app.allNotes === null, 'the list of notes is not open');
    await tick(600);
    const tombstone = id => put(dirsOf, `${id}.json`, note(id, '', new Date(Date.now() + 2000).toISOString(), 3, true));

    tombstone(ID_A);
    check(await waitFor(() => !windows.has(ID_A)), 'the first deleted note closes its clean window');
    await tick(600);
    check(windows.has(ID_B) && app.allNotes === null, 'another window is still open: the list of notes does not come up');

    tombstone(ID_B);
    check(await waitFor(() => !windows.has(ID_B)), 'the last deleted note closes its clean window');
    check(await waitFor(() => app.allNotes?.win.get_visible() === true), 'and the list of notes opens (the program does not leave)');
    await tick(800);
    check(windows.size === 0 && app.allNotes?.win.get_visible() === true, 'the list stays open, no note window, no new note');
    check(await waitFor(() => app.allNotes.stack.get_visible_child_name() === 'none'), `the list shows the empty page (${S.menuNewNote()} button)`);
});
