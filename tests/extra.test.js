// SPDX-License-Identifier: GPL-3.0-or-later
// Formatting contract section 3 (card 1751509d): saveNote(id, base, {text, color, deleted, extra}). `extra` sets unknown keys of the
// record (the formatting is stored under `marks`), null removes a key, an absent key is left alone. The V10 checks are the same
// as everywhere (BAD_INPUT, nothing written), the "nothing changed" branch looks at the unknown keys too (a formatting-only save
// must not vanish), a deleted note keeps no `marks`, fitsV11 and the conflict copy treat the keys as before.
import test from 'node:test';
import assert from 'node:assert/strict';

import {DEV_B, at, fmt, makeEnv, rec, uuid} from './support/helpers.js';

const X = uuid(1);
const S = `${X}.json`;
const mk = over => rec({id: X, ...over});
const MARKS = {h: '0123456789abcdef', r: [[0, 3, 1], [4, 7, 6]]};
const MARKS2 = {h: '0123456789abcdef', r: [[0, 3, 1]]};
const save = (text, extra, over = {}) => ({text, color: 'yellow', deleted: false, ...(extra === undefined ? {} : {extra}), ...over});
const WRITES = env => env.layer.calls.filter(c => ['writeTmp', 'move', 'remove'].includes(c.op)).length;

const withEnv = (opts, fn) => async () => {
    const env = makeEnv({wrap: true, ...opts});
    try {
        await env.start();
        await fn(env);
    } finally {
        env.cleanup();
    }
};

// A stored note to start from.
async function note(env, text = 'hello world', extra = undefined) {
    const created = (await env.store.createNote({text, color: 'yellow'})).record;
    if (extra === undefined)
        return created;
    const r = await env.store.saveNote(created.id, created, save(text, extra));
    assert.equal(r.ok, true);
    // the set-up must have worked: without this a test that starts from a formatted note would pass on a core that drops `extra`
    for (const [k, v] of Object.entries(extra))
        assert.deepEqual(r.record.extra.get(k), v, `set-up: ${k} stored`);
    return r.record;
}

test('extra: a save sets a key; the record on disk is canon with the key sorted in; the other unknown keys stay', withEnv({}, async env => {
    const base = mk({rev: 1, extra: {future_field: {a: [1, 2]}}});
    env.putRec(S, base);
    await env.store.refresh();
    const r = await env.store.saveNote(X, env.store.getNote(X), save(base.text, {marks: MARKS}));
    assert.equal(r.ok, true);
    assert.deepEqual(r.record.extra.get('marks'), MARKS);
    assert.deepEqual(r.record.extra.get('future_field'), {a: [1, 2]});
    assert.match(env.read(S), /"future_field":\{"a":\[1,2\]\},"marks":\{"h":"0123456789abcdef","r":\[\[0,3,1\],\[4,7,6\]\]\}\}\n$/);
    assert.equal(env.read(S), r.record.canon);
    assert.equal(env.store.getNote(X).v, r.record.v);
    assert.equal(r.record.text, base.text, 'formatting never changes the text');
}));

test('extra: null removes the key, an absent key is untouched, null of a key that is not there changes nothing', withEnv({}, async env => {
    const n = await note(env, 'hello world', {marks: MARKS, keepme: 7});
    const r1 = await env.store.saveNote(n.id, n, save('hello world', {marks: null}));
    assert.equal(r1.ok, true);
    assert.equal(r1.record.extra.has('marks'), false, 'null removes the key');
    assert.equal(r1.record.extra.get('keepme'), 7, 'keys that are not named stay');
    assert.doesNotMatch(env.read(`${n.id}.json`), /marks/);
    // null of a key that is not there, text unchanged: nothing to write
    env.layer.calls.length = 0;
    const r2 = await env.store.saveNote(n.id, r1.record, save('hello world', {marks: null}));
    assert.equal(r2.unchanged, true);
    assert.equal(WRITES(env), 0);
}));

test('extra: a save that changes ONLY the unknown keys is written (not "unchanged"); the same save again is not', withEnv({}, async env => {
    const created = await note(env);
    const first = await env.store.saveNote(created.id, created, save('hello world', {marks: MARKS}));
    assert.equal(first.ok, true);
    assert.notEqual(first.unchanged, true, 'formatting-only save must not be dropped');
    assert.equal(first.record.rev, created.rev + 1);
    assert.equal(first.record.text, created.text);
    assert.equal(first.record.color, created.color);
    assert.notEqual(first.record.v, created.v);
    assert.equal(env.read(`${created.id}.json`), first.record.canon);
    // the very same save, from the record it produced: no write
    env.layer.calls.length = 0;
    const again = await env.store.saveNote(created.id, first.record, save('hello world', {marks: {h: MARKS.h, r: MARKS.r.map(x => [...x])}}));
    assert.equal(again.unchanged, true);
    assert.equal(WRITES(env), 0);
    // and with a different value: a change again
    const changed = await env.store.saveNote(created.id, first.record, save('hello world', {marks: MARKS2}));
    assert.notEqual(changed.unchanged, true);
    assert.equal(changed.record.rev, first.record.rev + 1);
    assert.deepEqual(changed.record.extra.get('marks'), MARKS2);
}));

test('extra: a save without `extra` leaves every unknown key alone, and a note without marks is written byte-identical to the old rule', withEnv({}, async env => {
    const n = await note(env, 'hello world', {marks: MARKS, keepme: {z: 1}});
    const r = await env.store.saveNote(n.id, n, save('hello world, edited'));
    assert.equal(r.ok, true);
    assert.deepEqual(r.record.extra.get('marks'), MARKS, 'no extra argument: the stored marks stay as they were');
    assert.deepEqual(r.record.extra.get('keepme'), {z: 1});
    // a note that never had marks: the bytes are exactly what makeRecord gives for the same fields and no extra key
    const plain = await note(env, 'plain');
    const p = await env.store.saveNote(plain.id, plain, save('plain, edited'));
    const expected = fmt.makeRecord({
        id: plain.id, rev: p.record.rev, updated: p.record.updated, created: plain.created, device: env.store.deviceId, color: 'yellow',
        text: 'plain, edited', deleted: false, conflict_of: null,
    });
    assert.equal(p.record.canon, expected.canon);
    assert.equal(env.read(`${plain.id}.json`), expected.canon);
    assert.doesNotMatch(env.read(`${plain.id}.json`), /marks/);
    // an empty extra object is the same as none
    env.layer.calls.length = 0;
    const e = await env.store.saveNote(plain.id, p.record, save('plain, edited', {}));
    assert.equal(e.unchanged, true);
    assert.equal(WRITES(env), 0);
}));

test('extra: text and formatting change together in one record (the text-only edit rewrites marks, the contract rule 5)', withEnv({}, async env => {
    const n = await note(env, 'hello world', {marks: MARKS});
    const r = await env.store.saveNote(n.id, n, save('hello brave world', {marks: {h: 'fedcba9876543210', r: [[0, 5, 1]]}}));
    assert.equal(r.ok, true);
    assert.equal(r.record.text, 'hello brave world');
    assert.deepEqual(r.record.extra.get('marks'), {h: 'fedcba9876543210', r: [[0, 5, 1]]});
    assert.equal(r.record.rev, n.rev + 1);
}));

test('extra: values are taken through JSON; the caller changing its object afterwards does not change the stored record', withEnv({}, async env => {
    const n = await note(env);
    const marks = {h: MARKS.h, r: [[0, 3, 1]]};
    const r = await env.store.saveNote(n.id, n, save('hello world', {marks}));
    marks.r[0][2] = 15;
    marks.r.push([5, 6, 2]);
    assert.deepEqual(r.record.extra.get('marks'), {h: MARKS.h, r: [[0, 3, 1]]});
    assert.deepEqual(env.store.getNote(n.id).extra.get('marks'), {h: MARKS.h, r: [[0, 3, 1]]});
    assert.equal(env.read(`${n.id}.json`), r.record.canon);
}));

// ---- the V10 checks and the other refusals: BAD_INPUT, nothing written, no trace ----------------------------------------

const bad = {
    'a known key (it would be written twice by canon)': {text: 'x'},
    'a known key: rev': {rev: 99},
    'an upper-case key': {Marks: MARKS},
    'a key with a dash': {'my-key': 1},
    'a key longer than 32 characters': {['k'.repeat(33)]: 1},
    'a value nested 9 levels deep (the limit is 8)': {marks: {a: {b: {c: {d: {e: {f: {g: {h: {i: 1}}}}}}}}}},
    'an undefined value (nothing to write)': {marks: undefined},
    'a function value': {marks: () => 1},
    'a symbol value': {marks: Symbol('m')},
    'a value with a cycle': (() => { const o = {}; o.self = o; return {marks: o}; })(),
    'a BigInt value': {marks: 10n},
};
const notObjects = {'a string': 'marks', 'an array': [['marks', 1]], 'null': null, 'a number': 3, 'a Map': new Map([['marks', 1]]), 'true': true};

for (const [name, extra] of Object.entries({...bad, ...Object.fromEntries(Object.entries(notObjects).map(([k, v]) => [`extra is ${k}`, v]))})) {
    test(`extra [V10]: ${name}: refused as BAD_INPUT, nothing written`, withEnv({}, async env => {
        const n = await note(env, 'hello world', {marks: MARKS});
        const before = env.snapshot();
        env.layer.calls.length = 0;
        const r = await env.store.saveNote(n.id, n, save('hello world changed', extra));
        assert.equal(r.ok, false);
        assert.equal(r.cause.code, 'BAD_INPUT');
        assert.deepEqual(env.snapshot(), before, 'nothing written');
        assert.equal(WRITES(env), 0);
        assert.deepEqual(env.tmpNames(), []);
        assert.equal(env.store.getNote(n.id).v, n.v, 'the stored note is the one it was');
    }));
}

test('extra [V10]: more than 16 unknown keys: refused as BAD_INPUT, nothing written (15 + marks = 16 is allowed)', withEnv({}, async env => {
    const n = await note(env);
    const keys = n => Object.fromEntries(Array.from({length: n}, (_, i) => [`k${i}`, i]));
    const before = env.snapshot();
    env.layer.calls.length = 0;
    const r = await env.store.saveNote(n.id, n, save('hello world', {...keys(16), marks: MARKS}));        // 17 keys
    assert.equal(r.ok, false);
    assert.equal(r.cause.code, 'BAD_INPUT');
    assert.deepEqual(env.snapshot(), before);
    assert.equal(WRITES(env), 0);
    const ok = await env.store.saveNote(n.id, n, save('hello world', {...keys(15), marks: MARKS}));      // 16 keys
    assert.equal(ok.ok, true, 'control: 16 keys go through');
    assert.equal(ok.record.extra.size, 16);
    // a save that removes keys makes room again
    const room = await env.store.saveNote(n.id, ok.record, save('hello world', {k0: null, k1: null, marks: null}));
    assert.equal(room.ok, true);
    assert.equal(room.record.extra.size, 13);
}));

test('extra [V10]: a value nested exactly 8 levels deep is allowed (control of the depth refusal above)', withEnv({}, async env => {
    const n = await note(env);
    const r = await env.store.saveNote(n.id, n, save('hello world', {marks: {a: {b: {c: {d: {e: {f: {g: {h: 1}}}}}}}}}));
    assert.equal(r.ok, true);
}));

test('extra [V10]: a refused extra leaves no trace: the copy of D is not written when a version of the other computer arrived', withEnv({}, async env => {
    const created = await note(env);
    const D = mk({id: created.id, rev: 2, text: 'remote', device: DEV_B, updated: at(1), created: created.created});
    env.putRec(`${created.id}.json`, D);
    const before = env.snapshot();
    env.layer.calls.length = 0;
    const r = await env.store.saveNote(created.id, created, save('mine', {marks: undefined}));
    assert.equal(r.cause?.code, 'BAD_INPUT');
    assert.deepEqual(env.snapshot(), before, 'no copy of D, D intact');
    assert.equal(WRITES(env), 0);
    // control: the same save with a sound extra writes the copy first and then wins
    const ok = await env.store.saveNote(created.id, created, save('mine', {marks: MARKS}));
    assert.equal(ok.ok, true);
    assert.equal(env.names().length, 2, 'the record and the copy of D');
}));

test('extra [V11]: an extra that makes the record too large is refused as TOO_LARGE, nothing written', withEnv({}, async env => {
    const n = await note(env);
    const before = env.snapshot();
    env.layer.calls.length = 0;
    const r = await env.store.saveNote(n.id, n, save('hello world', {marks: {h: MARKS.h, r: 'x'.repeat(300 * 1024)}}));
    assert.equal(r.ok, false);
    assert.equal(r.cause.code, 'TOO_LARGE');
    assert.deepEqual(env.snapshot(), before);
    assert.equal(WRITES(env), 0);
    // control: a realistic worst case (256 ranges) fits
    const ranges = Array.from({length: 256}, (_, i) => [i * 2, i * 2 + 1, 1 + (i % 15)]);
    const ok = await env.store.saveNote(n.id, n, save('hello world', {marks: {h: MARKS.h, r: ranges}}));
    assert.equal(ok.ok, true);
}));

// ---- delete: a deleted note keeps no formatting ------------------------------------------------------------------------

test('extra: deleteNote drops `marks` and keeps the other unknown keys; the tombstone text is empty', withEnv({}, async env => {
    const n = await note(env, 'hello world', {marks: MARKS, keepme: 1});
    const r = await env.store.deleteNote(n.id, n);
    assert.equal(r.ok, true);
    assert.equal(r.record.deleted, true);
    assert.equal(r.record.text, '');
    assert.equal(r.record.extra.has('marks'), false);
    assert.equal(r.record.extra.get('keepme'), 1);
    assert.doesNotMatch(env.read(`${n.id}.json`), /marks/);
}));

test('extra: saveNote with deleted:true drops `marks` even when it is handed marks (the tombstone keeps no formatting)', withEnv({}, async env => {
    const n = await note(env, 'hello world', {marks: MARKS});
    const r = await env.store.saveNote(n.id, n, save('ignored', {marks: MARKS2}, {deleted: true}));
    assert.equal(r.ok, true);
    assert.equal(r.record.deleted, true);
    assert.equal(r.record.extra.has('marks'), false);
    assert.doesNotMatch(env.read(`${n.id}.json`), /marks/);
}));

// ---- the conflict copy and the size rule keep treating the keys as before -------------------------------------------------

test('extra: the conflict copy of a lost version carries ITS unknown keys unchanged (expectedCopy), the winner carries the saved ones', withEnv({}, async env => {
    const created = await note(env);
    const D = mk({id: created.id, rev: 2, text: 'remote', device: DEV_B, updated: at(1), created: created.created, extra: {marks: MARKS2, other: 5}});
    env.putRec(`${created.id}.json`, D);                                  // arrived, not yet processed
    const r = await env.store.saveNote(created.id, created, save('mine', {marks: MARKS}));
    assert.equal(r.ok, true);
    assert.deepEqual(r.record.extra.get('marks'), MARKS);
    assert.equal(r.record.extra.has('other'), false, 'the winner is built from the base the user started from');
    const copy = fmt.expectedCopy(D, created.id);
    assert.equal(env.has(`${copy.id}.json`), true, 'the copy of D is there');
    assert.equal(env.read(`${copy.id}.json`), copy.canon, 'and is exactly expectedCopy(D): its keys unchanged');
    assert.deepEqual(copy.extra.get('marks'), MARKS2);
}));

test('extra: a refused save is retried later WITH its extra (the request keeps it)', withEnv({}, async env => {
    const created = await note(env);
    const D = mk({id: created.id, rev: 2, text: 'remote', device: DEV_B, updated: at(1), created: created.created});
    env.putRec(`${created.id}.json`, D);
    // the copy slot of D holds somebody else's record: the save is refused (condition (ii)) and watches the slot
    const copy = fmt.expectedCopy(D, created.id);
    env.putRec(`${copy.id}.json`, mk({id: copy.id, text: 'something else', rev: 5, device: DEV_B, conflict_of: created.id}));
    const r = await env.store.saveNote(created.id, created, save('mine', {marks: MARKS}));
    assert.equal(r.ok, false);
    assert.equal(r.cause.code, 'COPY_PLACE_TAKEN');
    // the slot is freed: the retry runs on the next event and writes the record with the marks
    env.layer.calls.length = 0;
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.rmSync(path.join(env.dirs.notes, `${copy.id}.json`));
    await env.store._retryRefused();
    const written = env.store.getNote(created.id);
    assert.equal(written.text, 'mine');
    assert.deepEqual(written.extra.get('marks'), MARKS);
}));
