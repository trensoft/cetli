// SPDX-License-Identifier: GPL-3.0-or-later
// 0.2.5.3 (Attila's state): a synchronised notes folder (`.stfolder`) with deleted records and NO live note. The start opens the list of notes
// and makes no note; the list's empty page must carry a "New note" button, and the button makes ONE live note, red (the first note), with its window.
import * as S from '../app/strings.js';
import {NOTE_RHEL_RED, runStartGate} from './start-gate-support.js';

runStartGate({marker: true, deleted: 2}, async ({app, windows, files, records, check, tick, waitFor}) => {
    await app.ready;
    check(files().length === 2 && records().every(r => r.deleted === true), 'the folder holds two deleted records and no live note');
    check(windows.size === 0 && files().length === 2, 'the start makes no note and opens no note window');
    check(await waitFor(() => app.allNotes?.win.get_visible() === true), 'the start opens the list of notes');
    check(app.allNotes.stack.get_visible_child_name() === 'none', 'the list shows the "no notes" page');
    const button = app.allNotes.newNoteButton;
    check(button !== undefined && button.get_label() === S.menuNewNote() && button.get_mapped(), 'the empty page shows a "New note" button');
    button?.emit('clicked');
    check(await waitFor(() => windows.size === 1 && records().filter(r => !r.deleted).length === 1), 'the button makes ONE live note and opens its window');
    await tick(300);
    const live = records().filter(r => !r.deleted);
    check(live.length === 1 && windows.has(live[0].id), 'still one live note, and the open window is that note');
    check(live[0]?.color === NOTE_RHEL_RED, 'the first live note is red (Important)');
    check(records().filter(r => r.deleted).length === 2, 'the deleted records are untouched');
});
