// SPDX-License-Identifier: GPL-3.0-or-later
// The removal side of the group: revoke with the freeze, finish, the shortcut forget <ID>, harden, promote, ack, the state file
// (PLAN-ADMISSION-0.2.6 T-N7..T-N9, T-N13, T-N17..T-N20, T-N23, T-N24; PLAN-0.2.6 4.3-4.5, F6). Against the stub machine of support/world.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorld, OTHER, OWN, PEER, THIRD} from './support/world.js';
import {makeId} from './support/ids.js';
import {DWELL_MS, REMOVED_MAX, wantedIntroducer} from '../sync/policy.js';
import {createEngine} from '../sync/engine.js';
import {emit} from '../sync/protocol.js';
import {FREEZE_MAX, parseState} from '../sync/state.js';

const perform = (w, verb, arg) => w.engine().perform(verb, arg);
const ids = n => Array.from({length: n}, (_, i) => makeId(i + 1));
const ready = async opts => {
    const w = createWorld(opts);
    await w.setUp();
    return w;
};
const STATE = w => `${w.home}/cetli-sync-state.json`;
const stateOf = w => parseState(w.fsMap.get(STATE(w)).text).state;
const putState = (w, o) => w.put(STATE(w), `${JSON.stringify({v: 1, ack: [], tomb: [], freeze: null, ...o})}\n`, 0o600);
const connectAll = w => { for (const id of w.devices.keys()) if (id !== w.ownId) w.connections.set(id, true); };
const argvs = w => w.calls.map(c => c.argv);
const isWrite = a => a.some(x => ['add', 'delete', 'set'].includes(x));
const valid = (verb, result) => assert.doesNotThrow(() => emit(result, verb), `${verb} result fits the contract`);
// a snapshot of the whole config of the stub: devices with their flags, the folder with its devices
const snapshot = w => JSON.stringify([[...w.devices.entries()].sort(), [...w.folders.entries()].map(([id, f]) => [id, f.path, f.type, f.devices])]);
// the group of the tests: A accepted here (introducer), B and C introduced by A, D accepted here too
const makeGroup = async (opts = {}) => {
    const w = await ready(opts);
    const [a, b, c, d] = ids(4);
    w.pair(a, {introducer: true, name: 'pc-a'});
    w.introduce(b, a, {name: 'pc-b'});
    w.introduce(c, a, {name: 'pc-c'});
    w.pair(d, {introducer: true, name: 'pc-d'});
    connectAll(w);
    return {w, a, b, c, d};
};

// ---- forget ---------------------------------------------------------------------------------------------------------------

test('T-N7: forget <ID> (the shortcut) removes that one device and its share and nothing else; an ID that is not in the list is E_BAD_ID with zero writes', async () => {
    const {w, a, b, d} = await makeGroup({policy: {shortcutRemove: true}});
    const before = snapshot(w);
    w.calls.length = 0;
    const r = await perform(w, 'forget', {ids: [d]});
    assert.deepEqual(r, {result: {event: 'result', state: null, remaining: 3}});
    valid('forget', r.result);
    assert.equal(w.devices.has(d), false);
    assert.equal(w.folders.get('cetli-notes').devices.some(x => x.id === d), false);
    assert.equal(w.devices.has(a) && w.devices.has(b), true);
    const after = JSON.parse(snapshot(w));
    const was = JSON.parse(before);
    assert.deepEqual(after[0].filter(([id]) => id !== d), was[0].filter(([id]) => id !== d), 'every other pair is byte-identical');
    assert.equal(argvs(w).filter(isWrite).every(x => x.includes(d)), true, 'every write names that one ID');
    assert.deepEqual(stateOf(w).tomb, [d], 'it may come back from a computer that lists it: tombstone');
    // not in the list, own ID, an introduced device (a plain delete is not durable there), several IDs
    for (const [arg, label] of [[{ids: [OTHER]}, 'unknown'], [{ids: [OWN]}, 'own'], [{ids: [b]}, 'introduced'], [{ids: [a, b]}, 'two']]) {
        const x = (await makeGroup({policy: {shortcutRemove: true}})).w;
        x.calls.length = 0;
        const before2 = snapshot(x);
        assert.deepEqual(await perform(x, 'forget', arg), {error: {code: 'E_BAD_ID'}}, label);
        assert.equal(argvs(x).filter(isWrite).length, 0, `${label}: zero writes`);
        assert.equal(snapshot(x), before2);
    }
});

test('the shortcut is behind SHORTCUT_REMOVE: with the switch off forget <ID> is E_BAD_ID before anything is read (T-N19)', async () => {
    const {w, d} = await makeGroup({policy: {shortcutRemove: false}});
    w.calls.length = 0;
    assert.deepEqual(await perform(w, 'forget', {ids: [d]}), {error: {code: 'E_BAD_ID'}});
    assert.equal(w.calls.length, 0);
    assert.equal(w.devices.has(d), true);
    const cfg = createWorld();
    assert.equal((await perform(cfg, 'forget', {ids: [d]})).error.code, 'E_BAD_ID');
});

test('forget --all: every flag down first, then shares and devices, the state file is cleared; the notes and the folder stay', async () => {
    const {w, a, b, c, d} = await makeGroup();
    putState(w, {ack: [a, d], tomb: [OTHER], freeze: {ids: [a]}});
    w.note(2);
    w.calls.length = 0;
    const r = await perform(w, 'forget', {all: true});
    assert.deepEqual(r, {result: {event: 'result', state: 'set-up', remaining: 0}});
    const kinds = argvs(w).filter(isWrite).map(x => (x.includes('introducer') ? 'flag' : x.includes('folders') ? 'share' : 'device'));
    const lastFlag = kinds.lastIndexOf('flag');
    assert.ok(lastFlag >= 0 && lastFlag < kinds.indexOf('share'), `flags first: ${kinds.join(' ')}`);
    assert.deepEqual([...w.devices.keys()], [OWN]);
    assert.equal(w.folders.has('cetli-notes'), true);
    assert.deepEqual(stateOf(w), {v: 1, ack: [], tomb: [], freeze: null});
    assert.equal((await perform(w, 'status')).result.state, 'set-up');
    for (const id of [b, c])
        assert.equal(w.devices.has(id), false);
});

// ---- revoke ---------------------------------------------------------------------------------------------------------------

test('T-N8 / T-N18: revoke writes the freeze and the tombstones FIRST, then every flag down (X first), then share, device (X last), read-back, dwell, read-back', async () => {
    const {w, a, b, c, d} = await makeGroup();
    // a computer that still lists X: it would bring it back while a flag for it is up and it is a device here
    w.remoteLists.push({by: a, id: b, name: 'pc-b'});
    w.timeline.length = 0;
    w.calls.length = 0;
    const r = await perform(w, 'revoke', {ids: [b, c]});            // b = the lost one, c = "not mine"
    valid('revoke', r.result);
    assert.deepEqual(r.result.removed, [b, c]);
    assert.deepEqual(r.result.returned, []);
    assert.equal(r.result.revocation_open, true);
    assert.equal(w.devices.has(b) || w.devices.has(c), false, 'out, and not brought back by the lister: its flag was down before the first delete');
    const writesIn = argvs(w).filter(isWrite);
    const flags = writesIn.filter(x => x.includes('introducer'));
    assert.deepEqual(flags.map(x => x[x.indexOf('introducer') - 1]), [b, a, c, d], 'X first, then every other peer');
    assert.ok(flags.every(x => x.at(-1) === 'false'));
    const firstDelete = writesIn.findIndex(x => x.includes('delete'));
    assert.equal(writesIn.slice(0, firstDelete).every(x => x.includes('introducer')), true, 'no delete before the last flag is down');
    assert.equal(writesIn.filter(x => x.includes('delete')).length, 4, 'two shares, two devices');
    const dels = writesIn.filter(x => x.includes('delete'));
    assert.deepEqual(dels.map(x => [x.includes('folders') ? 'share' : 'device', x.find(y => y === b || y === c)]), [['share', c], ['device', c], ['share', b], ['device', b]], 'the share before the device, X last');
    assert.equal(w.fsMap.get(STATE(w)).mode, 0o600);
    const st = stateOf(w);
    assert.deepEqual([st.tomb.sort(), st.freeze.ids.includes(a), st.freeze.ids.includes(d)], [[b, c].sort(), true, true]);
    // the dwell: virtual time passed
    assert.ok(w.mono >= DWELL_MS);
    // the steps
    assert.deepEqual(w.events.filter(e => e.event === 'progress').map(e => `${e.step}:${e.state}`), ['freeze:start', 'freeze:ok', 'remove:start', 'remove:ok', 'verify:start', 'verify:ok', 'dwell:start', 'dwell:ok']);
});

test('T-N8: the state file is written before the first flag call, and the flags are down before the first delete (the order of the calls)', async () => {
    const {w, b} = await makeGroup();
    const order = [];
    const real = w.run;
    const realWrite = w.files.writeText;
    w.files.writeText = (p, text, mode) => { if (p === STATE(w)) order.push('state'); return realWrite(p, text, mode); };
    const ports = w.ports();
    ports.run = {
        syncthing: async (sub, args, opts) => {
            if (sub === 'cli' && args.includes('introducer'))
                order.push('flag');
            if (sub === 'cli' && args.includes('delete'))
                order.push('delete');
            return real.syncthing(sub, args, opts);
        },
        systemctl: real.systemctl,
    };
    const {createEngine} = await import('../sync/engine.js');
    await createEngine(ports).perform('revoke', {ids: [b]});
    assert.equal(order[0], 'state', 'write-ahead: the freeze and the tombstones are on disk before any flag moves');
    assert.ok(order.indexOf('flag') < order.indexOf('delete'));
    assert.equal(order.filter(x => x === 'state').length, 1);
});

test('revoke: an ID that is not in the list, the own ID or an empty list is E_BAD_ID, zero writes, no state file', async () => {
    for (const arg of [{ids: [OTHER]}, {ids: [OWN]}, {ids: []}, {}, {ids: [OTHER, PEER]}]) {
        const {w, b} = await makeGroup();
        w.calls.length = 0;
        const before = snapshot(w);
        assert.deepEqual(await perform(w, 'revoke', arg.ids?.length === 2 ? {ids: [b, OTHER]} : arg), {error: {code: 'E_BAD_ID'}}, JSON.stringify(arg));
        assert.equal(argvs(w).filter(isWrite).length, 0);
        assert.equal(snapshot(w), before);
        assert.equal(w.fsMap.has(STATE(w)), false, 'the state file is not even created');
    }
});

test('revoke: if a flag does not hold, nothing is deleted and the freeze stays open', async () => {
    const {w, b} = await makeGroup();
    w.noIntroducerSet = true;
    const r = await perform(w, 'revoke', {ids: [b]});
    assert.equal(r.error.code, 'E_CLI_FAILED');
    assert.equal(r.error.step, 'freeze');
    assert.equal(w.devices.has(b), true, 'nothing deleted');
    assert.equal(w.calls.some(c => c.argv.includes('delete')), false);
    assert.equal(stateOf(w).freeze !== null, true);
});

test('revoke runs in foreign-config and over the limit: it is the way out', async () => {
    const f = await ready();
    const [a, b] = ids(2);
    f.pair(a, {introducer: true});
    f.pair(b, {introducer: true});
    f.devices.get(a).autoAcceptFolders = true;
    assert.equal((await perform(f, 'status')).result.state, 'foreign-config');
    const r = await perform(f, 'revoke', {ids: [a]});
    assert.deepEqual(r.result.removed, [a]);
    assert.equal((await perform(f, 'status')).result.state, 'paired');
    const o = await ready();
    const list = ids(12);
    o.group(list);
    const ro = await perform(o, 'revoke', {ids: [list[11], list[10]]});
    assert.deepEqual(ro.result.removed, [list[11], list[10]]);
    assert.equal(ro.result.remaining, 10);
    assert.equal(FREEZE_MAX, 16, 'the cap of the frozen IDs is the read cap, not 10');
    // exactly the cap: every peer is recorded in the freeze, nothing is cut
    const cap = await ready();
    const many = ids(FREEZE_MAX);
    cap.group(many);
    const rc = await perform(cap, 'revoke', {ids: [many[FREEZE_MAX - 1]]});
    assert.deepEqual(rc.result.removed, [many[FREEZE_MAX - 1]]);
    assert.equal(stateOf(cap).freeze.ids.length, FREEZE_MAX, 'at the cap every touched peer is recorded');
    assert.equal(parseState(cap.fsMap.get(STATE(cap)).text).ok, true, 'the file with a full freeze list is a valid file');
});

test('T-N13: the result names exactly the remaining peers that are not connected after the dwell, and no other', async () => {
    const {w, a, b, c, d} = await makeGroup();
    w.connections.set(a, false);
    w.connections.set(c, true);
    w.connections.set(d, false);
    w.connections.set(b, false);                              // the removed one does not count as offline
    const r = await perform(w, 'revoke', {ids: [b]});
    assert.deepEqual(r.result.offline.map(o => o.id).sort(), [a, d].sort());
    assert.deepEqual(r.result.offline.find(o => o.id === a), {id: a, name: 'pc-a'});
    assert.equal(r.result.remaining, 3);
    // every remaining peer connected: none offline
    const x = await makeGroup();
    const ok = await perform(x.w, 'revoke', {ids: [x.b]});
    assert.deepEqual(ok.result.offline, []);
});

test('T-N9: a removed computer that is brought back is a result (returned), then status shows it as returned, host is refused, the row can be removed again', async () => {
    const {w, a, b} = await makeGroup();
    w.at(5000, x => x.introduce(b, a));                       // during the dwell somebody brings it back
    const r = await perform(w, 'revoke', {ids: [b]});
    assert.deepEqual([r.result.removed, r.result.returned], [[], [b]]);
    const s = (await perform(w, 'status')).result;
    assert.equal(s.peers.find(p => p.id === b).returned, true);
    assert.equal(s.revocation_open, true);
    assert.deepEqual(await perform(w, 'host'), {error: {code: 'E_REVOCATION_OPEN'}});
    // finish refuses while a removed computer is back (PLAN-ADMISSION 2.3, 10): nothing is raised, the freeze stays
    w.calls.length = 0;
    assert.deepEqual(await perform(w, 'finish'), {error: {code: 'E_REVOCATION_OPEN'}});
    assert.equal(argvs(w).filter(isWrite).length, 0);
    assert.equal(w.devices.get(b).introducer, true, 'the flag of the returned computer is not touched');
    assert.equal((await perform(w, 'status')).result.revocation_open, true);
    const again = await perform(w, 'revoke', {ids: [b]});
    assert.deepEqual(again.result.removed, [b]);
    assert.deepEqual(await perform(w, 'finish'), {result: {event: 'result', revocation_open: false}});
    // a tombstoned computer back with the freeze already finished: still refused (I8)
    w.introduce(b, a);
    assert.equal((await perform(w, 'status')).result.peers.find(p => p.id === b).returned, true);
    assert.deepEqual(await perform(w, 'host'), {error: {code: 'E_REVOCATION_OPEN'}});
    // the state file holds IDs only
    const text = w.fsMap.get(STATE(w)).text;
    assert.equal(/pc-|name|path|\/home/.test(text), false);
    assert.equal(w.fsMap.get(STATE(w)).mode, 0o600);
});

test('T-N24: revoke is idempotent: cut short after the flag step, a second run deletes only what is left and ends with the same result', async () => {
    const {w, b, c} = await makeGroup();
    w.failCli.add(`devices ${b} delete`);                      // the run dies here, after the flags and the first share
    const first = await perform(w, 'revoke', {ids: [b, c]});
    assert.equal(first.error.code, 'E_CLI_FAILED');
    assert.equal(w.devices.has(b), true);
    assert.equal(stateOf(w).freeze !== null, true, 'the freeze survived the crash');
    w.failCli.clear();
    w.calls.length = 0;
    const second = await perform(w, 'revoke', {ids: [b, c]});
    assert.deepEqual([second.result.removed, second.result.returned], [[b, c], []]);
    assert.equal(w.devices.has(b) || w.devices.has(c), false);
    const dels = argvs(w).filter(x => x.includes('delete'));
    assert.equal(dels.every(x => x.includes(b) || x.includes(c)), true);
    assert.equal(dels.some(x => x.includes('devices') && !x.includes('folders') && x.includes(c)), false, 'c was gone already: not deleted a second time');
    // a rerun when X itself is gone already (the run died after the last delete): nothing fails on the missing device
    const done = await makeGroup();
    await perform(done.w, 'revoke', {ids: [done.b]});
    done.w.calls.length = 0;
    const third = await perform(done.w, 'revoke', {ids: [done.b]});
    assert.deepEqual([third.result.removed, third.result.returned], [[done.b], []]);
    assert.equal(argvs(done.w).some(x => x.includes(done.b) && isWrite(x)), false, 'the missing device is not written to');
    // the same run from the start gives the same result
    const clean = await makeGroup();
    const ref = await perform(clean.w, 'revoke', {ids: [clean.b, clean.c]});
    assert.deepEqual([ref.result.removed.length, ref.result.returned.length, ref.result.remaining], [2, 0, second.result.remaining]);
});

// ---- finish, the freeze, the policy ---------------------------------------------------------------------------------------

test('T-N18: while a removal is open host, join and setup are E_REVOCATION_OPEN and promote is refused; finish ends it and nothing else does, no timer', async () => {
    const {w, b} = await makeGroup();
    await perform(w, 'revoke', {ids: [b]});
    assert.deepEqual(await perform(w, 'host'), {error: {code: 'E_REVOCATION_OPEN'}});
    assert.equal((await perform(w, 'join', THIRD)).error.code, 'E_REVOCATION_OPEN');
    assert.equal((await perform(w, 'setup')).error.code, 'E_REVOCATION_OPEN');
    const rest = [...w.devices.keys()].filter(id => id !== OWN);
    assert.equal((await perform(w, 'promote', {ids: [rest[0]]})).error.code, 'E_REVOCATION_OPEN');
    // a day later nothing has changed
    w.mono += 24 * 3600 * 1000;
    w.clock += 24 * 3600 * 1000;
    const s = (await perform(w, 'status')).result;
    assert.equal(s.revocation_open, true);
    assert.ok(s.peers.every(p => p.introducer === false), 'every peer is limited');
    assert.equal(s.promote_pending, 0);
    const f = await perform(w, 'finish');
    assert.deepEqual(f, {result: {event: 'result', revocation_open: false}});
    valid('finish', f.result);
    assert.equal((await perform(w, 'status')).result.revocation_open, false);
    assert.equal(stateOf(w).tomb.includes(b), true, 'the tombstone stays');
});

test('T-N18 / T-N19 / F6: finish gives each frozen peer the flag the POLICY wants, under both values of the switch; only the frozen peers; only when it differs', async () => {
    for (const hardenIntroduced of [false, true]) {
        const {w, a, b, c, d} = await makeGroup({policy: {hardenIntroduced}});
        const r = await perform(w, 'revoke', {ids: [c]});
        assert.deepEqual(r.result.removed, [c]);
        for (const id of [a, b, d])
            assert.equal(w.devices.get(id).introducer, false, 'frozen');
        w.calls.length = 0;
        await perform(w, 'finish');
        for (const id of [a, d])
            assert.equal(w.devices.get(id).introducer, true, `direct ${id.slice(0, 4)} is an introducer again, hardening ${hardenIntroduced}`);
        assert.equal(w.devices.get(b).introducer, !hardenIntroduced, `introduced: ${hardenIntroduced ? 'stays off' : 'on again'}`);
        const sets = argvs(w).filter(x => x.includes('introducer'));
        assert.equal(sets.length, hardenIntroduced ? 2 : 3, 'only what differs');
        assert.ok(wantedIntroducer({introducedBy: a}, hardenIntroduced) === !hardenIntroduced);
    }
    // not frozen: finish changes nothing and writes nothing
    const {w} = await makeGroup();
    w.calls.length = 0;
    w.timeline.length = 0;
    assert.deepEqual(await perform(w, 'finish'), {result: {event: 'result', revocation_open: false}});
    assert.equal(argvs(w).filter(isWrite).length, 0);
    assert.equal(w.timeline.some(e => e.startsWith('write ')), false);
});

test('T-N23: a missing state file is a fresh state with the direct peers already acknowledged; status does not create it; the first write verb does', async () => {
    const {w, a, b, d} = await makeGroup();
    assert.equal(w.fsMap.has(STATE(w)), false);
    const s = (await perform(w, 'status')).result;
    assert.deepEqual(s.peers.map(p => [p.id === b, p.new]).filter(([isB]) => isB), [[true, true]]);
    assert.equal(s.peers.filter(p => p.new).length, 2, 'the two introduced ones are new, the two accepted here are not');
    assert.equal(w.fsMap.has(STATE(w)), false, 'status wrote nothing');
    const r = await perform(w, 'ack', {ids: [b]});
    assert.deepEqual(r, {result: {event: 'result', changed: 1}});
    assert.deepEqual(stateOf(w).ack.sort(), [a, b, d].sort(), 'the direct peers are seeded at the first write');
    assert.equal(w.fsMap.get(STATE(w)).mode, 0o600);
});

test('T-N23: an unreadable state file is an open freeze: host, join and setup are refused, finish repairs it for every peer', async () => {
    for (const bad of ['not json', '{"v":2}', JSON.stringify({v: 1, ack: ['x'], tomb: [], freeze: null}), '']) {
        const {w, a, d} = await makeGroup();
        w.put(STATE(w), bad, 0o600);
        const s = (await perform(w, 'status')).result;
        assert.equal(s.revocation_open, true, JSON.stringify(bad));
        assert.deepEqual(await perform(w, 'host'), {error: {code: 'E_REVOCATION_OPEN'}});
        assert.equal((await perform(w, 'join', THIRD)).error.code, 'E_REVOCATION_OPEN');
        w.devices.get(a).introducer = false;                    // the flag a lost freeze left behind
        const f = await perform(w, 'finish');
        assert.deepEqual(f, {result: {event: 'result', revocation_open: false}});
        assert.equal(w.devices.get(a).introducer, true);
        assert.equal(w.devices.get(d).introducer, true);
        assert.equal(parseState(w.fsMap.get(STATE(w)).text).ok, true, 'rewritten as a clean file');
        assert.equal((await perform(w, 'status')).result.revocation_open, false);
    }
    const link = await makeGroup();
    link.w.fsMap.set(STATE(link.w), {link: true, dir: false, text: JSON.stringify({v: 1, ack: [], tomb: [], freeze: null}), mode: 0o600});
    assert.equal((await perform(link.w, 'status')).result.revocation_open, true, 'a link is not our file');
});

test('T-N19: harden lowers the flag of introduced devices only when the switch is on; it never deletes; it runs in foreign-config and while frozen', async () => {
    const on = await makeGroup({policy: {hardenIntroduced: true}});
    on.w.calls.length = 0;
    const r = await perform(on.w, 'harden');
    assert.deepEqual(r, {result: {event: 'result', changed: 2}});
    valid('harden', r.result);
    assert.equal(on.w.devices.get(on.b).introducer, false);
    assert.equal(on.w.devices.get(on.a).introducer, true, 'a directly accepted computer keeps it');
    assert.equal(argvs(on.w).some(x => x.includes('delete')), false);
    assert.equal((await perform(on.w, 'status')).result.harden_pending, 0);
    assert.deepEqual(await perform(on.w, 'harden'), {result: {event: 'result', changed: 0}}, 'idempotent');
    const off = await makeGroup({policy: {hardenIntroduced: false}});
    off.w.calls.length = 0;
    assert.deepEqual(await perform(off.w, 'harden'), {result: {event: 'result', changed: 0}});
    assert.equal(off.w.calls.length, 0, 'a switch that is off is a no-op without a single call');
    assert.equal(off.w.devices.get(off.b).introducer, true);
    const fo = await makeGroup({policy: {hardenIntroduced: true}});
    fo.w.devices.get(fo.a).autoAcceptFolders = true;
    assert.equal((await perform(fo.w, 'status')).result.state, 'foreign-config');
    assert.equal((await perform(fo.w, 'harden')).result.changed, 2);
    const fr = await makeGroup({policy: {hardenIntroduced: true}});
    await perform(fr.w, 'revoke', {ids: [fr.d]});
    const nowOn = fr.w.devices.get(fr.b).introducer;
    assert.equal(nowOn, false);
});

test('T-N20: promote raises the flag of directly accepted computers only; refused for an introduced one, an unknown one, in foreign-config', async () => {
    const w = await ready();
    const [a, b, c] = ids(3);
    w.pair(a, {introducer: false});                               // a pair of 0.2.5
    w.pair(b, {introducer: false});
    w.introduce(c, a, {introducer: false});
    connectAll(w);
    assert.equal((await perform(w, 'status')).result.promote_pending, 2);
    w.calls.length = 0;
    assert.equal((await perform(w, 'promote', {ids: [c]})).error.code, 'E_BAD_ID');
    assert.equal((await perform(w, 'promote', {ids: [OTHER]})).error.code, 'E_BAD_ID');
    assert.equal((await perform(w, 'promote', {ids: [a, c]})).error.code, 'E_BAD_ID');
    assert.equal(argvs(w).filter(isWrite).length, 0, 'zero writes for a bad list');
    const r = await perform(w, 'promote', {ids: [a, b]});
    assert.deepEqual(r, {result: {event: 'result', changed: 2}});
    valid('promote', r.result);
    assert.equal(w.devices.get(a).introducer && w.devices.get(b).introducer, true);
    assert.equal(w.devices.get(c).introducer, false);
    assert.equal((await perform(w, 'status')).result.promote_pending, 0);
    assert.deepEqual(await perform(w, 'promote', {ids: [a]}), {result: {event: 'result', changed: 0}}, 'a second time changes nothing');
    w.devices.get(a).autoAcceptFolders = true;
    assert.equal((await perform(w, 'promote', {ids: [b]})).error.code, 'E_FOREIGN_DEVICE');
});

test('T-N17: ack adds computers the user has seen to the acknowledged set; a new row stops being new; unknown IDs are E_BAD_ID', async () => {
    const {w, a, b, c, d} = await makeGroup();
    let s = (await perform(w, 'status')).result;
    assert.deepEqual(s.peers.filter(p => p.new).map(p => p.id).sort(), [b, c].sort());
    w.calls.length = 0;
    assert.equal((await perform(w, 'ack', {ids: [OTHER]})).error.code, 'E_BAD_ID');
    assert.equal((await perform(w, 'ack', {ids: [OWN]})).error.code, 'E_BAD_ID');
    assert.equal(w.fsMap.has(STATE(w)), false);
    assert.deepEqual(await perform(w, 'ack', {ids: [b]}), {result: {event: 'result', changed: 1}});
    s = (await perform(w, 'status')).result;
    assert.deepEqual(s.peers.filter(p => p.new).map(p => p.id), [c]);
    assert.deepEqual(await perform(w, 'ack', {all: true}), {result: {event: 'result', changed: 1}});
    assert.equal((await perform(w, 'status')).result.peers.some(p => p.new), false);
    assert.deepEqual(await perform(w, 'ack', {all: true}), {result: {event: 'result', changed: 0}});
    valid('ack', (await perform(w, 'ack', {ids: [a, d]})).result);
    // an introduction that arrives later is new again
    w.introduce(makeId(70), a);
    assert.equal((await perform(w, 'status')).result.peers.filter(p => p.new).length, 1);
});

test('host and join write the accepted computer into the acknowledged set; a typed ID is no longer a tombstone', async () => {
    const w = await ready();
    putState(w, {tomb: [PEER]});
    w.connections.set(PEER, true);
    await perform(w, 'join', PEER);
    const st = stateOf(w);
    assert.deepEqual([st.ack, st.tomb], [[PEER], []]);
    assert.equal((await perform(w, 'status')).result.peers[0].new, false);
});

test('the dwell is a parameter of the engine (timing.dwellMs) and the default is the policy value', async () => {
    const {w, b} = await makeGroup();
    const t0 = w.mono;
    await perform(w, 'revoke', {ids: [b]});
    assert.equal(w.mono - t0 >= DWELL_MS, true);
});

test('promote is refused over the limit (E_GROUP_FULL); join too, also over the read cap, with nothing added (review of 0.2.6)', async () => {
    const w = await ready();
    const list = ids(11);
    list.forEach((id, i) => w.pair(id, {introducer: i !== 0, name: `pc-${i}`}));
    w.calls.length = 0;
    assert.deepEqual(await perform(w, 'promote', {ids: [list[0]]}), {error: {code: 'E_GROUP_FULL'}});
    assert.equal(argvs(w).filter(isWrite).length, 0);
    const cap = await ready();
    ids(30).forEach(id => cap.introduce(id, makeId(1), {introducer: false}));
    cap.calls.length = 0;
    assert.deepEqual(await perform(cap, 'join', THIRD), {error: {code: 'E_GROUP_FULL'}});
    assert.equal(argvs(cap).filter(isWrite).length, 0, 'two groups are not merged by a flood of devices');
});

test('host: the count is checked again at the click; an introduction that filled the group while the window was open ends in E_GROUP_FULL', async () => {
    const w = await ready();
    w.group(ids(8));
    connectAll(w);
    w.at(3000, x => { x.pending[PEER] = {time: new Date(x.clock).toISOString().replace(/\.\d+Z$/, 'Z'), name: 'new-laptop', address: ''}; });
    w.at(5000, x => x.introduce(makeId(90), makeId(1)));       // the 9th arrives by introduction
    w.at(7000, x => x.write(`accept ${PEER}\n`));
    const r = await perform(w, 'host');
    assert.deepEqual(r.error, {code: 'E_GROUP_FULL'});
    assert.equal(w.devices.has(PEER), false);
});

test('forget <ID> writes the tombstone BEFORE it deletes: a lister that brings the device back before the read-back still leaves the tombstone', async () => {
    const {w, a, d} = await makeGroup({policy: {shortcutRemove: true}});
    w.remoteLists.push({by: a, id: d, name: 'pc-d'});
    const r = await perform(w, 'forget', {ids: [d]});
    assert.equal(r.error.code, 'E_CLI_FAILED');
    assert.deepEqual(stateOf(w).tomb, [d]);
    assert.equal((await perform(w, 'status')).result.peers.find(p => p.id === d).returned, true);
});

test('an unreadable state file stays a freeze over every peer when ack rewrites it', async () => {
    const {w, a, d} = await makeGroup();
    w.put(STATE(w), 'garbage', 0o600);
    await perform(w, 'ack', {ids: [a]});
    const st = stateOf(w);
    assert.deepEqual(st.freeze.ids.sort(), [...w.devices.keys()].filter(id => id !== OWN).sort());
    w.devices.get(a).introducer = false;
    await perform(w, 'finish');
    assert.equal(w.devices.get(a).introducer, true, 'finish still restores the flags of every peer');
    assert.equal(w.devices.get(d).introducer, true);
});

test('counts above 99 still fit the contract (a hostile introducer can inflate them); revoke over the freeze cap is a visible error, not a success', async () => {
    const w = await ready();
    const many = ids(150);
    many.forEach(id => w.introduce(id, makeId(1000), {introducer: false}));
    w.calls.length = 0;
    const before = snapshot(w);
    assert.deepEqual(await perform(w, 'revoke', {ids: [many[0]]}), {error: {code: 'E_GROUP_FULL', step: 'freeze'}});
    assert.equal(argvs(w).filter(isWrite).length, 0, 'refused before anything is written');
    assert.equal(snapshot(w), before);
    assert.equal(w.fsMap.has(STATE(w)), false, 'not even the state file');
    valid('revoke', {event: 'result', removed: [many[0]], returned: [], offline: [], remaining: 149, revocation_open: true});
});

// ---- PLAN-ADMISSION-0.2.6 section 10: the conditions the gate checks -----------------------------------------------------------

// every write of a run must be one of: an introducer flag set to false on a LISTED peer, or a delete of a NAMED ID (its share or its device)
const onlyFlagsAndNamed = (w, listed, named) => {
    for (const a of argvs(w).filter(isWrite)) {
        if (a.includes('introducer')) {
            assert.deepEqual([a.at(-2), a.at(-1)], ['set', 'false'], `a flag is only lowered: ${a.join(' ')}`);
            assert.ok(listed.includes(a[a.indexOf('introducer') - 1]), `a listed peer: ${a.join(' ')}`);
        } else {
            assert.equal(a.at(-1), 'delete', `only deletions besides the flags: ${a.join(' ')}`);
            assert.ok(named.some(id => a.includes(id)), `a named ID: ${a.join(' ')}`);
        }
    }
};

test('section 10 point 1: revoke and forget <ID> in foreign-config and over-limit write only introducer flags (down) and the named deletions; an ID that was not read in that run is E_BAD_ID', async () => {
    for (const label of ['foreign-config', 'over-limit', 'over the read cap']) {
        const w = await ready({policy: {shortcutRemove: true}});
        const list = ids(label === 'over the read cap' ? FREEZE_MAX + 4 : 12);
        w.group(list);
        if (label === 'foreign-config')
            w.devices.get(list[0]).autoAcceptFolders = true;
        const st = (await perform(w, 'status')).result;
        assert.equal(label === 'foreign-config' ? st.state : st.over_limit, label === 'foreign-config' ? 'foreign-config' : true, label);
        w.calls.length = 0;
        const before = snapshot(w);
        for (const bad of [{ids: [OTHER]}, {ids: [list[0], OTHER]}, {ids: [OWN]}, {ids: []}]) {
            assert.deepEqual(await perform(w, 'revoke', bad), {error: {code: 'E_BAD_ID'}}, `${label} ${JSON.stringify(bad)}`);
        }
        assert.equal(argvs(w).filter(isWrite).length, 0, `${label}: nothing written for a bad list`);
        assert.equal(snapshot(w), before);
        assert.equal(w.fsMap.has(STATE(w)), false, `${label}: not even the state file`);
        const named = [list[list.length - 1], list[1]];
        if (label === 'over the read cap') {                                  // more peers than the freeze can record: refused, nothing written
            assert.deepEqual(await perform(w, 'revoke', {ids: named}), {error: {code: 'E_GROUP_FULL', step: 'freeze'}});
            assert.equal(argvs(w).filter(isWrite).length, 0);
            assert.equal(snapshot(w), before);
            continue;
        }
        const r = await perform(w, 'revoke', {ids: named});
        assert.deepEqual(r.result.removed, named, label);
        onlyFlagsAndNamed(w, list, named);
        assert.ok(argvs(w).filter(isWrite).some(a => a.includes('introducer')), `${label}: the freeze lowered flags`);
        assert.ok(stateOf(w).freeze.ids.length <= FREEZE_MAX);
        for (const id of list.filter(i => !named.includes(i)))
            assert.equal(w.devices.has(id), true, `${label}: the rest of the list is untouched`);
    }
    // the shortcut in foreign-config: one directly accepted device, nothing else
    const f = await ready({policy: {shortcutRemove: true}});
    const [a, b] = ids(2);
    f.pair(a, {introducer: true});
    f.pair(b, {introducer: true});
    f.devices.get(b).autoAcceptFolders = true;
    f.calls.length = 0;
    assert.deepEqual((await perform(f, 'forget', {ids: [a]})).result.remaining, 1);
    onlyFlagsAndNamed(f, [], [a]);
});

test('section 10 point 3: forget <ID> on an introduced row is E_BAD_ID in the ENGINE even with the switch on, zero writes; on a directly accepted row it works', async () => {
    const {w, a, b, c} = await makeGroup({policy: {shortcutRemove: true}});
    for (const id of [b, c]) {
        w.calls.length = 0;
        assert.deepEqual(await perform(w, 'forget', {ids: [id]}), {error: {code: 'E_BAD_ID'}});
        assert.equal(argvs(w).filter(isWrite).length, 0);
        assert.equal(w.fsMap.has(STATE(w)), false);
    }
    assert.equal((await perform(w, 'forget', {ids: [a]})).result.remaining, 3);
    // with the switch off (the value of the release) even the directly accepted row is refused
    const off = await makeGroup({policy: {shortcutRemove: false}});
    assert.deepEqual(await perform(off.w, 'forget', {ids: [off.a]}), {error: {code: 'E_BAD_ID'}});
});

test('section 10 point 4: harden only lowers - it never raises a flag, never deletes, never touches a directly accepted device', async () => {
    const w = await ready({policy: {hardenIntroduced: true}});
    const [a, b, c, d] = ids(4);
    w.pair(a, {introducer: false});                              // a 0.2.5 pair: off, and harden must not turn it on
    w.pair(d, {introducer: true});
    w.introduce(b, d, {introducer: true});                       // the daemon copied the flag
    w.introduce(c, d, {introducer: false});                      // already down
    connectAll(w);
    const before = snapshot(w);
    w.calls.length = 0;
    assert.deepEqual(await perform(w, 'harden'), {result: {event: 'result', changed: 1}});
    const writes = argvs(w).filter(isWrite);
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].slice(-3), ['introducer', 'set', 'false']);
    assert.equal(writes[0].includes(b), true);
    assert.equal(writes.some(x => x.at(-1) === 'true' || x.includes('delete') || x.includes('add')), false);
    assert.deepEqual([w.devices.get(a).introducer, w.devices.get(d).introducer, w.devices.get(b).introducer, w.devices.get(c).introducer], [false, true, false, false]);
    const after = JSON.parse(snapshot(w));
    assert.deepEqual(after[0].map(([id]) => id).sort(), JSON.parse(before)[0].map(([id]) => id).sort(), 'no device added or removed');
    assert.deepEqual(await perform(w, 'harden'), {result: {event: 'result', changed: 0}});
});

test('section 10 point 2: promote is refused in foreign-config, over the limit and while a removal is open, with zero writes; it raises only directly accepted devices that are off', async () => {
    const mk = async () => {
        const w = await ready();
        const [a, b, c] = ids(3);
        w.pair(a, {introducer: false});
        w.pair(b, {introducer: true});
        w.introduce(c, b, {introducer: false});
        connectAll(w);
        return {w, a, b, c};
    };
    const fo = await mk();
    fo.w.devices.get(fo.b).autoAcceptFolders = true;
    const ov = await ready();
    const list = ids(11);
    list.forEach((id, i) => ov.pair(id, {introducer: i !== 0}));
    const re = await mk();
    await perform(re.w, 'revoke', {ids: [re.c]});
    for (const [label, w, id, code] of [['foreign-config', fo.w, fo.a, 'E_FOREIGN_DEVICE'], ['over-limit', ov, list[0], 'E_GROUP_FULL'], ['revocation-open', re.w, re.a, 'E_REVOCATION_OPEN']]) {
        w.calls.length = 0;
        assert.deepEqual(await perform(w, 'promote', {ids: [id]}), {error: {code}}, label);
        assert.equal(argvs(w).filter(isWrite).length, 0, label);
    }
    const ok = await mk();
    ok.w.calls.length = 0;
    assert.deepEqual(await perform(ok.w, 'promote', {ids: [ok.a, ok.b]}), {result: {event: 'result', changed: 1}}, 'b is on already');
    const writes = argvs(ok.w).filter(isWrite);
    assert.deepEqual(writes.map(x => [x[x.indexOf('introducer') - 1], x.at(-1)]), [[ok.a, 'true']]);
    assert.equal(ok.w.devices.get(ok.c).introducer, false, 'an introduced device is never promoted');
});

test('section 10 point 5 (F4): host reads the device list again right before the add; a computer that is listed by then, or a tombstone, is never made a directly accepted one', async () => {
    for (const how of ['introduced', 'tombstone']) {
        const w = await ready();
        const [a, b] = ids(2);
        w.pair(a, {introducer: true});
        w.introduce(b, a);
        connectAll(w);
        w.at(1000, x => { x.pending[PEER] = {time: new Date(x.clock).toISOString().replace(/\.\d+Z$/, 'Z'), name: 'new-laptop', address: ''}; });
        w.at(4000, x => x.write(`accept ${PEER}\n`));
        const ports = w.ports();
        const real = w.run;
        let prev = null;
        ports.run = {
            syncthing: async (sub, args, opts) => {
                const key = sub === 'cli' ? args.join(' ') : sub;
                // two device list calls in a row: the second is the re-read of the accept sequence (a poll is `show pending` then `list`)
                if (key === 'config devices list' && prev === 'config devices list') {
                    if (how === 'introduced')
                        w.introduce(PEER, a, {name: 'pc-new'});
                    else
                        w.put(STATE(w), `${JSON.stringify({v: 1, ack: [], tomb: [PEER], freeze: null})}\n`, 0o600);
                }
                prev = key;
                return real.syncthing(sub, args, opts);
            },
            systemctl: real.systemctl,
        };
        const r = await createEngine(ports).perform('host');
        assert.deepEqual(r.error?.code, 'E_PENDING_AMBIGUOUS', how);
        assert.equal(argvs(w).some(x => x.includes('add') && x.includes(PEER)), false, `${how}: the add never ran`);
        if (how === 'introduced')
            assert.equal(w.devices.get(PEER).introducedBy, a, 'an introduced device stays introduced');
        else
            assert.equal(w.devices.has(PEER), false);
    }
});

test('section 10 point 6: finish refuses while a tombstoned ID is in the device list, and works from an unreadable state file; the freeze ends only after the flags hold', async () => {
    const {w, a, b} = await makeGroup();
    await perform(w, 'revoke', {ids: [b]});
    w.introduce(b, a);                                           // it is back
    w.calls.length = 0;
    assert.deepEqual(await perform(w, 'finish'), {error: {code: 'E_REVOCATION_OPEN'}});
    assert.equal(argvs(w).filter(isWrite).length, 0);
    assert.equal(stateOf(w).freeze !== null, true, 'still frozen');
    // order of finish: the flags first and the read-back, then the state file that closes the freeze (a crash leaves a freeze that is simply finished again)
    const x = await makeGroup();
    await perform(x.w, 'revoke', {ids: [x.b]});
    const order = [];
    const real = x.w.run;
    const realWrite = x.w.files.writeText;
    x.w.files.writeText = (p, text, mode) => { if (p === STATE(x.w)) order.push('state'); return realWrite(p, text, mode); };
    const ports = x.w.ports();
    ports.run = {syncthing: async (sub, args, opts) => { if (sub === 'cli' && args.includes('introducer')) order.push('flag'); return real.syncthing(sub, args, opts); }, systemctl: real.systemctl};
    await createEngine(ports).perform('finish');
    assert.deepEqual(order.filter((v, i) => v !== order[i - 1]), ['flag', 'state'], 'flags, then the state file');
    assert.equal(stateOf(x.w).freeze, null);
    assert.equal(x.w.devices.get(x.d).introducer, true);
});

test('section 10 point 7 (F7): a tombstone is lifted by the user (ack <ID>, "add again"), status names the removed computers, and host offers the computer again', async () => {
    const {w, a, b} = await makeGroup();
    const r = await perform(w, 'revoke', {ids: [b]});
    assert.deepEqual(r.result.removed, [b]);
    const s0 = (await perform(w, 'status')).result;
    assert.deepEqual(s0.removed, [b], 'the removed computer is named so the window can offer "add again"');
    valid('status', s0);
    assert.equal(s0.peers.some(p => p.id === b), false);
    await perform(w, 'finish');
    // lift: only an ID that is a tombstone here (or in the list); anything else is E_BAD_ID with zero writes
    w.calls.length = 0;
    assert.deepEqual(await perform(w, 'ack', {ids: [OTHER]}), {error: {code: 'E_BAD_ID'}});
    assert.deepEqual(await perform(w, 'ack', {ids: [b, OTHER]}), {error: {code: 'E_BAD_ID'}});
    assert.equal(stateOf(w).tomb.includes(b), true, 'a bad list lifts nothing');
    const lifted = await perform(w, 'ack', {ids: [b]});
    assert.deepEqual(lifted, {result: {event: 'result', changed: 1}});
    valid('ack', lifted.result);
    assert.equal(argvs(w).filter(isWrite).length, 0, 'only the state file changes');
    assert.equal(stateOf(w).tomb.includes(b), false);
    assert.deepEqual((await perform(w, 'status')).result.removed, []);
    assert.deepEqual(await perform(w, 'ack', {ids: [b]}), {error: {code: 'E_BAD_ID'}}, 'a second time it is not a tombstone any more');
    // the lifted computer is now a candidate of host, which still needs the click
    w.at(w.mono + 3000, x => { x.pending[b] = {time: new Date(x.clock).toISOString().replace(/\.\d+Z$/, 'Z'), name: 'pc-b', address: ''}; });
    w.at(w.mono + 7000, x => x.write(`accept ${b}\n`));
    w.connections.set(b, true);
    const h = await perform(w, 'host');
    assert.equal(h.result?.peer?.id, b, JSON.stringify(h));
    assert.equal(w.devices.get(b).introducedBy, '');
    assert.equal(w.devices.get(a).introducedBy, '');
});

test('status.removed: the newest REMOVED_MAX tombstones that are not in the list, newest first; a tombstone that is in the list is a returned row, not a removed one', async () => {
    const w = await ready();
    const list = ids(6);
    const [a, ...gone] = list;
    w.pair(a, {introducer: true});
    putState(w, {ack: [a], tomb: gone});
    const s = (await perform(w, 'status')).result;
    assert.deepEqual(s.removed, gone.slice(-REMOVED_MAX).reverse());
    valid('status', s);
    const back = await ready();
    back.pair(a, {introducer: true});
    putState(back, {ack: [a], tomb: [a, gone[0]]});
    const sb = (await perform(back, 'status')).result;
    assert.deepEqual(sb.removed, [gone[0]]);
    assert.equal(sb.peers[0].returned, true);
});
