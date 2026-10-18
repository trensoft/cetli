// SPDX-License-Identifier: GPL-3.0-or-later
// app/sync-flow.js: the page for a status, the neutral/red split of errors, the actions an error offers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {ERROR_CODES, INFORMATION_CODES, STATUS_STATES, RESERVED_CODES} from '../sync/protocol.js';
import {PAGES, pageForStatus, isConnected, linkKey, errorView, idRows, compareLine, buttonGroup, idsReducer, initialIdsState} from '../app/sync-flow.js';

const A = 'F6HEWOE-4KSACQ5-5MAX7IC-HAP3EGW-AQYBTIX-V74MXIF-ZB3GZN6-4T3QYQZ';
const B = 'VTTWEJK-SMIOBMH-3FIWS7V-JFC2CL4-FCR3BU6-PEPADRQ-EYVVD3Z-BIGMUQ5';

test('every status state has exactly one page, all of them known pages', () => {
    const seen = {};
    for (const s of STATUS_STATES) {
        const p = pageForStatus({state: s});
        assert.ok(PAGES.includes(p), s);
        seen[s] = p;
    }
    assert.deepEqual(seen, {
        'no-syncthing': 'missing', 'not-set-up': 'consent', 'stfolder-conflict': 'info-stfolder', 'foreign-config': 'info-foreign',
        'set-up': 'ids', half: 'half', paired: 'paired',
    });
    for (const bad of [{state: 'connected'}, {}, null, undefined, {state: 5}])
        assert.equal(pageForStatus(bad), 'error');
});

test('"Connected" needs a paired state and link stable; up_to_date (null in 0.2.5) neither adds nor removes it, nothing else says it', () => {
    const p = o => ({state: 'paired', link: 'stable', connected_s: 9, up_to_date: null, connected: true, ...o});
    assert.equal(isConnected(p()), true);
    assert.equal(isConnected(p({link: 'flapping'})), false);
    assert.equal(isConnected(p({link: 'none'})), false);
    assert.equal(isConnected(p({link: null})), false);
    assert.equal(isConnected(p({state: 'half'})), false);
    assert.equal(isConnected(p({state: 'foreign-config'})), false);                 // foreign-config never says Connected
    assert.equal(isConnected({state: 'paired', connected: true}), false);           // raw connected alone is not proof
    assert.equal(isConnected(null), false);
});

test('linkKey: one key per link situation; connected only through isConnected', () => {
    const p = o => ({state: 'paired', link: 'stable', connected_s: 9, up_to_date: null, ...o});
    assert.equal(linkKey(p()), 'connected');
    assert.equal(linkKey(p({link: 'flapping', connected_s: null})), 'unstable');
    assert.equal(linkKey(p({link: 'none', connected_s: null})), 'offline');
    assert.equal(linkKey(p({link: null})), 'checking');
    assert.equal(linkKey({state: 'half'}), 'none');
    for (const s of [p(), p({link: 'flapping'}), p({link: 'none'}), p({link: null})])
        assert.equal(linkKey(s) === 'connected', isConnected(s));
});

test('errors: only E_STFOLDER_EXISTS and E_ALREADY_PAIRED are neutral; E_FOREIGN_DEVICE is red with no button', () => {
    for (const c of ERROR_CODES)
        assert.equal(errorView(c).neutral, INFORMATION_CODES.includes(c), c);
    assert.deepEqual(errorView('E_FOREIGN_DEVICE'), {code: 'E_FOREIGN_DEVICE', neutral: false, action: 'none'});
    assert.equal(errorView('E_STFOLDER_EXISTS').action, 'none');
    assert.equal(errorView('E_ALREADY_PAIRED').action, 'none');
});

test('every code of the closed list has an action; unknown and reserved codes read as the generic one', () => {
    for (const c of ERROR_CODES)
        assert.ok(['retry', 'restart', 'check', 'stop', 'edit', 'none'].includes(errorView(c).action), c);
    for (const c of [...RESERVED_CODES, 'E_NOPE', undefined, null, 5, '__proto__', 'toString'])
        assert.deepEqual(errorView(c), {code: 'E_INTERNAL', neutral: false, action: 'retry'}, String(c));
    assert.equal(errorView('E_BAD_ID').action, 'edit');
    assert.equal(errorView('E_OWN_ID').action, 'edit');
    assert.equal(errorView('E_HALF_STATE_OTHER').action, 'stop');
    assert.equal(errorView('E_NO_SYNCTHING').action, 'check');
    assert.equal(errorView('E_PEER_TIMEOUT').action, 'retry');
});

test('0.2.5.2: a sync program that does not answer has a restart and, as the way out, a reset; no other code has a second action', () => {
    assert.deepEqual(errorView('E_SERVICE_TIMEOUT'), {code: 'E_SERVICE_TIMEOUT', neutral: false, action: 'restart', secondary: 'reset'});
    for (const c of ERROR_CODES.filter(x => x !== 'E_SERVICE_TIMEOUT'))
        assert.equal(Object.hasOwn(errorView(c), 'secondary'), false, c);
    assert.equal(Object.hasOwn(errorView('E_NOPE'), 'secondary'), false);
});

test('0.2.5.2: after a restart that ends on E_CONFIG_UNSAFE (a dead end) the way out "reset" is offered; nowhere else, and not without a restart before', () => {
    assert.deepEqual(errorView('E_CONFIG_UNSAFE', {afterRestart: true}), {code: 'E_CONFIG_UNSAFE', neutral: false, action: 'none', secondary: 'reset'});
    assert.equal(Object.hasOwn(errorView('E_CONFIG_UNSAFE'), 'secondary'), false, 'the plain error stays as it was');
    for (const c of ERROR_CODES.filter(x => x !== 'E_SERVICE_TIMEOUT' && x !== 'E_CONFIG_UNSAFE'))
        assert.equal(Object.hasOwn(errorView(c, {afterRestart: true}), 'secondary'), false, c);
    assert.equal(errorView('E_SERVICE_TIMEOUT', {afterRestart: true}).secondary, 'reset');
});

test('the ID rows and the compare line', () => {
    assert.deepEqual(idRows(A), ['F6HEWOE-4KSACQ5-5MAX7IC-HAP3EGW', 'AQYBTIX-V74MXIF-ZB3GZN6-4T3QYQZ']);
    assert.equal(compareLine(A), 'F6HEWOE-4KSACQ5');
    assert.equal(buttonGroup(A), 'F6HEWOE');
    assert.equal(`${idRows(A)[0]}-${idRows(A)[1]}`, A);
});

test('the ID page reducer: a candidate, its replacement, the accept, the link', () => {
    let s = initialIdsState;
    s = idsReducer(s, {event: 'candidate', id: B, name: 'b'});
    assert.deepEqual(s.candidate, {id: B, name: 'b'});
    s = idsReducer(s, {event: 'candidate', id: A, name: null});
    assert.deepEqual(s.candidate, {id: A, name: null});
    s = idsReducer(s, {event: 'peer', id: A, name: null});
    assert.equal(s.candidate, null);
    assert.deepEqual(s.peer, {id: A, name: null});
    s = idsReducer(s, {event: 'link', state: 'stable', connected_s: 9});
    assert.deepEqual(s.link, {state: 'stable', connectedS: 9});
    s = idsReducer(s, {event: 'progress', step: 'share', state: 'ok'});
    assert.equal(s.step, 'share');
    assert.equal(idsReducer(s, {event: 'nothing'}), s);
    assert.equal(Object.isFrozen(initialIdsState), true);
});

test('the product turns the first-start sync window on in main.js; the notes tests leave it off', async () => {
    const {readFileSync} = await import('node:fs');
    assert.match(readFileSync(new URL('../app/main.js', import.meta.url), 'utf8'), /createApp\(\{firstStartSync: true\}\)/);
    const app = readFileSync(new URL('../app/application.js', import.meta.url), 'utf8');
    assert.match(app, /firstStartSync = false/);
    assert.match(app, /firstStartSync && wantsFirstStart/);
});
