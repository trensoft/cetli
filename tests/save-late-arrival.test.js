// SPDX-License-Identifier: GPL-3.0-or-later
// 0.2.8.1: the SAVE must not destroy a version of a note that the transport brings in while the save runs. Same guarantee
// as the resolution has since 0.2.7.1 (tests/late-arrival.test.js): what the replacement takes out of <X>.json and nobody
// else has a copy of goes to backup/ (outside the synced folder). The sweep injects the arrival before EVERY fs call of
// one save, from the first read of <X>.json to the last write of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {FS, FsError} from '../src/fs-error.js';
import {DEV_B, at, makeEnv, rec, uuid} from './support/helpers.js';

const X = uuid(1);
const S = `${X}.json`;
const mk = over => rec({id: X, ...over});
const D = mk({rev: 1, text: 'TEXT-D-on-disk-at-save', updated: at(300)});
const D2 = mk({rev: 3, text: 'TEXT-D2-late-arrival', updated: at(100), device: DEV_B});
const D2old = mk({rev: 1, text: 'TEXT-D2-late-arrival', updated: at(400), device: DEV_B});
const mine = {text: 'TEXT-MINE-typed', color: 'yellow', deleted: false};
const READONLY = new Set(['listDir', 'stat', 'readBytes', 'ensureDir']);
const touchesS = args => args.some(a => typeof a === 'string' && (a === S || a.endsWith(`/${S}`)));

const arrive = (env, bytes) => {
    const tmp = path.join(env.dirs.notes, '.syncthing.save.tmp');
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, path.join(env.dirs.notes, S));
};

function walk(dir, out = []) {
    let ents = [];
    try { ents = fs.readdirSync(dir, {withFileTypes: true}); } catch { return out; }
    for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.isFile()) out.push(p);
    }
    return out;
}

// is the text on disk anywhere but tmp/ (a tmp file is not a durable guarantee)?
function durable(env, text) {
    const tmp = path.resolve(env.dirs.tmp);
    return walk(env.root).some(f => !path.resolve(f).startsWith(tmp + path.sep) && fs.readFileSync(f, 'utf8').includes(text));
}

async function run(injectAt, {arrival = D2.bytes} = {}) {
    const env = makeEnv({wrap: true});
    try {
        await env.start();
        env.putRec(S, D);
        await env.store.refresh();
        const base = env.layer.calls.length;
        let injected = null;
        env.layer.hooks.before.push(() => {
            const i = env.layer.calls.length - 1 - base;
            if (injectAt !== null && injected === null && i === injectAt) {
                injected = i;
                arrive(env, arrival);
            }
        });
        const r = await env.store.saveNote(X, env.store.getNote(X), mine);
        const calls = env.layer.calls.slice(base).map(c => ({op: c.op, touchesS: touchesS(c.args)}));
        return {r, calls, injected, d2: durable(env, 'TEXT-D2-late-arrival'), mineOnDisk: durable(env, 'TEXT-MINE-typed'),
            left: env.tmpNames().filter(n => n.endsWith('.x') || n.endsWith('.tmp'))};
    } finally { env.cleanup(); }
}

for (const [kind, arrival] of [['newer', D2.bytes], ['older', D2old.bytes]]) {
    test(`save F1 [${kind}]: a version arrives in <X>.json at any point of the save: its text is never lost, the save lands, tmp/ is clean`, async () => {
        const baseline = await run(null);
        assert.equal(baseline.r.ok, true);
        const firstRead = baseline.calls.findIndex(c => c.op === 'readBytes' && c.touchesS);
        const lastS = baseline.calls.map((c, i) => (!READONLY.has(c.op) && c.touchesS ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
        assert.ok(lastS >= 0, 'meter sanity: the save must write <X>.json');
        assert.ok(firstRead >= 0, 'meter sanity: the save must read <X>.json');
        const bad = [];
        for (let i = firstRead + 1; i <= lastS; i++) {
            const x = await run(i, {arrival});
            if (x.injected === null) continue;
            if (!x.d2) bad.push(`#${i} (${baseline.calls[i].op}): D2 lost`);
            if (x.r.ok === true && !x.mineOnDisk) bad.push(`#${i}: saved but own text not on disk`);
            if (x.left.length) bad.push(`#${i}: tmp/ not clean ${x.left}`);
        }
        console.log(`  save sweep [${kind}]: calls ${firstRead + 1}..${lastS} of ${baseline.calls.length}: ${bad.length ? bad.join('; ') : 'ok'}`);
        assert.deepEqual(bad, []);
    });
}

// ---- the exact behaviour --------------------------------------------------------------------------------------------

const withEnv = fn => async () => {
    const env = makeEnv({wrap: true});
    try {
        await env.start();
        env.putRec(S, D);
        await env.store.refresh();
        env.layer.calls.length = 0;
        await fn(env);
    } finally { env.cleanup(); }
};
const backupDir = env => path.join(path.dirname(env.dirs.tmp), 'backup');
const backups = env => { try { return fs.readdirSync(backupDir(env)).sort(); } catch { return []; } };
const backupText = env => backups(env).map(n => fs.readFileSync(path.join(backupDir(env), n), 'utf8')).join('\n');
const leftovers = env => env.tmpNames().filter(n => n.endsWith('.x') || n.endsWith('.tmp'));
const before = (env, op, fn) => {
    let n = 0;
    env.layer.hooks.before.push((o, args) => { if (o === op) fn(n++, args); });
};
const save = env => env.store.saveNote(X, env.store.getNote(X), mine);

test('save T2: D2 arrives before the exchange: the text is in ONE backup file, the save is in place, a warning says so, tmp/ is clean', withEnv(async env => {
    before(env, 'exchange', n => { if (n === 0) arrive(env, D2.bytes); });
    const r = await save(env);
    assert.equal(r.ok, true);
    assert.equal(env.read(S), r.record.canon);
    assert.equal(backups(env).length, 1);
    assert.match(backupText(env), /TEXT-D2-late-arrival/);
    assert.deepEqual(leftovers(env), []);
    assert.ok(env.warned(/changed while it was replaced/));
    assert.equal(env.store.ownWrite(X), r.record.v, 'a completed write is remembered');
}));

test('save T3: the version taken out is D itself rewritten by the transport (same v): not kept, no backup', withEnv(async env => {
    const pretty = Buffer.from(JSON.stringify(JSON.parse(D.canon), null, 2));
    before(env, 'exchange', n => { if (n === 0) arrive(env, pretty); });
    const r = await save(env);
    assert.equal(r.ok, true);
    assert.equal(env.read(S), r.record.canon);
    assert.deepEqual(backups(env), []);
    assert.deepEqual(leftovers(env), []);
}));

test('save T4: an empty arrival holds no text: dropped, no backup', withEnv(async env => {
    before(env, 'exchange', n => { if (n === 0) arrive(env, ''); });
    assert.equal((await save(env)).ok, true);
    assert.deepEqual(backups(env), []);
    assert.deepEqual(leftovers(env), []);
}));

test('save T4b: an arrival that is not a readable record is kept in backup/', withEnv(async env => {
    before(env, 'exchange', n => { if (n === 0) arrive(env, '{"schema": 9, "text": "FROM A NEWER CETLI"}'); });
    assert.equal((await save(env)).ok, true);
    assert.match(backupText(env), /FROM A NEWER CETLI/);
}));

test('save T5: <X>.json vanishes after the scan: nothing is replaced on that read, the save runs again, lands as a new file, tmp/ is clean', withEnv(async env => {
    before(env, 'exchange', n => { if (n === 0) fs.unlinkSync(path.join(env.dirs.notes, S)); });
    const r = await save(env);
    assert.equal(r.ok, true);
    assert.equal(env.read(S), r.record.canon);
    assert.deepEqual(backups(env), []);
    assert.deepEqual(leftovers(env), []);
    assert.equal(env.layer.calls.filter(c => c.op === 'exchange').length, 1, 'the second read found no file: a plain move');
}));

test('save T6: no exchange in the layer, D2 arrives after the scan: the checked move refuses (CHANGED), the save reads again, D2 becomes a visible copy in notes/, the save lands', withEnv(async env => {
    delete env.layer.exchange;
    before(env, 'writeTmp', n => { if (n === 0) arrive(env, D2.bytes); });
    const r = await save(env);
    assert.equal(r.ok, true);
    assert.equal(env.read(S), r.record.canon);
    const copies = env.names().filter(n => n !== S && fs.readFileSync(path.join(env.dirs.notes, n), 'utf8').includes('TEXT-D2-late-arrival'));
    assert.equal(copies.length, 1, 'D2 is a copy in notes/ (the fallback path), not in backup/');
    assert.deepEqual(backups(env), []);
    assert.deepEqual(leftovers(env), []);
}));

test('save T6b: no exchange, a NEW arrival at every read: SAVE_RERUNS reads, then MOVE_FAILED; every arrival is on disk, nothing is overwritten, no retry by a later change, the failed write is not remembered', withEnv(async env => {
    delete env.layer.exchange;
    const own0 = env.store.ownWrite(X);
    const arrivals = [3, 4, 5].map(rev => mk({rev, text: `TEXT-D2-arrival-${rev}`, updated: at(100 - rev), device: DEV_B}));
    let k = 0;
    // one arrival per write of the OWN record (the copies of the arrivals are written too, those are left alone)
    before(env, 'writeTmp', (n, args) => { if (Buffer.from(args[1]).toString().includes('TEXT-MINE-typed') && k < arrivals.length) arrive(env, arrivals[k++].bytes); });
    const r = await save(env);
    assert.equal(r.ok, false);
    assert.equal(r.cause.code, 'MOVE_FAILED');
    assert.equal('changed' in r, false, 'the internal flag does not leak');
    assert.equal(k, 3, 'three reads, three own writes, three arrivals');
    for (const a of arrivals)
        assert.equal(durable(env, a.text), true, `${a.text} is on disk`);
    assert.equal(env.read(S), arrivals[2].canon, 'the last arrival was not overwritten');
    assert.equal(env.store.ownWrite(X), own0, 'a write that did not complete is not remembered');
    env.events.length = 0;
    arrive(env, mk({rev: 9, text: 'later remote', updated: at(1), device: DEV_B}).bytes);
    await env.store.refresh({hint: [S]});
    assert.equal(env.events.some(e => e.type === 'save-retried'), false, 'MOVE_FAILED is not retried (next key = new save)');
    assert.deepEqual(leftovers(env), []);
}));

test('save T6c: a real exchange error (EIO) falls back to the checked move; an EIO of that move is a MOVE_FAILED, not re-read and not retried', withEnv(async env => {
    before(env, 'exchange', () => { throw new FsError(FS.IO, 'injected EIO'); });
    before(env, 'move', (n, args) => { if (args[1].endsWith(S)) throw new FsError(FS.IO, 'injected EIO'); });
    const r = await save(env);
    assert.equal(r.ok, false);
    assert.equal(r.cause.code, 'MOVE_FAILED');
    assert.equal(env.layer.calls.filter(c => c.op === 'writeTmp').length, 1, 'one attempt: an IO error is not a reason to read again');
    assert.equal(env.read(S), D.canon, 'the file is as it was');
    assert.deepEqual(leftovers(env), []);
}));

test('save T7: a NEW note (no <X>.json at the scan): D2 arriving before the move gives EEXIST, D2 is untouched, nothing is read again', async () => {
    const env = makeEnv({wrap: true});
    try {
        await env.start();
        env.layer.calls.length = 0;
        before(env, 'move', (n, args) => { if (n === 0 && args[1].endsWith(S)) arrive(env, D2.bytes); });
        const r = await env.store.saveNote(X, null, mine);
        assert.equal(r.ok, false);
        assert.equal(env.read(S), D2.canon);
        assert.equal(env.layer.calls.filter(c => c.op === 'writeTmp').length, 1);
        assert.deepEqual(leftovers(env), []);
    } finally { env.cleanup(); }
});
