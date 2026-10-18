// SPDX-License-Identifier: GPL-3.0-or-later
// 0.2.5.4 (Attila's state): a synchronised notes folder with live notes and three Syncthing conflict copies (`<uuid>.sync-conflict-<date>-<time>-<id>.json`)
// with different texts, one of them NEWER than its main file. The product's store (createApp) resolves them on its own: no "unresolved" in the header,
// every text is kept as a note, the conflict files are gone.
// The store's own default (off) is held by tests/resolve.test.js; with the flag turned back in application.js this smoke fails.
import {runStartGate} from './start-gate-support.js';
import GLib from 'gi://GLib';

const ID_A = '00000000-0000-4000-8000-0000000000a1';
const ID_B = '00000000-0000-4000-8000-0000000000b2';
const ago = min => new Date(Date.now() - min * 60000).toISOString();
const note = (id, text, updated, rev) => ({schema: 1, id, rev, updated, created: ago(500), device: 'b5b5b5b5', color: 'yellow', text, deleted: false, conflict_of: null});
const put = (dirs, name, obj) => GLib.file_set_contents(`${dirs.notes}/${name}`, `${JSON.stringify(obj)}\n`);

const TEXTS = ['A main text', 'A conflict, OLDER', 'A conflict, NEWER than main', 'B main text', 'B conflict, older'];

function seed(dirs) {
    put(dirs, `${ID_A}.json`, note(ID_A, TEXTS[0], ago(100), 2));
    put(dirs, `${ID_A}.sync-conflict-20261018-203000-ABCDEFG.json`, note(ID_A, TEXTS[1], ago(200), 2));
    put(dirs, `${ID_A}.sync-conflict-20261018-213000-HIJKLMN.json`, note(ID_A, TEXTS[2], ago(10), 3));      // the newer one
    put(dirs, `${ID_B}.json`, note(ID_B, TEXTS[3], ago(90), 2));
    put(dirs, `${ID_B}.sync-conflict-20261018-220000-OPQRSTU.json`, note(ID_B, TEXTS[4], ago(150), 2));
}

runStartGate({marker: true, seed}, async ({app, windows, files, records, check, waitFor}) => {
    await app.ready;
    check(await waitFor(() => files(true).every(f => !f.includes('.sync-conflict-'))), 'the conflict files are gone after the start');
    const live = records().filter(r => !r.deleted);
    const texts = live.map(r => r.text);
    for (const t of TEXTS)
        check(texts.filter(x => x === t).length === 1, `the text "${t}" is a note, exactly once`);
    check(live.length === 5 && records().length === 5, 'five notes in all, none lost, none deleted');
    check(live.find(r => r.id === ID_A)?.text === TEXTS[2], 'the NEWER conflict copy became the note of the main name');
    check(live.find(r => r.id === ID_B)?.text === TEXTS[3], 'the older conflict copy lost: the main file stays the note');
    const copies = live.filter(r => r.conflict_of !== null);
    check(copies.length === 3 && copies.every(r => r.conflict_of === ID_A || r.conflict_of === ID_B), 'the three losers are separate notes that point to their origin');
    check(app.store.status().unresolved === 0, 'the store counts no unresolved conflict');
    check(windows.size > 0 && [...windows.values()].every(w => w.unresolved.get_visible() === false), 'no note window shows the unresolved label');
});
