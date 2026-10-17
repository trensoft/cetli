// SPDX-License-Identifier: GPL-3.0-or-later
// Base colour of a new note (src/colors.js, Store.createNote): a random one of the six named menu colours that no live note uses
// yet; all used -> one of all. Custom colours, the legacy names (orange, mint, peach), unknown strings and deleted notes occupy nothing. The random source is the
// injected platform's `randomBytes`; here it is scripted, so every result is deterministic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {NOTE_COLOR_IDS, pickNoteColor, randomIndex} from '../src/colors.js';
import {makeEnv, rec, uuid} from './support/helpers.js';

const IDS = ['yellow', 'pink', 'green', 'purple', 'blue', 'gray'];
const LEGACY = ['orange', 'mint', 'peach'];

// randomBytes(4) that returns the scripted unsigned 32-bit values one by one (big endian); the last one repeats.
const script = values => {
    const q = [...values];
    const calls = {n: 0};
    const fn = len => {
        assert.equal(len, 4);
        calls.n++;
        const u = q.length > 1 ? q.shift() : q[0];
        return Uint8Array.from([(u >>> 24) & 255, (u >>> 16) & 255, (u >>> 8) & 255, u & 255]);
    };
    fn.calls = calls;
    return fn;
};

const withEnv = fn => async () => {
    const env = makeEnv({});
    try {
        await env.start();
        await fn(env);
    } finally {
        env.cleanup();
    }
};

test('colours: the six are exactly yellow, pink, green, purple, blue, gray (orange, mint, peach are not drawn)', () => {
    assert.deepEqual([...NOTE_COLOR_IDS], IDS);
    assert.ok(Object.isFrozen(NOTE_COLOR_IDS));
    for (const old of LEGACY)
        assert.equal(NOTE_COLOR_IDS.includes(old), false, old);
});

test('colours: randomIndex maps a draw to [0, n) and rejects the biased tail (no modulo bias)', () => {
    assert.equal(randomIndex(script([0]), 8), 0);
    assert.equal(randomIndex(script([7]), 8), 7);
    assert.equal(randomIndex(script([13]), 8), 5);
    // n = 3: 2^32 mod 3 = 1, so the draw 0xFFFFFFFF is outside the unbiased range and is drawn again
    const s = script([0xffffffff, 4]);
    assert.equal(randomIndex(s, 3), 1);                  // 0xffffffff rejected, then 4 % 3
    assert.equal(s.calls.n, 2);
    assert.equal(randomIndex(script([0xfffffffe]), 3), 2);   // the last accepted value
    assert.throws(() => randomIndex(script([0]), 0), RangeError);
});

test('colours: a source that is always rejected ends after 64 draws (no endless loop)', () => {
    const s = script([0xffffffff]);
    const r = randomIndex(s, 3);
    assert.ok(r >= 0 && r < 3);
    assert.equal(s.calls.n, 64);
});

test('colours: only colours that no live note uses are drawn, and every free colour can be drawn', () => {
    const used = ['yellow', 'green', 'blue'];
    const free = IDS.filter(c => !used.includes(c));
    assert.deepEqual(free, ['pink', 'purple', 'gray']);
    const got = free.map((_, k) => pickNoteColor(used, script([k])));
    assert.deepEqual(got, free);
    for (let u = 0; u < 40; u++)
        assert.ok(free.includes(pickNoteColor(used, script([u]))), `draw ${u}`);
});

test('colours: when all 6 are used the draw is over all 6 again', () => {
    const got = IDS.map((_, k) => pickNoteColor(IDS, script([k])));
    assert.deepEqual(got, IDS);
    assert.equal(pickNoteColor([...IDS, ...IDS], script([3])), 'purple');
});

test('colours: gray is a candidate like the others (it is used by a note -> not drawn while another is free)', () => {
    const used = IDS.filter(c => c !== 'blue');
    for (let u = 0; u < 20; u++)
        assert.equal(pickNoteColor(used, script([u])), 'blue');
});

test('colours: a custom colour, a legacy name and an unknown string occupy nothing', () => {
    const used = [...IDS.filter(c => c !== 'green'), '#aabbcc', ...LEGACY, 'no-such-colour', '', '#AABBCC'];
    for (let u = 0; u < 20; u++)
        assert.equal(pickNoteColor(used, script([u])), 'green');
    // they do not take a slot either when nothing else is used
    assert.deepEqual(IDS.map((_, k) => pickNoteColor(['#aabbcc', ...LEGACY, 'zzz'], script([k]))), IDS);
});

test('colours: createNote without a colour lets the core pick; 6 notes get 6 different colours, the 7th starts over', withEnv(async env => {
    const draws = script([0]);                           // always the first free colour
    env.platform.randomBytes = draws;
    const seen = [];
    for (let i = 0; i < 6; i++) {
        const r = await env.store.createNote({text: `n${i}`});
        assert.equal(r.ok, true);
        seen.push(r.record.color);
    }
    assert.deepEqual(seen, IDS);
    env.platform.randomBytes = script([3]);
    const seventh = await env.store.createNote({text: 'n7'});
    assert.equal(seventh.record.color, 'purple');        // all 6 used: index 3 of ALL
}));

test('colours: a deleted note no longer occupies its colour', withEnv(async env => {
    env.platform.randomBytes = script([0]);
    const a = (await env.store.createNote({text: 'a'})).record;
    assert.equal(a.color, 'yellow');
    const b = (await env.store.createNote({text: 'b'})).record;
    assert.equal(b.color, 'pink');
    assert.equal((await env.store.deleteNote(a.id, a)).ok, true);
    const c = (await env.store.createNote({text: 'c'})).record;
    assert.equal(c.color, 'yellow');                     // the first free again, because a is deleted
}));

test('colours: a note that arrives from another device occupies its colour; one with a custom colour does not', withEnv(async env => {
    env.putRec(`${uuid(7)}.json`, rec({id: uuid(7), color: 'yellow'}));
    env.putRec(`${uuid(8)}.json`, rec({id: uuid(8), color: '#123456'}));
    await env.store.refresh();
    env.platform.randomBytes = script([0]);
    const r = (await env.store.createNote({text: 'x'})).record;
    assert.equal(r.color, 'pink');
}));

test('colours: an explicit colour is kept as given (a legacy name, custom) and does not use the random source', withEnv(async env => {
    const s = script([0]);
    env.platform.randomBytes = s;
    const g = (await env.store.createNote({text: 'g', color: 'peach'})).record;
    const c = (await env.store.createNote({text: 'c', color: '#0a0b0c'})).record;
    assert.equal(g.color, 'peach');
    assert.equal(c.color, '#0a0b0c');
    assert.equal(s.calls.n, 0);
    assert.equal(fs.readFileSync(`${env.dirs.notes}/${c.id}.json`, 'utf8').includes('"#0a0b0c"'), true);
}));

test('colours: the picker has no ambient random source (the platform is the only one)', () => {
    const src = fs.readFileSync(new URL('../src/colors.js', import.meta.url), 'utf8');
    assert.equal(/Math\.random|crypto|Date\.now/.test(src), false);
});
