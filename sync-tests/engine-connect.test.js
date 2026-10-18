// SPDX-License-Identifier: GPL-3.0-or-later
// The engine: host (the waiting machine, one candidate, one accept), join (the typed ID) and the link rule, against the stub machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorld, isoOf, OWN, PEER, OTHER, THIRD} from './support/world.js';
import {checkRun, emit} from '../sync/protocol.js';
import {createEngine, TIMING} from '../sync/engine.js';

const valid = () => ({remote: 'valid', completion: 100});
async function ready(opts) {
    const w = createWorld(opts);
    await w.setUp();
    return w;
}
const knock = (w, at, id = PEER, name = 'laptop-b', extra = {}) => w.at(at, x => { x.pending[id] = {time: isoOf(x.clock), name, address: '127.0.0.1:22000', ...extra}; });
const accept = (w, at, id = PEER) => w.at(at, x => x.write(`accept ${id}\n`));
const connect = (w, at, id = PEER) => w.at(at, x => x.connections.set(id, true));
const kinds = w => w.events.map(e => e.event);
const perform = (w, verb, arg) => createEngine(w.ports()).perform(verb, arg);
const addCalls = w => w.calls.map(c => c.argv).filter(a => a.includes('add') && (a.includes('devices')));
const ranPending = w => w.calls.some(c => c.argv.includes('pending'));

test('host: one computer knocks, the window accepts that ID, the link becomes stable and up to date: a result and nothing sooner', async () => {
    const w = await ready();
    w.completion = valid;
    knock(w, 3000);
    accept(w, 7000);
    connect(w, 7500);
    const r = await perform(w, 'host');
    assert.deepEqual(r.result.peer, {id: PEER, name: 'laptop-b'});
    assert.deepEqual([r.result.link, r.result.up_to_date, r.result.connected], ['stable', true, true]);
    const cand = w.events.filter(e => e.event === 'candidate');
    assert.deepEqual(cand, [{event: 'candidate', id: PEER, name: 'laptop-b'}], 'one candidate, announced once');
    assert.ok(kinds(w).indexOf('candidate') < kinds(w).indexOf('peer') && kinds(w).indexOf('peer') < kinds(w).indexOf('link'));
    assert.ok(w.devices.has(PEER) && w.folders.get('cetli-notes').devices.some(d => d.id === PEER));
    const adds = addCalls(w);
    assert.deepEqual(adds.map(a => a.slice(3)), [
        ['config', 'devices', 'add', '--device-id', PEER, '--name=other computer'],
        ['config', 'folders', 'cetli-notes', 'devices', 'add', '--device-id', PEER],
    ]);
    // the whole run is a valid transcript of the protocol, line by line
    const lines = [...w.events.map(e => emit(e, 'host')), emit(r.result, 'host')];
    assert.equal(checkRun('host', lines, 0).ok, true);
});

test('host: before the window nothing is read, and only a running host reads the pending list (T1/T4)', async () => {
    const w = await ready();
    knock(w, 100);
    for (const verb of ['status', 'own-id', 'forget'])
        await perform(w, verb);
    await perform(w, 'join', PEER);
    assert.equal(ranPending(w), false, 'no verb but host reads the pending devices');
    assert.equal(w.devices.size, 2);
    const w2 = await ready();
    knock(w2, 100);
    await perform(w2, 'host').catch(() => {});
    w2.eof();
    assert.equal(addCalls(w2).length, 0, 'a stranger that knocks is never accepted without the window');
});

test('T5: an accept for an ID that is not the single current candidate is refused, and nothing is added', async () => {
    const w = await ready();
    knock(w, 3000);
    accept(w, 7000, OTHER);
    const r = await perform(w, 'host');
    assert.deepEqual(r.error, {code: 'E_PENDING_AMBIGUOUS'});
    assert.equal(addCalls(w).length, 0);
    // the candidate changes between the display and the click
    const sw = await ready();
    knock(sw, 3000, PEER, 'one');
    sw.at(6000, x => { delete x.pending[PEER]; x.pending[OTHER] = {time: isoOf(x.clock), name: 'two', address: ''}; });
    accept(sw, 7000, PEER);
    assert.equal((await perform(sw, 'host')).error.code, 'E_PENDING_AMBIGUOUS');
    assert.equal(addCalls(sw).length, 0, 'a switch between the display and the click cannot hand a different device the share');
});

test('T6: two computers knocking: no candidate, fail closed, nothing accepted', async () => {
    const w = await ready();
    knock(w, 3000, PEER);
    knock(w, 3000, OTHER, 'stranger');
    const r = await perform(w, 'host');
    assert.deepEqual(r.error, {code: 'E_PENDING_AMBIGUOUS'});
    assert.equal(kinds(w).includes('candidate'), false);
    assert.equal(addCalls(w).length, 0);
});

test('T7: an entry older than the moment the window opened is not offered; the window ends by itself after 15 minutes', async () => {
    const w = await ready();
    w.pending[PEER] = {time: isoOf(w.clock - 10_000), name: 'stale', address: ''};
    const r = await perform(w, 'host');
    assert.deepEqual(r.error, {code: 'E_EXPIRED'});
    assert.equal(kinds(w).includes('candidate'), false);
    assert.ok(w.mono >= TIMING.hostWindowMs && w.mono < TIMING.hostWindowMs + 1000, `ended at ${w.mono} ms`);
    // a requester that is still trying (its time is refreshed) is offered
    const live = await ready();
    live.pending[PEER] = {time: isoOf(live.clock - 10_000), name: 'stale', address: ''};
    live.at(4000, x => { x.pending[PEER].time = isoOf(x.clock); });
    live.at(9000, x => x.eof());
    await perform(live, 'host');
    assert.equal(kinds(live).includes('candidate'), true);
});

test('T8: the name is display text only: 5000 characters, control characters and markup; the argv never carries it', async () => {
    const cases = [
        ['x'.repeat(5000), null], ['a\nb', null], ['café', null], ['<b>bold</b>', '<b>bold</b>'], ['y'.repeat(33), 'y'.repeat(32)],
        ['z'.repeat(96), 'z'.repeat(32)], ['z'.repeat(97), null], ['', null], [5, null],
    ];
    for (const [raw, shown] of cases) {
        const w = await ready();
        w.completion = valid;
        knock(w, 3000, PEER, raw);
        accept(w, 7000);
        connect(w, 7500);
        const r = await perform(w, 'host');
        assert.equal(w.events.find(e => e.event === 'candidate').name, shown, String(raw).slice(0, 20));
        assert.equal(r.result.peer.name, shown);
        for (const a of addCalls(w))
            assert.equal(a.some(x => typeof raw === 'string' && raw.length > 3 && x.includes(raw)), false, 'the pending name is not in any argument');
        assert.equal(JSON.stringify(w.journal).includes('bold'), false);
    }
});

test('host: only the first accept counts, other lines are ignored, an accept written before any candidate is judged at once', async () => {
    const w = await ready();
    w.completion = valid;
    knock(w, 3000);
    w.at(5000, x => { x.write('hello\n'); x.write(`ACCEPT ${PEER}\n`); x.write(`accept ${PEER.toLowerCase()}\n`); x.write(`accept ${PEER} extra\n`); });
    accept(w, 7000);
    accept(w, 7000, OTHER);
    connect(w, 7500);
    const r = await perform(w, 'host');
    assert.equal(r.result.peer.id, PEER, 'a second accept for another ID changed nothing');
    assert.equal(addCalls(w).length, 2);
});

test('host: EOF on stdin stops it at once and accepts nothing; so does an EOF during the wait for the link', async () => {
    const w = await ready();
    knock(w, 100);
    w.eof();
    assert.deepEqual((await perform(w, 'host')).error, {code: 'E_EXPIRED'});
    assert.equal(addCalls(w).length, 0);
    assert.ok(w.mono < 1000);
    const v = await ready();
    knock(v, 3000);
    accept(v, 7000);
    v.at(12000, x => x.eof());
    const r = await perform(v, 'host');
    assert.equal(r.error.code, 'E_EXPIRED');
    assert.ok(v.mono < 60_000, 'it stopped within seconds of the EOF');
});

test('host: refuses to start with a peer present (neutral), with a foreign device, with a runaway pending list', async () => {
    const paired = await ready();
    paired.pair(PEER);
    assert.deepEqual((await perform(paired, 'host')).error, {code: 'E_ALREADY_PAIRED'});
    const foreign = await ready();
    foreign.devices.set(OTHER, {name: 'x', introducer: true, autoAcceptFolders: false, introducedBy: ''});
    assert.deepEqual((await perform(foreign, 'host')).error, {code: 'E_FOREIGN_DEVICE'});
    assert.equal(ranPending(foreign), false);
    const odd = await ready();
    odd.folders.set('x', {path: '/x', type: 'sendreceive', devices: [{id: OWN, introducedBy: ''}]});
    assert.equal((await perform(odd, 'host')).error.code, 'E_CONFIG_UNSAFE');
    const big = await ready();
    big.pendingBytes = 17 * 1024 * 1024;
    assert.deepEqual((await perform(big, 'host')).error, {code: 'E_PENDING_TOO_LARGE'});
    assert.equal(addCalls(big).length, 0);
    const down = await ready();
    down.daemon = false;
    assert.equal((await perform(down, 'host')).error.code, 'E_SERVICE_TIMEOUT');
    const nb = createWorld({backend: false});
    assert.equal((await perform(nb, 'host')).error.code, 'E_NO_SYNCTHING');
});

test('host: an entry whose key is no valid ID is not a candidate but counts for "how many"', async () => {
    const w = await ready();
    knock(w, 3000, PEER);
    knock(w, 3000, 'NOT-AN-ID');
    assert.equal((await perform(w, 'host')).error.code, 'E_PENDING_AMBIGUOUS');
    const solo = await ready();
    knock(solo, 3000, 'NOT-AN-ID');
    solo.at(8000, x => x.eof());
    await perform(solo, 'host');
    assert.equal(kinds(solo).includes('candidate'), false);
    const own = await ready();
    knock(own, 3000, OWN);
    own.at(8000, x => x.eof());
    await perform(own, 'host');
    assert.equal(kinds(own).includes('candidate'), false, 'this computer\'s own ID is no candidate');
});

test('host: a device that came in foreign after the add makes the accept step fail with E_FOREIGN_DEVICE', async () => {
    const w = await ready();
    w.afterAdd = id => { w.devices.get(id).introducer = true; };
    knock(w, 3000);
    accept(w, 7000);
    const r = await perform(w, 'host');
    assert.equal(r.error.code, 'E_FOREIGN_DEVICE');
});

test('the log-114 shape: 18 connected samples but no completion evidence is flapping: no result, a timeout, never "stable"', async () => {
    for (const evidence of [() => null, () => ({remote: 'unknown', completion: 0}), () => ({remote: 'unknown', completion: 100})]) {
        const w = await ready();
        w.completion = evidence;
        knock(w, 3000);
        accept(w, 7000);
        connect(w, 7500);
        const r = await perform(w, 'host');
        assert.equal(r.result, undefined);
        assert.deepEqual(r.error, {code: 'E_PEER_TIMEOUT', step: 'connect'});
        assert.equal(w.events.some(e => e.event === 'link' && e.state === 'stable'), false);
        assert.equal(w.events.some(e => e.event === 'link' && e.state === 'flapping'), true);
        assert.ok(w.mono - 7000 >= TIMING.peerTimeoutMs);
    }
});

test('"connected" for fewer than 10 samples proves nothing: one true read and then false is flapping, not stable (mutant: threshold 1)', async () => {
    const w = await ready();
    w.completion = valid;
    knock(w, 3000);
    accept(w, 7000);
    w.connections.set(PEER, ms => ms >= 7000 && ms < 8000 + 3000);          // three samples only, then it drops
    const r = await perform(w, 'host');
    assert.equal(r.error.code, 'E_PEER_TIMEOUT');
    assert.equal(w.events.some(e => e.event === 'link' && e.state === 'stable'), false);
    // and the stable state needs the evidence at the moment of the claim, even after ten good samples
    const v = await ready();
    v.completion = () => null;
    knock(v, 3000);
    accept(v, 7000);
    connect(v, 7000);
    assert.equal((await perform(v, 'host')).error.code, 'E_PEER_TIMEOUT');
});

test('stable but the notes do not arrive: E_NOT_UP_TO_DATE after the extra five minutes, not a result', async () => {
    const w = await ready();
    w.completion = () => ({remote: 'valid', completion: 40});
    knock(w, 3000);
    accept(w, 7000);
    connect(w, 7000);
    const r = await perform(w, 'host');
    assert.deepEqual(r.error, {code: 'E_NOT_UP_TO_DATE', step: 'sync'});
    assert.equal(w.events.some(e => e.event === 'link' && e.state === 'stable' && e.up_to_date === false), true);
    // it becomes up to date late: still a result
    const late = await ready();
    late.completion = (id, x) => ({remote: 'valid', completion: x.mono > 100_000 ? 100 : 60});
    knock(late, 3000);
    accept(late, 7000);
    connect(late, 7000);
    assert.equal((await perform(late, 'host')).result.up_to_date, true);
});

test('link events: only on a change, at most one per sample', async () => {
    const w = await ready();
    w.completion = valid;
    knock(w, 3000);
    accept(w, 7000);
    connect(w, 7500);
    await perform(w, 'host');
    const links = w.events.filter(e => e.event === 'link');
    for (let i = 1; i < links.length; i++)
        assert.notDeepEqual(links[i], links[i - 1]);
    assert.ok(links.length <= 4);
});

// ---- join --------------------------------------------------------------------------------------------------------------------

test('join: the typed ID is canonicalised by the engine, added, shared, and the result needs the same stable proof', async () => {
    const w = await ready();
    w.completion = valid;
    connect(w, 100);
    const r = await perform(w, 'join', `  ${PEER.toLowerCase().replace(/-/g, ' ')} \n`);
    assert.deepEqual(r.result.peer, {id: PEER, name: null});
    assert.equal(r.result.own_id, OWN);
    assert.deepEqual(addCalls(w).map(a => a.slice(3)), [
        ['config', 'devices', 'add', '--device-id', PEER, '--name=other computer'],
        ['config', 'folders', 'cetli-notes', 'devices', 'add', '--device-id', PEER],
    ]);
    assert.equal(ranPending(w), false, 'join reads no pending list');
    assert.deepEqual(w.events.filter(e => e.event === 'peer'), [{event: 'peer', id: PEER, name: null}]);
    assert.equal(checkRun('join', [...w.events.map(e => emit(e, 'join')), emit(r.result, 'join')], 0).ok, true);
});

test('join: E_BAD_ID and E_OWN_ID before any write; no code path of today produces a code error', async () => {
    for (const bad of ['', 'nonsense', PEER.slice(0, 40), `${PEER}A`, 'x'.repeat(5000), PEER.replace('V', '0')]) {
        const w = await ready();
        assert.deepEqual((await perform(w, 'join', bad)).error, {code: 'E_BAD_ID'}, bad.slice(0, 20));
        assert.equal(addCalls(w).length, 0);
    }
    const w = await ready();
    assert.deepEqual((await perform(w, 'join', OWN.toLowerCase())).error, {code: 'E_OWN_ID'});
    assert.equal(addCalls(w).length, 0);
});

test('join: the same peer again is idempotent; a missing share is finished; another peer is refused (rows 10-12)', async () => {
    const w = await ready();
    w.completion = valid;
    w.pair(PEER);
    connect(w, 100);
    assert.equal((await perform(w, 'join', PEER)).result.peer.id, PEER);
    assert.equal(addCalls(w).length, 0, 'already shared: nothing is added again');
    const half = await ready();
    half.completion = valid;
    half.pair(PEER, {shared: false});
    connect(half, 100);
    assert.equal((await perform(half, 'join', PEER)).result.peer.id, PEER);
    assert.deepEqual(addCalls(half).map(a => a.slice(3, 7)), [['config', 'devices', 'add', '--device-id'], ['config', 'folders', 'cetli-notes', 'devices']]);
    const other = await ready();
    other.pair(PEER);
    assert.deepEqual((await perform(other, 'join', THIRD)).error, {code: 'E_ALREADY_PAIRED'});
    assert.equal(addCalls(other).length, 0);
    const otherHalf = await ready();
    otherHalf.pair(PEER, {shared: false});
    assert.deepEqual((await perform(otherHalf, 'join', THIRD)).error, {code: 'E_HALF_STATE_OTHER'});
    assert.equal(otherHalf.devices.has(PEER), true, 'nothing is replaced or removed');
});

test('join: the wrong-ID shape (connected, no completion) ends in a timeout with link flapping, never a result', async () => {
    const w = await ready();
    w.completion = () => ({remote: 'unknown', completion: 0});
    connect(w, 100);
    const r = await perform(w, 'join', PEER);
    assert.deepEqual(r.error, {code: 'E_PEER_TIMEOUT', step: 'connect'});
    assert.equal(w.events.some(e => e.event === 'link' && e.state === 'flapping'), true);
    const none = await ready();
    const rn = await perform(none, 'join', PEER);
    assert.equal(rn.error.code, 'E_PEER_TIMEOUT');
    assert.equal(none.events.filter(e => e.event === 'link').every(e => e.state === 'none'), true);
});

test('join: foreign device or odd folder before the add: nothing is added', async () => {
    const w = await ready();
    w.devices.set(OTHER, {name: 'x', introducer: false, autoAcceptFolders: true, introducedBy: ''});
    assert.deepEqual((await perform(w, 'join', PEER)).error, {code: 'E_FOREIGN_DEVICE'});
    assert.equal(addCalls(w).length, 0);
    const f = await ready();
    f.folders.get('cetli-notes').path = 'notes';
    assert.equal((await perform(f, 'join', PEER)).error.code, 'E_CONFIG_UNSAFE');
    assert.equal(addCalls(f).length, 0);
});

test('status link rule: paired + connected + evidence valid + 100 = stable; without evidence flapping; not connected = none', async () => {
    const mk = async (evidence, connected) => {
        const w = await ready();
        w.pair(PEER);
        w.completion = evidence;
        w.connections.set(PEER, connected);
        return (await perform(w, 'status')).result;
    };
    let r = await mk(valid, true);
    assert.deepEqual([r.state, r.link, r.up_to_date, r.connected], ['paired', 'stable', true, true]);
    r = await mk(() => ({remote: 'valid', completion: 30}), true);
    assert.deepEqual([r.link, r.up_to_date], ['stable', false]);
    r = await mk(() => null, true);
    assert.deepEqual([r.link, r.up_to_date, r.connected], ['flapping', false, true], 'no way to read the evidence: never stable');
    r = await mk(() => ({remote: 'unknown', completion: 0}), true);
    assert.equal(r.link, 'flapping');
    r = await mk(valid, false);
    assert.deepEqual([r.link, r.connected], ['none', false]);
    const quick = await ready();
    quick.pair(PEER);
    const s0 = quick.sleeps;
    await perform(quick, 'status');
    assert.ok(quick.sleeps - s0 <= 1, 'the first not-connected sample ends the run at once');
});

test('the journal carries codes, steps and field names only: no ID, no name, no address', async () => {
    const w = await ready();
    w.completion = () => null;
    knock(w, 3000, PEER, 'secret-looking-name');
    accept(w, 7000);
    connect(w, 7500);
    await perform(w, 'host');
    const j = JSON.stringify(w.journal);
    for (const s of [PEER, OWN, 'secret-looking-name', '127.0.0.1', 'caller-key'])
        assert.equal(j.includes(s), false, s);
    assert.ok(w.journal.length >= 1);
});

// ---- option (a) of 0G.2: the link decided by unbroken connected samples alone ------------------------------------------------------

test('samples rule: ten unbroken connected samples at 1 s are stable, with no evidence at all; the default rule is the strict one', async () => {
    const w = await ready({linkRule: 'samples'});
    knock(w, 3000);
    accept(w, 7000);
    connect(w, 7000);
    const r = await perform(w, 'host');
    assert.deepEqual([r.result.link, r.result.up_to_date], ['stable', true]);
    assert.ok(w.mono >= 7000 + 9 * 1000, 'not before ten samples');
    const strict = await ready();
    knock(strict, 3000);
    accept(strict, 7000);
    connect(strict, 7000);
    assert.equal((await perform(strict, 'host')).error.code, 'E_PEER_TIMEOUT', 'without the option the engine needs the evidence');
    const { readFileSync } = await import('node:fs');
    assert.match(readFileSync(new URL('../sync/main.js', import.meta.url), 'utf8'), /const LINK_RULE = 'evidence';/, 'the product ships the strict rule until it is decided');
    const base = (await ready()).ports();
    assert.throws(() => createEngine({...base, linkRule: 'nonsense'}), RangeError);
});

test('samples rule: the wrong-ID shape of M-W6b (a 4.8 s burst, then 0.9 s bursts every 20 s) never gives stable; a flicker shorter than ten samples neither', async () => {
    const w = await ready({linkRule: 'samples'});
    knock(w, 3000);
    accept(w, 7000);
    const t0 = 7000;
    w.connections.set(PEER, ms => { const d = ms - t0; return (d >= 0 && d < 4800) || (d >= 17000 && d < 17900) || (d >= 37000 && d < 37900) || (d >= 57000 && d < 57900); });
    const r = await perform(w, 'host');
    assert.deepEqual(r.error, {code: 'E_PEER_TIMEOUT', step: 'connect'});
    assert.equal(w.events.some(e => e.event === 'link' && e.state === 'stable'), false);
    // nine good samples and a drop, over and over: flapping, never stable (mutant: threshold 9 or less)
    const v = await ready({linkRule: 'samples'});
    knock(v, 3000);
    accept(v, 7000);
    v.connections.set(PEER, ms => (ms - 7000) % 10_000 < 9_000);
    assert.equal((await perform(v, 'host')).error.code, 'E_PEER_TIMEOUT');
    assert.equal(v.events.some(e => e.event === 'link' && e.state === 'stable'), false);
    // the same shapes for join and for status
    const j = await ready({linkRule: 'samples'});
    j.connections.set(PEER, ms => ms % 20_000 < 4800);
    assert.equal((await perform(j, 'join', PEER)).error.code, 'E_PEER_TIMEOUT');
    const st = await ready({linkRule: 'samples'});
    st.pair(PEER);
    st.connections.set(PEER, ms => ms < 4800);
    const s = (await perform(st, 'status')).result;
    assert.deepEqual([s.link, s.up_to_date], ['flapping', false]);
    const ok = await ready({linkRule: 'samples'});
    ok.pair(PEER);
    ok.connections.set(PEER, true);
    const o = (await perform(ok, 'status')).result;
    assert.deepEqual([o.link, o.up_to_date, o.state], ['stable', true, 'paired']);
});
