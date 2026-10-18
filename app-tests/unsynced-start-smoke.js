// SPDX-License-Identifier: GPL-3.0-or-later
// 0.2.5.3 control: a notes folder WITHOUT the `.stfolder` marker and no note. The old path is unchanged: the start makes ONE red note and opens its
// window, and the list of notes is not opened.
import {NOTE_RHEL_RED, runStartGate} from './start-gate-support.js';

runStartGate({marker: false}, async ({app, windows, files, records, check, tick, waitFor}) => {
    await app.ready;
    check(await waitFor(() => windows.size === 1 && files().length === 1), 'the start makes ONE note and opens its window');
    await tick(300);
    const live = records().filter(r => !r.deleted);
    check(live.length === 1 && windows.has(live[0].id), 'one live note, and the open window is that note');
    check(live[0]?.color === NOTE_RHEL_RED, 'the first note is red (Important)');
    check(app.allNotes === null, 'the list of notes is not opened');
});
