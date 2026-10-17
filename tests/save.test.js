// SPDX-License-Identifier: GPL-3.0-or-later
// PLAN.md section 2.5 (local save, "local typing wins", refusals), 3 (4) (own-write filter), 1.2 (rev, updated).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

import {FS, FsError} from '../src/fs-error.js';
import {DEV_B, T0, at, fmt, makeEnv, rec, uuid} from './support/helpers.js';

const X = uuid(1);
const S = `${X}.json`;
const mk = over => rec({id: X, ...over});
const copyOf = l => fmt.expectedCopy(l, X);
const copyName = l => `${copyOf(l).id}.json`;
const cn = n => `${X}.sync-conflict-20261017-1200${String(n).padStart(2, '0')}-ABCDEFG.json`;
const mine = (text = 'mine', extra = {}) => ({text, color: 'yellow', deleted: false, ...extra});
const MOVES = env => env.layer.calls.filter(c => c.op === 'move' && c.args[1].startsWith(env.dirs.notes)).map(c => path.basename(c.args[1]));

const withEnv = (opts, fn) => async () => {
    const env = makeEnv({wrap: true, ...opts});
    try {
        await env.start();
        await fn(env);
    } finally {
        env.cleanup();
    }
};

test('1.2: a new note: rev 1, created = updated >= now, this device, no conflict_of; saved bytes are canon', withEnv({}, async env => {
    const r = await env.store.createNote({text: 'hello', color: 'green'});
    assert.equal(r.ok, true);
    const n = r.record;
    assert.equal(n.rev, 1);
    assert.equal(n.updated, new Date(T0).toISOString());
    assert.equal(n.created, n.updated);
    assert.equal(n.device, env.store.deviceId);
    assert.equal(n.conflict_of, null);
    assert.equal(n.schema, 1);
    assert.equal(env.read(`${n.id}.json`), n.canon);
    assert.equal(env.store.getNote(n.id).v, n.v);
}));

test('1.2: a save sets rev = max over every valid record of the id + 1 and updated = max(now, latest + 1 ms)', withEnv({}, async env => {
    const ahead = new Date(T0 + 3600000).toISOString();          // a record dated one hour AHEAD of the local clock (valid, < 24 h)
    const D = mk({rev: 3, updated: ahead, text: 'd'});
    env.putRec(S, D);
    env.putRec(cn(1), mk({rev: 8, updated: at(500), text: 'old conflict'}));
    // no refresh before the save: the conflict file is still in the folder when the save reads the group
    const r = await env.store.saveNote(X, D, mine());
    assert.equal(r.ok, true);
    // the conflict file is lower by order but its rev counts: rev = 8 + 1
    assert.equal(r.record.rev, 9);
    assert.equal(r.record.updated, new Date(T0 + 3600000 + 1).toISOString(), 'latest known updated + 1 ms, not the earlier local clock');
    // the clock ahead of everything: updated = now
    env.clock.t = T0 + 2 * 3600000;
    const r2 = await env.store.saveNote(X, r.record, mine('again'));
    assert.equal(r2.record.updated, new Date(T0 + 2 * 3600000).toISOString());
    assert.ok(Date.parse(r2.record.updated) > Date.parse(r.record.updated));
}));

test('1.2: unknown keys, created and conflict_of are carried over a rewrite', withEnv({}, async env => {
    const base = mk({rev: 1, created: at(900), conflict_of: uuid(9), extra: {future_field: {a: [1, 2]}, z: 1}});
    env.putRec(S, base);
    await env.store.refresh();
    const r = await env.store.saveNote(X, env.store.getNote(X), mine('edited'));
    assert.equal(r.ok, true);
    assert.equal(r.record.created, at(900));
    assert.equal(r.record.conflict_of, uuid(9));
    assert.deepEqual(r.record.extra.get('future_field'), {a: [1, 2]});
    assert.match(env.read(S), /"future_field":\{"a":\[1,2\]\},"z":1\}\n$/);
}));

test('2.5: remote version arrived while typing: the copy of it is written FIRST, then the local record wins', withEnv({}, async env => {
    const created = (await env.store.createNote({text: 'v1'})).record;
    const R = mk({id: created.id, rev: 2, text: 'remote edit', device: DEV_B, updated: at(1), created: created.created});
    env.putRec(`${created.id}.json`, R);                                   // arrived, not yet processed by the store
    env.layer.calls.length = 0;
    env.events.length = 0;
    const r = await env.store.saveNote(created.id, created, mine('typed meanwhile'));
    assert.equal(r.ok, true);
    const copy = fmt.expectedCopy(R, created.id);
    assert.deepEqual(MOVES(env), [`${copy.id}.json`, `${created.id}.json`], 'copy first, local record second');
    assert.equal(env.read(`${copy.id}.json`), copy.canon, 'the remote version is kept as a second cetli');
    const local = env.store.getNote(created.id);
    assert.equal(local.text, 'typed meanwhile');
    assert.ok(local.rev > R.rev && Date.parse(local.updated) > Date.parse(R.updated), 'above everything seen: a rule, not clock luck');
    assert.deepEqual(env.events.map(e => `${e.type}:${e.id}`), [`added:${copy.id}`], 'the copy is announced, the own write is not echoed');
}));

test('2.5: the remote version is a tombstone: no copy, the note comes back', withEnv({}, async env => {
    const created = (await env.store.createNote({text: 'v1'})).record;
    const T = mk({id: created.id, rev: 2, text: '', deleted: true, device: DEV_B, updated: at(1), created: created.created});
    env.putRec(`${created.id}.json`, T);
    const before = env.names().length;
    const r = await env.store.saveNote(created.id, created, mine('still wanted'));
    assert.equal(r.ok, true);
    assert.equal(env.names().length, before, 'no copy of a tombstone');
    assert.equal(env.store.getNote(created.id).deleted, false);
    assert.equal(env.store.getNote(created.id).text, 'still wanted');
}));

test('3 (3): an unchanged buffer is not written', withEnv({}, async env => {
    const created = (await env.store.createNote({text: 'same'})).record;
    env.layer.calls.length = 0;
    const r = await env.store.saveNote(created.id, created, {text: 'same', color: 'yellow', deleted: false});
    assert.equal(r.ok, true);
    assert.equal(r.unchanged, true);
    assert.equal(env.layer.calls.filter(c => c.op === 'writeTmp').length, 0);
}));

test('deleteNote writes a tombstone with an emptied text', withEnv({}, async env => {
    const created = (await env.store.createNote({text: 'to go'})).record;
    const r = await env.store.deleteNote(created.id, created);
    assert.equal(r.ok, true);
    assert.equal(r.record.deleted, true);
    assert.equal(r.record.text, '');
    assert.match(env.read(`${created.id}.json`), /"text":"","deleted":true/);
}));

test('[P2-T10][P2-T14] 2.5 refusal (i): <X>.json is not a valid record of the group: nothing written, cause with text, retry on change', async () => {
    const future = new Date(T0 + 30 * 3600000).toISOString();
    const cases = [
        ['UNKNOWN', env => env.put(S, 'garbage'), 'NOT_READABLE', 'file not readable'],
        ['NEWER', env => env.put(S, {schema: 2, id: X}), 'NEWER_SCHEMA', 'file needs a newer cetli'],
        ['QUARANTINED', env => env.putRec(S, mk({updated: future})), 'QUARANTINE', 'newer date: quarantine until 2026-10-17T18:00:00.000Z'],
        ['directory', env => fs.mkdirSync(path.join(env.dirs.notes, S)), 'NOT_READABLE', 'file not readable'],
        ['FIFO', env => execFileSync('mkfifo', [path.join(env.dirs.notes, S)]), 'NOT_READABLE', 'file not readable'],
    ];
    for (const [label, make, code, text] of cases) {
        const env = makeEnv({wrap: true});
        try {
            await env.start();
            make(env);
            await env.store.refresh();
            const before = env.snapshot();
            env.layer.calls.length = 0;
            const r = await env.store.saveNote(X, null, mine());
            assert.equal(r.ok, false, label);
            assert.equal(r.cause.code, code, label);
            assert.equal(r.cause.text, text, label);
            assert.equal(r.cause.watch, S);
            if (code === 'QUARANTINE')
                assert.equal(r.cause.until, '2026-10-17T18:00:00.000Z', 'the quarantine names the time');
            assert.deepEqual(env.snapshot(), before, `${label}: nothing written`);
            assert.equal(env.layer.calls.filter(c => ['writeTmp', 'move', 'remove'].includes(c.op)).length, 0, label);
            assert.equal(env.store.ownWrite(X), null, label);
            assert.ok(env.warned(new RegExp(`save of ${X} refused: ${text}`)), `${label}: the cause is in the log`);
        } finally {
            env.cleanup();
        }
    }
    // retry: the entry that blocked the save changes (becomes a valid record), the save runs again by itself
    const env = makeEnv({wrap: true});
    try {
        await env.start();
        env.put(S, 'garbage');
        await env.store.refresh();
        const r = await env.store.saveNote(X, null, mine('kept in the buffer'));
        assert.equal(r.ok, false);
        const D = mk({rev: 2, text: 'valid now', updated: at(30)});
        env.putRec(S, D);
        env.events.length = 0;
        await env.store.refresh({hint: [S]});
        const retried = env.events.find(e => e.type === 'save-retried');
        assert.ok(retried && retried.result.ok, 'retried and saved');
        assert.equal(env.store.getNote(X).text, 'kept in the buffer');
        assert.equal(env.read(copyName(D)), copyOf(D).canon, 'D was kept as a copy first (2.5 (ii))');
    } finally {
        env.cleanup();
    }
});

test('[P2-T10][P2-T14] 2.5 refusal (ii): the copy slot of D is taken: nothing written, D intact, retry when that entry changes', withEnv({}, async env => {
    const created = (await env.store.createNote({text: 'v1'})).record;
    const D = mk({id: created.id, rev: 2, text: 'remote', device: DEV_B, updated: at(1), created: created.created});
    const slot = `${fmt.cid(created.id, D.v)}.json`;
    env.putRec(`${created.id}.json`, D);
    env.put(slot, rec({id: slot.slice(0, 36), text: 'planted in advance', conflict_of: created.id}).bytes);
    const before = env.snapshot();
    env.layer.calls.length = 0;
    const r = await env.store.saveNote(created.id, created, mine('typed'));
    assert.equal(r.ok, false);
    assert.equal(r.cause.code, 'COPY_PLACE_TAKEN');
    assert.equal(r.cause.text, 'copy place taken');
    assert.equal(r.cause.watch, slot, 'the retry watches the file that blocked the save, here the copy slot');
    assert.deepEqual(env.snapshot(), before, 'D is intact, the local record was not written');
    assert.equal(env.layer.calls.filter(c => ['writeTmp', 'move', 'remove'].includes(c.op)).length, 0);
    // the retry fires on a change of the COPY SLOT, not of <X>.json
    env.events.length = 0;
    await env.store.refresh();
    assert.equal(env.events.some(e => e.type === 'save-retried'), false, 'nothing changed, nothing retried');
    fs.rmSync(path.join(env.dirs.notes, slot));
    await env.store.refresh({hint: [slot]});
    const retried = env.events.find(e => e.type === 'save-retried');
    assert.ok(retried?.result.ok);
    assert.equal(env.store.getNote(created.id).text, 'typed');
    assert.equal(env.read(slot), fmt.expectedCopy(D, created.id).canon);
}));

test('[P2-T10] 2.5: a failing WRITE OF THE COPY (ENOSPC, EEXIST) stops the save: no local record, D intact, nothing in the own-write filter', async () => {
    for (const [label, hook, code, text] of [
        ['ENOSPC on the tmp write', (op, args) => { if (op === 'writeTmp') throw new FsError(FS.NO_SPACE, 'injected ENOSPC'); }, 'COPY_NOT_WRITTEN', 'copy not written'],
        ['EEXIST: the slot filled in since the check', (op, args) => { if (op === 'move') throw new FsError(FS.EXISTS, 'injected EEXIST'); }, 'COPY_PLACE_TAKEN', 'copy place taken'],
        ['I/O error on the move', (op, args) => { if (op === 'move') throw new FsError(FS.IO, 'injected EIO'); }, 'COPY_NOT_WRITTEN', 'copy not written'],
    ]) {
        const env = makeEnv({wrap: true});
        try {
            await env.start();
            const created = (await env.store.createNote({text: 'v1'})).record;
            const D = mk({id: created.id, rev: 2, text: 'remote', device: DEV_B, updated: at(1), created: created.created});
            env.putRec(`${created.id}.json`, D);
            const before = env.snapshot();
            const priorOwn = env.store.ownWrite(created.id);
            env.layer.hooks.before.push(hook);
            const r = await env.store.saveNote(created.id, created, mine('typed'));
            env.layer.hooks.before.length = 0;
            assert.equal(r.ok, false, label);
            assert.equal(r.cause.code, code, label);
            assert.equal(r.cause.text, text, label);
            assert.deepEqual(env.snapshot(), before, `${label}: the local record is not written, D intact`);
            assert.deepEqual(env.tmpNames(), [], `${label}: our tmp file is gone`);
            assert.equal(env.store.ownWrite(created.id), priorOwn, `${label}: no new entry in the own-write filter`);
            assert.equal(env.store.ownWrite(fmt.cid(created.id, D.v)), null, `${label}: nor for the copy`);
        } finally {
            env.cleanup();
        }
    }
});

test('[P2-T10] 3 (4): only a COMPLETED write is remembered: a failed record that later arrives from a peer is NOT dropped as an echo', withEnv({}, async env => {
    const created = (await env.store.createNote({text: 'v1'})).record;
    let intended = null;
    env.layer.hooks.before.push((op, args) => {
        if (op === 'move' && args[1].endsWith(`${created.id}.json`)) {
            intended = fs.readFileSync(args[0]);                // the bytes of the record that did not make it
            throw new FsError(FS.IO, 'injected');
        }
    });
    const r = await env.store.saveNote(created.id, created, mine('lost write'));
    env.layer.hooks.before.length = 0;
    assert.equal(r.cause.code, 'MOVE_FAILED');
    assert.equal(env.store.ownWrite(created.id), created.v, 'still the last COMPLETED write');
    env.events.length = 0;
    env.put(`${created.id}.json`, intended);                    // the same version shows up from the peer
    await env.store.refresh({hint: [`${created.id}.json`]});
    const ch = env.events.filter(e => e.type === 'changed');
    assert.equal(ch.length, 1, 'the event is not dropped');
    assert.equal(ch[0].record.text, 'lost write');
}));

test('3 (4): the echo of our own COMPLETED write is not announced; a different remote version is', withEnv({}, async env => {
    const created = (await env.store.createNote({text: 'v1'})).record;
    env.events.length = 0;
    const saved = await env.store.saveNote(created.id, created, mine('v2'));
    assert.equal(env.store.ownWrite(created.id), saved.record.v);
    await env.store.refresh({hint: [`${created.id}.json`]});
    assert.deepEqual(env.events.filter(e => e.type === 'changed'), [], 'own write: no echo');
    env.putRec(`${created.id}.json`, mk({id: created.id, rev: 5, text: 'from the peer', updated: at(1), device: DEV_B}));
    await env.store.refresh({hint: [`${created.id}.json`]});
    assert.equal(env.events.filter(e => e.type === 'changed').length, 1);
}));

test('[P2-T14] 1.4/V9/V11: size causes: text over 64 KiB, and control characters that blow up the canonical form', withEnv({}, async env => {
    const ok = await env.store.createNote({text: 'a'.repeat(65536)});
    assert.equal(ok.ok, true, '65536 bytes of text are allowed');
    const over = await env.store.createNote({text: 'a'.repeat(65537)});
    assert.equal(over.ok, false);
    assert.equal(over.cause.code, 'TOO_LARGE');
    assert.equal(over.cause.text, 'too large');
    // 65536 control characters: 65536 bytes for the editor, six bytes each as \u0001 in canon (393218 with quotes)
    const before = env.names().length;
    const ctrl = await env.store.createNote({text: '\u0001'.repeat(65536)});
    assert.equal(ctrl.ok, false);
    assert.equal(ctrl.cause.code, 'TOO_LARGE');
    assert.equal(env.names().length, before, 'nothing was written');
    assert.ok(env.warned(/refused: too large/));
}));

test('[P2-T14] 1.5: "move failed" and the rest of the causes carry readable text', withEnv({}, async env => {
    env.layer.hooks.before.push(op => { if (op === 'move') throw new FsError(FS.NOT_SUPPORTED, 'x'); });
    const r = await env.store.createNote({text: 'x'});
    assert.equal(r.cause.text, 'move failed');
    env.layer.hooks.before.length = 0;
    const created = (await env.store.createNote({text: 'ok'})).record;
    env.putRec(`${created.id}.json`, mk({id: created.id, rev: 1_000_000_000, updated: at(1), device: DEV_B, created: created.created, text: 'max rev'}));
    const lim = await env.store.saveNote(created.id, created, mine('x'));
    assert.equal(lim.cause.code, 'REV_LIMIT');
    assert.equal((await env.store.saveNote('nope', null, mine())).cause.code, 'BAD_INPUT');
}));

test('[P2-T14] not in the plan: updated would leave the V6 range (year above 2100): refused as REV_LIMIT, nothing written', withEnv({}, async env => {
    const created = (await env.store.createNote({text: 'ok'})).record;
    env.clock.t = Date.parse('2101-01-01T00:00:00.000Z');
    const before = env.snapshot();
    const r = await env.store.saveNote(created.id, created, mine('x'));
    assert.equal(r.ok, false);
    assert.equal(r.cause.code, 'REV_LIMIT');
    assert.deepEqual(env.snapshot(), before);
    env.clock.t = Date.parse('2100-12-31T23:59:59.999Z');
    assert.equal((await env.store.saveNote(created.id, created, mine('x'))).ok, true, 'the last valid millisecond still saves');
}));

test('[P2-T14] 2.5: a save never writes a file our own reader rejects: clock before year 2000, malformed base; refused as BAD_INPUT, nothing written', async () => {
    // (a) the clock is before year 2000: `updated` would be V6-unknown (an existing 2026 note would be QUARANTINED then,
    // so the save is a new note and a new save of an id that has no file yet)
    const a = makeEnv({wrap: true});
    try {
        await a.start();
        a.clock.t = Date.parse('1999-12-31T23:59:59.999Z') - 10 * 365 * 86400000;
        const before = a.snapshot();
        a.layer.calls.length = 0;
        const r = await a.store.saveNote(X, null, mine('x'));
        assert.equal(r.ok, false);
        assert.equal(r.cause.code, 'BAD_INPUT');
        assert.deepEqual(a.snapshot(), before, 'nothing written');
        assert.equal(a.layer.calls.filter(c => ['writeTmp', 'move', 'remove'].includes(c.op)).length, 0);
        assert.deepEqual(a.tmpNames(), []);
        assert.equal(a.store.ownWrite(X), null);
        assert.ok(a.warned(/would write an unreadable record \(V6 date\)/), 'the reason is in the log');
        const c = await a.store.createNote({text: 'new'});
        assert.equal(c.ok, false, 'a new note too');
        assert.equal(c.cause.code, 'BAD_INPUT');
        assert.deepEqual(a.snapshot(), before);
        a.clock.t = T0;
        assert.equal((await a.store.saveNote(X, null, mine('x'))).ok, true, 'control: with a sound clock the same save goes through');
    } finally {
        a.cleanup();
    }
    // (b) a malformed base: its `created` is copied into the new record
    const b = makeEnv({wrap: true});
    try {
        await b.start();
        const created = (await b.store.createNote({text: 'ok'})).record;
        const before = b.snapshot();
        const r = await b.store.saveNote(created.id, {...created, created: 'yesterday'}, mine('x'));
        assert.equal(r.ok, false);
        assert.equal(r.cause.code, 'BAD_INPUT');
        assert.deepEqual(b.snapshot(), before, 'nothing written');
        assert.equal(b.read(`${created.id}.json`), created.canon, 'the stored note still reads');
        assert.equal(b.store.getNote(created.id).v, created.v, 'and is still the note the store holds');
        // control: the same save with a sound base goes through
        assert.equal((await b.store.saveNote(created.id, created, mine('x'))).ok, true);
    } finally {
        b.cleanup();
    }
});

test('[P2-T14] 2.5: a refused save leaves no trace: the copy of D is not written when the revision limit or the size limit refuses', async () => {
    for (const [label, remote, text, code] of [
        ['REV_LIMIT', {rev: 1_000_000_000}, 'x', 'REV_LIMIT'],
        ['TOO_LARGE (canonical form)', {}, '\u0001'.repeat(65536), 'TOO_LARGE'],
    ]) {
        const env = makeEnv({wrap: true});
        try {
            await env.start();
            const created = (await env.store.createNote({text: 'v1'})).record;
            env.putRec(`${created.id}.json`, mk({id: created.id, rev: 2, text: 'remote', device: DEV_B, updated: at(1), created: created.created, ...remote}));
            await env.store.refresh({hint: [`${created.id}.json`]});
            const before = env.snapshot();
            const priorOwn = env.store.ownWrite(created.id);
            env.layer.calls.length = 0;
            const r = await env.store.saveNote(created.id, created, mine(text));
            assert.equal(r.ok, false, label);
            assert.equal(r.cause.code, code, label);
            assert.deepEqual(env.snapshot(), before, `${label}: no copy file, D intact`);
            assert.equal(env.layer.calls.filter(c => ['writeTmp', 'move', 'remove'].includes(c.op)).length, 0, label);
            assert.equal(env.store.ownWrite(created.id), priorOwn, label);
        } finally {
            env.cleanup();
        }
    }
});

test('[P2-T10] 2.5: a refusal without a blocking file (move failed) is NOT retried when something changes', withEnv({}, async env => {
    const created = (await env.store.createNote({text: 'v1'})).record;
    env.putRec(`${created.id}.json`, mk({id: created.id, rev: 2, text: 'remote', device: DEV_B, updated: at(1), created: created.created}));
    await env.store.refresh({hint: [`${created.id}.json`]});
    env.layer.hooks.before.push((op, args) => { if (op === 'move' && args[1].startsWith(env.dirs.notes) && args[1].endsWith(`${created.id}.json`)) throw new FsError(FS.IO, 'injected EIO'); });
    const r = await env.store.saveNote(created.id, created, mine('typed'));
    env.layer.hooks.before.length = 0;
    assert.equal(r.ok, false);
    assert.equal(r.cause.code, 'MOVE_FAILED');
    // the file the save wanted to replace changes: a save that WATCHES it would run again by itself
    env.putRec(`${created.id}.json`, mk({id: created.id, rev: 5, text: 'later remote', device: DEV_B, updated: at(0.5), created: created.created}));
    env.events.length = 0;
    await env.store.refresh({hint: [`${created.id}.json`]});
    assert.equal(env.events.some(e => e.type === 'save-retried'), false, 'no retry (next key = new save)');
}));

test('[P2-T10] 2.5: a failed COPY write (ENOSPC) is the same refusal as "copy place taken": retried when the copy slot changes, not before', withEnv({}, async env => {
    const created = (await env.store.createNote({text: 'v1'})).record;
    const D = mk({id: created.id, rev: 2, text: 'remote', device: DEV_B, updated: at(1), created: created.created});
    env.putRec(`${created.id}.json`, D);
    await env.store.refresh({hint: [`${created.id}.json`]});
    env.layer.hooks.before.push(op => { if (op === 'writeTmp') throw new FsError(FS.NO_SPACE, 'injected ENOSPC'); });
    const r = await env.store.saveNote(created.id, created, mine('typed'));
    env.layer.hooks.before.length = 0;
    assert.equal(r.ok, false);
    assert.equal(r.cause.code, 'COPY_NOT_WRITTEN');
    const slot = `${fmt.cid(created.id, D.v)}.json`;
    assert.equal(r.cause.watch, slot);
    env.events.length = 0;
    await env.store.refresh();
    assert.equal(env.events.some(e => e.type === 'save-retried'), false, 'the slot did not change: nothing retried');
    env.putRec(slot, fmt.expectedCopy(D, created.id));         // the transport brings the expected copy: D is preserved
    await env.store.refresh({hint: [slot]});
    const retried = env.events.find(e => e.type === 'save-retried');
    assert.ok(retried?.result.ok, 'retried by itself and saved');
    assert.equal(env.store.getNote(created.id).text, 'typed');
}));

test('2.5: saves of one store are serialised (two calls without await)', withEnv({}, async env => {
    const created = (await env.store.createNote({text: 'v1'})).record;
    const [a, b] = await Promise.all([
        env.store.saveNote(created.id, created, mine('first')),
        env.store.saveNote(created.id, created, mine('second')),
    ]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(b.record.rev, a.record.rev + 1);
    assert.equal(env.store.getNote(created.id).text, 'second');
    assert.ok(env.names().length >= 2, 'the first was kept as a copy: the second started from an outdated base');
}));
