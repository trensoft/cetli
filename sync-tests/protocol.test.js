// SPDX-License-Identifier: GPL-3.0-or-later
// sync/protocol.js against the contract fixtures in sync-tests/contract/ (both sides replay the SAME files) and on its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {
    BRIDGE_ONLY_CODES, ERROR_CODES, INFORMATION_CODES, MAX_LINE_BYTES, MAX_TOTAL_BYTES, RESERVED_CODES, VERBS, acceptLine, argvFor,
    checkRun, createRunChecker, emit, isKnownStep, isNeutralCode, joinStdin, parse, parseAcceptLine,
} from '../sync/protocol.js';

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
        'status-paired', 'status-flapping', 'host-foreign-device', 'join-foreign-device', 'setup-foreign-device', 'setup-ok', 'setup-fail-systemd',
        'host-ok', 'host-expired', 'host-stdin-eof', 'join-ok', 'join-flapping', 'forget-ok', 'oversize', 'not-json', 'v2',
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

test('the foreign-config state is a RESULT with rc 0 and no link; E_FOREIGN_DEVICE comes from setup, host and join only (Robert 8389)', () => {
    const r = checkRun('status', linesOf('status-foreign-config.ndjson'), 0);
    assert.equal(r.outcome.result.state, 'foreign-config');
    assert.equal(r.outcome.result.link, null);
    for (const f of ['setup-foreign-device', 'host-foreign-device', 'join-foreign-device'])
        assert.equal(INDEX[`${f}.ndjson`].expect, 'error:E_FOREIGN_DEVICE');
    assert.equal(INDEX['status-foreign-device.ndjson'], undefined);
    const asStatus = emit.bind(null, {event: 'error', code: 'E_FOREIGN_DEVICE'});
    for (const verb of ['status', 'own-id', 'forget'])
        assert.throws(() => asStatus(verb), /not raised by/);
    for (const verb of ['setup', 'host', 'join'])
        assert.doesNotThrow(() => asStatus(verb));
    const line = JSON.stringify({v: 1, event: 'error', code: 'E_FOREIGN_DEVICE'});
    assert.equal(parse(line, 'status'), null);
    assert.deepEqual(parse(line, 'join'), {event: 'error', code: 'E_FOREIGN_DEVICE'});
});

test('error codes: the closed list, the pinned information pair, the reserved and the bridge-only codes', () => {
    assert.deepEqual([...INFORMATION_CODES].sort(), ['E_ALREADY_PAIRED', 'E_STFOLDER_EXISTS']);
    for (const c of ERROR_CODES)
        assert.equal(isNeutralCode(c), c === 'E_STFOLDER_EXISTS' || c === 'E_ALREADY_PAIRED', c);
    for (const c of ['E_BAD_CODE', 'E_OWN_CODE', 'E_FOREIGN_DEVICE', 'E_NOT_A_CODE', 'E_INTERNAL', 'E_PROTOCOL'])
        assert.equal(isNeutralCode(c), false, c);
    assert.deepEqual([...RESERVED_CODES], ['E_BAD_CODE', 'E_OWN_CODE']);
    for (const c of RESERVED_CODES) {
        assert.equal(ERROR_CODES.includes(c), false);
        assert.throws(() => emit({event: 'error', code: c}));                    // never emitted today
    }
    for (const c of ['E_PENDING_AMBIGUOUS', 'E_BAD_ID', 'E_OWN_ID', 'E_FOREIGN_DEVICE'])
        assert.ok(ERROR_CODES.includes(c), c);
    for (const c of BRIDGE_ONLY_CODES) {
        assert.throws(() => emit({event: 'error', code: c}), /may raise/);
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

test('parse: unknown fields are ignored, an unknown step is returned (the window ignores it), an unknown error code reads as E_INTERNAL', () => {
    assert.deepEqual(parse(JSON.stringify({v: 1, event: 'progress', step: 'instance', state: 'ok', future: [1]})), {event: 'progress', step: 'instance', state: 'ok', future: [1]});
    const e = parse(JSON.stringify({v: 1, event: 'progress', step: 'brand-new', state: 'start'}));
    assert.equal(e.step, 'brand-new');
    assert.equal(isKnownStep(e.step), false);
    assert.equal(isKnownStep('share'), true);
    assert.deepEqual(parse(JSON.stringify({v: 1, event: 'error', code: 'E_FROM_THE_FUTURE', step: 'x'})), {event: 'error', code: 'E_INTERNAL', step: 'x'});
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

test('link: state none|flapping|stable and a boolean up_to_date', () => {
    for (const s of ['none', 'flapping', 'stable'])
        assert.ok(parse(JSON.stringify({v: 1, event: 'link', state: s, up_to_date: false})));
    for (const bad of [{state: 'connected', up_to_date: true}, {state: 'stable'}, {state: 'stable', up_to_date: 'yes'}, {up_to_date: true}])
        assert.equal(parse(JSON.stringify({v: 1, event: 'link', ...bad})), null);
});

test('result of host and join is the proof: link stable AND up to date, otherwise it is not a result (section 3)', () => {
    const base = {v: 1, event: 'result', peer: {id: B, name: 'b'}, connected: true, link: 'stable', up_to_date: true, notes: 3};
    assert.ok(parse(JSON.stringify(base), 'host'));
    for (const bad of [{link: 'flapping'}, {link: 'none'}, {link: null}, {up_to_date: false}, {up_to_date: null}, {connected: 'true'}, {notes: -1}, {notes: 1.5}, {peer: null}, {peer: {id: B}}])
        assert.equal(parse(JSON.stringify({...base, ...bad}), 'host'), null, JSON.stringify(bad));
    const j = {...base, own_id: A};
    assert.ok(parse(JSON.stringify(j), 'join'));
    assert.equal(parse(JSON.stringify(base), 'join'), null);                                  // join carries the own ID
    assert.equal(parse(JSON.stringify({...j, own_id: A.slice(0, 14)}), 'join'), null);        // in full
});

test('result of status: the closed states, link null unless half or paired, peer present for half and paired', () => {
    const st = (o = {}) => JSON.stringify({v: 1, event: 'result', state: 'paired', own_id: A, peer: {id: B, name: 'b'}, connected: true, link: 'stable', shared: true, up_to_date: true, notes: 1, waiting: false, ...o});
    assert.ok(parse(st(), 'status'));
    assert.equal(parse(st({state: 'connected'}), 'status'), null);
    assert.equal(parse(st({state: 'foreign-config'}), 'status'), null);                       // link must be null there
    assert.ok(parse(st({state: 'foreign-config', link: null, shared: null, up_to_date: null}), 'status'));
    assert.equal(parse(st({state: 'set-up', peer: null}), 'status'), null);                   // a link without a peer state
    assert.equal(parse(st({peer: null}), 'status'), null);
    assert.equal(parse(st({link: 'maybe'}), 'status'), null);
    assert.equal(parse(st({waiting: null}), 'status'), null);
    assert.equal(parse(st({own_id: 'nope'}), 'status'), null);
    for (const k of ['state', 'own_id', 'peer', 'connected', 'link', 'shared', 'up_to_date', 'notes', 'waiting']) {
        const o = JSON.parse(st());
        delete o[k];
        assert.equal(parse(JSON.stringify(o), 'status'), null, `missing ${k}`);
    }
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
    assert.throws(() => emit({event: 'error', code: 'E_BAD_ID'}, 'host'));                   // E_BAD_ID is join's
    assert.doesNotThrow(() => emit({event: 'error', code: 'E_BAD_ID'}, 'join'));
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
    const link = emit({event: 'link', state: 'none', up_to_date: false});
    const peer = emit({event: 'peer', id: B, name: null});
    const err = JSON.stringify({v: 1, event: 'error', code: 'E_INTERNAL'});
    assert.equal(checkRun('host', [cand, link, peer, err], 1).ok, true);
    assert.equal(checkRun('join', [link, peer, err], 1).ok, true);
    assert.equal(checkRun('join', [cand, err], 1).code, 'E_PROTOCOL');                    // no candidate in join
    for (const verb of ['status', 'setup', 'own-id', 'forget']) {
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

test('argv and stdin: the verb list is closed, the only flag is forget --stop, and no typed text becomes an argument', () => {
    assert.deepEqual([...VERBS], ['status', 'setup', 'own-id', 'host', 'join', 'forget']);
    for (const v of VERBS)
        assert.deepEqual(argvFor(v), [v]);
    assert.deepEqual(argvFor('forget', {stop: true}), ['forget', '--stop']);
    assert.deepEqual(argvFor('forget', {stop: false}), ['forget']);
    assert.throws(() => argvFor('connect'));
    assert.throws(() => argvFor('host', {stop: true}));
    assert.throws(() => argvFor('forget', {name: 'x'}));
    assert.equal(joinStdin(A), `${A}\n`);
    assert.equal(joinStdin(`${A}\r\n`), `${A}\n`);
    assert.equal(joinStdin(`${A}\nrest`), null);
    assert.equal(joinStdin(5), null);
    assert.equal(acceptLine(B), `accept ${B}\n`);
    assert.throws(() => acceptLine(B.toLowerCase()));
    assert.equal(parseAcceptLine(`accept ${B}\n`), B);
    for (const bad of [`accept ${B.toLowerCase()}`, `accept  ${B}`, `ACCEPT ${B}`, `accept ${B} x`, B, 'accept', '', `accept ${B.slice(0, 20)}`, null])
        assert.equal(parseAcceptLine(bad), null, String(bad));
});
