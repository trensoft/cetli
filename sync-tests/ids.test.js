// SPDX-License-Identifier: GPL-3.0-or-later
// sync/ids.js: vectors are the two real IDs of v2 4.6, the ID Syncthing printed in M-W6 log 113, and the valid ID of M-W1 log 100.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ID_ALPHABET, E_BAD_ID, E_OWN_ID, canonicalId, displayName, firstGroups, groupId, isCanonicalId, luhn32, parseTypedId,
} from '../sync/ids.js';

const REAL = [
    'F6HEWOE-4KSACQ5-5MAX7IC-HAP3EGW-AQYBTIX-V74MXIF-ZB3GZN6-4T3QYQZ',
    'VTTWEJK-SMIOBMH-3FIWS7V-JFC2CL4-FCR3BU6-PEPADRQ-EYVVD3Z-BIGMUQ5',
    'TKIBGPF-WSGKBIH-LXXRQZX-HYOCM6Y-T6IYH5B-5CNPJLR-UHMG75U-JXHXVQP',
    'IZA3FNQ-S6ZB6SZ-KJXJ4MB-KUYXPYA-MYWCRPI-TSVUXR2-CRK2SYT-YGUA6QZ',
];
const [A, B] = REAL;
const compact = id => id.replace(/-/g, '');

test('the four real IDs are accepted in canonical form', () => {
    for (const id of REAL) {
        assert.equal(canonicalId(id), id);
        assert.equal(isCanonicalId(id), true);
    }
});

test('non-canonical forms of a real ID give the canonical one: no dashes, lower case, spaces, surrounding whitespace', () => {
    assert.equal(canonicalId(compact(A)), A);
    assert.equal(canonicalId(A.toLowerCase()), A);
    assert.equal(canonicalId(A.replace(/-/g, ' ')), A);
    assert.equal(canonicalId(`  ${A}\n`), A);
    assert.equal(canonicalId(`\t${A}\r\n`), A);
    assert.equal(canonicalId(A.replace(/-/g, ' - ')), A);
});

test('every single-character change of a real ID is refused (check characters)', () => {
    for (const id of REAL) {
        const c = compact(id);
        for (let i = 0; i < c.length; i++) {
            for (const x of ID_ALPHABET) {
                if (x === c[i])
                    continue;
                const bad = c.slice(0, i) + x + c.slice(i + 1);
                assert.equal(canonicalId(bad), null, `${id} position ${i} -> ${x}`);
            }
        }
    }
});

test('the four bad variants of the M-W1 log 100 ID are refused', () => {
    assert.equal(canonicalId('IZA3FNRS6ZB6SZKJXJ4MBKUYXPYAMYWCRPITSVUXR2CRK2SYTYGUA6QZ'), null);      // first group, check digit
    assert.equal(canonicalId('IZA3FNQS6ZB6SZKJXJ4MBKUYXPYAMYWCRPITSVUXR2CRK2SYTYGUA6QA'), null);      // last character
    assert.equal(canonicalId('IZA3FNQ-S6ZB6SZ-KJXJ4MB-KUYXPYA-MYWCRPI-TSVUXR2-CRK2SYT-YGUA6Q'), null); // truncated
    assert.equal(canonicalId('IZA3FNQ-S6ZB6SZ-KJXJ4MB-KUYXPYA-MYWCRPI-TSVUXR2-CRK2SYT-YGUA6QZX'), null); // extra character
});

test('negative vectors: length, alphabet, control characters, size, look-alikes, types', () => {
    const c = compact(A);
    const bad = [
        '', ' ', '-', c.slice(0, 55), `${c}A`, c.slice(0, 27) + c.slice(28),
        c.replace('4', '0'), c.replace('4', '1'), c.replace('4', '8'), c.replace('4', '9'),      // 0 1 8 9 are not in the alphabet
        `${c.slice(0, 20)}\0${c.slice(20)}`, `${c.slice(0, 20)}\n${c.slice(20)}`, `${c.slice(0, 20)}\t${c.slice(20)}`,
        `${c.slice(0, 20)} ${c.slice(20)}`, `${c.slice(0, 20)}‐${c.slice(20)}`,
        c.replace('F', 'Ｆ'), c.replace('E', 'Е'), c.replace('S', 'ſ'), c.replace('S', 'ß'),   // full width, Cyrillic, long s, sharp s
        'A'.repeat(5000), ` ${A}`.padEnd(101, ' '), `${A}${' '.repeat(40)}`,
    ];
    for (const v of bad)
        assert.equal(canonicalId(v), null, JSON.stringify(v).slice(0, 80));
    for (const v of [null, undefined, 5, {}, [], [A], true])
        assert.equal(canonicalId(v), null);
});

test('the field cap of 100 characters is applied to the raw string before any work', () => {
    assert.equal(canonicalId(A + ' '.repeat(100 - A.length)), A);          // exactly 100 characters
    assert.equal(canonicalId(A + ' '.repeat(101 - A.length)), null);       // 101
});

test('a leading dash is dropped, so the canonical form can never start with one', () => {
    assert.equal(canonicalId(`-${A}`), A);
    assert.equal(canonicalId(`--${compact(A)}`), A);
    for (const id of REAL)
        assert.notEqual(canonicalId(id)[0], '-');
});

test('isCanonicalId accepts only the exact canonical form with valid check characters', () => {
    assert.equal(isCanonicalId(A.toLowerCase()), false);
    assert.equal(isCanonicalId(compact(A)), false);
    assert.equal(isCanonicalId(`${A}\n`), false);
    assert.equal(isCanonicalId(`${A.slice(0, 62)}A`), false);
    assert.equal(isCanonicalId(null), false);
});

test('parseTypedId: E_BAD_ID for a malformed ID, E_OWN_ID for this computer\'s own, the canonical ID otherwise', () => {
    assert.deepEqual(parseTypedId(compact(A).slice(1), B), {ok: false, code: E_BAD_ID});
    assert.deepEqual(parseTypedId(A, A), {ok: false, code: E_OWN_ID});
    assert.deepEqual(parseTypedId(compact(A).toLowerCase(), A), {ok: false, code: E_OWN_ID});
    assert.deepEqual(parseTypedId(A, compact(A).toLowerCase()), {ok: false, code: E_OWN_ID});     // an own ID that is not in canonical form still matches
    assert.deepEqual(parseTypedId(A, 'garbage'), {ok: true, id: A});
    assert.deepEqual(parseTypedId(A, B), {ok: true, id: A});
    assert.deepEqual(parseTypedId(A, null), {ok: true, id: A});
    assert.deepEqual(parseTypedId('nonsense', A), {ok: false, code: E_BAD_ID});      // bad wins over own (nothing to compare)
});

test('luhn32 reproduces the check character of every block of the real IDs; a character outside the alphabet throws', () => {
    for (const id of REAL) {
        const c = compact(id);
        for (let i = 0; i < 4; i++)
            assert.equal(luhn32(c.slice(i * 14, i * 14 + 13)), c[i * 14 + 13]);
    }
    assert.throws(() => luhn32('A0'), RangeError);
});

test('groupId and firstGroups', () => {
    assert.equal(groupId(compact(A)), A);
    assert.equal(firstGroups(A, 1), 'F6HEWOE');
    assert.equal(firstGroups(A, 2), 'F6HEWOE-4KSACQ5');
});

test('T8 displayName: table-driven', () => {
    const rep = (ch, n) => ch.repeat(n);
    const cases = [
        [null, null], [undefined, null], [5, null], [{}, null], [[], null], ['', null],
        ['a', 'a'], [rep('a', 32), rep('a', 32)], [rep('a', 33), rep('a', 32)], [rep('a', 96), rep('a', 32)],
        [rep('a', 97), null], [rep('a', 5000), null],
        [`${rep('a', 95)}\u0007`, null], [`${rep('a', 20)}\n${rep('a', 20)}`, null], [`${rep('a', 20)}é${rep('a', 20)}`, null],
        [`${rep('a', 20)}\0${rep('a', 20)}`, null], [`${rep('a', 20)}\x7f`, null], ['😀', null],
        ['<b>x</b>', '<b>x</b>'], ['  spaced name  ', '  spaced name  '], [`${rep('b', 31)}c${rep('d', 40)}`, `${rep('b', 31)}c`],
    ];
    for (const [raw, want] of cases)
        assert.equal(displayName(raw), want, JSON.stringify(raw)?.slice(0, 60));
});

test('T8 displayName: the length gate is on the raw string before the cut (a 5000 character name is not shown as 32 characters)', () => {
    assert.equal(displayName(`${'a'.repeat(32)}${'b'.repeat(4968)}`), null);
    assert.equal(displayName('a'.repeat(96) + 'é'), null);
});

test('E_BAD_CODE and E_OWN_CODE are not produced by ids.js', async () => {
    const {readFileSync} = await import('node:fs');
    const text = readFileSync(new URL('../sync/ids.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
    assert.equal(/E_BAD_CODE|E_OWN_CODE/.test(text), false);
});

test('isCanonicalId is anchored: a prefix, a suffix, or a trailing newline makes it false', () => {
    for (const bad of [`x${A}`, `${A}x`, `${A}\n`, `\n${A}`, ` ${A}`, A.toLowerCase()])
        assert.equal(isCanonicalId(bad), false, JSON.stringify(bad));
    assert.equal(isCanonicalId(A), true);
});
