// SPDX-License-Identifier: GPL-3.0-or-later
// sync/protocol.js against the contract fixtures in sync-tests/contract/ (both sides replay the SAME files) and on its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {
    BRIDGE_ONLY_CODES, ERROR_CODES, ID_VERBS, INFORMATION_CODES, MAX_LINE_BYTES, MAX_TOTAL_BYTES, RESERVED_CODES, VERBS, acceptLine, argvFor,
    checkRun, createRunChecker, emit, isKnownStep, isNeutralCode, joinStdin, parse, parseAcceptLine, parseArgs,
} from '../sync/protocol.js';
import {MAX_COMPUTERS, MAX_PEERS} from '../sync/policy.js';
import {makeId} from './support/ids.js';

const dir = new URL('./contract/', import.meta.url);
const INDEX = JSON.parse(readFileSync(new URL('index.json', dir), 'utf8'));
const A = 'F6HEWOE-4KSACQ5-5MAX7IC-HAP3EGW-AQYBTIX-V74MXIF-ZB3GZN6-4T3QYQZ';
const B = 'VTTWEJK-SMIOBMH-3FIWS7V-JFC2CL4-FCR3BU6-PEPADRQ-EYVVD3Z-BIGMUQ5';
const linesOf = file => readFileSync(new URL(file, dir), 'utf8').split('\n').filter(l => l !== '');

test('the fixture directory and index.json list the same files', () => {
    const files = readdirSync(dir).filter(f => f.endsWith('.ndjson')).sort();
    assert.deepEqual(Object.keys(INDEX).sort(), files);
});

test('the fixtures the Interface file names exist (section 5, with the 0.2.5 names where the code form is reserved)', () => {
    const required = [
        'status-no-syncthing', 'status-not-set-up', 'status-stfolder-conflict', 'status-foreign-config', 'status-set-up', 'status-half',
        'status-paired', 'status-flapping', 'status-listener-degraded', 'host-foreign-device', 'join-foreign-device', 'setup-foreign-device', 'setup-ok', 'setup-fail-systemd',
        'host-ok', 'host-expired', 'host-stdin-eof', 'join-ok', 'join-flapping', 'forget-ok', 'oversize', 'not-json', 'v2',
        // 0.2.6 (PLAN-0.2.6 3.2)
        'status-group-3', 'status-group-new', 'status-over-limit', 'status-revocation-open', 'status-returned', 'status-promote-pending', 'status-max-size',
        'status-removed', 'host-group-full', 'host-revocation-open', 'finish-returned', 'revoke-ok', 'revoke-returned', 'finish-ok', 'harden-ok', 'promote-ok', 'forget-all-ok', 'forget-one-ok', 'ack-ok',
    ];
    for (const r of required)
        assert.ok(INDEX[`${r}.ndjson`], r);
});

test('every fixture replays to the outcome the index states', () => {
    for (const [file, spec] of Object.entries(INDEX)) {
        const r = checkRun(spec.verb, linesOf(file), spec.rc);
        if (spec.expect === 'result') {
            assert.equal(r.ok, true, file);
            assert.equal(r.outcome.kind, 'result', file);
        } else if (spec.expect.startsWith('error:')) {
            assert.equal(r.ok, true, file);
            assert.deepEqual([r.outcome.kind, r.outcome.code], ['error', spec.expect.slice(6)], file);
        } else {
            assert.deepEqual([r.ok, r.code], [false, spec.expect], file);
        }
    }
});

test('the foreign-config state is a RESULT with rc 0, the list of peers and no link; E_FOREIGN_DEVICE comes from setup, host, join and promote only (Robert 8389)', () => {
    const r = checkRun('status', linesOf('status-foreign-config.ndjson'), 0);
    assert.equal(r.outcome.result.state, 'foreign-config');
    assert.ok(r.outcome.result.peers.length > 0 && r.outcome.result.peers.every(p => p.link === null && p.connected === null));
    for (const f of ['setup-foreign-device', 'host-foreign-device', 'join-foreign-device'])
        assert.equal(INDEX[`${f}.ndjson`].expect, 'error:E_FOREIGN_DEVICE');
    assert.equal(INDEX['status-foreign-device.ndjson'], undefined);
    const asStatus = emit.bind(null, {event: 'error', code: 'E_FOREIGN_DEVICE'});
    for (const verb of ['status', 'own-id', 'forget', 'revoke', 'finish', 'harden', 'ack'])
        assert.throws(() => asStatus(verb), /not raised by/);                  // revoke, forget and harden must run in foreign-config (PLAN-0.2.6 F7)
    for (const verb of ['setup', 'host', 'join', 'promote'])
        assert.doesNotThrow(() => asStatus(verb));
    const line = JSON.stringify({v: 1, event: 'error', code: 'E_FOREIGN_DEVICE'});
    assert.equal(parse(line, 'status'), null);
    assert.deepEqual(parse(line, 'join'), {event: 'error', code: 'E_FOREIGN_DEVICE'});
});

test('error codes: the closed list, the pinned information codes, the reserved and the bridge-only codes', () => {
    assert.deepEqual([...INFORMATION_CODES].sort(), ['E_ALREADY_PAIRED', 'E_GROUP_FULL', 'E_REVOCATION_OPEN', 'E_STFOLDER_EXISTS']);
    for (const c of ERROR_CODES)
        assert.equal(isNeutralCode(c), INFORMATION_CODES.includes(c), c);
    for (const c of ['E_BAD_CODE', 'E_OWN_CODE', 'E_FOREIGN_DEVICE', 'E_NOT_A_CODE', 'E_INTERNAL', 'E_PROTOCOL'])
        assert.equal(isNeutralCode(c), false, c);
    assert.deepEqual([...RESERVED_CODES], ['E_BAD_CODE', 'E_OWN_CODE', 'E_NOT_UP_TO_DATE']);
    for (const c of RESERVED_CODES) {
        assert.equal(ERROR_CODES.includes(c), false);
        assert.throws(() => emit({event: 'error', code: c}, 'join'), /may raise/);       // never emitted today
    }
    for (const c of ['E_PENDING_AMBIGUOUS', 'E_BAD_ID', 'E_OWN_ID', 'E_FOREIGN_DEVICE', 'E_GROUP_FULL', 'E_REVOCATION_OPEN'])
        assert.ok(ERROR_CODES.includes(c), c);
    for (const c of BRIDGE_ONLY_CODES) {
        assert.throws(() => emit({event: 'error', code: c}, 'host'), /may raise/);
        assert.equal(parse(JSON.stringify({v: 1, event: 'error', code: c})), null);
    }
    assert.equal(new Set(ERROR_CODES).size, ERROR_CODES.length);
});

test('no module under sync/ can produce E_BAD_CODE or E_OWN_CODE: only the reserved list of protocol.js names them (grep gate)', () => {
    const syncDir = new URL('../sync/', import.meta.url);
    for (const f of readdirSync(syncDir).filter(n => n.endsWith('.js'))) {
        const text = readFileSync(new URL(f, syncDir), 'utf8').replace(/\/\/.*$/gm, '');
        const hits = text.match(/E_BAD_CODE|E_OWN_CODE/g) ?? [];
        assert.equal(hits.length, f === 'protocol.js' ? 2 : 0, f);
    }
});

test('parse: not JSON, not an object, v other than 1, unknown event, a line over 4 KiB: all null', () => {
    const ok = {v: 1, event: 'progress', step: 'instance', state: 'start'};
    assert.deepEqual(parse(JSON.stringify(ok)), {event: 'progress', step: 'instance', state: 'start'});
    for (const bad of ['', 'x', '[]', '5', 'null', JSON.stringify({...ok, v: 2}), JSON.stringify({...ok, v: '1'}), JSON.stringify({...ok, event: 'nope'}),
        JSON.stringify({event: 'progress', step: 'instance', state: 'start'}), JSON.stringify({...ok, pad: 'x'.repeat(MAX_LINE_BYTES)})])
        assert.equal(parse(bad), null, bad.slice(0, 40));
    assert.equal(parse(null), null);
    assert.equal(parse(5), null);
    assert.equal(parse(JSON.stringify({...ok, pad: 'é'.repeat(2100)})), null);           // 4 KiB in bytes, not in characters
});

test('parse: unknown fields are dropped, an unknown step reads as null (the window ignores it), an unknown error code reads as E_INTERNAL', () => {
    assert.deepEqual(parse(JSON.stringify({v: 1, event: 'progress', step: 'instance', state: 'ok', future: [1]})), {event: 'progress', step: 'instance', state: 'ok'});
    const e = parse(JSON.stringify({v: 1, event: 'progress', step: 'brand-new', state: 'start'}));
    assert.equal(e.step, null);
    assert.equal(isKnownStep(e.step), false);
    assert.equal(isKnownStep('share'), true);
    assert.deepEqual(parse(JSON.stringify({v: 1, event: 'error', code: 'E_FROM_THE_FUTURE', step: 'x'})), {event: 'error', code: 'E_INTERNAL', step: null});
    assert.deepEqual(parse(JSON.stringify({v: 1, event: 'error', code: 'E_EXPIRED', step: 'share', extra: {}}), 'host'), {event: 'error', code: 'E_EXPIRED', step: 'share'});
    assert.deepEqual(parse(JSON.stringify({v: 1, event: 'error', code: 'E_BAD_CODE'})), {event: 'error', code: 'E_INTERNAL'});      // reserved: generic
});

test('the code form is 0.2.6: the events `code` and `attempts` are not part of the wire today', () => {
    assert.equal(parse(JSON.stringify({v: 1, event: 'code', code: 'X', expires_s: 900})), null);
    assert.equal(parse(JSON.stringify({v: 1, event: 'attempts', ignored: 1})), null);
    assert.throws(() => emit({event: 'code', code: 'X', expires_s: 900}));
    assert.throws(() => emit({event: 'attempts', ignored: 1}));
});

test('candidate and peer: the FULL canonical ID with valid check characters, the name null or 1-32 printable ASCII', () => {
    const cand = (id, name) => JSON.stringify({v: 1, event: 'candidate', id, name});
    assert.deepEqual(parse(cand(B, 'laptop-b')), {event: 'candidate', id: B, name: 'laptop-b'});
    assert.deepEqual(parse(cand(B, null)), {event: 'candidate', id: B, name: null});
    assert.deepEqual(parse(cand(B, 'x'.repeat(32))), {event: 'candidate', id: B, name: 'x'.repeat(32)});
    for (const name of ['x'.repeat(33), '', 'café', 'a\nb', '<b>ok</b>\u0007', 5, undefined])
        assert.equal(parse(name === undefined ? JSON.stringify({v: 1, event: 'candidate', id: B}) : cand(B, name)), name === '<b>ok</b>\u0007' ? null : null, String(name));
    assert.deepEqual(parse(cand(B, '<b>x</b>')), {event: 'candidate', id: B, name: '<b>x</b>'});      // markup passes as text; the window has markup off
    for (const id of [B.toLowerCase(), B.replace(/-/g, ''), B.slice(0, 62), `${B.slice(0, 62)}A`, null, 5, ''])
        assert.equal(parse(cand(id, 'n')), null, String(id));
    assert.deepEqual(parse(JSON.stringify({v: 1, event: 'peer', id: B, name: null})), {event: 'peer', id: B, name: null});
    assert.equal(parse(JSON.stringify({v: 1, event: 'peer', id: B.slice(0, 14), name: null})), null);          // no prefix: the full ID (Interface 2a)
});

const emitThrows = ev => { try { emit({event: 'link', ...ev}); return false; } catch { return true; } };

test('link: state none|flapping|stable and connected_s, a whole number exactly when stable', () => {
    for (const s of ['none', 'flapping'])
        assert.ok(parse(JSON.stringify({v: 1, event: 'link', state: s, connected_s: null})));
    assert.ok(parse(JSON.stringify({v: 1, event: 'link', state: 'stable', connected_s: 9})));
    for (const bad of [{state: 'connected', connected_s: 9}, {state: 'stable'}, {state: 'stable', connected_s: null}, {state: 'stable', connected_s: 'nine'},
        {state: 'stable', connected_s: 9.5}, {state: 'stable', connected_s: -1}, {state: 'flapping', connected_s: 9}, {state: 'none', connected_s: 0}, {connected_s: 9},
        {state: 'none'}, {state: 'none', up_to_date: false}, {state: 'stable', connected_s: 9, up_to_date: true}])
        assert.equal(emitThrows(bad) || parse(JSON.stringify({v: 1, event: 'link', ...bad})) === null, true, JSON.stringify(bad));
});

test('result of host and join is the proof: link stable with connected_s, up_to_date null, otherwise it is not a result (section 3)', () => {
    const base = {v: 1, event: 'result', peer: {id: B, name: 'b'}, connected: true, link: 'stable', connected_s: 9, up_to_date: null, notes: 3};
    assert.ok(parse(JSON.stringify(base), 'host'));
    for (const bad of [{link: 'flapping'}, {link: 'none'}, {link: null}, {up_to_date: false}, {up_to_date: true}, {connected_s: null}, {connected_s: 1.5}, {connected: 'true'}, {notes: -1}, {notes: 1.5}, {peer: null}, {peer: {id: B}}])
        assert.equal(parse(JSON.stringify({...base, ...bad}), 'host'), null, JSON.stringify(bad));
    const j = {...base, own_id: A};
    assert.ok(parse(JSON.stringify(j), 'join'));
    assert.equal(parse(JSON.stringify(base), 'join'), null);                                  // join carries the own ID
    assert.equal(parse(JSON.stringify({...j, own_id: A.slice(0, 14)}), 'join'), null);        // in full
});

const groupPeer = (id, o = {}) => ({id, name: 'b', introduced_by: null, introducer: true, shared: true, connected: true, link: 'stable', connected_s: 9, new: false, returned: false, ...o});
const statusOf = (o = {}) => ({v: 1, event: 'result', state: 'paired', own_id: A, peers: [groupPeer(B)], computers: 2, max_computers: MAX_COMPUTERS, over_limit: false, revocation_open: false,
    harden_pending: 0, promote_pending: 0, removed: [], listener: 'ok', up_to_date: null, notes: 1, waiting: false, ...o});

test('result of status: the closed states, the list of peers, links null where they are not measured (PLAN-0.2.6 3.2)', () => {
    const st = (o = {}) => JSON.stringify(statusOf(o));
    assert.ok(parse(st(), 'status'));
    assert.equal(parse(st({state: 'connected'}), 'status'), null);
    assert.equal(parse(st({state: 'foreign-config'}), 'status'), null);                       // links must be null there
    const noLink = {connected: null, link: null, connected_s: null};
    assert.ok(parse(st({state: 'foreign-config', listener: null, peers: [groupPeer(B, noLink)]}), 'status'));
    assert.ok(parse(st({state: 'foreign-config', listener: null, peers: []}), 'status'));
    assert.equal(parse(st({state: 'foreign-config', listener: 'ok', peers: [groupPeer(B, noLink)]}), 'status'), null);
    assert.equal(parse(st({state: 'set-up'}), 'status'), null);                               // set-up has no peers
    assert.ok(parse(st({state: 'set-up', peers: [], computers: 1, listener: 'degraded'}), 'status'));
    assert.equal(parse(st({peers: []}), 'status'), null);                                     // paired needs peers
    assert.equal(parse(st({state: 'half'}), 'status'), null);                                 // half: none shared
    assert.ok(parse(st({state: 'half', peers: [groupPeer(B, {shared: false})]}), 'status'));
    assert.equal(parse(st({peers: [groupPeer(B, {shared: false})]}), 'status'), null);        // paired: at least one shared
    assert.equal(parse(st({peers: [groupPeer(B, {link: 'maybe'})]}), 'status'), null);
    assert.equal(parse(st({peers: [groupPeer(B, {connected_s: null})]}), 'status'), null);    // stable needs the count
    assert.equal(parse(st({peers: [groupPeer(B, {link: 'flapping'})]}), 'status'), null);     // and a count needs stable
    assert.ok(parse(st({peers: [groupPeer(B, {link: 'flapping', connected_s: null})]}), 'status'));
    assert.equal(parse(st({peers: [groupPeer(B, {link: null})]}), 'status'), null);           // link, connected and connected_s are null together
    assert.equal(parse(st({up_to_date: true}), 'status'), null);                              // always null
    for (const l of ['ok', 'degraded', 'down', null])
        assert.ok(parse(st({listener: l}), 'status'), String(l));
    for (const l of ['fine', 'OK', 5, undefined])
        assert.equal(parse(st({listener: l}), 'status'), null, String(l));
    for (const state of ['no-syncthing', 'not-set-up', 'stfolder-conflict']) {
        assert.ok(parse(st({state, peers: [], computers: null, listener: null, own_id: null, notes: null}), 'status'), state);
        assert.equal(parse(st({state, peers: [], listener: 'ok'}), 'status'), null, state);
        assert.equal(parse(st({state, peers: [groupPeer(B)], listener: null}), 'status'), null, state);
        assert.equal(parse(st({state, peers: [], listener: null, over_limit: true}), 'status'), null, state);
    }
    assert.equal(parse(st({waiting: null}), 'status'), null);
    // `removed`: tombstoned IDs that are not in the list, at most REMOVED_MAX, canonical, no duplicates
    const gone = [1, 2, 3, 4].map(i => makeId(40 + i));
    assert.ok(parse(st({removed: gone.slice(0, 3)}), 'status'));
    assert.equal(parse(st({removed: gone}), 'status'), null, 'more than REMOVED_MAX');
    assert.equal(parse(st({removed: [gone[0], gone[0]]}), 'status'), null);
    assert.equal(parse(st({removed: ['nope']}), 'status'), null);
    assert.equal(parse(st({removed: undefined}), 'status'), null, 'the key is required');
    assert.ok(parse(st({state: 'set-up', peers: [], computers: 1, removed: [gone[0]]}), 'status'), 'a set-up computer can have removed ones');
    assert.equal(parse(st({state: 'not-set-up', peers: [], computers: null, listener: null, own_id: null, notes: null, removed: [gone[0]]}), 'status'), null);
    assert.equal(parse(st({own_id: 'nope'}), 'status'), null);
    for (const k of ['state', 'own_id', 'peers', 'computers', 'max_computers', 'over_limit', 'revocation_open', 'harden_pending', 'promote_pending', 'listener', 'up_to_date', 'notes', 'waiting']) {
        const o = statusOf();
        delete o[k];
        assert.equal(parse(JSON.stringify(o), 'status'), null, `missing ${k}`);
    }
    for (const k of ['peer', 'connected', 'link', 'connected_s', 'shared'])                    // the 0.2.5 top-level fields are gone
        assert.equal(parse(JSON.stringify({...statusOf(), [k]: null}), 'status')[k], undefined, k);
});

test('status peers: every field of a peer is checked, at most MAX_COMPUTERS entries, no duplicate fields of text', () => {
    const st = o => parse(JSON.stringify(statusOf(o)), 'status');
    const one = o => st({peers: [groupPeer(B, o)]});
    assert.ok(one({}));
    assert.ok(one({name: null}));
    assert.ok(one({introduced_by: A}));
    for (const bad of [{id: A.slice(1)}, {name: 'x'.repeat(33)}, {name: ''}, {name: 'caf\u00e9'}, {introduced_by: 'x'}, {introduced_by: A.toLowerCase()}, {introducer: 1}, {shared: null}, {new: 'no'}, {returned: undefined}, {connected: 'yes'}])
        assert.equal(one(bad), null, JSON.stringify(bad));
    assert.equal(parse(JSON.stringify(statusOf({peers: [groupPeer(B), 5]})), 'status'), null);
    const ten = Array.from({length: MAX_COMPUTERS}, (_, i) => groupPeer(makeId(i)));
    assert.ok(st({peers: ten}));
    assert.equal(st({peers: [...ten, groupPeer(makeId(99))]}), null);
    assert.equal(st({max_computers: 1}), null);
    assert.equal(st({harden_pending: -1}), null);
    assert.equal(st({promote_pending: 1.5}), null);
    assert.equal(st({computers: 0}), null);
    assert.equal(st({revocation_open: 'yes'}), null);
});

test('status over the limit: the links are not measured, the list may be cut, the state is the one of the whole list; an unread list is half with no peers', () => {
    const ten = Array.from({length: MAX_COMPUTERS}, (_, i) => groupPeer(makeId(i), {connected: null, link: null, connected_s: null}));
    const o = {over_limit: true, computers: 12, peers: ten};
    assert.ok(parse(JSON.stringify(statusOf(o)), 'status'));
    assert.ok(parse(JSON.stringify(statusOf({...o, state: 'half'})), 'status'));              // the shared flags of the cut part are unknown
    assert.equal(parse(JSON.stringify(statusOf({...o, peers: [groupPeer(B)]})), 'status'), null);       // a measured link while over the limit
    assert.ok(parse(JSON.stringify(statusOf({over_limit: true, state: 'half', peers: [], computers: 40})), 'status'));
    assert.equal(parse(JSON.stringify(statusOf({over_limit: true, state: 'set-up', peers: [], computers: 40})), 'status'), null);
});

test('the largest status line fits with margin: 9 peers, every field at its maximum, under 3500 bytes (PLAN-0.2.6 F7, T-N25)', () => {
    const line = linesOf('status-max-size.ndjson').at(-1);
    const bytes = new TextEncoder().encode(line).length;
    assert.ok(bytes < 3500, `${bytes} bytes`);
    assert.ok(bytes < MAX_LINE_BYTES * 0.9);
    const ev = parse(line, 'status');
    assert.equal(ev.peers.length, MAX_PEERS);
    assert.ok(ev.peers.every(p => p.name.length === 32 && p.introduced_by !== null && p.new && p.returned));
    assert.equal(emit(ev, 'status'), line);
});

test('results of the new verbs: revoke, finish, harden, promote, ack, forget with a remaining count', () => {
    const rd = (verb, o) => parse(JSON.stringify({v: 1, event: 'result', ...o}), verb);
    const rv = {removed: [B], returned: [], offline: [{id: A, name: null}], remaining: 2, revocation_open: true};
    assert.ok(rd('revoke', rv));
    for (const bad of [{removed: [B, B]}, {removed: ['x']}, {returned: [A.slice(1)]}, {offline: [{id: A}]}, {offline: [5]}, {remaining: -1}, {remaining: 1.5}, {revocation_open: false}, {revocation_open: 'true'}])
        assert.equal(rd('revoke', {...rv, ...bad}), null, JSON.stringify(bad));
    assert.ok(rd('finish', {revocation_open: false}));
    assert.equal(rd('finish', {revocation_open: true}), null);
    for (const verb of ['harden', 'promote', 'ack']) {
        assert.ok(rd(verb, {changed: 0}), verb);
        assert.equal(rd(verb, {changed: -1}), null, verb);
        assert.equal(rd(verb, {changed: 'one'}), null, verb);
    }
    assert.ok(rd('forget', {state: 'set-up', remaining: 0}));
    assert.ok(rd('forget', {state: null, remaining: 3}));
    assert.equal(rd('forget', {state: 'set-up', remaining: 3}), null);                       // set-up is zero peers
    assert.equal(rd('forget', {state: null, remaining: 0}), null);
    assert.equal(rd('forget', {state: 'set-up'}), null);
    assert.equal(rd('forget', {remaining: 0}), null);
    const big = Array.from({length: MAX_PEERS + 1}, (_, i) => makeId(i));
    assert.equal(rd('revoke', {...rv, removed: big}), null);
});

test('emit: strict; a line that parse reads back identically; unknown event, unknown field, bad value, missing verb throw', () => {
    const ev = {event: 'candidate', id: B, name: 'laptop-b'};
    assert.deepEqual(parse(emit(ev)), ev);
    assert.equal(emit(ev).startsWith('{"v":1,"event":"candidate"'), true);
    assert.throws(() => emit({event: 'nope'}));
    assert.throws(() => emit({...ev, extra: 1}), /not part of/);
    assert.throws(() => emit({...ev, id: 'x'}));
    assert.throws(() => emit({...ev, name: 'x'.repeat(33)}));
    assert.throws(() => emit({event: 'result', own_id: A}), /needs its verb/);
    assert.throws(() => emit({event: 'progress', step: 'brand-new', state: 'start'}), /unknown progress step/);
    assert.throws(() => emit({event: 'error', code: 'E_BAD_ID'}, 'host'));                   // E_BAD_ID is the verbs with a typed or listed ID
    for (const verb of ['join', 'forget', 'revoke', 'promote', 'ack'])
        assert.doesNotThrow(() => emit({event: 'error', code: 'E_BAD_ID'}, verb), verb);
    for (const verb of ['host', 'join', 'setup', 'promote'])
        assert.doesNotThrow(() => emit({event: 'error', code: 'E_GROUP_FULL'}, verb), verb);
    for (const verb of ['status', 'revoke', 'forget', 'finish', 'ack', 'harden'])
        assert.throws(() => emit({event: 'error', code: 'E_GROUP_FULL'}, verb), verb);
    assert.throws(() => emit({event: 'error', code: 'E_REVOCATION_OPEN'}, 'revoke'));         // revoke always runs
    for (const verb of ['host', 'join', 'setup', 'promote', 'finish'])
        assert.doesNotThrow(() => emit({event: 'error', code: 'E_REVOCATION_OPEN'}, verb), verb);       // finish refuses while a removed computer is back
    assert.throws(() => emit({event: 'error', code: 'E_EXPIRED'}, 'join'));
    assert.throws(() => emit({event: 'error', code: 'E_PENDING_AMBIGUOUS'}, 'join'));
    assert.throws(() => emit({event: 'error', code: 'E_INTERNAL', step: 'unknown-step'}));
    assert.throws(() => emit(null));
});

test('the run checker: exactly one terminal line, last; rc must agree; nothing after the terminal', () => {
    const prog = JSON.stringify({v: 1, event: 'progress', step: 'instance', state: 'start'});
    const result = JSON.stringify({v: 1, event: 'result', own_id: A});
    const error = JSON.stringify({v: 1, event: 'error', code: 'E_INTERNAL'});
    assert.equal(checkRun('own-id', [prog, result], 0).ok, true);
    assert.equal(checkRun('own-id', [prog, error], 1).outcome.code, 'E_INTERNAL');
    assert.deepEqual(checkRun('own-id', [prog, result, prog], 0).code, 'E_PROTOCOL');           // a line after the terminal
    assert.deepEqual(checkRun('own-id', [prog, result, result], 0).code, 'E_PROTOCOL');         // two terminal lines
    assert.deepEqual(checkRun('own-id', [prog], 0).code, 'E_ENGINE_DIED');                      // no terminal line
    assert.deepEqual(checkRun('own-id', [], 0).code, 'E_ENGINE_DIED');
    assert.deepEqual(checkRun('own-id', [prog, result], 1).code, 'E_ENGINE_DIED');              // result but rc 1
    assert.deepEqual(checkRun('own-id', [prog, error], 0).code, 'E_ENGINE_DIED');               // error but rc 0
    assert.deepEqual(checkRun('own-id', [prog, result], 137).code, 'E_ENGINE_DIED');            // killed
    assert.deepEqual(checkRun('own-id', [prog, result], 2), {ok: false, code: 'E_ENGINE_DIED', usage: true, events: [{event: 'progress', step: 'instance', state: 'start'}, {event: 'result', own_id: A}]});
    assert.deepEqual(checkRun('own-id', ['junk', result], 0).code, 'E_PROTOCOL');
});

test('the run checker: events that belong to host or join only, per verb', () => {
    const cand = emit({event: 'candidate', id: B, name: 'n'});
    const link = emit({event: 'link', state: 'none', connected_s: null});
    const peer = emit({event: 'peer', id: B, name: null});
    const err = JSON.stringify({v: 1, event: 'error', code: 'E_INTERNAL'});
    assert.equal(checkRun('host', [cand, link, peer, err], 1).ok, true);
    assert.equal(checkRun('join', [link, peer, err], 1).ok, true);
    assert.equal(checkRun('join', [cand, err], 1).code, 'E_PROTOCOL');                    // no candidate in join
    for (const verb of ['status', 'setup', 'own-id', 'forget', 'revoke', 'finish', 'harden', 'promote', 'ack']) {
        for (const e of [cand, link, peer])
            assert.equal(checkRun(verb, [e, err], 1).code, 'E_PROTOCOL', `${verb}`);
    }
});

test('the run checker: 64 KiB in total and a streaming feed that stops at the first violation', () => {
    const prog = JSON.stringify({v: 1, event: 'progress', step: 'instance', state: 'start', pad: 'x'.repeat(1000)});
    const many = Array.from({length: Math.floor(MAX_TOTAL_BYTES / (prog.length + 1)) + 2}, () => prog);
    assert.equal(checkRun('setup', many, 0).code, 'E_PROTOCOL');
    const c = createRunChecker('setup');
    assert.equal(c.feed('garbage').ok, false);
    assert.equal(c.feed(prog).ok, false);                                                  // once broken, always broken
    assert.equal(c.finish(0).code, 'E_PROTOCOL');
    assert.throws(() => createRunChecker('connect'));
});

test('argv and stdin: the verb list is closed, IDs are canonical positional arguments, and no typed text becomes an argument', () => {
    assert.deepEqual([...VERBS], ['status', 'setup', 'own-id', 'host', 'join', 'forget', 'revoke', 'finish', 'harden', 'promote', 'ack']);
    assert.deepEqual([...ID_VERBS], ['forget', 'revoke', 'promote', 'ack']);
    for (const v of VERBS.filter(v => !ID_VERBS.includes(v)))
        assert.deepEqual(argvFor(v), [v]);
    assert.deepEqual(argvFor('forget', {all: true}), ['forget', '--all']);
    assert.deepEqual(argvFor('forget', {all: true, stop: true}), ['forget', '--all', '--stop']);
    assert.deepEqual(argvFor('forget', {all: true, stop: false}), ['forget', '--all']);
    assert.deepEqual(argvFor('forget', {}, [B]), ['forget', B]);
    assert.deepEqual(argvFor('revoke', {}, [A, B]), ['revoke', A, B]);
    assert.deepEqual(argvFor('promote', {}, [B]), ['promote', B]);
    assert.deepEqual(argvFor('ack', {}, [B]), ['ack', B]);
    assert.deepEqual(argvFor('ack', {all: true}), ['ack', '--all']);
    assert.throws(() => argvFor('connect'));
    assert.throws(() => argvFor('host', {stop: true}));
    assert.throws(() => argvFor('forget', {name: 'x'}));
    assert.throws(() => argvFor('forget'));                                            // 0.2.5's bare `forget` is gone: --all or one ID
    assert.throws(() => argvFor('forget', {}, [A, B]));                                 // one ID
    assert.throws(() => argvFor('forget', {stop: true}, [B]));                          // --stop only with --all
    assert.throws(() => argvFor('forget', {all: true}, [B]));                           // --all and IDs exclude each other
    assert.throws(() => argvFor('revoke'));
    assert.throws(() => argvFor('revoke', {all: true}));
    assert.throws(() => argvFor('promote', {all: true}));
    assert.throws(() => argvFor('ack'));
    assert.throws(() => argvFor('status', {}, [B]));                                    // a verb without IDs takes none
    assert.throws(() => argvFor('finish', {}, [B]));
    assert.throws(() => argvFor('revoke', {}, [B, B]));                                 // no duplicates
    for (const bad of ['--home=/x', '-H', B.toLowerCase(), B.slice(1), `${B} `, '', 5, null, `${B}\n`])
        assert.throws(() => argvFor('revoke', {}, [bad]), String(bad));
    assert.throws(() => argvFor('revoke', {}, Array.from({length: MAX_PEERS + 1}, (_, i) => makeId(i))));
    assert.doesNotThrow(() => argvFor('revoke', {}, Array.from({length: MAX_PEERS}, (_, i) => makeId(i))));
    assert.throws(() => argvFor('forget', {all: 'yes'}));
    assert.equal(joinStdin(A), `${A}\n`);
    assert.equal(joinStdin(`${A}\r\n`), `${A}\n`);
    assert.equal(joinStdin(`${A}\nrest`), null);
    assert.equal(joinStdin(5), null);
    assert.equal(joinStdin('x'.repeat(103)), null);                              // over ID_RAW_MAX (+ a line end): not one line of ours
    assert.equal(joinStdin(`${'x'.repeat(100)}\r\n`), `${'x'.repeat(100)}\n`);
    assert.equal(joinStdin(`${A}\n\n\r`), `${A}\n`);
    assert.equal(joinStdin('a\0b'), null);
    const t0 = Date.now();
    assert.equal(joinStdin('\r'.repeat(80000) + 'x'), null);                    // no quadratic trim
    assert.ok(Date.now() - t0 < 500);
    assert.throws(() => emit({event: 'error', code: 'E_BAD_ID'}), /needs its verb/);       // a null verb would skip the per-verb code rules
    assert.throws(() => emit({event: 'error', code: 'E_BAD_ID'}, 'host'), /not raised by host/);
    assert.equal(acceptLine(B), `accept ${B}\n`);
    assert.throws(() => acceptLine(B.toLowerCase()));
    assert.equal(parseAcceptLine(`accept ${B}\n`), B);
    for (const bad of [`accept ${B.toLowerCase()}`, `accept  ${B}`, `ACCEPT ${B}`, `accept ${B} x`, B, 'accept', '', `accept ${B.slice(0, 20)}`, null])
        assert.equal(parseAcceptLine(bad), null, String(bad));
});

test('parseArgs is the reverse of argvFor: the engine reads its own command line with the same closed rules', () => {
    assert.deepEqual(parseArgs(['status']), {verb: 'status', flags: {}, ids: []});
    assert.deepEqual(parseArgs(['forget', '--all', '--stop']), {verb: 'forget', flags: {all: true, stop: true}, ids: []});
    assert.deepEqual(parseArgs(['forget', B]), {verb: 'forget', flags: {}, ids: [B]});
    assert.deepEqual(parseArgs(['revoke', A, B]), {verb: 'revoke', flags: {}, ids: [A, B]});
    assert.deepEqual(parseArgs(['ack', '--all']), {verb: 'ack', flags: {all: true}, ids: []});
    for (const verb of VERBS) {
        for (const [flags, ids] of [[{}, []], [{all: true}, []], [{all: true, stop: true}, []], [{}, [B]], [{}, [A, B]]]) {
            let argv = null;
            try {
                argv = argvFor(verb, flags, ids);
            } catch {
                assert.throws(() => parseArgs([verb, ...(flags.all ? ['--all'] : []), ...(flags.stop ? ['--stop'] : []), ...ids]), verb);
                continue;
            }
            const back = parseArgs(argv);
            assert.deepEqual([back.verb, back.ids], [verb, ids], verb);
            assert.deepEqual(argvFor(back.verb, back.flags, back.ids), argv, verb);
        }
    }
    for (const bad of [[], [''], [5], ['connect'], ['status', 'x'], ['status', '--all'], ['forget', '--stop'], ['forget', '--all', '--all'], ['forget', '--all', B],
        ['revoke'], ['revoke', '-H'], ['revoke', '--home=/x', B], ['revoke', B.toLowerCase()], ['promote', '--all'], ['join', B], ['host', '--stop']])
        assert.throws(() => parseArgs(bad), JSON.stringify(bad));
});

test('every fixture line that the engine could have written is what emit() writes for parse() of it (the fixtures come from emit)', () => {
    let compared = 0;
    for (const [file, meta] of Object.entries(INDEX)) {
        for (const line of linesOf(file)) {
            const ev = parse(line, meta.verb);
            if (ev === null || (ev.event === 'error' && !ERROR_CODES.includes(ev.code)))
                continue;
            let out;
            try {
                out = emit(ev, meta.verb);
            } catch (e) {
                continue;                                  // a line the engine could not have written (a bridge-only code, a future field)
            }
            assert.deepEqual(JSON.parse(out), JSON.parse(line), `${file}: ${line}`);
            compared++;
        }
    }
    assert.ok(compared >= 90, `only ${compared} lines compared`);
});

test('a result with an invalid peer ID or a null where the state demands one is not read', () => {
    const base = JSON.parse(linesOf('status-paired.ndjson').at(-1));
    const read = o => parse(JSON.stringify(o), 'status');
    assert.notEqual(read(base), null);
    assert.equal(read({...base, peers: [{...base.peers[0], id: A.slice(1)}]}), null);
    assert.equal(read({...base, peers: [{...base.peers[0], id: `x${B}`}]}), null);        // garbage in front of an otherwise valid ID
    assert.equal(read({...base, state: 'not-set-up'}), null);                             // peers and a listener only in the states that have them
    assert.equal(read({...base, state: 'half', peers: []}), null);
    assert.equal(read({...base, notes: -1}), null);
});
