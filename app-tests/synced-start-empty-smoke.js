// SPDX-License-Identifier: GPL-3.0-or-later
// 0.2.5.3: a synchronised notes folder (`.stfolder`) that is completely empty. The start opens the list of notes, the empty page has a "New note"
// button, the button makes ONE live red note and opens its window.
import * as S from '../app/strings.js';
import {NOTE_RHEL_RED, runStartGate} from './start-gate-support.js';

runStartGate({marker: true}, async ({app, windows, files, records, check, tick, waitFor}) => {
    await app.ready;
    check(windows.size === 0 && files().length === 0, 'the start makes no note and opens no note window');
    check(await waitFor(() => app.allNotes?.win.get_visible() === true), 'the start opens the list of notes');
    check(await waitFor(() => app.allNotes.stack.get_visible_child_name() === 'none'), 'the list shows the "no notes" page');
    const button = app.allNotes.newNoteButton;
    check(button !== undefined && button.get_label() === S.menuNewNote() && await waitFor(() => button.get_mapped()), 'the empty page shows a "New note" button');
    await tick(500);
    check(windows.size === 0 && files().length === 0, 'and without a click NO note comes, however long the list is open');
    check(app.allNotes.win.get_focus() !== button, 'the button does not hold the keyboard focus (an Enter or a Space typed into the new window would press it)');
    button?.emit('clicked');
    check(await waitFor(() => windows.size === 1 && files().length === 1), 'the button makes ONE live note and opens its window');
    await tick(300);
    const live = records().filter(r => !r.deleted);
    check(live.length === 1 && windows.has(live[0].id), 'one live note, and the open window is that note');
    check(live[0]?.color === NOTE_RHEL_RED, 'the first live note is red (Important)');
});
