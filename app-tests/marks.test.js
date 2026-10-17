// SPDX-License-Identifier: GPL-3.0-or-later
// app/marks.js: the stored text formatting (extra.marks) and the arithmetic on its ranges. The reference model in this file is
// independent of marks.js (one flags number per code point), so that a wrong boundary or merge there is caught. The decoder gets
// hostile input: it must answer null and never throw. A POSITIVE CONTROL runs next to every rejection table: the same harness must
// accept the unbroken value, otherwise "null" proves nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

import {
    BOLD, ITALIC, MAX_RANGES, STRIKE, UNDERLINE, decodeMarks, encodeMarks, flagsAt, normalizeRanges, toggleFlag,
} from '../app/marks.js';

const sha16 = text => crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex').slice(0, 16);
const clone = v => JSON.parse(JSON.stringify(v));
const deepFreeze = v => {
    if (v !== null && typeof v === 'object') {
        Object.values(v).forEach(deepFreeze);
        Object.freeze(v);
    }
    return v;
};
const cpLen = s => [...s].length;

// reference model: the flags number of every code point 0..n-1, and back to the canonical ranges
const modelOf = (ranges, n) => {
    const m = new Array(n).fill(0);
    for (const [s, e, f] of ranges)
        for (let i = s; i < Math.min(e, n); i++)
            m[i] |= f;
    return m;
};
const rangesOf = m => {
    const out = [];
    m.forEach((f, i) => {
        if (f === 0)
            return;
        const last = out[out.length - 1];
        if (last && last[1] === i && last[2] === f)
            last[1] = i + 1;
        else
            out.push([i, i + 1, f]);
    });
    return out;
};

// seeded generator, so that a failure can be repeated
let seed = 20261017;
const rnd = n => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
};
const randomRanges = (n, count) => Array.from({length: count}, () => {
    const s = rnd(n);
    return [s, s + 1 + rnd(n - s), 1 + rnd(15)];
});

const TEXT = 'Hello wörld';                 // 11 code points
const GOOD = () => ({marks: {h: sha16(TEXT), r: [[0, 5, BOLD], [6, 11, ITALIC | UNDERLINE]]}});

test('flags: bold 1, italic 2, underline 4, strikethrough 8', () => {
    assert.deepEqual([BOLD, ITALIC, UNDERLINE, STRIKE], [1, 2, 4, 8]);
    assert.equal(MAX_RANGES, 256);
});

test('encode: the stored shape, h is the sha256 head of the text, offsets are code points', () => {
    const got = encodeMarks(TEXT, [[0, 5, BOLD]], sha16);
    assert.deepEqual(got, {h: sha16(TEXT), r: [[0, 5, 1]]});
    assert.match(got.h, /^[0-9a-f]{16}$/);
    assert.equal(got.h, crypto.createHash('sha256').update('Hello wörld').digest('hex').slice(0, 16));
});

test('encode: a note with no formatting gives null (the marks key must be absent, never an empty r)', () => {
    assert.equal(encodeMarks(TEXT, [], sha16), null);
    assert.equal(encodeMarks(TEXT, [[3, 3, BOLD]], sha16), null);        // an empty range is nothing
    assert.equal(encodeMarks('', [[0, 4, BOLD]], sha16), null);          // nothing to format in an empty text
});

test('encode: ranges are normalized and cut to the text', () => {
    assert.deepEqual(encodeMarks(TEXT, [[6, 99, ITALIC], [0, 3, BOLD], [3, 5, BOLD]], sha16).r, [[0, 5, BOLD], [6, 11, ITALIC]]);
    assert.equal(encodeMarks(TEXT, [[11, 20, BOLD]], sha16), null);
    assert.equal(encodeMarks(TEXT, [[50, 60, BOLD]], sha16), null);
});

test('encode: more than MAX_RANGES keeps the first MAX_RANGES, and the result decodes', () => {
    const text = 'x'.repeat(1000);
    const ranges = Array.from({length: 400}, (_, i) => [i * 2, i * 2 + 1, BOLD]);
    const got = encodeMarks(text, ranges, sha16);
    assert.equal(got.r.length, MAX_RANGES);
    assert.deepEqual(got.r[255], [510, 511, BOLD]);
    assert.deepEqual(decodeMarks(text, {marks: got}, sha16), got.r);
});

test('encode: never throws; a bad text, ranges or hash function give null', () => {
    const boom = () => {
        throw new Error('boom');
    };
    for (const bad of [null, undefined, 5, {}, [], Symbol('x'), 10n])
        assert.equal(encodeMarks(bad, [[0, 1, BOLD]], sha16), null, String(typeof bad));
    for (const bad of [null, undefined, 5, 'abc', {}, [[0]], [[0, 1, 99]], [[-1, 2, 1]], [[0.5, 2, 1]], [['0', '2', 1]], [null], [[]]])
        assert.equal(encodeMarks(TEXT, bad, sha16), null, JSON.stringify(bad));
    for (const bad of [undefined, null, boom, () => 'XYZ', () => 'ABCDEF0123456789', () => 'abc', () => 5, () => undefined])
        assert.equal(encodeMarks(TEXT, [[0, 1, BOLD]], bad), null, String(bad));
});

test('decode: the round trip of encode gives the same ranges (POSITIVE CONTROL of the whole table below)', () => {
    const ranges = [[0, 5, BOLD], [6, 11, ITALIC | UNDERLINE]];
    const stored = encodeMarks(TEXT, ranges, sha16);
    assert.deepEqual(decodeMarks(TEXT, {marks: stored}, sha16), ranges);
    assert.deepEqual(decodeMarks(TEXT, GOOD(), sha16), ranges);
    // survives the file: JSON text and back
    assert.deepEqual(decodeMarks(TEXT, JSON.parse(JSON.stringify({marks: stored})), sha16), ranges);
});

test('decode: extra with other keys is fine, the marks key is read by its own name only', () => {
    const extra = {...GOOD(), other: 'x', Marks: 5};
    assert.deepEqual(decodeMarks(TEXT, extra, sha16), [[0, 5, 1], [6, 11, 6]]);
    assert.equal(decodeMarks(TEXT, {Marks: GOOD().marks}, sha16), null);
    assert.equal(decodeMarks(TEXT, {}, sha16), null);
    assert.equal(decodeMarks(TEXT, {other: 1}, sha16), null);
});

test('decode: the result is a new array (the input is not shared and not changed)', () => {
    const extra = deepFreeze(GOOD());
    const got = decodeMarks(TEXT, extra, sha16);
    assert.deepEqual(got, [[0, 5, 1], [6, 11, 6]]);
    assert.notEqual(got, extra.marks.r);
    assert.notEqual(got[0], extra.marks.r[0]);
    got[0][1] = 99;
    assert.equal(extra.marks.r[0][1], 5);
});

// each case breaks the unbroken GOOD() in ONE way
const HOSTILE = {
    'extra is null': () => null,
    'extra is an array': () => [GOOD().marks],
    'extra is a string': () => 'marks',
    'extra is a number': () => 7,
    'marks is null': e => ({...e, marks: null}),
    'marks is an array': e => ({...e, marks: [e.marks.h, e.marks.r]}),
    'marks is a string': e => ({...e, marks: 'bold'}),
    'marks is the removed key': () => ({}),
    'h missing': e => ({marks: {r: e.marks.r}}),
    'h is a number': e => ({marks: {...e.marks, h: 1234567890123456}}),
    'h has 15 digits': e => ({marks: {...e.marks, h: e.marks.h.slice(1)}}),
    'h has 17 digits': e => ({marks: {...e.marks, h: `${e.marks.h}0`}}),
    'h is upper case': e => ({marks: {...e.marks, h: e.marks.h.toUpperCase()}}),
    'h is not hex': e => ({marks: {...e.marks, h: 'zzzzzzzzzzzzzzzz'}}),
    'h is the hash of another text': e => ({marks: {...e.marks, h: sha16('Hello world')}}),
    'h with a trailing newline': e => ({marks: {...e.marks, h: `${e.marks.h}\n`}}),
    'r missing': e => ({marks: {h: e.marks.h}}),
    'r is an object': e => ({marks: {...e.marks, r: {0: [0, 5, 1], length: 1}}}),
    'r is a string': e => ({marks: {...e.marks, r: '[[0,5,1]]'}}),
    'r is empty': e => ({marks: {...e.marks, r: []}}),
    'r has 257 ranges': e => ({marks: {...e.marks, r: Array.from({length: 257}, (_, i) => [i, i + 1, 1])}}),
    'a range is not an array': e => ({marks: {...e.marks, r: [{0: 0, 1: 5, 2: 1}, e.marks.r[1]]}}),
    'a range is null': e => ({marks: {...e.marks, r: [null, e.marks.r[1]]}}),
    'a range has 2 numbers': e => ({marks: {...e.marks, r: [[0, 5], e.marks.r[1]]}}),
    'a range has 4 numbers': e => ({marks: {...e.marks, r: [[0, 5, 1, 0], e.marks.r[1]]}}),
    'start is a string': e => ({marks: {...e.marks, r: [['0', 5, 1], e.marks.r[1]]}}),
    'end is a string': e => ({marks: {...e.marks, r: [[0, '5', 1], e.marks.r[1]]}}),
    'flags is a string': e => ({marks: {...e.marks, r: [[0, 5, '1'], e.marks.r[1]]}}),
    'start is not an integer': e => ({marks: {...e.marks, r: [[0.5, 5, 1], e.marks.r[1]]}}),
    'end is not an integer': e => ({marks: {...e.marks, r: [[0, 4.5, 1], e.marks.r[1]]}}),
    'flags is not an integer': e => ({marks: {...e.marks, r: [[0, 5, 1.5], e.marks.r[1]]}}),
    'start is NaN': e => ({marks: {...e.marks, r: [[NaN, 5, 1], e.marks.r[1]]}}),
    'end is Infinity': e => ({marks: {...e.marks, r: [[0, Infinity, 1], e.marks.r[1]]}}),
    'start is negative': e => ({marks: {...e.marks, r: [[-1, 5, 1], e.marks.r[1]]}}),
    'start is a BigInt': e => ({marks: {...e.marks, r: [[0n, 5, 1], e.marks.r[1]]}}),
    'start is a boolean': e => ({marks: {...e.marks, r: [[false, 5, 1], e.marks.r[1]]}}),
    'start is null': e => ({marks: {...e.marks, r: [[null, 5, 1], e.marks.r[1]]}}),
    'start is a hole': e => ({marks: {...e.marks, r: [[, 5, 1], e.marks.r[1]]}}),
    'start is above the safe integers': e => ({marks: {...e.marks, r: [[2 ** 53, 2 ** 53 + 2, 1]]}}),
    'an empty range (start == end)': e => ({marks: {...e.marks, r: [[3, 3, 1], e.marks.r[1]]}}),
    'a backwards range (start > end)': e => ({marks: {...e.marks, r: [[5, 0, 1], e.marks.r[1]]}}),
    'end is past the text by 1': e => ({marks: {...e.marks, r: [e.marks.r[0], [6, 12, 6]]}}),
    'end is far past the text': e => ({marks: {...e.marks, r: [[0, 1e9, 1]]}}),
    'the ranges overlap by 1': e => ({marks: {...e.marks, r: [[0, 7, 1], [6, 11, 6]]}}),
    'the ranges are unsorted': e => ({marks: {...e.marks, r: [e.marks.r[1], e.marks.r[0]]}}),
    'the ranges are equal': e => ({marks: {...e.marks, r: [e.marks.r[0], e.marks.r[0]]}}),
    'flags is 0': e => ({marks: {...e.marks, r: [[0, 5, 0], e.marks.r[1]]}}),
    'flags is 16': e => ({marks: {...e.marks, r: [[0, 5, 16], e.marks.r[1]]}}),
    'flags is negative': e => ({marks: {...e.marks, r: [[0, 5, -1], e.marks.r[1]]}}),
};

test('decode: hostile input gives null, one rule broken at a time (the unbroken value is accepted in the same harness)', () => {
    assert.notEqual(decodeMarks(TEXT, GOOD(), sha16), null, 'positive control');
    for (const [name, make] of Object.entries(HOSTILE)) {
        let got;
        assert.doesNotThrow(() => {
            got = decodeMarks(TEXT, make(GOOD()), sha16);
        }, name);
        assert.equal(got, null, name);
    }
});

test('decode: a range may end exactly at the end of the text; a range at the last code point is fine', () => {
    assert.deepEqual(decodeMarks(TEXT, {marks: {h: sha16(TEXT), r: [[10, 11, STRIKE]]}}, sha16), [[10, 11, 8]]);
    assert.deepEqual(decodeMarks(TEXT, {marks: {h: sha16(TEXT), r: [[0, 11, 15]]}}, sha16), [[0, 11, 15]]);
    assert.deepEqual(decodeMarks(TEXT, {marks: {h: sha16(TEXT), r: [[0, 1, 1], [1, 2, 2], [2, 3, 4], [3, 4, 8]]}}, sha16),
        [[0, 1, 1], [1, 2, 2], [2, 3, 4], [3, 4, 8]]);
});

test('decode: exactly MAX_RANGES ranges are fine, one more is not', () => {
    const text = 'x'.repeat(600);
    const ranges = n => Array.from({length: n}, (_, i) => [i * 2, i * 2 + 1, BOLD]);
    assert.equal(decodeMarks(text, {marks: {h: sha16(text), r: ranges(256)}}, sha16).length, 256);
    assert.equal(decodeMarks(text, {marks: {h: sha16(text), r: ranges(257)}}, sha16), null);
});

test('decode: -0 is a zero (no negative zero in the result); touching ranges with equal flags are merged', () => {
    const got = decodeMarks(TEXT, {marks: {h: sha16(TEXT), r: [[-0, 3, 1], [3, 5, 1]]}}, sha16);
    assert.deepEqual(got, [[0, 5, 1]]);
    assert.ok(Object.is(got[0][0], 0));
});

test('decode: the text is hashed as stored: a changed, trimmed or re-encoded text does not match (old client defence)', () => {
    const stored = GOOD();
    for (const other of ['Hello wörld ', ' Hello wörld', 'hello wörld', 'Hello wörld\n', 'Hello wörld', 'Hello wörld!'])
        assert.equal(decodeMarks(other, stored, sha16), null, JSON.stringify(other));
    assert.notEqual(decodeMarks(TEXT, stored, sha16), null);
});

test('decode: a bad text or hash function gives null and never throws', () => {
    const boom = () => {
        throw new Error('boom');
    };
    for (const bad of [null, undefined, 5, {}, [], 10n, Symbol('x')])
        assert.equal(decodeMarks(bad, GOOD(), sha16), null, String(typeof bad));
    for (const bad of [undefined, null, 'sha', boom, () => undefined, () => 5, () => sha16(TEXT).toUpperCase(), () => `${sha16(TEXT)} `])
        assert.equal(decodeMarks(TEXT, GOOD(), bad), null, String(bad));
});

test('decode: a hostile object (throwing getters, Proxy, cyclic, huge) gives null and never throws', () => {
    const trap = new Proxy({}, {get() { throw new Error('trap'); }, has() { throw new Error('trap'); }, ownKeys() { throw new Error('trap'); }, getOwnPropertyDescriptor() { throw new Error('trap'); }});
    const getter = {get marks() { throw new Error('getter'); }};
    const hGetter = {marks: {get h() { throw new Error('getter'); }, r: [[0, 1, 1]]}};
    const rGetter = {marks: {h: sha16(TEXT), get r() { throw new Error('getter'); }}};
    const cyc = {marks: {h: sha16(TEXT), r: []}};
    cyc.marks.r.push(cyc.marks.r);
    const tripleProxy = {marks: {h: sha16(TEXT), r: [new Proxy([0, 5, 1], {get() { throw new Error('trap'); }})]}};
    for (const [name, x] of Object.entries({trap, getter, hGetter, rGetter, cyc, tripleProxy})) {
        let got;
        assert.doesNotThrow(() => {
            got = decodeMarks(TEXT, x, sha16);
        }, name);
        assert.equal(got, null, name);
    }
    const big = {marks: {h: sha16(TEXT), r: new Array(5_000_000).fill([0, 1, 1])}};      // rejected by its length, not walked
    const t0 = Date.now();
    assert.equal(decodeMarks(TEXT, big, sha16), null);
    assert.ok(Date.now() - t0 < 1000, 'a 5-million-entry r is refused at once');
    const polluted = JSON.parse('{"__proto__": {"marks": {"h": "0000000000000000", "r": [[0, 1, 1]]}}}');
    assert.equal(decodeMarks(TEXT, polluted, sha16), null);                    // marks must be the object's OWN key
    assert.equal(decodeMarks(TEXT, Object.create(GOOD()), sha16), null);
});

test('decode: fuzz: damaged copies of a valid value are null or a valid canonical list, and never throw', () => {
    const text = 'a😀b🏳️‍🌈c\u{1F468}‍\u{1F469}d';
    const n = cpLen(text);
    const good = encodeMarks(text, [[0, 2, BOLD], [3, 7, ITALIC], [8, n, UNDERLINE | STRIKE]], sha16);
    assert.deepEqual(decodeMarks(text, {marks: good}, sha16), good.r, 'positive control');
    const values = [null, undefined, true, false, -1, 0, 1, 2, 3, 15, 16, 255, 256, n, n + 1, 0.5, NaN, Infinity, -Infinity, '', '1', 'x', [], {}, [0, 1, 1], 2 ** 53, 10n, -0];
    let accepted = 0;
    for (let i = 0; i < 20000; i++) {
        const e = {marks: clone(good)};
        const edits = 1 + rnd(3);
        for (let k = 0; k < edits; k++) {
            if (e.marks === null || typeof e.marks !== 'object' || !Array.isArray(e.marks.r) || e.marks.r.length === 0)
                break;                      // an earlier edit already made it a non-list: nothing left to damage in a list
            const which = rnd(6);
            const v = values[rnd(values.length)];
            const row = e.marks.r[rnd(e.marks.r.length)];
            if (which === 0 && Array.isArray(row))
                row[rnd(3)] = v;
            else if (which === 1)
                e.marks.r = rnd(2) === 0 ? e.marks.r.slice(rnd(3)) : [...e.marks.r, e.marks.r[rnd(e.marks.r.length)]];
            else if (which === 2)
                e.marks.h = rnd(2) === 0 ? v : e.marks.h.slice(rnd(16));
            else if (which === 3)
                e.marks.r.splice(rnd(3), 0, v);
            else if (which === 4)
                e.marks = rnd(2) === 0 ? v : {...e.marks, r: v};
            else
                e.marks.r.reverse();
        }
        let got;
        assert.doesNotThrow(() => {
            got = decodeMarks(text, e, sha16);
        }, JSON.stringify(e, (_, x) => (typeof x === 'bigint' ? `${x}n` : x)));
        if (got === null)
            continue;
        accepted++;
        assert.ok(got.length >= 1 && got.length <= MAX_RANGES);
        let prev = 0;
        got.forEach(([s, en, f], idx) => {
            assert.ok(Number.isInteger(s) && Number.isInteger(en) && Number.isInteger(f));
            assert.ok(s >= prev && en > s && en <= n && f >= 1 && f <= 15, JSON.stringify(got));
            if (idx > 0)
                assert.ok(!(got[idx - 1][1] === s && got[idx - 1][2] === f), 'touching equal ranges are merged');
            prev = en;
        });
    }
    assert.ok(accepted > 0 && accepted < 20000, `fuzz accepted ${accepted} of 20000 (it must reject most and still accept some)`);
});

test('code points: an astral character and an emoji are ONE offset, not two (the UTF-16 index would be wrong)', () => {
    const text = 'a😀b';                                   // UTF-16 length 4, code points 3
    assert.equal(text.length, 4);
    assert.equal(cpLen(text), 3);
    assert.deepEqual(encodeMarks(text, [[1, 2, BOLD]], sha16).r, [[1, 2, BOLD]]);       // exactly the emoji
    assert.deepEqual(encodeMarks(text, [[0, 3, BOLD]], sha16).r, [[0, 3, BOLD]]);
    assert.deepEqual(encodeMarks(text, [[0, 4, BOLD]], sha16).r, [[0, 3, BOLD]]);        // 4 is past the end in code points
    assert.deepEqual(decodeMarks(text, {marks: {h: sha16(text), r: [[0, 3, 1]]}}, sha16), [[0, 3, 1]]);
    assert.equal(decodeMarks(text, {marks: {h: sha16(text), r: [[0, 4, 1]]}}, sha16), null);   // fits UTF-16, not the code points
    assert.deepEqual(decodeMarks(text, {marks: {h: sha16(text), r: [[2, 3, 1]]}}, sha16), [[2, 3, 1]]);
});

test('code points: only astral text, a ZWJ family and a flag are counted by code point', () => {
    const all = '\u{1F600}\u{1F601}\u{1F602}';            // 3 code points, 6 UTF-16 units
    assert.deepEqual(encodeMarks(all, [[0, 3, 15]], sha16).r, [[0, 3, 15]]);
    assert.equal(decodeMarks(all, {marks: {h: sha16(all), r: [[0, 6, 1]]}}, sha16), null);
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';   // 5 code points, one grapheme: the offsets still count code points
    assert.equal(cpLen(family), 5);
    assert.deepEqual(encodeMarks(family, [[0, 5, BOLD]], sha16).r, [[0, 5, BOLD]]);
    assert.deepEqual(encodeMarks(family, [[0, 9, BOLD]], sha16).r, [[0, 5, BOLD]]);
    const flag = '\u{1F1ED}\u{1F1FA}';                      // 2 regional indicators
    assert.deepEqual(encodeMarks(flag, [[1, 2, ITALIC]], sha16).r, [[1, 2, ITALIC]]);
    const combining = 'éx';                           // e + combining acute: 3 code points
    assert.deepEqual(encodeMarks(combining, [[2, 3, STRIKE]], sha16).r, [[2, 3, STRIKE]]);
});

test('code points: the hash is of the UTF-8 text with the astral characters in it', () => {
    const text = 'x😀y';
    const stored = encodeMarks(text, [[1, 2, BOLD]], sha16);
    assert.equal(stored.h, crypto.createHash('sha256').update(Buffer.from([0x78, 0xf0, 0x9f, 0x98, 0x80, 0x79])).digest('hex').slice(0, 16));
});

test('normalize: sorted, merged, overlapping flags OR-ed, bad entries dropped, argument unchanged', () => {
    const input = deepFreeze([[6, 9, ITALIC], [0, 3, BOLD], [3, 5, BOLD], [2, 7, UNDERLINE], [4, 4, BOLD], [-1, 3, BOLD], [1, 2, 99], null, 'x', [1, 2], [0.5, 2, 1]]);
    assert.deepEqual(normalizeRanges(input), [[0, 2, 1], [2, 5, 5], [5, 6, 4], [6, 7, 6], [7, 9, 2]]);
    assert.deepEqual(normalizeRanges([]), []);
    for (const bad of [null, undefined, 5, 'abc', {}, {length: 2, 0: [0, 1, 1]}])
        assert.deepEqual(normalizeRanges(bad), [], String(bad));
});

test('normalize: touching ranges with equal flags merge, touching ranges with other flags stay apart', () => {
    assert.deepEqual(normalizeRanges([[0, 2, 1], [2, 4, 1]]), [[0, 4, 1]]);
    assert.deepEqual(normalizeRanges([[0, 2, 1], [2, 4, 2]]), [[0, 2, 1], [2, 4, 2]]);
    assert.deepEqual(normalizeRanges([[0, 2, 1], [3, 4, 1]]), [[0, 2, 1], [3, 4, 1]]);
    assert.deepEqual(normalizeRanges([[0, 4, 1], [1, 3, 1]]), [[0, 4, 1]]);
    assert.deepEqual(normalizeRanges([[0, 4, 3], [2, 6, 1]]), [[0, 4, 3], [4, 6, 1]]);
});

test('model: normalize, flagsAt and toggleFlag agree with the one-number-per-code-point model on random input', () => {
    const n = 14;
    for (let i = 0; i < 4000; i++) {
        const ranges = randomRanges(n, rnd(6));
        const model = modelOf(ranges, n);
        const frozen = deepFreeze(clone(ranges));
        assert.deepEqual(normalizeRanges(frozen), rangesOf(model), JSON.stringify(ranges));
        assert.deepEqual(normalizeRanges(normalizeRanges(frozen)), normalizeRanges(frozen), 'idempotent');
        const s = rnd(n);
        const e = s + 1 + rnd(n - s);
        const sel = model.slice(s, e);
        assert.deepEqual(flagsAt(frozen, s, e), {all: sel.reduce((a, f) => a & f, 15), any: sel.reduce((a, f) => a | f, 0)},
            `${JSON.stringify(ranges)} ${s}-${e}`);
        const flag = [1, 2, 4, 8][rnd(4)];
        const everyone = sel.every(f => (f & flag) !== 0);
        const after = model.map((f, k) => (k < s || k >= e ? f : (everyone ? f & ~flag : f | flag)));
        assert.deepEqual(toggleFlag(frozen, s, e, flag), rangesOf(after), `${JSON.stringify(ranges)} ${s}-${e} flag ${flag}`);
    }
});

test('toggle: all of the selection has the flag -> remove, otherwise add; twice is the identity; not a toggle of the whole note', () => {
    assert.deepEqual(toggleFlag([], 2, 5, BOLD), [[2, 5, 1]]);
    assert.deepEqual(toggleFlag([[2, 5, BOLD]], 2, 5, BOLD), []);
    assert.deepEqual(toggleFlag([[2, 5, BOLD]], 3, 4, BOLD), [[2, 3, 1], [4, 5, 1]]);        // a part of a bold range is un-bolded
    assert.deepEqual(toggleFlag([[2, 5, BOLD]], 0, 8, BOLD), [[0, 8, 1]]);                   // not all bold -> add to all
    assert.deepEqual(toggleFlag([[2, 5, BOLD], [6, 8, BOLD]], 2, 8, BOLD), [[2, 8, 1]]);     // a gap -> not all -> add: the gap fills
    assert.deepEqual(toggleFlag([[0, 4, BOLD | ITALIC]], 1, 3, BOLD), [[0, 1, 3], [1, 3, 2], [3, 4, 3]]);
    assert.deepEqual(toggleFlag([[0, 4, BOLD]], 1, 3, ITALIC), [[0, 1, 1], [1, 3, 3], [3, 4, 1]]);
    // twice is the identity when the selection had the flag everywhere or nowhere; in the mixed case the first toggle makes it all
    const start = [[1, 4, BOLD], [6, 9, ITALIC | STRIKE]];
    for (const [s, e, f] of [[1, 4, BOLD], [2, 3, BOLD], [6, 9, STRIKE], [0, 1, ITALIC], [4, 6, BOLD], [9, 12, STRIKE], [0, 10, UNDERLINE]]) {
        const had = flagsAt(start, s, e);
        assert.ok((had.all & f) !== 0 || (had.any & f) === 0, `${s}-${e} ${f} is not a mixed case`);
        assert.deepEqual(toggleFlag(toggleFlag(start, s, e, f), s, e, f), normalizeRanges(start), `${s}-${e} ${f}`);
    }
    assert.deepEqual(toggleFlag(start, 0, 10, BOLD), [[0, 6, 1], [6, 9, 11], [9, 10, 1]]);   // mixed: all get it
    assert.deepEqual(toggleFlag(toggleFlag(start, 0, 10, BOLD), 0, 10, BOLD), [[6, 9, 10]]);                                   // then all lose it
});

test('toggle: a bad selection or flag leaves the (normalized) ranges as they are; the argument is not changed', () => {
    const r = deepFreeze([[3, 5, BOLD], [0, 2, ITALIC]]);
    const want = [[0, 2, 2], [3, 5, 1]];
    for (const args of [[3, 3, BOLD], [5, 3, BOLD], [-1, 3, BOLD], [0.5, 3, BOLD], ['0', '3', BOLD], [NaN, 3, BOLD], [0, Infinity, BOLD],
        [0, 3, 0], [0, 3, 3], [0, 3, 16], [0, 3, '1'], [0, 3, undefined], [undefined, undefined, undefined]])
        assert.deepEqual(toggleFlag(r, ...args), want, JSON.stringify(args));
    assert.deepEqual(toggleFlag(null, 0, 2, BOLD), [[0, 2, 1]]);
});

test('flagsAt: all and any, a gap or the outside of the ranges counts as no flags, a bad selection is nothing', () => {
    const r = [[0, 4, BOLD | ITALIC], [4, 8, BOLD]];
    assert.deepEqual(flagsAt(r, 0, 8), {all: 1, any: 3});
    assert.deepEqual(flagsAt(r, 0, 4), {all: 3, any: 3});
    assert.deepEqual(flagsAt(r, 3, 5), {all: 1, any: 3});
    assert.deepEqual(flagsAt(r, 7, 9), {all: 0, any: 1});          // 8 is past the last range
    assert.deepEqual(flagsAt(r, 9, 12), {all: 0, any: 0});
    assert.deepEqual(flagsAt([[0, 2, BOLD], [4, 6, BOLD]], 0, 6), {all: 0, any: 1});
    assert.deepEqual(flagsAt([[0, 2, BOLD], [4, 6, BOLD]], 1, 2), {all: 1, any: 1});
    for (const args of [[3, 3], [4, 3], [-1, 3], [0.5, 2], ['0', '2'], [NaN, 2], [undefined, undefined]])
        assert.deepEqual(flagsAt(r, ...args), {all: 0, any: 0}, JSON.stringify(args));
    assert.deepEqual(flagsAt(undefined, 0, 2), {all: 0, any: 0});
});

test('purity: no function changes its arguments (frozen input), and the results do not share arrays with the input', () => {
    const r = deepFreeze([[0, 2, BOLD], [4, 6, ITALIC]]);
    for (const out of [normalizeRanges(r), toggleFlag(r, 0, 1, ITALIC), encodeMarks('abcdefgh', r, sha16).r])
        for (const row of out)
            assert.ok(!r.includes(row));
    const extra = deepFreeze({marks: {h: sha16('abcdefgh'), r: [[0, 2, 1]]}});
    assert.doesNotThrow(() => decodeMarks('abcdefgh', extra, sha16));
});

test('app/marks.js has no import at all (no Gtk, Gio, GLib, no node module): the hash is a parameter', () => {
    const src = fs.readFileSync(new URL('../app/marks.js', import.meta.url), 'utf8');
    assert.equal(/^\s*import\b|\bimport\s*\(|\brequire\s*\(|gi:\/\/|imports\.gi|resource:\/\//m.test(src), false);
    assert.equal(/\bcrypto\b|GLib|Gio\b|Gtk\b/.test(src.replace(/^\s*\/\/.*$/gm, '')), false);
});
