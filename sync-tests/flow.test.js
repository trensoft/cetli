// SPDX-License-Identifier: GPL-3.0-or-later
// app/sync-flow.js: the page for a status, the rows and banners of the group, the remove logic, the neutral/red split of errors, the actions
// an error offers. The statuses are the contract fixtures (sync-tests/contract), so the window logic is tested against what the engine sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ERROR_CODES, INFORMATION_CODES, STATUS_STATES, RESERVED_CODES, parse} from '../sync/protocol.js';
import {SHORTCUT_REMOVE} from '../sync/policy.js';
import {
    PAGES, pageForStatus, isConnected, linkKey, groupSummary, peerRow, peerRows, promoteIds, groupView, removePaths, removeDefaults, revokeIds, forgetId,
    revokeSummary, errorView, idRows, compareLine, buttonGroup, idsReducer, initialIdsState,
} from '../app/sync-flow.js';

const A = 'F6HEWOE-4KSACQ5-5MAX7IC-HAP3EGW-AQYBTIX-V74MXIF-ZB3GZN6-4T3QYQZ';
const B = 'VTTWEJK-SMIOBMH-3FIWS7V-JFC2CL4-FCR3BU6-PEPADRQ-EYVVD3Z-BIGMUQ5';
const P = 'TKIBGPF-WSGKBIH-LXXRQZX-HYOCM6Y-T6IYH5B-5CNPJLR-UHMG75U-JXHXVQP';
const O = 'IZA3FNQ-S6ZB6SZ-KJXJ4MB-KUYXPYA-MYWCRPI-TSVUXR2-CRK2SYT-YGUA6QZ';

// The result of a status fixture, read through the protocol parser like the bridge does (a fixture that does not fit would be null).
const fixture = name => {
    const lines = readFileSync(new URL(`./contract/${name}.ndjson`, import.meta.url), 'utf8').split('\n').filter(l => l !== '');
    const result = lines.map(l => parse(l, 'status')).find(e => e !== null && e.event === 'result');
    assert.ok(result, name);
    return result;
};
const peer = (id, o = {}) => ({id, name: 'pc', introduced_by: null, introducer: true, shared: true, connected: true, link: 'stable', connected_s: 9, new: false, returned: false, ...o});
const group = (peers, o = {}) => ({state: 'paired', own_id: A, peers, computers: peers.length + 1, max_computers: 10, over_limit: false, revocation_open: false,
    harden_pending: 0, promote_pending: 0, listener: 'ok', up_to_date: null, notes: 1, waiting: false, ...o});

test('every status state has exactly one page, all of them known pages', () => {
    const seen = {};
    for (const s of STATUS_STATES) {
        const p = pageForStatus({state: s});
        assert.ok(PAGES.includes(p), s);
        seen[s] = p;
    }
    assert.deepEqual(seen, {
        'no-syncthing': 'missing', 'not-set-up': 'consent', 'stfolder-conflict': 'info-stfolder', 'foreign-config': 'info-foreign',
        'set-up': 'ids', half: 'group', paired: 'group',
    });
    for (const bad of [{state: 'connected'}, {}, null, undefined, {state: 5}])
        assert.equal(pageForStatus(bad), 'error');
    assert.equal(PAGES.includes('paired') || PAGES.includes('half'), false, 'paired and half are gone');
    for (const p of ['group', 'add', 'remove', 'revoking', 'revoke-result'])
        assert.ok(PAGES.includes(p), p);
});

test('"Connected" is said of one computer, and only when its link is stable; the raw connected flag, a missing link or a state say nothing', () => {
    assert.equal(isConnected(peer(B)), true);
    assert.equal(isConnected(peer(B, {link: 'flapping', connected_s: null})), false);
    assert.equal(isConnected(peer(B, {link: 'none', connected: false, connected_s: null})), false);
    assert.equal(isConnected(peer(B, {link: null, connected: null, connected_s: null})), false);
    assert.equal(isConnected({id: B, connected: true}), false);                       // raw connected alone is not proof
    assert.equal(isConnected(null), false);
    assert.equal(isConnected(undefined), false);
});

test('linkKey: one key per link situation; connected only through isConnected; an unmeasured link says nothing', () => {
    assert.equal(linkKey(peer(B)), 'connected');
    assert.equal(linkKey(peer(B, {link: 'flapping', connected_s: null})), 'unstable');
    assert.equal(linkKey(peer(B, {link: 'none', connected: false, connected_s: null})), 'offline');
    assert.equal(linkKey(peer(B, {link: null, connected: null, connected_s: null})), 'unmeasured');
    assert.equal(linkKey(null), 'none');
    assert.equal(linkKey('stable'), 'none');
    for (const p of [peer(B), peer(B, {link: 'flapping'}), peer(B, {link: 'none'}), peer(B, {link: null})])
        assert.equal(linkKey(p) === 'connected', isConnected(p));
});

test('the group summary comes from the list alone, one counter per situation', () => {
    const st = fixture('status-group-3');
    assert.deepEqual(groupSummary(st), {total: 2, connected: 1, unstable: 0, offline: 1, unmeasured: 0});
    assert.deepEqual(groupSummary(fixture('status-over-limit')), {total: 10, connected: 0, unstable: 0, offline: 0, unmeasured: 10});
    assert.deepEqual(groupSummary(fixture('status-flapping')), {total: 1, connected: 0, unstable: 1, offline: 0, unmeasured: 0});
    assert.deepEqual(groupSummary({}), {total: 0, connected: 0, unstable: 0, offline: 0, unmeasured: 0});
});

test('how a computer came: accepted, through a listed computer (name hint and ID start), or through one that is no longer here', () => {
    const st = fixture('status-group-3');
    const [b, phone] = peerRows(st);
    assert.deepEqual(b.how, {kind: 'accepted'});
    assert.deepEqual(phone.how, {kind: 'through', name: 'laptop-b', idStart: compareLine(B)});
    assert.equal(b.compare, compareLine(B));
    assert.equal(b.connected, true);
    assert.equal(phone.connected, false);
    assert.equal(phone.link, 'offline');
    const orphan = group([peer(B, {introduced_by: P})]);
    assert.deepEqual(peerRow(orphan, orphan.peers[0]).how, {kind: 'gone'});
    const unnamed = group([peer(B), peer(P, {name: null, introduced_by: null}), peer(O, {introduced_by: P})]);
    assert.deepEqual(peerRow(unnamed, unnamed.peers[2]).how, {kind: 'through', name: null, idStart: compareLine(P)});
    assert.equal(peerRow(unnamed, unnamed.peers[1]).name, null);
});

test('rows: limited only while a removal is open and only for a computer that is not an introducer; same name marked, a missing name never', () => {
    const open = fixture('status-revocation-open');
    assert.deepEqual(peerRows(open).map(r => r.limited), [true, true]);
    const closed = group(open.peers);
    assert.deepEqual(peerRows(closed).map(r => r.limited), [false, false]);
    const mixed = group([peer(B, {introducer: true}), peer(P, {introducer: false})], {revocation_open: true});
    assert.deepEqual(peerRows(mixed).map(r => r.limited), [false, true]);
    const same = group([peer(B, {name: 'laptop'}), peer(P, {name: 'laptop'}), peer(O, {name: 'other'})]);
    assert.deepEqual(peerRows(same).map(r => r.sameName), [true, true, false]);
    const unnamed = group([peer(B, {name: null}), peer(P, {name: null})]);
    assert.deepEqual(peerRows(unnamed).map(r => r.sameName), [false, false]);
    const flags = peerRows(fixture('status-group-new'));
    assert.deepEqual(flags.map(r => [r.isNew, r.returned]), [[false, false], [true, false]]);
    assert.deepEqual(peerRows(fixture('status-returned')).map(r => [r.isNew, r.returned]), [[false, false], [false, true]]);
});

test('the rows keep the order the engine sends', () => {
    const st = group([peer(O), peer(P), peer(B)]);
    assert.deepEqual(peerRows(st).map(r => r.id), [O, P, B]);
});

test('banners: each shows only on its flag; the fixtures decide', () => {
    const none = groupView(fixture('status-group-3'));
    assert.deepEqual([none.revocationOpen, none.overLimit, none.full, none.promoteIds, none.newIds, none.returnedIds, none.addBlocked], [false, false, false, [], [], [], false]);
    assert.equal(none.computers, 3);
    assert.equal(none.max, 10);
    const nw = groupView(fixture('status-group-new'));
    assert.deepEqual(nw.newIds, [P]);
    assert.equal(nw.addBlocked, false);
    const ret = groupView(fixture('status-returned'));
    assert.deepEqual(ret.returnedIds, [P]);
    assert.equal(ret.addBlocked, true);
    const frozen = groupView(fixture('status-revocation-open'));
    assert.deepEqual([frozen.revocationOpen, frozen.addBlocked], [true, true]);
    const prom = groupView(fixture('status-promote-pending'));
    assert.deepEqual(prom.promoteIds, [B]);
    const over = groupView(fixture('status-over-limit'));
    assert.deepEqual([over.overLimit, over.addBlocked, over.full, over.computers, over.rows.length], [true, true, false, 12, 10]);
    const full = groupView(fixture('status-max-size'));
    assert.deepEqual([full.full, full.addBlocked, full.computers], [true, true, 10]);
});

test('group page edge cases: an unread list (over the cap) has no rows; a status with no counts reads from the list', () => {
    const unread = {...fixture('status-over-limit'), peers: [], state: 'half', computers: 40};
    const v = groupView(unread);
    assert.deepEqual([v.rows.length, v.overLimit, v.computers, v.addBlocked], [0, true, 40, true]);
    const bare = groupView({state: 'paired', peers: [peer(B), peer(P)]});
    assert.deepEqual([bare.computers, bare.max, bare.full], [3, null, false]);
    assert.equal(groupView(null).rows.length, 0);
});

test('promote: only direct peers with the flag off, only while the engine would take it (no removal open, not over the limit)', () => {
    const st = group([peer(B, {introducer: false}), peer(P, {introducer: false, introduced_by: B}), peer(O, {introducer: true})], {promote_pending: 1});
    assert.deepEqual(promoteIds(st), [B]);
    assert.deepEqual(promoteIds({...st, promote_pending: 0}), []);
    assert.deepEqual(promoteIds({...st, revocation_open: true}), []);
    assert.deepEqual(promoteIds({...st, over_limit: true}), []);
    assert.deepEqual(promoteIds(null), []);
    // the frozen fixture has two direct peers with the flag off, and promote_pending 0: nothing is offered
    assert.deepEqual(promoteIds(fixture('status-revocation-open')), []);
});

test('remove paths: lost is always there; "I still have it" needs the policy switch, a directly accepted row, and no new or returned mark', () => {
    const st = fixture('status-group-new');
    assert.deepEqual(removePaths(st, B, false), ['lost']);
    assert.deepEqual(removePaths(st, B, true), ['have', 'lost']);
    assert.deepEqual(removePaths(st, B), ['lost'], 'the release value of the switch (M-J1 FAIL): no window offers the shortcut');
    assert.equal(forgetId(st, B), null);
    assert.deepEqual(removePaths(st, P, true), ['lost'], 'an introduced row: only the freeze path');
    const ret = group([peer(B, {returned: true}), peer(P, {new: true})]);
    assert.deepEqual(removePaths(ret, B, true), ['lost']);
    assert.deepEqual(removePaths(ret, P, true), ['lost']);
    assert.deepEqual(removePaths(st, 'NOT-LISTED', true), []);
    assert.deepEqual(removePaths(st, B), SHORTCUT_REMOVE ? ['have', 'lost'] : ['lost'], 'the default is the policy switch');
});

test('forget <ID> only where the shortcut is offered; the ID is the listed one', () => {
    const st = fixture('status-group-3');
    assert.equal(forgetId(st, B, true), B);
    assert.equal(forgetId(st, B, false), null);
    assert.equal(forgetId(st, P, true), null);
    assert.equal(forgetId(st, A, true), null);
});

test('remove defaults: the rows the chosen one introduced, the new rows, and what those introduced; the chosen row itself never; kept only by a click', () => {
    const C = 'MMMHB3P-THG6WOI-G6WOG6W-OGZVB5J-JAQAQAQ-AL7DXWV-OG6RNZV-B5JAG6V';
    const D = 'KIKS2CK-S2CKS2D-5JFRNZV-BYIYITP-HL76WOB-5E2CS27-CKS25MV-4444442';
    const st = group([peer(B), peer(P, {introduced_by: B}), peer(O, {introduced_by: P}), peer(C), peer(D, {new: true, introduced_by: C})]);
    assert.deepEqual([...removeDefaults(st, B)].sort(), [P, O, D].sort());           // P by B, O by P (in the set), D is new
    assert.deepEqual([...removeDefaults(st, C)].sort(), [D].sort());
    assert.deepEqual([...removeDefaults(st, P)].sort(), [O, D].sort());
    assert.equal(removeDefaults(st, B).has(B), false);
    assert.deepEqual([...removeDefaults(group([peer(B), peer(P)]), B)], []);
    // a cycle of introductions ends
    const cyc = group([peer(B, {introduced_by: P}), peer(P, {introduced_by: B})]);
    assert.deepEqual([...removeDefaults(cyc, B)], [P]);
});

test('revoke IDs: the chosen first, then the marked rows in list order; never an ID the status did not list; at most max - 1', () => {
    const st = fixture('status-group-new');
    assert.deepEqual(revokeIds(st, B, new Set([P])), {ids: [B, P], tooMany: false, max: 9});
    assert.deepEqual(revokeIds(st, P, new Set()), {ids: [P], tooMany: false, max: 9});
    assert.deepEqual(revokeIds(st, B, new Set(['XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX', A, B])).ids, [B], 'unlisted IDs, the own ID and the chosen one again are dropped');
    assert.deepEqual(revokeIds(st, 'NOT-LISTED', new Set([P])).ids, []);
    const many = fixture('status-over-limit');
    const all = new Set(many.peers.map(p => p.id));
    const first = many.peers[0].id;
    const r = revokeIds(many, first, all);
    assert.deepEqual([r.tooMany, r.ids.length, r.max], [true, 0, 9], 'ten rows cannot go in one revoke');
    const nine = revokeIds(many, first, new Set(many.peers.slice(1, 9).map(p => p.id)));
    assert.deepEqual([nine.tooMany, nine.ids.length], [false, 9]);
    assert.deepEqual(revokeIds(null, B, new Set()).ids, []);
});

test('the revoke result: names from the status that was chosen from, the engine\'s sanitised names for the offline ones', () => {
    const st = fixture('status-group-new');
    const done = {removed: [P], returned: [P], offline: [{id: O, name: 'office'}, {id: B, name: null}], remaining: 2, revocation_open: true};
    assert.deepEqual(revokeSummary(st, done), {removed: [{id: P, name: 'unknown-pc'}], offline: [{id: O, name: 'office'}, {id: B, name: null}], returned: [{id: P, name: 'unknown-pc'}]});
    assert.deepEqual(revokeSummary(st, {removed: [O]}).removed, [{id: O, name: null}]);
    assert.deepEqual(revokeSummary(null, null), {removed: [], offline: [], returned: []});
});

test('errors: only the four information codes are neutral (no button); E_FOREIGN_DEVICE is red with no button', () => {
    for (const c of ERROR_CODES)
        assert.equal(errorView(c).neutral, INFORMATION_CODES.includes(c), c);
    assert.deepEqual(errorView('E_FOREIGN_DEVICE'), {code: 'E_FOREIGN_DEVICE', neutral: false, action: 'none'});
    assert.equal(errorView('E_STFOLDER_EXISTS').action, 'none');
    assert.equal(errorView('E_ALREADY_PAIRED').action, 'none');
    for (const c of ['E_GROUP_FULL', 'E_REVOCATION_OPEN']) {
        assert.deepEqual(errorView(c), {code: c, neutral: true, action: 'none'}, c);
        assert.ok(INFORMATION_CODES.includes(c), c);
    }
    assert.equal(INFORMATION_CODES.length, 4);
});

test('every code of the closed list has an action; unknown and reserved codes read as the generic one', () => {
    for (const c of ERROR_CODES)
        assert.ok(['retry', 'check', 'stop', 'edit', 'none'].includes(errorView(c).action), c);
    for (const c of [...RESERVED_CODES, 'E_NOPE', undefined, null, 5, '__proto__', 'toString'])
        assert.deepEqual(errorView(c), {code: 'E_INTERNAL', neutral: false, action: 'retry'}, String(c));
    assert.equal(errorView('E_BAD_ID').action, 'edit');
    assert.equal(errorView('E_OWN_ID').action, 'edit');
    assert.equal(errorView('E_HALF_STATE_OTHER').action, 'stop');
    assert.equal(errorView('E_NO_SYNCTHING').action, 'check');
    assert.equal(errorView('E_PEER_TIMEOUT').action, 'retry');
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

test('groupView: a list the engine did not read (over the cap) is over_limit with no rows: overCap, only "Stop syncing" is left', () => {
    const capped = groupView(group([], {state: 'half', over_limit: true, computers: 40}));
    assert.deepEqual([capped.overLimit, capped.overCap, capped.rows.length, capped.addBlocked], [true, true, 0, true]);
    const over = groupView(group([peer(B), peer(P)], {over_limit: true, computers: 12}));
    assert.deepEqual([over.overLimit, over.overCap], [true, false], 'a list that was read keeps its rows and the remove path');
    assert.equal(groupView(group([peer(B)])).overCap, false);
});
