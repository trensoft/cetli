// SPDX-License-Identifier: GPL-3.0-or-later
// sync/policy.js (the knobs of the group rule) and sync/state.js (the engine's state file).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {DWELL_MS, HARDEN_INTRODUCED, MAX_COMPUTERS, MAX_PEERS, READ_CAP, SHORTCUT_REMOVE, wantedIntroducer} from '../sync/policy.js';
import {
    ACK_MAX, FREEZE_MAX, TOMB_MAX, brokenState, freshState, isFrozen, parseState, serializeState, withAck, withFreeze, withTomb, withoutFreeze,
} from '../sync/state.js';
import {makeId} from './support/ids.js';

test('policy: 10 computers are 9 peers, the cap of the device list sits above the limit, the number lives once (T-N1, T-N26)', () => {
    assert.equal(MAX_COMPUTERS, 10);
    assert.equal(MAX_PEERS, 9);
    assert.equal(READ_CAP, 16);
    assert.ok(READ_CAP > MAX_COMPUTERS);
    assert.ok(DWELL_MS > 0);
    for (const f of readdirSync(new URL('../sync/', import.meta.url)).filter(n => n.endsWith('.js'))) {
        const text = readFileSync(new URL(`../sync/${f}`, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
        const defines = text.match(/export const (MAX_PEERS|MAX_COMPUTERS|READ_CAP)\b/g) ?? [];
        assert.equal(defines.length, f === 'policy.js' ? 3 : 0, f);
    }
});

test('policy: both switches are off until John has measured them (M-J5, M-J1)', () => {
    assert.equal(HARDEN_INTRODUCED, false);
    assert.equal(SHORTCUT_REMOVE, false);
});

test('wantedIntroducer: a directly accepted device is an introducer; an introduced one is none exactly when the hardening is on (T-N19)', () => {
    const direct = {introducedBy: ''};
    const introduced = {introducedBy: makeId(1)};
    for (const harden of [true, false]) {
        assert.equal(wantedIntroducer(direct, harden), true, `direct, harden ${harden}`);
        assert.equal(wantedIntroducer(introduced, harden), !harden, `introduced, harden ${harden}`);
    }
    assert.equal(wantedIntroducer(introduced), !HARDEN_INTRODUCED);                  // the default is the policy value
});

test('state: a fresh state serialises and reads back identically; the file is one JSON line', () => {
    const text = serializeState(freshState());
    assert.equal(text.endsWith('\n'), true);
    assert.equal(text.trim().includes('\n'), false);
    assert.deepEqual(parseState(text), {ok: true, state: freshState()});
    const s = withFreeze(withTomb(withAck(freshState(), [makeId(1), makeId(2)]), [makeId(3)]), [makeId(1)]);
    assert.deepEqual(parseState(serializeState(s)), {ok: true, state: s});
    assert.equal(isFrozen(s), true);
    assert.equal(isFrozen(withoutFreeze(s)), false);
    assert.equal(isFrozen(freshState()), false);
});

test('state: only IDs and counters; names, paths and times have no place in the file', () => {
    const s = withFreeze(withTomb(withAck(freshState(), [makeId(1)]), [makeId(3)]), [makeId(2)]);
    const o = JSON.parse(serializeState(s));
    assert.deepEqual(Object.keys(o).sort(), ['ack', 'freeze', 'tomb', 'v']);
    assert.deepEqual(Object.keys(o.freeze), ['ids']);
    const text = JSON.stringify(o);
    assert.equal(/[a-z]{3,}-[a-z]/.test(text.replace(/"(ack|tomb|freeze|ids|v)"/g, '')), false);        // no word or path-like text beyond the keys
});

test('state: a file that does not read cleanly is refused, never taken as fresh (fail closed)', () => {
    const good = JSON.parse(serializeState(freshState()));
    const bad = [
        '', 'x', '[]', 'null', '5', '{', JSON.stringify({...good, v: 2}), JSON.stringify({...good, v: '1'}), JSON.stringify({...good, extra: 1}),
        JSON.stringify({...good, ack: 'x'}), JSON.stringify({...good, ack: ['nope']}), JSON.stringify({...good, ack: [makeId(1), makeId(1)]}),
        JSON.stringify({...good, tomb: [makeId(1).toLowerCase()]}), JSON.stringify({...good, freeze: []}), JSON.stringify({...good, freeze: {}}),
        JSON.stringify({...good, freeze: {ids: ['x']}}), JSON.stringify({...good, freeze: {ids: [], more: 1}}), JSON.stringify({...good, freeze: 5}),
        JSON.stringify({v: 1, ack: [], tomb: []}),
        JSON.stringify({...good, ack: Array.from({length: ACK_MAX + 1}, (_, i) => makeId(i))}),
        JSON.stringify({...good, tomb: Array.from({length: TOMB_MAX + 1}, (_, i) => makeId(i))}),
        JSON.stringify({...good, freeze: {ids: Array.from({length: FREEZE_MAX + 1}, (_, i) => makeId(i))}}),
    ];
    for (const text of bad)
        assert.deepEqual(parseState(text), {ok: false}, text.slice(0, 60));
    assert.equal(parseState(JSON.stringify({...good, freeze: null})).ok, true);
});

test('state: a broken file reads as an open freeze with nothing known', () => {
    const b = brokenState();
    assert.equal(isFrozen(b), true);
    assert.deepEqual([b.ack, b.tomb, b.freeze.ids], [[], [], []]);
    assert.equal(b.broken, true);
    assert.equal(parseState(serializeState(b)).ok, true);                              // `finish` rewrites it as a clean file
    assert.equal(parseState(serializeState(b)).state.broken, undefined);
});

test('state: the lists are sets with a cap; the oldest tombstone and acknowledgement fall off first', () => {
    let s = freshState();
    for (let i = 0; i < TOMB_MAX + 5; i++)
        s = withTomb(s, [makeId(i)]);
    assert.equal(s.tomb.length, TOMB_MAX);
    assert.equal(s.tomb.includes(makeId(0)), false);
    assert.equal(s.tomb.at(-1), makeId(TOMB_MAX + 4));
    s = withTomb(s, [makeId(TOMB_MAX + 4)]);                                              // the same ID again: moved to the end, not doubled
    assert.equal(s.tomb.filter(x => x === makeId(TOMB_MAX + 4)).length, 1);
    let a = freshState();
    for (let i = 0; i < ACK_MAX + 3; i++)
        a = withAck(a, [makeId(i)]);
    assert.equal(a.ack.length, ACK_MAX);
    assert.deepEqual(parseState(serializeState(a)).state, a);
    const f = withFreeze(withFreeze(freshState(), [makeId(1), makeId(2)]), [makeId(2), makeId(3)]);
    assert.deepEqual(f.freeze.ids, [makeId(1), makeId(2), makeId(3)]);                  // a second freeze adds to the first
});
