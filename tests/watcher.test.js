// SPDX-License-Identifier: GPL-3.0-or-later
// PLAN.md section 3: FileMonitor events, debounce, cost bound in batches, echo loop. Monitor and timers are injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {createWatcher} from '../src/watcher.js';
import {T0, at, conflictName, makeEnv, rec, uuid} from './support/helpers.js';

function fakeTimers() {
    let now = 0;
    let n = 0;
    const q = new Map();
    return {
        set(fn, ms) { q.set(++n, {fn, due: now + ms}); return n; },
        clear(id) { q.delete(id); },
        advance(ms) {
            now += ms;
            for (const [id, t] of [...q]) {
                if (t.due <= now) {
                    q.delete(id);
                    t.fn();
                }
            }
        },
        pending: () => q.size,
    };
}

async function setup(opts = {}) {
    const env = makeEnv({wrap: true, ...opts});
    await env.start();
    const timers = fakeTimers();
    let emit = null;
    let cancelled = false;
    const refreshes = [];
    const real = env.store.refresh.bind(env.store);
    env.store.refresh = async arg => {
        refreshes.push(arg?.hint ?? []);
        return real(arg);
    };
    const w = createWatcher({
        store: env.store, notesDir: env.dirs.notes, timers,
        monitorFactory: (dir, cb) => { emit = cb; return {cancel() { cancelled = true; }}; },
    });
    return {env, w, timers, refreshes, ev: e => emit(e), wasCancelled: () => cancelled};
}

test('3: only CREATED / MOVED_IN / CHANGES_DONE_HINT / DELETED of candidate names react; dotfiles and other names do not', async () => {
    const {env, w} = await setup();
    try {
        const U = uuid(1);
        for (const event of ['CREATED', 'MOVED_IN', 'CHANGES_DONE_HINT', 'DELETED']) {
            assert.equal(w.relevant({event, name: `${U}.json`}), true, event);
            assert.equal(w.relevant({event, name: conflictName(U)}), true, event);
            assert.equal(w.relevant({event, name: `.syncthing.${U}.json.tmp`}), false, `${event} tmp`);
            assert.equal(w.relevant({event, name: '.stfolder'}), false);
            assert.equal(w.relevant({event, name: `${U}.json\n`}), false);
            assert.equal(w.relevant({event, name: 'readme.txt'}), false);
            assert.equal(w.relevant({event, name: null}), false);
        }
        for (const event of ['CHANGED', 'ATTRIBUTE_CHANGED', 'MOVED_OUT', 'OTHER'])
            assert.equal(w.relevant({event, name: `${U}.json`}), false, event);
        // a monitor with WATCH_MOVES reports the Syncthing rename as RENAMED(old tmp name, new name)
        assert.equal(w.relevant({event: 'RENAMED', name: `.syncthing.${U}.json.tmp`, otherName: `${U}.json`}), true);
        assert.equal(w.relevant({event: 'RENAMED', name: '.a', otherName: '.b'}), false);
    } finally {
        env.cleanup();
    }
});

test('3: events are debounced (trailing, 100 ms) into one refresh that re-reads the named files', async () => {
    const {env, w, timers, refreshes, ev} = await setup();
    try {
        await w.start();
        refreshes.length = 0;
        const U = uuid(1);
        env.putRec(`${U}.json`, rec({id: U}));
        ev({event: 'CREATED', name: `${U}.json`});
        timers.advance(60);
        ev({event: 'CHANGES_DONE_HINT', name: `${U}.json`});
        timers.advance(60);
        assert.equal(refreshes.length, 0, 'the second event restarted the 100 ms');
        ev({event: 'CREATED', name: `.syncthing.${U}.json.tmp`});
        assert.equal(timers.pending(), 1);
        timers.advance(100);
        await w.idle();
        assert.equal(refreshes.length, 1);
        assert.deepEqual(refreshes[0], [`${U}.json`]);
        assert.equal(env.store.getNote(U).id, U);
        w.stop();
    } finally {
        env.cleanup();
    }
});

test('3: an event forces a re-read although size and mtime are unchanged', async () => {
    const {env, w, timers, ev} = await setup();
    try {
        const U = uuid(1);
        const a = rec({id: U, text: 'aaaa'});
        const b = rec({id: U, text: 'bbbb', rev: a.rev});
        assert.equal(a.bytes.length, b.bytes.length);
        env.putRec(`${U}.json`, a);
        const p = path.join(env.dirs.notes, `${U}.json`);
        const t = new Date('2026-10-17T11:00:00Z');
        fs.utimesSync(p, t, t);
        await w.start();
        assert.equal(env.store.getNote(U).text, 'aaaa');
        fs.writeFileSync(p, b.bytes);
        fs.utimesSync(p, t, t);
        await env.store.refresh();
        assert.equal(env.store.getNote(U).text, 'aaaa', 'a plain scan trusts (size, mtime)');
        ev({event: 'CHANGES_DONE_HINT', name: `${U}.json`});
        timers.advance(100);
        await w.idle();
        assert.equal(env.store.getNote(U).text, 'bbbb', 'the event hint reads the file again');
        w.stop();
    } finally {
        env.cleanup();
    }
});

test('3: the first load uses the cost bound in batches until nothing is pending', async () => {
    const {env, w, refreshes} = await setup();
    try {
        for (let i = 1; i <= 150; i++)
            env.putRec(`${uuid(i)}.json`, rec({id: uuid(i)}));
        await w.start();
        assert.equal(refreshes.length, 3, '64 + 64 + 22');
        assert.equal(env.store.listNotes().length, 150);
        w.stop();
    } finally {
        env.cleanup();
    }
});

test('3: no echo loop: the event of our own write causes a refresh but no write and no announcement', async () => {
    const {env, w, timers, ev} = await setup();
    try {
        await w.start();
        const created = (await env.store.createNote({text: 'v1'})).record;
        env.events.length = 0;
        const writes = () => env.layer.calls.filter(c => c.op === 'writeTmp').length;
        const before = writes();
        ev({event: 'CREATED', name: `${created.id}.json`});
        ev({event: 'CHANGES_DONE_HINT', name: `${created.id}.json`});
        timers.advance(100);
        await w.idle();
        assert.equal(writes(), before, 'applying a version never writes');
        assert.deepEqual(env.events, []);
        w.stop();
    } finally {
        env.cleanup();
    }
});

test('3: stop() cancels the monitor and the pending timer', async () => {
    const {env, w, timers, refreshes, ev, wasCancelled} = await setup();
    try {
        await w.start();
        refreshes.length = 0;
        ev({event: 'CREATED', name: `${uuid(1)}.json`});
        w.stop();
        assert.equal(wasCancelled(), true);
        assert.equal(timers.pending(), 0);
        timers.advance(1000);
        assert.equal(refreshes.length, 0);
    } finally {
        env.cleanup();
    }
});

test('3: a conflict file arriving by event is resolved end to end', async () => {
    const {env, w, timers, ev} = await setup();
    try {
        const U = uuid(1);
        env.putRec(`${U}.json`, rec({id: U, text: 'old', updated: at(300)}));
        await w.start();
        env.putRec(conflictName(U), rec({id: U, text: 'new', rev: 2}));
        ev({event: 'CREATED', name: conflictName(U)});
        timers.advance(100);
        await w.idle();
        assert.equal(env.store.getNote(U).text, 'new');
        assert.equal(env.has(conflictName(U)), false);
        w.stop();
    } finally {
        env.cleanup();
    }
});

test('V6 / 2.2 step 0: a QUARANTINED file is released by a one-shot timer at its time, without any event; stop() clears it', async () => {
    const env = makeEnv({wrap: true});
    try {
        await env.start();
        const timers = fakeTimers();
        const U = uuid(1);
        env.putRec(`${U}.json`, rec({id: U, text: 'from the future', updated: new Date(T0 + 30 * 3600000).toISOString()}));
        const w = createWatcher({
            store: env.store, notesDir: env.dirs.notes, timers, now: () => env.clock.t,
            monitorFactory: () => ({cancel() {}}),
        });
        await w.start();
        assert.equal(env.store.getNote(U), null, 'quarantined: not shown');
        assert.equal(timers.pending(), 1, 'one release timer');
        const due = env.store.nextQuarantineRelease();
        assert.equal(due, T0 + 6 * 3600000);
        env.clock.t = due + 1;
        timers.advance(6 * 3600000 + 1);      // the release timer fires and asks for a refresh
        timers.advance(0);                    // the debounce timer (0 ms)
        await w.idle();
        assert.equal(env.store.getNote(U).text, 'from the future');
        assert.equal(timers.pending(), 0, 'nothing quarantined any more: no timer');
        env.putRec(`${uuid(2)}.json`, rec({id: uuid(2), text: 'again', updated: new Date(env.clock.t + 30 * 3600000).toISOString()}));
        await env.store.refresh();
        w.stop();
        assert.equal(timers.pending(), 0, 'stop() leaves no timer');
    } finally {
        env.cleanup();
    }
});

test('V6: nextQuarantineRelease gives the EARLIEST release of several quarantined files', async () => {
    const env = makeEnv({wrap: true});
    try {
        await env.start();
        assert.equal(env.store.nextQuarantineRelease(), null, 'none quarantined');
        for (const [n, hours] of [[1, 30], [2, 50], [3, 27], [4, 90]])
            env.putRec(`${uuid(n)}.json`, rec({id: uuid(n), updated: new Date(T0 + hours * 3600000).toISOString()}));
        await env.store.refresh();
        assert.equal(env.store.nextQuarantineRelease(), T0 + 3 * 3600000, 'the 27 h file is released first (at +3 h)');
        env.clock.t = T0 + 3 * 3600000 + 1;
        await env.store.refresh();
        assert.equal(env.store.nextQuarantineRelease(), T0 + 6 * 3600000, 'then the 30 h file');
    } finally {
        env.cleanup();
    }
});

test('3: an event that is not relevant (a dotfile, another name, a CHANGED event) starts no refresh through the monitor', async () => {
    const {env, w, timers, refreshes, ev} = await setup();
    try {
        await w.start();
        refreshes.length = 0;
        for (const e of [{event: 'CREATED', name: '.syncthing.tmp'}, {event: 'CREATED', name: 'readme.txt'},
            {event: 'CHANGED', name: `${uuid(1)}.json`}, {event: 'CREATED', name: null}, {event: 'ATTRIBUTE_CHANGED', name: `${uuid(1)}.json`}])
            ev(e);
        assert.equal(timers.pending(), 0, 'no debounce timer was armed');
        timers.advance(1000);
        await w.idle();
        assert.deepEqual(refreshes, []);
        ev({event: 'CREATED', name: `${uuid(1)}.json`});
        assert.equal(timers.pending(), 1, 'control: a relevant event arms the timer');
        w.stop();
    } finally {
        env.cleanup();
    }
});

test('V6: the release timer is capped at 2^31-1 ms (a larger delay would fire at once); the quarantine of a year-2100 date is re-armed, not released', async () => {
    const env = makeEnv({wrap: true});
    try {
        await env.start();
        const timers = fakeTimers();
        const delays = [];
        const set = timers.set;
        timers.set = (fn, ms) => { delays.push(ms); return set(fn, ms); };
        const U = uuid(1);
        env.putRec(`${U}.json`, rec({id: U, text: 'far future', updated: '2100-06-01T00:00:00.000Z'}));
        const w = createWatcher({
            store: env.store, notesDir: env.dirs.notes, timers, now: () => env.clock.t,
            monitorFactory: () => ({cancel() {}}),
        });
        await w.start();
        assert.equal(env.store.getNote(U), null, 'quarantined');
        assert.ok(env.store.nextQuarantineRelease() - env.clock.t > 2 ** 31 - 1, 'the release is further away than a timer can wait');
        assert.deepEqual(delays, [2 ** 31 - 1], 'the release timer is capped');
        timers.advance(2 ** 31 - 1);          // the capped timer fires and asks for a refresh
        timers.advance(0);                    // the debounce timer
        await w.idle();
        assert.equal(env.store.getNote(U), null, 'still quarantined: not released early');
        assert.equal(timers.pending(), 1, 'the release timer was armed again');
        w.stop();
        assert.equal(timers.pending(), 0);
    } finally {
        env.cleanup();
    }
});
