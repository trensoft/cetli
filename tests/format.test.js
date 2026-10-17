// SPDX-License-Identifier: GPL-3.0-or-later
// PLAN.md section 1: names, validation V1-V11, canonical form, version identity, cid, order.
import test from 'node:test';
import assert from 'node:assert/strict';

import {NAME_CONFLICT, NAME_MAIN, UUID_RE, ST} from '../src/constants.js';
import {entryProblem, parseUpdated} from '../src/format.js';
import {DEV_A, DEV_B, T0, at, enc, fmt, jsonBytes, raw, rec, uuid} from './support/helpers.js';

const X = uuid(1);
const cls = (obj, id = X, now = T0) => fmt.classify(typeof obj === 'string' ? enc(obj) : obj instanceof Uint8Array ? obj : jsonBytes(obj), id, now);
const state = (obj, id) => cls(obj, id).state;

test('[P2-T1] name patterns: a trailing newline, NUL, a leading newline, upper-case hex, a non-ASCII digit are no candidates', () => {
    const U = '3f0c9a52-8d41-4b6e-a7c3-1e5b92d0f4a8';
    assert.ok(NAME_MAIN.test(`${U}.json`));
    assert.ok(NAME_CONFLICT.test(`${U}.sync-conflict-20261016-202144-ABCDEFG.json`));
    for (const bad of [`${U}.json\n`, `${U}.json\0`, `\n${U}.json`, `${U.toUpperCase()}.json`, ` ${U}.json`, `${U}.JSON`, `${U}.json.bak`]) {
        assert.equal(NAME_MAIN.test(bad), false, JSON.stringify(bad));
        assert.equal(NAME_CONFLICT.test(bad), false, JSON.stringify(bad));
    }
    const c = d => `${U}.sync-conflict-${d}-202144-ABCDEFG.json`;
    assert.equal(NAME_CONFLICT.test(c('20261016')), true);
    assert.equal(NAME_CONFLICT.test(c('2026101٦')), false, 'Arabic-indic digit in the date part');
    assert.equal(NAME_CONFLICT.test(c('２０２６1016')), false, 'full-width digits');
    assert.equal(NAME_CONFLICT.test(`${U}.sync-conflict-20261016-202144-ABCDEFG.json\n`), false);
    assert.equal(NAME_CONFLICT.test(`${U}.sync-conflict-20261016-202144-.json`), false, 'modifiedBy part is required (2.1)');
    assert.equal(NAME_CONFLICT.test(`${U}.sync-conflict-20261016-202144-${'A'.repeat(17)}.json`), false);
    assert.equal(UUID_RE.test(`${U}\n`), false);
});

test('V1: only a regular file of at most 256 KiB passes, decided from the entry (before it is opened)', () => {
    assert.equal(entryProblem('regular', 0), null);
    assert.equal(entryProblem('regular', 262144), null);
    assert.match(entryProblem('regular', 262145), /size/);
    for (const t of ['symlink', 'directory', 'special', 'unknown'])
        assert.match(entryProblem(t, 10), /not a regular file/);
    assert.equal(cls(new Uint8Array(262145).fill(32)).state, ST.UNKNOWN, 'content longer than 256 KiB is refused after the read too');
});

test('V2: UTF-8 and a JSON object', () => {
    const good = raw();
    assert.equal(state(good), ST.VALID);
    assert.equal(state(Uint8Array.from([0x7b, 0xff, 0xfe, 0x7d])), ST.UNKNOWN, 'invalid UTF-8');
    assert.equal(state(Uint8Array.from([0xef, 0xbb, 0xbf, ...enc(JSON.stringify(good))])), ST.UNKNOWN, 'a BOM is not repaired');
    for (const s of ['', '[]', 'null', '7', '"x"', '{', '{"a":1}garbage'])
        assert.equal(state(s), ST.UNKNOWN, s);
    // the id rule of V4 uses the name, a missing field is not a valid record
    assert.equal(state({...good, text: undefined}), ST.UNKNOWN);
});

test('V3: schema must be the integer 1; a higher integer is NEWER and its other fields are not checked', () => {
    assert.equal(state(raw({schema: 1})), ST.VALID);
    assert.equal(state({...raw(), schema: 1.5}), ST.UNKNOWN);
    assert.equal(state({...raw(), schema: '1'}), ST.UNKNOWN);
    assert.equal(state({...raw(), schema: 0}), ST.UNKNOWN);
    assert.equal(state({...raw(), schema: true}), ST.UNKNOWN);
    const newer = cls({schema: 2, anything: [1, 2], text: 'from the future'});
    assert.equal(newer.state, ST.NEWER);
    assert.equal(newer.shownText, 'from the future');
    assert.equal(cls({schema: 2, text: 5}).shownText, null);
    assert.equal(cls({schema: 2, text: 'x'.repeat(65537)}).shownText, null);
    assert.equal(cls({schema: 2, text: 'x'.repeat(65536)}).shownText.length, 65536);
    assert.equal(cls({schema: 2, text: 'é'.repeat(32769)}).shownText, null, 'bytes, not characters');
    assert.equal(cls({schema: 1e30}).state, ST.NEWER);
    assert.equal(cls('{"schema":1e999}').state, ST.UNKNOWN);
});

test('V4: id is a lower-case UUID equal to the UUID of the file name', () => {
    assert.equal(state(raw({id: uuid(2)}), X), ST.UNKNOWN);
    assert.equal(state(raw({id: '../../.config/x'}), '../../.config/x'), ST.UNKNOWN);
    const L = 'abcdef01-2345-4678-89ab-cdef01234567';
    assert.equal(state(raw({id: L}), L), ST.VALID);
    assert.equal(state(raw({id: L.toUpperCase()}), L.toUpperCase()), ST.UNKNOWN);
    assert.equal(state(raw({id: L.toUpperCase()}), L), ST.UNKNOWN);
    assert.equal(state(raw({id: `${L}\n`}), `${L}\n`), ST.UNKNOWN);
    assert.equal(state(raw({id: 5})), ST.UNKNOWN);
});

test('V5: rev is an integer from 1 to 1000000000', () => {
    for (const ok of [1, 7, 1000000000])
        assert.equal(state(raw({rev: ok})), ST.VALID, String(ok));
    for (const bad of [0, -1, 1000000001, 1.5, '7', null, true])
        assert.equal(state(raw({rev: bad})), ST.UNKNOWN, String(bad));
    assert.equal(cls(JSON.stringify(raw()).replace('"rev":1', '"rev":7.0')).state, ST.VALID, '7.0 is the integer 7');
    assert.equal(cls(JSON.stringify(raw()).replace('"rev":1', '"rev":1e999')).state, ST.UNKNOWN);
});

test('V6: strict dates, year 2000 to 2100, real dates only; a date more than 24 h ahead is QUARANTINED', () => {
    const s = d => state(raw({updated: d}));
    assert.equal(s('2026-10-17T10:00:00.000Z'), ST.VALID);
    assert.equal(s('2000-01-01T00:00:00.000Z'), ST.VALID);
    assert.equal(parseUpdated('2100-12-31T23:59:59.999Z') !== null, true);
    for (const bad of ['1999-12-31T23:59:59.999Z', '2101-01-01T00:00:00.000Z', '2026-02-30T10:00:00.000Z', '2026-13-01T10:00:00.000Z',
        '2026-10-17T24:00:00.000Z', '2026-10-17T10:00:00Z', '2026-10-17 10:00:00.000Z', '2026-10-17T10:00:00.000+00:00',
        '2026-10-17T10:00:00.000Z\n', '٢٠٢٦-10-17T10:00:00.000Z', '2026-10-17T23:59:60.000Z', 5, null])
        assert.equal(s(bad), ST.UNKNOWN, String(bad));
    assert.equal(state(raw({created: 'nope'})), ST.UNKNOWN);
    const limit = new Date(T0 + 24 * 3600 * 1000).toISOString();
    assert.equal(s(limit), ST.VALID, 'exactly 24 h ahead is still accepted');
    const future = new Date(T0 + 24 * 3600 * 1000 + 1).toISOString();
    const q = cls(raw({updated: future}));
    assert.equal(q.state, ST.QUARANTINED);
    assert.equal(q.until, T0 + 1, 'valid again from this instant');
    assert.ok(q.rec, 'the parsed record is kept so that the quarantine can end without a re-read');
    // a quarantined-looking record that breaks another rule is UNKNOWN, not quarantined
    assert.equal(state(raw({updated: future, device: 'xx'})), ST.UNKNOWN);
});

test('V7, V8, V9: device, color, text bytes, deleted, conflict_of', () => {
    assert.equal(state(raw({device: 'a1b2c3d'})), ST.UNKNOWN);
    assert.equal(state(raw({device: 'A1B2C3D4'})), ST.UNKNOWN);
    assert.equal(state(raw({device: 'a1b2c3d4e'})), ST.UNKNOWN);
    const c = cls(raw({color: 'chartreuse'}));
    assert.equal(c.state, ST.VALID, 'an unknown colour is kept');
    assert.equal(c.rec.color, 'chartreuse');
    assert.equal(state(raw({color: 3})), ST.UNKNOWN);
    assert.equal(state(raw({text: 'x'.repeat(65536)})), ST.VALID);
    assert.equal(state(raw({text: 'x'.repeat(65537)})), ST.UNKNOWN);
    assert.equal(state(raw({text: 'é'.repeat(32768)})), ST.VALID, '65536 bytes');
    assert.equal(state(raw({text: `${'é'.repeat(32768)}x`})), ST.UNKNOWN, '65537 bytes');
    assert.equal(state(raw({text: null})), ST.UNKNOWN);
    assert.equal(state(raw({deleted: 'false'})), ST.UNKNOWN);
    assert.equal(state(raw({deleted: 0})), ST.UNKNOWN);
    assert.equal(state(raw({conflict_of: uuid(9)})), ST.VALID);
    assert.equal(state(raw({conflict_of: 'nope'})), ST.UNKNOWN);
    assert.equal(state(raw({conflict_of: undefined})), ST.UNKNOWN, 'conflict_of must be present');
});

test('V10: unknown keys: pattern, count, depth, Map container, __proto__ is a legal key', () => {
    assert.equal(state(raw({extra_1: 1, a: [1], b_c: {d: null}})), ST.VALID);
    for (const k of ['Upper', 'has-dash', 'x'.repeat(33), '', 'ü', 'a b', 'line\n'])
        assert.equal(state({...raw(), [k]: 1}), ST.UNKNOWN, JSON.stringify(k));
    const many = n => Object.fromEntries(Array.from({length: n}, (_, i) => [`k${i}`, i]));
    assert.equal(state({...raw(), ...many(16)}), ST.VALID);
    assert.equal(state({...raw(), ...many(17)}), ST.UNKNOWN);

    const nest = n => '['.repeat(n) + ']'.repeat(n);
    const withValue = v => JSON.stringify(raw()).slice(0, -1) + `,"deep":${v}}`;
    assert.equal(cls(withValue(nest(8))).state, ST.VALID, 'depth 8');
    assert.equal(cls(withValue(nest(9))).state, ST.UNKNOWN, 'depth 9');
    assert.equal(cls(withValue(`{"a":${nest(7)}}`)).state, ST.VALID, 'object + 7 arrays = 8');
    assert.equal(cls(withValue(`{"a":${nest(8)}}`)).state, ST.UNKNOWN, 'arrays and objects are counted together');

    const proto = withValue('{"x":1}').replace('"deep"', '"__proto__"');
    const p = cls(proto);
    assert.equal(p.state, ST.VALID);
    assert.ok(p.rec.extra.has('__proto__'), 'kept like any other key');
    assert.match(p.rec.canon, /,"__proto__":\{"x":1\}\}\n$/);
    assert.equal(({}).x, undefined, 'the prototype was not touched');
    assert.notEqual(p.rec.v, cls(raw()).rec.v);
    for (const k of ['constructor', 'prototype'])
        assert.equal(cls(withValue('1').replace('"deep"', `"${k}"`)).state, ST.VALID, k);
});

test('[P2-T3] V10/1.3: a 200 KB deep value is rejected after 9 levels and no exception reaches the caller', () => {
    const deep = 100000;
    const text = JSON.stringify(raw()).slice(0, -1) + `,"deep":${'['.repeat(deep)}${']'.repeat(deep)}}`;
    assert.ok(text.length > 200000 && text.length <= 262144);
    let c;
    assert.doesNotThrow(() => { c = cls(text); });
    assert.equal(c.state, ST.UNKNOWN);
    assert.equal(c.reason, 'V10 depth');
    // the same input in the object form
    const deepObj = `${'{"a":'.repeat(40000)}1${'}'.repeat(40000)}`;
    assert.equal(cls(JSON.stringify(raw()).slice(0, -1) + `,"deep":${deepObj}}`).state, ST.UNKNOWN);
});

test('[P2-T3] 1.3: ANY exception inside canon / V makes the record UNKNOWN', () => {
    const orig = JSON.stringify;
    try {
        JSON.stringify = (v, ...rest) => {
            if (v === 'BOOM')
                throw new RangeError('Maximum call stack size exceeded');
            return orig(v, ...rest);
        };
        let c;
        assert.doesNotThrow(() => { c = cls(raw({text: 'BOOM'})); });
        assert.equal(c.state, ST.UNKNOWN);
        assert.match(c.reason, /RangeError/);
    } finally {
        JSON.stringify = orig;
    }
});

test('V10: the double round trip is stable and V is taken over it', () => {
    const base = JSON.stringify(raw()).slice(0, -1);
    const pairs = [['1e999', 'null'], ['12345678901234567890', '12345678901234567000'], ['-0', '0'], ['1e21', '1e+21'],
        ['1.0', '1'], ['1E3', '1000'], ['0.1e1', '1'], ['1e-7', '1e-7']];
    for (const [src, want] of pairs) {
        const c = cls(`${base},"num":${src}}`);
        assert.equal(c.state, ST.VALID, src);
        assert.match(c.rec.canon, new RegExp(`,"num":${want.replace('+', '\\+')}\\}\\n$`), src);
        const again = cls(c.rec.bytes);
        assert.equal(again.rec.canon, c.rec.canon, `canon(parse(canon)) = canon for ${src}`);
        assert.equal(again.rec.v, c.rec.v);
    }
    assert.equal(cls(`${base},"num":1.0}`).rec.v, cls(`${base},"num":1}`).rec.v, 'same version');
});

test('1.3: canon has the fixed key order, unknown keys by code point, one newline; V ignores formatting', () => {
    const r = cls(JSON.stringify({z_last: 1, ...raw(), a_first: [1, {b: 2}]}, null, 3)).rec;
    assert.equal(r.canon, '{"schema":1,"id":"' + X + '","rev":1,"updated":"' + at(120) + '","created":"' + at(180) +
        '","device":"a1b2c3d4","color":"yellow","text":"milk, bread","deleted":false,"conflict_of":null,"a_first":[1,{"b":2}],"z_last":1}\n');
    const shuffled = cls(JSON.stringify({a_first: [1, {b: 2}], conflict_of: null, text: 'milk, bread', z_last: 1, ...raw()})).rec;
    assert.equal(shuffled.v, r.v);
    assert.deepEqual(Array.from(r.bytes), Array.from(enc(r.canon)));
    const other = cls(raw({text: 'milk, bread, x'})).rec;
    assert.notEqual(other.v, r.v);
    assert.equal(r.v.length, 64);
});

test('[P2-T11] V11: the size is measured on the form that a COPY would have (canonE)', () => {
    const MAX = 262144;
    const padded = (padLen, over = {}) => {
        const r = rec({...over, extra: {pad: 'a'.repeat(padLen)}});
        return r;
    };
    // find the pad length that gives an exact canon length
    const forCanon = (target, over = {}) => {
        let n = target - padded(0, over).bytes.length;
        const r = padded(n, over);
        assert.equal(r.bytes.length, target);
        return r;
    };
    const ok = forCanon(262110);
    assert.equal(ok.conflict_of, null);
    assert.equal(fmt.canonESize(ok), MAX, 'E(L) is exactly 262144');
    assert.equal(cls(ok.bytes).state, ST.VALID, 'canon 262110 with conflict_of null is valid');
    const copy = fmt.expectedCopy(ok, X);
    assert.equal(copy.bytes.length, MAX);
    assert.equal(cls(copy.bytes, copy.id).state, ST.VALID, 'the copy itself is a valid record');

    const bad = forCanon(262111);
    assert.equal(fmt.canonESize(bad), MAX + 1);
    assert.equal(cls(bad.bytes).state, ST.UNKNOWN, 'canon 262111 with conflict_of null is UNKNOWN');
    assert.match(cls(bad.bytes).reason, /V11/);

    const withUuid = forCanon(262144, {conflict_of: uuid(7)});
    assert.equal(fmt.canonESize(withUuid), MAX, 'a record with a UUID in conflict_of is measured as it is');
    assert.equal(cls(withUuid.bytes).state, ST.VALID);
    assert.equal(cls(forCanon(262145, {conflict_of: uuid(7)}).bytes).state, ST.UNKNOWN, 'and fails over the limit');
});

test('[P2-T11] V11: 1e21 numbers make canon larger than the file: the file passes V1 and fails V11', () => {
    const head = JSON.stringify(raw()).slice(0, -1);
    let src = `${head},"nums":[`;
    while (src.length + 6 <= 262000)
        src += '1e21,';
    src += '1]}';
    assert.ok(src.length > 261900 && src.length <= 262144, `source ${src.length} bytes passes V1`);
    const c = cls(src);
    assert.equal(c.state, ST.UNKNOWN);
    assert.match(c.reason, /V11/);
    // the same shape with few numbers is valid, and its canon is longer than the source
    const small = cls(`${head},"nums":[1e21,1e21]}`);
    assert.equal(small.state, ST.VALID);
    assert.equal(small.rec.bytes.length, enc(`${head},"nums":[1e21,1e21]}\n`).length + 2);
});

test('2.2 step 2: cid(L) test vector of the plan, and it depends only on (X, V(L))', () => {
    const X0 = '3f0c9a52-8d41-4b6e-a7c3-1e5b92d0f4a8';
    const V0 = '50d858e0985ecc7f60418aaf0cc5ab587f42c2570a884095a9e8ccacd0f6545c';
    assert.equal(fmt.cid(X0, V0), 'b544623d-3598-52d5-999c-8c50a9c01766');
    assert.match(fmt.cid(X0, V0), UUID_RE);
    assert.notEqual(fmt.cid(X0, V0), fmt.cid(uuid(5), V0));
    assert.notEqual(fmt.cid(X0, V0), fmt.cid(X0, V0.replace(/^./, '0')));
});

test('2.1: order of distinct versions: updated, then rev, then device, then V; total', () => {
    const t = (updated, rev, device, text = 'x') => rec({updated, rev, device, text});
    const a = t(at(10), 1, DEV_A);
    assert.ok(fmt.compare(t(at(5), 1, DEV_A), a) > 0, 'later updated wins');
    assert.ok(fmt.compare(t(at(10), 2, DEV_A), a) > 0, 'then rev');
    assert.ok(fmt.compare(t(at(10), 1, DEV_B), a) > 0, 'then device');
    const c1 = t(at(10), 1, DEV_A, 'c1');
    const c2 = t(at(10), 1, DEV_A, 'c2');
    assert.equal(Math.sign(fmt.compare(c1, c2)), c1.v < c2.v ? -1 : 1, 'then V');
    assert.equal(fmt.compare(c1, c1), 0);
    assert.equal(fmt.compare(a, t(at(5), 1, DEV_A)), -fmt.compare(t(at(5), 1, DEV_A), a));
});
