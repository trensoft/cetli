// SPDX-License-Identifier: GPL-3.0-or-later
// The engine for a group of up to 10 computers: who is admitted, what the others take over, the count, the name hygiene
// (PLAN-ADMISSION-0.2.6 T-N1..T-N6, T-N10, T-N11, T-N16, T-N21, T-N22; PLAN-0.2.6 sections 2-4). Against the stub machine of support/world.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorld, isoOf, OTHER, OWN, PEER, THIRD} from './support/world.js';
import {makeId} from './support/ids.js';
import {MAX_COMPUTERS, MAX_PEERS} from '../sync/policy.js';
import {emit, MAX_LINE_BYTES} from '../sync/protocol.js';

const perform = (w, verb, arg) => w.engine().perform(verb, arg);
const ids = n => Array.from({length: n}, (_, i) => makeId(i + 1));
const ready = async opts => {
    const w = createWorld(opts);
    await w.setUp();
    return w;
};
const knock = (w, at, id = PEER, name = 'laptop-b') => w.at(at, x => { x.pending[id] = {time: isoOf(x.clock), name, address: '127.0.0.1:22000'}; });
const accept = (w, at, id = PEER) => w.at(at, x => x.write(`accept ${id}\n`));
const connectAll = w => { for (const id of w.devices.keys()) if (id !== w.ownId) w.connections.set(id, true); };
const writes = w => w.calls.map(c => c.argv).filter(a => a.some(x => ['add', 'delete', 'set'].includes(x)));
const ranPending = w => w.calls.some(c => c.argv.includes('pending'));
// the result must be one the protocol accepts: the strict emit of the wire contract
const valid = (verb, result) => assert.doesNotThrow(() => emit(result, verb), `${verb} result fits the contract`);

test('T-N2: host at 9 peers is E_GROUP_FULL before it listens; at 8 peers it opens and the 9th accepted ends at 9', async () => {
    const full = await ready();
    full.group(ids(MAX_PEERS));
    assert.deepEqual(await perform(full, 'host'), {error: {code: 'E_GROUP_FULL'}});
    assert.equal(ranPending(full), false, 'no pending read');
    assert.equal(writes(full).length, 0);
    const w = await ready();
    const eight = ids(MAX_PEERS - 1);
    w.group(eight);
    connectAll(w);
    const ninth = makeId(100);
    knock(w, 3000, ninth);
    accept(w, 7000, ninth);
    w.connections.set(ninth, true);
    const r = await perform(w, 'host');
    assert.equal(r.result.peer.id, ninth);
    assert.equal([...w.devices.keys()].filter(id => id !== OWN).length, MAX_PEERS);
    valid('host', r.result);
});

test('T-N3: an introduction that crosses 9 peers: status says over_limit, host, setup and join are refused, nothing is deleted', async () => {
    const w = await ready();
    w.group(ids(MAX_PEERS));
    w.introduce(makeId(200), makeId(1));                       // the daemon admits it; the engine cannot refuse
    const s = (await perform(w, 'status')).result;
    valid('status', s);
    assert.deepEqual([s.state, s.over_limit, s.computers, s.peers.length], ['paired', true, MAX_COMPUTERS + 1, MAX_COMPUTERS]);
    assert.ok(s.peers.every(p => p.link === null && p.connected === null), 'links are not measured over the limit');
    w.calls.length = 0;
    assert.deepEqual(await perform(w, 'host'), {error: {code: 'E_GROUP_FULL'}});
    assert.deepEqual((await perform(w, 'setup')).error.code, 'E_GROUP_FULL');
    assert.equal((await perform(w, 'join', makeId(300))).error.code, 'E_GROUP_FULL');
    assert.equal(writes(w).length, 0, 'the engine never picks a victim');
    assert.equal(w.calls.some(c => c.argv.includes('delete')), false);
});

test('T-N4: the accepted device is added with the introducer role and ONE --name= argument; the read-back needs the flag, no introducedBy, no auto-accept', async () => {
    const w = await ready();
    knock(w, 3000, PEER, 'laptop b');
    accept(w, 7000);
    connectAll(w);
    w.connections.set(PEER, true);
    await perform(w, 'host');
    const add = w.calls.map(c => c.argv).find(a => a.includes('add') && a.includes('devices') && !a.includes('folders'));
    assert.deepEqual(add.slice(3), ['config', 'devices', 'add', '--device-id', PEER, '--introducer', '--name=laptop b']);
    assert.equal(w.devices.get(PEER).introducer, true);
    assert.equal(w.devices.get(PEER).introducedBy, '');
    // the read-back: a flag that did not hold, a device that came in by introduction first, an auto-accept
    for (const [hook, code] of [
        [(x, id) => { x.devices.get(id).introducer = false; x.noIntroducerSet = true; }, 'E_CLI_FAILED'],
        [(x, id) => { x.devices.get(id).introducedBy = THIRD; }, 'E_CLI_FAILED'],
        [(x, id) => { x.devices.get(id).autoAcceptFolders = true; }, 'E_FOREIGN_DEVICE'],
    ]) {
        const x = await ready();
        x.afterAdd = id => hook(x, id);
        knock(x, 3000);
        accept(x, 7000);
        const r = await perform(x, 'host');
        assert.equal(r.error.code, code);
    }
    // the guest side adds the host the same way
    const g = await ready();
    connectAll(g);
    g.connections.set(PEER, true);
    await perform(g, 'join', PEER);
    const gadd = g.calls.map(c => c.argv).find(a => a.includes('add') && a.includes('devices') && !a.includes('folders'));
    assert.deepEqual(gadd.slice(3), ['config', 'devices', 'add', '--device-id', PEER, '--introducer', '--name=other computer']);
});

test('T-N5: an introduced name of 5000 characters, markup, control characters, NUL or non-ASCII reaches the list as null or 1-32 printable ASCII, never in an argument or the journal', async () => {
    const hostile = ['x'.repeat(5000), '<b onclick=x>bold</b>', 'a\nb', 'tab\there', 'nul\0here', 'café', '‮evil', 'y'.repeat(97), 'z'.repeat(96), '', 'plain name'];
    const w = await ready();
    const list = ids(hostile.length);
    list.forEach((id, i) => w.introduce(id, id === list[0] ? PEER : list[0], {name: hostile[i]}));
    w.pair(PEER, {introducer: true});
    list.forEach(id => w.connections.set(id, false));
    const r = (await perform(w, 'status')).result;
    valid('status', r);
    for (const p of r.peers)
        assert.ok(p.name === null || /^[\x20-\x7E]{1,32}$/.test(p.name), `name ${JSON.stringify(p.name)}`);
    assert.deepEqual(r.peers.slice(0, 2).map(p => p.name), [null, '<b onclick=x>bold</b>'], '5000 characters is null; markup passes as text (the window has markup off)');
    for (const a of w.calls.map(c => c.argv).flat())
        assert.equal(hostile.some(h => h.length > 3 && a.includes(h)), false, 'no foreign name on a command line');
    assert.equal(hostile.some(h => h.length > 3 && JSON.stringify(w.journal).includes(JSON.stringify(h).slice(1, -1))), false);
});

test('T-N6: a device list over the cap is not read one by one: over_limit after the single list call, not after 200 dump-json calls', async () => {
    const w = await ready();
    Array.from({length: 200}, (_, i) => makeId(i + 1)).forEach(id => w.introduce(id, makeId(1), {introducer: false}));
    w.calls.length = 0;
    const r = (await perform(w, 'status')).result;
    valid('status', r);
    assert.deepEqual([r.state, r.over_limit, r.computers, r.peers.length], ['half', true, 201, 0]);
    const deviceDumps = w.calls.map(c => c.argv).filter(a => a.includes('devices') && a.includes('dump-json'));
    assert.equal(deviceDumps.length, 0);
    assert.equal(w.calls.map(c => c.argv).filter(a => a.includes('devices') && a.includes('list')).length, 1);
    assert.equal(w.calls.length < 12, true, `${w.calls.length} calls`);
    // exactly at the cap it is still read: 16 devices
    const at = await ready();
    at.group(ids(15));
    const a = (await perform(at, 'status')).result;
    assert.deepEqual([a.over_limit, a.computers, a.peers.length], [true, 16, MAX_COMPUTERS]);
});

test('T-N10: join on a computer that has peers and a different ID is refused, zero writes; the group never merges', async () => {
    const w = await ready();
    w.group(ids(3));
    assert.deepEqual(await perform(w, 'join', THIRD), {error: {code: 'E_ALREADY_PAIRED'}});
    assert.equal(writes(w).length, 0);
    const half = await ready();
    half.group(ids(2), {shared: false});
    assert.deepEqual(await perform(half, 'join', THIRD), {error: {code: 'E_HALF_STATE_OTHER'}});
    assert.equal(writes(half).length, 0);
});

test('T-N11 (F4): a pending entry whose ID is already a device here (introduced a moment ago) is not a candidate and does not count; one that becomes a device before the accept is not added', async () => {
    const w = await ready();
    w.group(ids(2));
    w.introduce(makeId(50), makeId(1));
    knock(w, 3000, makeId(50), 'introduced');                  // the new computer knocks here too, while the daemon already took it in
    knock(w, 3500, PEER, 'real-candidate');
    w.at(9000, x => x.eof());
    const r = await perform(w, 'host');
    assert.equal(r.error.code, 'E_EXPIRED');
    assert.deepEqual(w.events.filter(e => e.event === 'candidate').map(e => e.id), [PEER], 'one candidate: the device that is in the list is neither offered nor counted');
    // between the display and the click the candidate becomes a device through an introduction: nothing is added
    const v = await ready();
    v.group(ids(2));
    knock(v, 3000);
    v.at(5000, x => x.introduce(PEER, makeId(1)));
    accept(v, 7000);
    const r2 = await perform(v, 'host');
    assert.equal(r2.error.code, 'E_PENDING_AMBIGUOUS');
    assert.equal(writes(v).length, 0);
});

test('T-N16: a tombstoned ID in the pending list is not a candidate and is not counted; a stranger that is not tombstoned still is', async () => {
    const w = await ready();
    w.put(`${w.home}/cetli-sync-state.json`, `${JSON.stringify({v: 1, ack: [], tomb: [OTHER], freeze: null})}\n`, 0o600);
    knock(w, 3000, OTHER, 'removed-laptop');
    knock(w, 3000, PEER, 'new-laptop');
    w.at(9000, x => x.eof());
    await perform(w, 'host');
    assert.deepEqual(w.events.filter(e => e.event === 'candidate').map(e => e.id), [PEER], 'two knocking, one of them removed here: not ambiguous');
    const x = await ready();
    knock(x, 3000, PEER);
    knock(x, 3000, THIRD);
    assert.equal((await perform(x, 'host')).error.code, 'E_PENDING_AMBIGUOUS');
    const only = await ready();
    only.put(`${only.home}/cetli-sync-state.json`, `${JSON.stringify({v: 1, ack: [], tomb: [OTHER], freeze: null})}\n`, 0o600);
    knock(only, 3000, OTHER);
    only.at(9000, x2 => x2.eof());
    await perform(only, 'host');
    assert.equal(only.events.some(e => e.event === 'candidate'), false, 'a knocking removed computer alone is no candidate');
});

test('T-N21: status never writes, in any state: no config add/set/delete, no file written', async () => {
    const mk = {
        group: w => { w.group(ids(4)); connectAll(w); },
        newRow: w => { w.group(ids(3)); w.introduce(makeId(60), makeId(1)); },
        foreign: w => { w.pair(PEER, {introducer: true}); w.devices.get(PEER).autoAcceptFolders = true; },
        overLimit: w => w.group(ids(11)),
        overCap: w => w.group(ids(30)),
        frozen: w => { w.group(ids(3)); w.put(`${w.home}/cetli-sync-state.json`, `${JSON.stringify({v: 1, ack: [], tomb: [], freeze: {ids: ids(3)}})}\n`, 0o600); },
        brokenState: w => { w.group(ids(3)); w.put(`${w.home}/cetli-sync-state.json`, 'not json', 0o600); },
        zeroPeers: () => {},
    };
    for (const [name, build] of Object.entries(mk)) {
        const w = await ready();
        build(w);
        w.timeline.length = 0;
        w.calls.length = 0;
        const r = await perform(w, 'status');
        assert.ok(r.result, name);
        valid('status', r.result);
        assert.equal(writes(w).length, 0, `${name}: no write call`);
        assert.equal(w.timeline.some(e => e.startsWith('write ')), false, `${name}: no file written`);
    }
});

test('T-N22: the link phase with 9 peers, 2 offline: one show connections per sample for all, the offline ones end at the first, the rest are stable', async () => {
    const w = await ready();
    const list = ids(MAX_PEERS);
    w.group(list);
    list.forEach((id, i) => w.connections.set(id, i >= 2));
    w.calls.length = 0;
    const r = (await perform(w, 'status')).result;
    valid('status', r);
    assert.deepEqual(r.peers.map(p => p.link), ['none', 'none', ...Array(7).fill('stable')]);
    assert.ok(r.peers.slice(2).every(p => p.connected_s === 9 && p.connected === true));
    assert.ok(r.peers.slice(0, 2).every(p => p.connected === false && p.connected_s === null));
    const samples = w.calls.map(c => c.argv).filter(a => a.includes('connections')).length;
    assert.ok(samples <= 11, `${samples} show connections calls`);
    assert.equal(samples, 10, 'ten samples for the stable ones, shared by all');
    // all offline: one sample, no waiting
    const off = await ready();
    off.group(list);
    off.calls.length = 0;
    const s0 = off.sleeps;
    await perform(off, 'status');
    assert.equal(off.calls.map(c => c.argv).filter(a => a.includes('connections')).length, 1);
    assert.ok(off.sleeps - s0 <= 1);
});

test('status of a group: how each computer came, new and returned rows, the counters, the largest line fits (T-N25)', async () => {
    const w = await ready();
    const [a, b, c] = ids(3);
    w.pair(a, {introducer: true});                                        // accepted here
    w.introduce(b, a);                                                    // arrived by introduction
    w.introduce(c, b, {introducer: false});
    w.put(`${w.home}/cetli-sync-state.json`, `${JSON.stringify({v: 1, ack: [a], tomb: [c], freeze: null})}\n`, 0o600);
    connectAll(w);
    const r = (await perform(w, 'status')).result;
    valid('status', r);
    const by = id => r.peers.find(p => p.id === id);
    assert.deepEqual([by(a).introduced_by, by(b).introduced_by, by(c).introduced_by], [null, a, b]);
    assert.deepEqual([by(a).new, by(b).new, by(c).new], [false, true, true]);
    assert.deepEqual([by(a).returned, by(b).returned, by(c).returned], [false, false, true]);
    assert.deepEqual([r.computers, r.max_computers, r.revocation_open, r.harden_pending, r.promote_pending], [4, 10, false, 1, 0]);   // b arrived with the flag: harden lowers it
    // the largest status the engine can produce: 9 peers, introduced, new, returned, 32-character names
    const big = await ready();
    const list = ids(MAX_PEERS);
    list.forEach((id, i) => (i === 0 ? big.pair(id, {introducer: true, name: 'N'.repeat(32)}) : big.introduce(id, list[0], {name: 'N'.repeat(32)})));
    big.put(`${big.home}/cetli-sync-state.json`, `${JSON.stringify({v: 1, ack: [], tomb: list, freeze: null})}\n`, 0o600);
    connectAll(big);
    big.note(0);
    const line = emit((await perform(big, 'status')).result, 'status');
    assert.ok(new TextEncoder().encode(line).length < 3500, `${line.length} bytes`);
    assert.ok(line.length < MAX_LINE_BYTES);
});

test('status counters: promote_pending is a 0.2.5 pair without the flag (0 while a removal is open), harden_pending follows the policy switch (T-N19)', async () => {
    const mk = async policy => {
        const w = await ready({policy});
        const [a, b] = ids(2);
        w.pair(a, {introducer: false});                                     // a pair of 0.2.5
        w.introduce(b, a, {introducer: true});                              // an introduced computer that inherited the flag
        connectAll(w);
        return w;
    };
    let r = (await perform(await mk({hardenIntroduced: true}), 'status')).result;
    assert.deepEqual([r.promote_pending, r.harden_pending], [1, 1]);
    r = (await perform(await mk({hardenIntroduced: false}), 'status')).result;
    assert.deepEqual([r.promote_pending, r.harden_pending], [1, 0], 'without the hardening nothing is pending for the introduced one');
    const frozen = await mk({hardenIntroduced: true});
    frozen.put(`${frozen.home}/cetli-sync-state.json`, `${JSON.stringify({v: 1, ack: [], tomb: [], freeze: {ids: []}})}\n`, 0o600);
    r = (await perform(frozen, 'status')).result;
    assert.deepEqual([r.revocation_open, r.promote_pending], [true, 0]);
});
