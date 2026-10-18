// SPDX-License-Identifier: GPL-3.0-or-later
// PLAN.md sections 1.4, 1.5, 3 (scan side), 4 (d): scanning, limits, what is read and when, durable write, device id, layout.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

import {FS, FsError} from '../src/fs-error.js';
import {createStore} from '../src/store.js';
import {nodeFs} from './support/node-layer.js';
import {nodePlatform} from './support/node-platform.js';
import {T0, at, conflictName, enc, makeEnv, raw, rec, uuid} from './support/helpers.js';

const withEnv = (opts, fn) => async () => {
    const env = makeEnv(opts);
    try {
        await env.start();
        await fn(env);
    } finally {
        env.cleanup();
    }
};
const reads = env => env.layer.calls.filter(c => c.op === 'readBytes').map(c => path.basename(c.args[0]));

test('scan: only NAME_MAIN / NAME_CONFLICT are candidates; dotfiles and other names are never touched', withEnv({wrap: true}, async env => {
    const good = rec({id: uuid(1)});
    env.putRec(`${uuid(1)}.json`, good);
    env.put('.stfolder', '');
    env.put(`.syncthing.${uuid(2)}.json.tmp`, 'half');
    env.put('notes.txt', 'hello');
    env.put(`${uuid(3)}.json.bak`, '{}');
    fs.mkdirSync(path.join(env.dirs.notes, '.stversions'));
    fs.writeFileSync(path.join(env.dirs.notes, '.stversions', 'old.json'), '{}');
    const before = env.snapshot();
    const r = await env.store.refresh();
    assert.deepEqual(env.snapshot(), before, 'nothing was written, renamed or deleted');
    assert.deepEqual(reads(env), [`${uuid(1)}.json`], 'only the candidate was opened');
    assert.equal(r.stats.ignoredNames, 2, 'notes.txt and the .bak name are counted, dotfiles are not');
    assert.equal(env.store.listNotes().length, 1);
}));

test('[P2-T1] hostile file names on a real file system: not candidates, not read, not touched', withEnv({wrap: true}, async env => {
    const body = rec({id: uuid(1)}).bytes;
    const names = [`${uuid(1)}.json\n`, `\n${uuid(1)}.json`, `${uuid(1).replace('0000000', 'ABCDEF1')}.json`.toUpperCase(),
        `${uuid(1)}.sync-conflict-2026101٦-120000-ABCDEFG.json`];
    for (const n of names)
        env.put(n, body);
    const before = env.snapshot();
    await env.store.refresh();
    assert.deepEqual(env.snapshot(), before);
    assert.deepEqual(reads(env), []);
    assert.equal(env.store.listNotes().length, 0);
}));

test('V1: a symlink, a FIFO, a directory and an oversize file are decided from the entry, before any open', withEnv({wrap: true}, async env => {
    const names = {
        link: `${uuid(1)}.json`, fifo: `${uuid(2)}.json`, dir: `${uuid(3)}.json`, big: `${uuid(4)}.json`,
    };
    fs.symlinkSync('/dev/zero', path.join(env.dirs.notes, names.link));
    execFileSync('mkfifo', [path.join(env.dirs.notes, names.fifo)]);
    fs.mkdirSync(path.join(env.dirs.notes, names.dir));
    env.put(names.big, new Uint8Array(262145).fill(32));
    const before = env.snapshot();
    const r = await env.store.refresh();
    assert.deepEqual(reads(env), [], 'readBytes was never called on any of them');
    assert.deepEqual(env.snapshot(), before);
    assert.equal(r.stats.unknown, 4);
    assert.equal(env.store.listNotes().length, 0);
}));

test('[P2-T2] V3/2.2 step 5: a NEWER file is counted, shown only as a safe text, never copied, overwritten or deleted', withEnv({}, async env => {
    const a = uuid(1);
    const b = uuid(2);
    const c = uuid(3);
    env.put(`${a}.json`, {schema: 2, text: 'from the future', whatever: [1]});
    env.put(`${b}.json`, {schema: 3, text: 7});
    env.put(`${c}.json`, {schema: 2, text: 'x'.repeat(65537)});
    // a NEWER conflict file beside a valid note is in no group either
    const w = rec({id: uuid(4), rev: 5});
    const d = rec({id: uuid(4), rev: 1, text: 'old', updated: at(500)});
    env.putRec(`${uuid(4)}.json`, d);
    env.put(conflictName(uuid(4)), {schema: 2, id: uuid(4), text: 'newer conflict'});
    const before = env.snapshot();
    const r = await env.store.refresh();
    assert.deepEqual(env.snapshot(), before, 'no file was copied, overwritten or deleted');
    assert.equal(r.stats.newer, 4);
    const shown = Object.fromEntries(env.store.newerNotes().map(n => [n.name, n.text]));
    assert.equal(shown[`${a}.json`], 'from the future');
    assert.equal(shown[`${b}.json`], null, 'non-string text is counted, not shown');
    assert.equal(shown[`${c}.json`], null, 'oversize text is counted, not shown');
    assert.equal(env.store.getNote(uuid(4)).text, 'old', 'the NEWER conflict file took no part');
    // a local save never replaces a NEWER file (2.5)
    const res = await env.store.saveNote(a, null, {text: 'mine', color: 'yellow', deleted: false});
    assert.equal(res.ok, false);
    assert.equal(res.cause.code, 'NEWER_SCHEMA');
    assert.deepEqual(env.snapshot(), before);
    void w;
}));

test('V6 quarantine: not applied now, not deleted, looked at again at the next event once its time has come', withEnv({}, async env => {
    const future = new Date(T0 + 30 * 3600 * 1000).toISOString();
    env.putRec(`${uuid(1)}.json`, rec({id: uuid(1), updated: future}));
    const r1 = await env.store.refresh();
    assert.equal(r1.stats.quarantined, 1);
    assert.equal(env.store.getNote(uuid(1)), null);
    assert.ok(env.has(`${uuid(1)}.json`));
    env.clock.t = T0 + 7 * 3600 * 1000;           // 30 h - 7 h = 23 h ahead: inside the tolerance
    const r2 = await env.store.refresh();
    assert.equal(r2.stats.quarantined, 0);
    assert.equal(env.store.getNote(uuid(1)).updated, future, 'applied, without a re-read of the file');
}));

test('0.2.6: a note that leaves the view is "removed" with gone=true only when it has no file; a quarantined or unknown file is gone=false', withEnv({}, async env => {
    const future = new Date(T0 + 30 * 3600 * 1000).toISOString();
    for (const n of [1, 2, 3])
        env.putRec(`${uuid(n)}.json`, rec({id: uuid(n)}));
    await env.store.refresh();
    assert.equal(env.store.listNotes().length, 3);
    env.events.length = 0;
    env.putRec(`${uuid(1)}.json`, rec({id: uuid(1), rev: 2, updated: future}));     // quarantined: still on disk
    env.put(`${uuid(2)}.json`, '{broken');                                           // unknown: still on disk
    fs.unlinkSync(path.join(env.dirs.notes, `${uuid(3)}.json`));                     // vanished
    await env.store.refresh();
    const removed = Object.fromEntries(env.events.filter(e => e.type === 'removed').map(e => [e.id, e.gone]));
    assert.deepEqual(removed, {[uuid(1)]: false, [uuid(2)]: false, [uuid(3)]: true});
    assert.ok(env.has(`${uuid(1)}.json`) && env.has(`${uuid(2)}.json`), 'the two files are still there');
}));

test('3: unknown files are logged once per (name, size, mtime), never deleted', withEnv({}, async env => {
    env.put(`${uuid(1)}.json`, '{broken');
    await env.store.refresh();
    await env.store.refresh();
    const count = () => env.lines.filter(l => l.includes(`${uuid(1)}.json: unknown`)).length;
    assert.equal(count(), 1);
    env.put(`${uuid(1)}.json`, '{broken again');
    await env.store.refresh();
    assert.equal(count(), 2, 'a changed size is a new (name, size, mtime)');
    assert.ok(env.has(`${uuid(1)}.json`));
}));

test('1.4: at most N valid notes are loaded; the rest stay on disk; the next local "new cetli" is refused', withEnv({maxNotes: 3}, async env => {
    for (let i = 1; i <= 5; i++)
        env.putRec(`${uuid(i)}.json`, rec({id: uuid(i)}));
    const r = await env.store.refresh();
    assert.equal(r.stats.loaded, 3);
    assert.equal(r.stats.overLimit, 2);
    assert.deepEqual(env.store.listNotes().map(n => n.id).sort(), [uuid(1), uuid(2), uuid(3)]);
    assert.equal(env.names().length, 5, 'valid files beyond the limit are left on disk');
    const before = env.snapshot();
    const res = await env.store.createNote({text: 'one too many'});
    assert.equal(res.ok, false);
    assert.equal(res.cause.code, 'TOO_MANY');
    assert.equal(res.cause.text, 'too many cetli');
    assert.deepEqual(env.snapshot(), before);
    assert.ok(env.warned(/note limit 3 reached: .*0004/));
}));

test('1.4: the default limit is 500 (501 valid files: 500 loaded)', withEnv({}, async env => {
    const hex = n => n.toString(16).padStart(12, '0');
    for (let i = 0; i < 501; i++) {
        const id = `00000000-0000-4000-8000-${hex(i)}`;
        env.putRec(`${id}.json`, rec({id}));
    }
    let r;
    do {
        r = await env.store.refresh();
    } while (r.pending > 0);
    assert.equal(r.stats.loaded, 500);
    assert.equal(r.stats.overLimit, 1);
    assert.equal((await env.store.createNote({})).cause.code, 'TOO_MANY');
}));

test('3: cost bound: at most 64 files per tick; the rest waits for the next tick', withEnv({wrap: true}, async env => {
    for (let i = 1; i <= 150; i++)
        env.putRec(`${uuid(i)}.json`, rec({id: uuid(i)}));
    env.layer.calls.length = 0;
    const r1 = await env.store.refresh();
    assert.equal(reads(env).length, 64);
    assert.equal(r1.pending, 86);
    const r2 = await env.store.refresh();
    assert.equal(r2.pending, 22);
    const r3 = await env.store.refresh();
    assert.equal(r3.pending, 0);
    assert.equal(env.store.listNotes().length, 150);
    assert.equal(reads(env).length, 150, 'every file was read exactly once');
}));

test('3: cost bound: at most 4 MiB per tick', withEnv({wrap: true}, async env => {
    const pad = n => rec({id: uuid(n), extra: {pad: 'a'.repeat(250000)}});
    for (let i = 1; i <= 20; i++)
        env.putRec(`${uuid(i)}.json`, pad(i));
    env.layer.calls.length = 0;
    const r1 = await env.store.refresh();
    assert.equal(reads(env).length, 16, '16 files of about 250 KB are 4 MB');
    assert.equal(r1.pending, 4);
    assert.equal((await env.store.refresh()).pending, 0);
}));

test('3: a group is resolved only when all of its files have been read (no decision on a partial group)', withEnv({}, async env => {
    // 70 other files fill the first tick; the group of uuid(99) sorts after them and stays pending
    for (let i = 1; i <= 70; i++)
        env.putRec(`${uuid(i)}.json`, rec({id: uuid(i)}));
    const x = uuid(99);
    env.putRec(`${x}.json`, rec({id: x, rev: 1, text: 'old', updated: at(300)}));
    env.putRec(conflictName(x), rec({id: x, rev: 2, text: 'new'}));
    const before = env.snapshot();
    const r1 = await env.store.refresh();
    assert.equal(r1.pending > 0, true);
    assert.deepEqual(Object.keys(env.snapshot()), Object.keys(before), 'nothing written while the group is pending');
    let r = r1;
    while (r.pending > 0)
        r = await env.store.refresh();
    assert.equal(env.store.getNote(x).text, 'new');
}));

test('1.5/2.6: a save writes the canonical bytes into tmp/ (outside notes/) and moves them without a fallback', withEnv({wrap: true}, async env => {
    env.layer.calls.length = 0;
    const res = await env.store.createNote({text: 'first', color: 'pink'});
    assert.equal(res.ok, true);
    const ops = env.layer.calls.filter(c => c.op === 'writeTmp' || c.op === 'move' || c.op === 'remove');
    assert.deepEqual(ops.map(o => o.op), ['writeTmp', 'move']);
    assert.ok(ops[0].args[0].startsWith(`${env.dirs.tmp}/`) && ops[0].args[0].endsWith('.tmp'));
    assert.ok(!ops[0].args[0].startsWith(env.dirs.notes));
    assert.equal(ops[1].args[0], ops[0].args[0]);
    assert.equal(ops[1].args[1], `${env.dirs.notes}/${res.record.id}.json`);
    assert.deepEqual(ops[1].args[2], {overwrite: false}, 'a free slot: no OVERWRITE');
    assert.equal(env.read(`${res.record.id}.json`), res.record.canon);
    assert.deepEqual(env.tmpNames(), [], 'nothing is left in tmp/');
    assert.equal(fs.statSync(path.join(env.dirs.notes, `${res.record.id}.json`)).mode & 0o777, 0o600);
    env.layer.calls.length = 0;
    const again = await env.store.saveNote(res.record.id, res.record, {text: 'second', color: 'pink', deleted: false});
    assert.equal(again.ok, true);
    const mv = env.layer.calls.find(c => c.op === 'move');
    assert.deepEqual(mv.args[2], {overwrite: true}, 'replacing a known valid version: OVERWRITE');
    assert.ok(env.layer.calls.every(c => c.op !== 'move' || c.args[1].startsWith(env.dirs.notes)));
    assert.equal(env.layer.calls.filter(c => c.op === 'remove').length, 0);
}));

test('[P2-T13] 1.5: a move that cannot be a rename (NOT_SUPPORTED) is a visible refusal; no file in notes/, tmp/ file gone', withEnv({wrap: true}, async env => {
    env.layer.hooks.before.push((op) => {
        if (op === 'move')
            throw new FsError(FS.NOT_SUPPORTED, 'injected G_IO_ERROR_NOT_SUPPORTED');
    });
    const before = env.snapshot();
    const res = await env.store.createNote({text: 'x'});
    assert.equal(res.ok, false);
    assert.equal(res.cause.code, 'MOVE_FAILED');
    assert.equal(res.cause.text, 'move failed');
    assert.deepEqual(env.snapshot(), before);
    assert.deepEqual(env.tmpNames(), []);
    assert.equal(env.store.ownWrite(res.cause.watch?.slice(0, 36)), null);
}));

test('[P2-T13] 1.5: tmp/ on ANOTHER file system than notes/ (real EXDEV): refused, nothing installed, tmp/ file gone', async t => {
    const env = makeEnv({tmpOnOtherFs: true});
    try {
        await env.start();
        const dev = p => fs.statSync(p).dev;
        if (dev(env.dirs.tmp) === dev(env.dirs.notes)) {
            t.skip('/dev/shm is on the same file system here');
            return;
        }
        const res = await env.store.createNote({text: 'x'});
        assert.equal(res.ok, false);
        assert.equal(res.cause.code, 'MOVE_FAILED');
        assert.deepEqual(env.names(), []);
        assert.deepEqual(env.tmpNames(), []);
    } finally {
        env.cleanup();
    }
});

test('4 (d) (iii): leftovers of our own in tmp/ are removed at start; nothing else is touched', async () => {
    const env = makeEnv();
    try {
        fs.mkdirSync(env.dirs.tmp, {recursive: true});
        fs.writeFileSync(path.join(env.dirs.tmp, `${uuid(7)}.tmp`), 'half');
        fs.writeFileSync(path.join(env.dirs.tmp, 'foreign.txt'), 'keep');
        await env.start();
        assert.deepEqual(env.tmpNames(), ['foreign.txt']);
    } finally {
        env.cleanup();
    }
});

test('7: a path is built only from a validated name or id', withEnv({wrap: true}, async env => {
    assert.throws(() => env.store._notePath('../../etc/passwd'), /refusing/);
    assert.throws(() => env.store._notePath(`${uuid(1)}.json/../x`), /refusing/);
    assert.throws(() => env.store._notePath('.hidden.json'), /refusing/);
    assert.doesNotThrow(() => env.store._notePath(`${uuid(1)}.json`));
    env.layer.calls.length = 0;
    const res = await env.store.saveNote('../../outside', null, {text: 'x', color: 'yellow', deleted: false});
    assert.equal(res.ok, false);
    assert.equal(res.cause.code, 'BAD_INPUT');
    assert.equal(env.layer.calls.filter(c => ['writeTmp', 'move', 'remove'].includes(c.op)).length, 0);
}));

test('1.2/4 (d) (ii): a valid tombstone alone in its group and older than 90 days is purged; nothing else', withEnv({}, async env => {
    const old = new Date(T0 - 91 * 86400000).toISOString();
    const young = new Date(T0 - 89 * 86400000).toISOString();
    env.putRec(`${uuid(1)}.json`, rec({id: uuid(1), deleted: true, text: '', updated: old}));
    env.putRec(`${uuid(2)}.json`, rec({id: uuid(2), deleted: true, text: '', updated: young}));
    env.putRec(`${uuid(3)}.json`, rec({id: uuid(3), deleted: false, updated: old}));
    env.put(`${uuid(4)}.json`, 'garbage');
    await env.store.refresh();
    assert.equal(await env.store.purgeTombstones(), 1);
    assert.deepEqual(env.names(), [`${uuid(2)}.json`, `${uuid(3)}.json`, `${uuid(4)}.json`]);
}));

test('1.2: the device id is 8 hex characters, made once and kept', async () => {
    const env = makeEnv();
    try {
        await env.start();
        const id = env.store.deviceId;
        assert.match(id, /^[0-9a-f]{8}$/);
        assert.equal(fs.readFileSync(path.join(env.dirs.state, 'device'), 'utf8'), `${id}\n`);
        const other = nodePlatform();
        other.platform.randomBytes = () => Uint8Array.from([1, 2, 3, 4]);
        const again = createStore({fs: nodeFs(), platform: other.platform, dirs: env.dirs});
        await again.start();
        assert.equal(again.deviceId, id, 'read back, not regenerated');
        fs.writeFileSync(path.join(env.dirs.state, 'device'), 'not-hex!');
        const third = createStore({fs: nodeFs(), platform: other.platform, dirs: env.dirs});
        await third.start();
        assert.equal(third.deviceId, '01020304', 'a broken device file is replaced');
        assert.equal(fs.readFileSync(path.join(env.dirs.state, 'device'), 'utf8'), '01020304\n');
    } finally {
        env.cleanup();
    }
});

test('1.5: layout.json is local plain data: round trip, deterministic bytes, broken parts dropped, never throws', async () => {
    const env = makeEnv();
    try {
        await env.start();
        assert.deepEqual({...await env.store.loadLayout()}, {}, 'missing file: empty layout');
        const layout = {
            [uuid(2)]: {x: 10, y: 20, w: 300, h: 200, monitor: 'DP-1 ACME 27 SN1', open: true},
            [uuid(1)]: {x: -5, y: 0, w: 280, h: 280, monitor: {connector: 'eDP-1', vendor: 'AUO', product: '0x1', serial: ''}, open: false},
        };
        const w = await env.store.saveLayout(layout);
        assert.equal(w.ok, true);
        const file = path.join(env.dirs.state, 'layout.json');
        assert.equal(fs.readFileSync(file, 'utf8').indexOf(uuid(1)) < fs.readFileSync(file, 'utf8').indexOf(uuid(2)), true, 'sorted ids');
        assert.deepEqual({...await env.store.loadLayout()}, layout);
        assert.deepEqual(fs.readdirSync(env.dirs.state).sort(), ['device', 'layout.json'], 'no tmp file left');
        fs.writeFileSync(file, JSON.stringify({
            [uuid(1)]: {x: 1, y: 2, w: 3, h: 4, monitor: 'm', open: true},
            [uuid(2)]: {x: 'one', y: 2, w: 3, h: 4, monitor: 'm', open: true},
            '../../x': {x: 1, y: 2, w: 3, h: 4, monitor: 'm', open: true},
            [uuid(3)]: null,
        }));
        const l = await env.store.loadLayout();
        assert.deepEqual(Object.keys(l), [uuid(1)]);
        assert.ok(env.warned(/3 entries dropped/));
        for (const bad of ['{not json', '[]', 'null', '7']) {
            fs.writeFileSync(file, bad);
            assert.deepEqual({...await env.store.loadLayout()}, {}, bad);
        }
        fs.rmSync(file);
        fs.mkdirSync(file);
        assert.deepEqual({...await env.store.loadLayout()}, {}, 'a directory instead of the file');
    } finally {
        env.cleanup();
    }
});

void enc; void raw;
