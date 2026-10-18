// SPDX-License-Identifier: GPL-3.0-or-later
// Headless smoke test of the sync window (0.2.5, 0.2.6 group): run it inside a headless Wayland compositor, see app-tests/run.sh. The window
// talks to a FAKE bridge (no engine, no process, no Syncthing): the fake answers with the contract fixtures (sync-tests/contract) and records
// every call. It also checks every call the way the engine would read it: the argv must be one argvFor accepts, and an ID the window passes
// must be one the last status it showed listed. Every wait is a poll on a condition with a generous limit, never a fixed sleep.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';

import {createApp} from '../app/application.js';
import {readWizardState, wantsFirstStart, writeDismissed} from '../app/sync-hook.js';
import {SyncWizard} from '../app/sync-wizard.js';
import {DISMISSED_TEXT} from '../app/sync-start.js';
import * as S from '../app/strings.js';
import {argvFor, parse} from '../sync/protocol.js';
import {compareLine} from '../app/sync-flow.js';

const base = GLib.dir_make_tmp('cetli-sync-XXXXXX');
const dirs = {notes: `${base}/home/.local/share/cetli/notes`, tmp: `${base}/home/.local/share/cetli/tmp`, state: `${base}/home/.local/state/cetli`};
const HOME = `${base}/home`;
let failed = 0;
let checks = 0;
const check = (cond, label) => {
    checks++;
    if (cond) {
        print(`ok   ${label}`);
    } else {
        failed++;
        print(`FAIL ${label}`);
    }
};
const tick = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE; }));
async function waitFor(cond, limit = 8000) {
    const t0 = GLib.get_monotonic_time();
    for (;;) {
        if (cond())
            return true;
        if ((GLib.get_monotonic_time() - t0) / 1000 > limit)
            return false;
        await tick(40);
    }
}

const A = 'F6HEWOE-4KSACQ5-5MAX7IC-HAP3EGW-AQYBTIX-V74MXIF-ZB3GZN6-4T3QYQZ';
const B = 'VTTWEJK-SMIOBMH-3FIWS7V-JFC2CL4-FCR3BU6-PEPADRQ-EYVVD3Z-BIGMUQ5';
const P = 'TKIBGPF-WSGKBIH-LXXRQZX-HYOCM6Y-T6IYH5B-5CNPJLR-UHMG75U-JXHXVQP';
const O = 'IZA3FNQ-S6ZB6SZ-KJXJ4MB-KUYXPYA-MYWCRPI-TSVUXR2-CRK2SYT-YGUA6QZ';
// A status result without any computer (the shape the contract fixes), and one built from a contract fixture.
const status = (state, extra = {}) => ({ok: true, result: {event: 'result', state, own_id: A, peers: [], computers: null, max_computers: 10, over_limit: false, revocation_open: false,
    harden_pending: 0, promote_pending: 0, listener: null, up_to_date: null, notes: null, waiting: false, ...extra}});
const fixtureDir = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const fixture = (name, extra = {}) => {
    const [, bytes] = Gio.File.new_for_path(`${fixtureDir}/../sync-tests/contract/${name}.ndjson`).load_contents(null);
    const lines = new TextDecoder().decode(bytes).split('\n').filter(l => l !== '');
    const result = lines.map(l => parse(l, 'status')).find(e => e !== null && e.event === 'result');
    return {ok: true, result: {...result, ...extra}};
};
const peerOf = (id, o = {}) => ({id, name: 'pc', introduced_by: null, introducer: true, shared: true, connected: true, link: 'stable', connected_s: 9, new: false, returned: false, ...o});
const groupOf = (peers, extra = {}) => status('paired', {peers, computers: peers.length + 1, listener: 'ok', notes: 3, ...extra});
const fail = (code, step = null) => ({ok: false, error: {code, step}});
const hostResult = {ok: true, result: {event: 'result', peer: {id: B, name: 'laptop-b'}, connected: true, link: 'stable', connected_s: 9, up_to_date: null, notes: 4}};

// The fake bridge: `answers[verb]` is a function (opts) -> outcome | Promise. `host` is a controllable handle.
class FakeBridge {
    constructor() {
        this.reset();
    }

    reset() {
        this.calls = [];
        this.answers = {};
        this.hosts = [];
        this.stopped = 0;
        this.listed = new Set();                       // the IDs of the last status the window was given
        this.argv = [];                                // what the engine would be started with, per call
    }

    start(verb, opts = {}) {
        this.calls.push({verb, opts});
        try {
            this.argv.push(argvFor(verb, opts.flags ?? {}, opts.ids ?? []));
        } catch (e) {
            check(false, `${verb}: the window asked for an argv the contract refuses (${e.message})`);
        }
        for (const id of opts.ids ?? [])
            check(this.listed.has(id), `${verb}: the ID ${id.slice(0, 7)} was listed by the status on screen`);
        if (verb === 'host') {
            let resolve;
            const done = new Promise(r => { resolve = r; });
            const h = {opts, done, accepted: [], stopCalls: 0, finish: resolve, emit: ev => opts.onEvent?.(ev),
                accept(id) { h.accepted.push(id); return true; }, stop() { h.stopCalls++; resolve(fail('E_EXPIRED')); return done; }};
            this.hosts.push(h);
            return h;
        }
        const answer = this.answers[verb] ?? (() => fail('E_INTERNAL'));
        const done = Promise.resolve().then(() => answer(opts)).then(out => {
            if (verb === 'status' && out.ok)
                this.listed = new Set([...out.result.peers.map(p => p.id), ...(out.result.removed ?? [])]);   // a removed computer is named by the status too ("Add again")
            return out;
        });
        return {done, accept: () => false, stop: () => done};
    }

    run(verb, opts) {
        return this.start(verb, opts).done;
    }

    stop() {
        this.stopped++;
        return Promise.resolve();
    }

    count(verb) {
        return this.calls.filter(c => c.verb === verb).length;
    }

    verbs() {
        return this.calls.map(c => c.verb);
    }
}

const fake = new FakeBridge();
const app = createApp({dirs, bridge: fake, homeDir: HOME});
const {gtkApp} = app;

const labelText = l => l.get_label();
const rowsText = idl => idl.rows.map(r => r.get_label()).join('-');
const widgetText = w => (w.get_label ? w.get_label() : '');

async function scenario() {
    await app.ready;
    const open = async answers => {
        fake.reset();
        Object.assign(fake.answers, answers);
        const w = app.showSync();
        await tick(50);
        return w;
    };
    const closeWin = async w => {
        w.win.close();
        await tick(60);
    };
    const pageIs = async (w, name) => waitFor(() => w.page === name);

    // ---- the menu
    const items = [];
    const walk = m => {
        for (let i = 0; i < m.get_n_items(); i++) {
            items.push({label: m.get_item_attribute_value(i, 'label', null)?.get_string()[0], action: m.get_item_attribute_value(i, 'action', null)?.get_string()[0]});
            for (const kind of ['section', 'submenu']) {
                const sub = m.get_item_link(i, kind);
                if (sub)
                    walk(sub);
            }
        }
    };
    walk(app.ctl.menu);
    check(items.some(i => i.action === 'app.sync-setup' && i.label === S.menuSync()), 'the hamburger menu has "Sync…"');
    const aboutIdx = items.findIndex(i => i.action === 'win.about');
    const syncIdx = items.findIndex(i => i.action === 'app.sync-setup');
    check(syncIdx >= 0 && syncIdx < aboutIdx, 'it sits before "About"');

    // ---- status -> page
    for (const [name, answer, page] of [
        ['no program', status('no-syncthing', {own_id: null}), 'missing'],
        ['not set up', status('not-set-up', {own_id: null}), 'consent'],
        ['stfolder conflict', status('stfolder-conflict', {own_id: null}), 'info-stfolder'],
        ['foreign config', fixture('status-foreign-config'), 'info-foreign'],
        ['set up', status('set-up'), 'ids'],
        ['half', fixture('status-half'), 'group'],
        ['paired', fixture('status-paired'), 'group'],
        ['group of three', fixture('status-group-3'), 'group'],
    ]) {
        const w = await open({status: () => answer});
        check(await pageIs(w, page), `status ${name}: page ${page} (${w.page})`);
        await closeWin(w);
    }

    // ---- the missing-program page: the commands are shown and copyable, Check again asks again
    let w = await open({status: () => status('no-syncthing', {own_id: null})});
    await pageIs(w, 'missing');
    check(labelText(w.w.missingCommands) === S.syncInstallCommands && S.syncInstallCommands.includes('dnf install'), 'the install commands are shown as text');
    check(fake.count('setup') === 0 && fake.count('host') === 0 && fake.count('join') === 0, 'nothing else was started');
    w.w.missingCheck.emit('clicked');
    check(await waitFor(() => fake.count('status') === 2), '"Check again" asks the engine again');
    await closeWin(w);

    // ---- the consent page and the set-up
    w = await open({
        status: () => status('not-set-up', {own_id: null}),
        setup: async opts => { opts.onEvent({event: 'progress', step: 'folder', state: 'start'}); await tick(100); return {ok: true, result: {event: 'result', own_id: A, state: 'set-up'}}; },
    });
    await pageIs(w, 'consent');
    check(labelText(w.w.consentText) === S.syncConsentText() && labelText(w.w.consentButton) === S.syncConsentButton(), 'consent text and button');
    check(fake.count('setup') === 0, 'nothing runs before the click');
    w.w.consentButton.emit('clicked');
    check(await pageIs(w, 'setup'), 'the set-up page');
    check(await waitFor(() => labelText(w.w.setupStep) === S.syncStepText('folder')), 'a progress event shows its step');
    check(await pageIs(w, 'ids'), 'then the ID page');
    check(rowsText(w.w.ownId) === A, `the ID of this computer is shown in full (${rowsText(w.w.ownId)})`);
    check(fake.count('host') === 1, 'a waiting run started');
    await closeWin(w);
    check(fake.hosts[0].stopCalls === 1, 'closing the window stops the waiting run');

    // ---- the ID page: a candidate, the button, the accept
    w = await open({status: () => status('set-up')});
    await pageIs(w, 'ids');
    check(!w.w.cand.get_visible(), 'no candidate card before a computer knocks');
    const host = fake.hosts[0];
    host.emit({event: 'candidate', id: B, name: '<b>x</b>&amp;%s$&'});
    check(w.w.cand.get_visible(), 'a candidate card appears');
    check(labelText(w.w.candName) === S.syncCandidateName('<b>x</b>&amp;%s$&') && !w.w.candName.get_use_markup(), 'the name is plain text, markup off, every character literal');
    check(labelText(w.w.candAccept) === S.syncAcceptButton('<b>x</b>&amp;%s$&', 'VTTWEJK') && labelText(w.w.candAccept).includes('VTTWEJK'), `the button carries the name and the first group (${labelText(w.w.candAccept)})`);
    check(rowsText(w.w.candId) === B, 'the candidate ID is shown in full');
    check(labelText(w.w.candCompare) === S.syncCompareText(), 'the compare sentence is there');
    host.emit({event: 'candidate', id: A, name: null});
    check(labelText(w.w.candName) === S.syncCandidateName(S.syncNameUnreadable()) && rowsText(w.w.candId) === A, 'a replaced candidate / an unreadable name');
    host.emit({event: 'candidate', id: B, name: 'laptop-b'});
    w.w.candAccept.emit('clicked');
    check(host.accepted.length === 1 && host.accepted[0] === B, `the accept names the candidate's canonical ID (${host.accepted})`);
    check(w.page === 'connecting' && rowsText(w.w.connOwnId) === A, 'the connecting page shows the ID of this computer at once');
    w.w.candAccept.emit('clicked');
    check(host.accepted.length === 1, 'a second click sends nothing');
    host.emit({event: 'peer', id: B, name: 'laptop-b'});
    host.finish({ok: true, result: {event: 'result', peer: {id: B, name: 'laptop-b'}, connected: true, link: 'stable', connected_s: 9, up_to_date: null, notes: 4}});
    check(await pageIs(w, 'done'), 'the result shows the done page');
    check(labelText(w.w.doneText) === S.syncDoneText('laptop-b') && rowsText(w.w.donePeerId) === B, 'the name and the FULL ID of the other computer');
    check(labelText(w.w.doneCheck) === S.syncCheckOther(), 'the sentence to check the other computer is on the page');
    check(labelText(w.w.doneSeconds) === S.syncDoneSeconds(9) && !labelText(w.w.doneSeconds).includes('ynced'), 'the done page says "Connected for 9 seconds", never "Synced"');
    await closeWin(w);

    // ---- errors: red with a button, red without (foreign device), neutral (information codes)
    for (const [code, expect] of [
        ['E_PENDING_AMBIGUOUS', {neutral: false, button: S.syncTryAgain()}],
        ['E_EXPIRED', {neutral: false, button: S.syncTryAgain()}],
        ['E_PEER_TIMEOUT', {neutral: false, button: S.syncTryAgain()}],
        ['E_FOREIGN_DEVICE', {neutral: false, button: null}],
        ['E_STFOLDER_EXISTS', {neutral: true, button: null}],
        ['E_ALREADY_PAIRED', {neutral: true, button: null}],
        ['E_NO_SYNCTHING', {neutral: false, button: S.syncCheckAgain()}],
        ['E_HALF_STATE_OTHER', {neutral: false, button: S.syncStopShort()}],
        ['E_BRAND_NEW', {neutral: false, button: S.syncTryAgain()}],
    ]) {
        w = await open({status: () => fail(code)});
        await pageIs(w, 'error');
        const hasRed = w.w.errText.has_css_class('cetli-error');
        const btn = w.w.errAction.get_visible() ? labelText(w.w.errAction) : null;
        check(hasRed === !expect.neutral && btn === expect.button, `${code}: ${expect.neutral ? 'neutral' : 'red'}, button ${btn}`);
        check(labelText(w.w.errText) === S.syncErrorText(code), `${code}: the text comes from strings.js`);
        await closeWin(w);
    }

    // ---- the ambiguity error offers a new waiting run
    w = await open({status: () => status('set-up')});
    await pageIs(w, 'ids');
    fake.hosts[0].finish(fail('E_PENDING_AMBIGUOUS'));
    check(await pageIs(w, 'error'), 'the waiting run ends with an error page');
    w.w.errAction.emit('clicked');
    check(await pageIs(w, 'ids') && fake.hosts.length === 2, 'Try again goes back to the ID page and waits again');
    await closeWin(w);

    // ---- a timeout after the accept: Try again asks the status (the other computer is already added), it does not start a second opening
    w = await open({status: () => fixture('status-half')});
    await pageIs(w, 'group');
    await closeWin(w);
    w = await open({status: () => status('set-up')});
    await pageIs(w, 'ids');
    fake.hosts[0].finish(fail('E_PEER_TIMEOUT', 'connect'));
    check(await pageIs(w, 'error'), 'E_PEER_TIMEOUT ends on the error page');
    const statusBefore = fake.count('status');
    w.w.errAction.emit('clicked');
    check(await waitFor(() => fake.count('status') === statusBefore + 1) && fake.hosts.length === 1, 'Try again asks the status and starts no second waiting run');
    await closeWin(w);

    // ---- entering the other ID: the waiting run stops, join gets the line as typed, errors stay under the field
    w = await open({
        status: () => status('set-up'),
        join: opts => (opts.stdin.startsWith('bad') ? fail('E_BAD_ID') : opts.stdin.startsWith('own') ? fail('E_OWN_ID') :
            {ok: true, result: {event: 'result', peer: {id: B, name: null}, own_id: A, connected: true, link: 'stable', connected_s: 9, up_to_date: null, notes: 1}}),
    });
    await pageIs(w, 'ids');
    check(!w.w.connect.get_sensitive(), 'Connect is off while the field is empty');
    w.w.entry.set_text('bad id');
    check(w.w.connect.get_sensitive(), 'Connect is on with text in the field');
    w.w.connect.emit('clicked');
    check(await waitFor(() => fake.count('join') === 1), 'join was called');
    check(fake.hosts[0].stopCalls === 1, 'the waiting run was stopped first (a machine is host OR guest)');
    check(fake.calls.find(c => c.verb === 'join').opts.stdin === 'bad id\n', `join got the line exactly as typed (${JSON.stringify(fake.calls.find(c => c.verb === 'join').opts.stdin)})`);
    check(await pageIs(w, 'ids') && w.w.entryError.get_visible() && labelText(w.w.entryError) === S.syncBadId(), 'E_BAD_ID stays under the field');
    check(fake.hosts.length === 2, 'and the window waits again');
    w.w.entry.set_text('own id');
    w.w.connect.emit('clicked');
    check(await waitFor(() => fake.count('join') === 2) && await pageIs(w, 'ids') && labelText(w.w.entryError) === S.syncOwnIdEntered(), 'E_OWN_ID has its own text');
    w.w.entry.set_text(`  ${B.toLowerCase()}  `);
    w.w.connect.emit('clicked');
    check(await waitFor(() => fake.count('join') === 3), 'a third join');
    check(fake.calls.filter(c => c.verb === 'join')[2].opts.stdin === `  ${B.toLowerCase()}  \n`, 'the window does not canonicalise: the engine does');
    check(await pageIs(w, 'done'), 'a good ID ends on the done page');
    check(labelText(w.w.doneText) === S.syncDoneText(S.syncNameUnreadable()), 'the guest knows no name: "(name not readable)"');
    await closeWin(w);

    // ---- the ID page of a computer with no other computer: the field, the guest note, where to start; the connecting page of a guest
    w = await open({status: () => status('set-up'), join: async () => { await tick(300); return hostResult; }});
    await pageIs(w, 'ids');
    check(w.w.entry !== undefined && w.w.entry.get_visible(), 'ids page (no other computer): the field for the other ID is there');
    check(labelText(w.w.newStart) === S.syncNewStart() && labelText(w.w.guestNote) === S.syncGuestNote(), 'it says where to start and what joining means');
    check(w.w.cand !== undefined && !w.w.cand.get_visible(), 'the candidate card exists, hidden until a computer knocks');
    check(w.sets.add.entry === undefined, 'the add page has no field');
    w.w.entry.set_text(B);
    w.w.connect.emit('clicked');
    check(await waitFor(() => fake.count('join') === 1), 'a guest joins');
    check(w.page === 'connecting' && w.w.connGuest.get_visible() && labelText(w.w.connGuest) === S.syncGuestNote(), 'the connecting page of a guest carries the guest note');
    check(await pageIs(w, 'done'), 'and it ends on the done page');
    await closeWin(w);

    // ---- the group page: three computers, how each came, the link of each, markup off, the footnote
    w = await open({status: () => fixture('status-group-3')});
    check(await pageIs(w, 'group'), 'group of three: the group page');
    check(labelText(w.w.groupCount) === S.syncGroupCount(3, 10) && labelText(w.w.groupCount).includes('3 /'), `the count is "n / max" (${labelText(w.w.groupCount)})`);
    check(w.rowWidgets.length === 2 && w.rowWidgets[0].id === B && w.rowWidgets[1].id === P, 'one row per other computer, in the order the engine sends');
    check(labelText(w.rowWidgets[0].name) === 'laptop-b' && labelText(w.rowWidgets[0].compare) === compareLine(B), 'a row shows the name and the first two ID groups');
    check(labelText(w.rowWidgets[0].how) === S.syncRowAccepted() && labelText(w.rowWidgets[1].how) === S.syncRowThrough('laptop-b', compareLine(B)), 'how each came: accepted / added through laptop-b with its ID start');
    check(labelText(w.rowWidgets[0].link) === S.syncLinkText('connected') && labelText(w.rowWidgets[1].link) === S.syncLinkText('offline'), 'each row has its own link text: only the stable one says Connected');
    check(!w.rowWidgets[0].limited.get_visible() && !w.rowWidgets[0].sameName.get_visible(), 'no limited or same-name mark');
    check([w.w.bnFreeze, w.w.bnOver, w.w.bnFull, w.w.bnPromote, w.w.bnNew].every(b => !b.box.get_visible()) && w.returnedRows.length === 0, 'no banner while no flag is set');
    check(w.w.groupAdd.get_sensitive() && labelText(w.w.groupAdd) === S.syncAddButton(), 'Add a computer is on');
    check(labelText(w.w.groupFootnote) === S.syncTrustSentence(), 'the footnote carries the sentence about the accepted computer');
    check(!w.w.groupOwn.get_visible(), 'the own ID is hidden until asked');
    w.w.groupShowOwn.emit('clicked');
    check(w.w.groupOwn.get_visible() && rowsText(w.w.groupOwnId) === A, 'then shown in full');
    await closeWin(w);

    // names are foreign input: markup off on every label that shows one, every character literal; a same-name pair is marked
    const evil = '<b>x</b>&amp;%s$&';
    w = await open({status: () => groupOf([peerOf(B, {name: evil}), peerOf(P, {name: evil, introduced_by: B}), peerOf(O, {name: null})])});
    await pageIs(w, 'group');
    const nameRows = w.rowWidgets;
    check(labelText(nameRows[0].name) === evil && !nameRows[0].name.get_use_markup(), 'a hostile name is plain text, markup off, every character literal');
    check(labelText(nameRows[1].how) === S.syncRowThrough(evil, compareLine(B)) && !nameRows[1].how.get_use_markup(), 'the name in "added through" is plain text too');
    check(nameRows.every(r => !r.name.get_use_markup() && !r.how.get_use_markup() && !r.compare.get_use_markup() && !r.link.get_use_markup()), 'no row label uses markup');
    check(nameRows[0].sameName.get_visible() && nameRows[1].sameName.get_visible() && !nameRows[2].sameName.get_visible(), 'two rows with the same name are marked, an unreadable name is not');
    check(labelText(nameRows[2].name) === S.syncNameUnreadable(), 'a missing name reads "(name not readable)"');
    await closeWin(w);

    // the link of a flapping peer and the listener note
    w = await open({status: () => fixture('status-flapping')});
    await pageIs(w, 'group');
    check(labelText(w.rowWidgets[0].link) === S.syncLinkText('unstable') && labelText(w.rowWidgets[0].link) !== S.syncLinkText('connected'), 'flapping: never "Connected"');
    await closeWin(w);
    for (const [listener, shown] of [['degraded', true], ['down', true], ['ok', false], [null, false]]) {
        w = await open({status: () => fixture('status-paired', {listener})});
        await pageIs(w, 'group');
        check(w.w.groupListener.get_visible() === shown && (labelText(w.w.groupListener) !== '') === shown, `listener ${listener}: ${shown ? 'a note' : 'no note'} on the group page`);
        check(!w.w.groupListener.has_css_class('error') && labelText(w.rowWidgets[0].link) === S.syncLinkText('connected'), `listener ${listener}: neutral, the row is unchanged`);
        await closeWin(w);
    }
    w = await open({status: () => status('set-up', {listener: 'degraded'})});
    await pageIs(w, 'ids');
    check(w.w.idsListener.get_visible() && labelText(w.w.idsListener) === S.syncListenerText('degraded') && !w.w.idsListener.has_css_class('error'), 'the ID page carries the same neutral note');
    await closeWin(w);

    // ---- Add a computer: the add page waits, never types; the candidate card, the accept, the notes; Cancel goes back
    w = await open({status: () => fixture('status-group-3'), host: null});
    await pageIs(w, 'group');
    w.w.groupAdd.emit('clicked');
    check(w.page === 'add' && fake.hosts.length === 1, 'Add a computer: the add page, a waiting run started');
    check(w.sets.add.entry === undefined && w.sets.add.cancel !== undefined, 'no field to type on a computer that has others; a Cancel button');
    check(rowsText(w.sets.add.ownId) === A, 'this computer\'s ID is shown in full');
    const addHost = fake.hosts[0];
    addHost.emit({event: 'candidate', id: O, name: 'office'});
    check(w.sets.add.cand.get_visible() && labelText(w.sets.add.candAccept) === S.syncAcceptButton('office', 'IZA3FNQ'), 'the candidate card and the Accept button');
    check(labelText(w.sets.add.candNote) === S.syncAcceptNote() && labelText(w.sets.add.candTrust) === S.syncTrustSentence(), 'the accept note and the sentence about the accepted computer sit on the card');
    w.sets.add.cancel.emit('clicked');
    check(await waitFor(() => fake.count('status') === 2) && addHost.stopCalls === 1, 'Cancel stops the waiting run and reads the list again');
    check(await pageIs(w, 'group'), 'and the group page is back');
    w.w.groupAdd.emit('clicked');
    const addHost2 = fake.hosts[1];
    addHost2.emit({event: 'candidate', id: O, name: 'office'});
    w.sets.add.candAccept.emit('clicked');
    check(addHost2.accepted.length === 1 && addHost2.accepted[0] === O && w.page === 'connecting', 'the accept names the candidate\'s canonical ID');
    check(!w.w.connGuest.get_visible(), 'the host side does not show the guest note');
    addHost2.finish(hostResult);
    check(await pageIs(w, 'done'), 'the add ends on the done page');
    await closeWin(w);

    // a refused opening is a neutral page with the engine's reason and no button (the number comes from the status)
    for (const [code, text] of [['E_GROUP_FULL', S.syncGroupFull(10)], ['E_REVOCATION_OPEN', S.syncFreezeBanner()]]) {
        w = await open({status: () => fixture('status-group-3')});
        await pageIs(w, 'group');
        w.w.groupAdd.emit('clicked');
        fake.hosts[0].finish(fail(code));
        check(await pageIs(w, 'error') && !w.w.errText.has_css_class('cetli-error') && !w.w.errAction.get_visible() && labelText(w.w.errText) === text, `${code}: a neutral page, its text, no button (${labelText(w.w.errText).slice(0, 40)})`);
        await closeWin(w);
    }

    // ---- banners: new computers (and the harden step before), the promote consent, a returned computer, an open removal, the limit
    const afterHarden = fixture('status-group-new', {harden_pending: 0});
    let statusCalls = 0;
    w = await open({status: () => (++statusCalls === 1 ? fixture('status-group-new') : afterHarden), harden: () => ({ok: true, result: {event: 'result', changed: 1}}),
        ack: () => ({ok: true, result: {event: 'result', changed: 1}})});
    check(await pageIs(w, 'group'), 'new computer: the group page');
    check(fake.verbs().join() === 'status,harden,status', `harden_pending runs harden and then status once more (${fake.verbs()})`);
    check(w.w.bnNew.box.get_visible() && labelText(w.w.bnNew.label) === S.syncNewBanner(1), 'the "added since you last looked" banner counts the new rows');
    check(labelText(w.rowWidgets[1].remove) === S.syncNewNotMine() && labelText(w.rowWidgets[0].remove) === S.syncRemoveButton(), 'a new row offers "Not mine, remove", the other "Remove"');
    check(w.w.groupAdd.get_sensitive(), 'a new row alone does not stop Add');
    w.w.newAllMine.emit('clicked');
    check(await waitFor(() => fake.count('ack') === 1), 'They are all mine runs ack');
    check(JSON.stringify(fake.argv.find(a => a[0] === 'ack')) === JSON.stringify(['ack', P]), `ack names exactly the new row, no --all (${fake.argv.find(a => a[0] === 'ack')})`);
    check(await waitFor(() => fake.count('status') >= 3), 'and the list is read again');
    await closeWin(w);

    statusCalls = 0;
    w = await open({status: () => (++statusCalls === 1 ? fixture('status-group-new') : fail('E_CLI_FAILED')), harden: () => fail('E_CLI_FAILED')});
    check(await pageIs(w, 'group') && fake.verbs().join() === 'status,harden', 'a failing harden is not a loop and not an error: the first status is shown');
    await closeWin(w);

    w = await open({status: () => fixture('status-promote-pending'), promote: () => ({ok: true, result: {event: 'result', changed: 1}})});
    await pageIs(w, 'group');
    check(w.w.bnPromote.box.get_visible() && labelText(w.w.bnPromote.label) === `${S.syncTrustSentence()} ${S.syncPromoteNote()}` && labelText(w.w.promoteAllow) === S.syncPromoteAllow() && labelText(w.w.promoteLater) === S.syncPromoteLater(), 'the promote consent banner with Allow and Not now');
    w.w.promoteLater.emit('clicked');
    check(!w.w.bnPromote.box.get_visible() && fake.count('promote') === 0, 'Not now hides it and runs nothing');
    await closeWin(w);
    w = await open({status: () => fixture('status-promote-pending'), promote: () => ({ok: true, result: {event: 'result', changed: 1}})});
    await pageIs(w, 'group');
    w.w.promoteAllow.emit('clicked');
    check(await waitFor(() => fake.count('promote') === 1) && JSON.stringify(fake.argv.find(a => a[0] === 'promote')) === JSON.stringify(['promote', B]), 'Allow runs promote for the direct peer whose flag is off');
    check(await waitFor(() => fake.count('status') === 2), 'and reads the list again');
    await closeWin(w);

    w = await open({status: () => fixture('status-returned')});
    await pageIs(w, 'group');
    check(w.returnedRows.length === 1 && labelText(w.returnedRows[0].label) === S.syncReturned(compareLine(P)), 'a returned computer: its banner with the ID start');
    check(!w.w.groupAdd.get_sensitive(), 'Add is off while a removed computer is back');
    w.returnedRows[0].button.emit('clicked');
    check(w.page === 'remove' && w.rm.id === P && w.rm.path === 'lost', 'Remove it again: the remove page for that row, the lost path');
    await closeWin(w);

    // a removed computer that is not in the list: "Add again" runs ack for exactly that ID (the tombstone is lifted), on the group page and on the ID page
    const removedId = fixture('status-removed').result.removed[0];
    w = await open({status: () => fixture('status-removed'), ack: () => ({ok: true, result: {event: 'result', changed: 1}})});
    await pageIs(w, 'group');
    check(w.removedRows.length === 1 && labelText(w.removedRows[0].label) === S.syncRemovedBanner(compareLine(removedId)) && labelText(w.removedRows[0].button) === S.syncReaddButton(), 'a removed computer: its banner with the ID start and Add again');
    check(w.w.groupAdd.get_sensitive(), 'a removed computer does not stop Add');
    w.removedRows[0].button.emit('clicked');
    check(await waitFor(() => fake.count('ack') === 1) && JSON.stringify(fake.argv.find(a => a[0] === 'ack')) === JSON.stringify(['ack', removedId]), 'Add again runs ack for that one ID');
    check(await waitFor(() => fake.count('status') >= 2), 'and the list is read again');
    await closeWin(w);
    w = await open({status: () => fixture('status-set-up', {removed: [removedId]})});
    await pageIs(w, 'ids');
    check(w.removedRows.length === 1 && w.w.removed.get_first_child() !== null, 'a computer with no other computer shows the removed ones on the ID page too');
    await closeWin(w);

    w = await open({status: () => fixture('status-revocation-open'), finish: () => ({ok: true, result: {event: 'result', revocation_open: false}})});
    await pageIs(w, 'group');
    check(w.w.bnFreeze.box.get_visible() && labelText(w.w.bnFreeze.label) === S.syncFreezeBanner() && labelText(w.w.freezeButton) === S.syncFinishButton(), 'an open removal: the neutral banner with the Finish button');
    check(!w.w.groupAdd.get_sensitive() && w.rowWidgets.every(r => r.limited.get_visible() && labelText(r.limited) === S.syncRowLimited()), 'Add is off and every row that is no longer taken from says "Limited"');
    check(!w.w.bnPromote.box.get_visible(), 'no promote consent while a removal is open');
    w.w.freezeButton.emit('clicked');
    check(w.confirmDialog !== undefined && fake.count('finish') === 0, 'Finish asks first; nothing ran yet');
    w.confirmDialog.emit('response', 'cancel');
    await tick(80);
    check(fake.count('finish') === 0, 'Cancel runs nothing');
    w.w.freezeButton.emit('clicked');
    w.confirmDialog.emit('response', 'go');
    check(await waitFor(() => fake.count('finish') === 1 && fake.count('status') >= 2), 'confirming runs finish and reads the list again');
    check(JSON.stringify(fake.argv.find(a => a[0] === 'finish')) === JSON.stringify(['finish']), 'finish has no argument');
    await closeWin(w);

    // the last computer was revoked and the window was closed before Finish: no peer, the removal still open. The group page has Finish; the ID page had none.
    let lastOpen = true;
    w = await open({status: () => status('set-up', {computers: 1, listener: 'ok', notes: 3, revocation_open: lastOpen, removed: lastOpen ? [B] : []}),
        finish: () => { lastOpen = false; return {ok: true, result: {event: 'result', revocation_open: false}}; }});
    await pageIs(w, 'group');
    check(w.w.bnFreeze.box.get_visible() && w.w.freezeButton.get_visible() && labelText(w.w.freezeButton) === S.syncFinishButton(), 'no computer left and a removal open: the group page with the banner and the Finish button');
    check(w.rowWidgets.length === 0 && !w.w.groupAdd.get_sensitive(), 'no rows, Add is off');
    w.w.freezeButton.emit('clicked');
    w.confirmDialog.emit('response', 'go');
    check(await waitFor(() => fake.count('finish') === 1), 'Finish runs');
    await pageIs(w, 'ids');
    check(!lastOpen, 'after it the status has no removal open and the ID page is shown (the list is empty, the window can add a computer again)');
    await closeWin(w);

    // over the limit: the banner with the counts, no link text (not measured), Add off, and a choice longer than the engine takes is not sent
    w = await open({status: () => fixture('status-over-limit'), revoke: () => fail('E_INTERNAL')});
    await pageIs(w, 'group');
    const over = fixture('status-over-limit').result;
    check(w.w.bnOver.box.get_visible() && labelText(w.w.bnOver.label) === S.syncOverLimit(over.computers, over.max_computers), 'over the limit: the banner names the counts');
    check(w.rowWidgets.length === over.peers.length && w.rowWidgets.every(r => !r.link.get_visible()) && !w.w.groupAdd.get_sensitive(), 'the cut list is shown, no link text, Add off');
    w.rowWidgets[0].remove.emit('clicked');
    check(w.page === 'remove' && w.removeChecks.length === over.peers.length - 1 && w.removeChecks.every(c => c.check.get_active()), 'removing the introducer marks every row it introduced');
    check(w.w.removeTooMany.get_visible() && labelText(w.w.removeTooMany) === S.syncRemoveTooMany(over.max_computers - 1) && !w.w.removeConfirm.get_sensitive(), 'more rows than one revoke takes: a hint and no confirm');
    w.removeChecks[0].check.set_active(false);
    check(!w.w.removeTooMany.get_visible() && w.w.removeConfirm.get_sensitive(), 'one explicit keep brings it back in range');
    await closeWin(w);

    w = await open({status: () => ({...fixture('status-over-limit'), result: {...fixture('status-over-limit').result, peers: [], state: 'half', computers: 40}})});
    await pageIs(w, 'group');
    check(w.w.bnOver.box.get_visible() && w.rowWidgets.length === 0 && labelText(w.w.groupCount) === S.syncGroupCount(40, 10) && labelText(w.w.bnOver.label) === S.syncOverCap(40), 'a list over the read cap: the banner says only Stop syncing is left, the count, no rows');
    await closeWin(w);

    w = await open({status: () => fixture('status-max-size'), harden: () => ({ok: true, result: {event: 'result', changed: 9}})});
    await pageIs(w, 'group');
    check(w.w.bnFull.box.get_visible() && labelText(w.w.bnFull.label) === S.syncGroupFull(10) && !w.w.groupAdd.get_sensitive(), 'a full group: the line and Add off');
    await closeWin(w);

    // ---- the remove dialog and the revoke run
    const revokeProgress = opts => {
        for (const step of ['freeze', 'remove', 'verify', 'dwell']) {
            opts.onEvent({event: 'progress', step, state: 'start'});
            opts.onEvent({event: 'progress', step, state: 'ok'});
        }
    };
    let revokeResult = {event: 'result', removed: [B], returned: [], offline: [{id: O, name: 'office'}], remaining: 2, revocation_open: true};
    const answers = () => ({
        status: () => fixture('status-group-new', {harden_pending: 0}),
        revoke: async opts => { opts.onEvent({event: 'progress', step: 'freeze', state: 'start'}); await tick(60); revokeProgress(opts); return {ok: true, result: revokeResult}; },
        finish: () => ({ok: true, result: {event: 'result', revocation_open: false}}),
        forget: () => ({ok: true, result: {event: 'result', state: 'set-up', remaining: 0}}),
    });
    w = await open(answers());
    await pageIs(w, 'group');
    w.rowWidgets[0].remove.emit('clicked');
    check(w.page === 'remove' && labelText(w.w.removeTarget).startsWith('laptop-b'), 'Remove on a row: the remove page for that computer');
    check(!w.w.removeHave.get_visible() && w.w.removeLost.get_active(), 'the "I still have it" path is hidden while the policy switch is off (and lost is chosen)');
    check(w.removeChecks.length === 1 && w.removeChecks[0].id === P && w.removeChecks[0].check.get_active(), 'the row it introduced (and a new row) is marked "not mine" by default');
    check(w.w.removeOthers.get_visible() && labelText(w.w.removeOthersHeading) === S.syncRemoveOthers(), 'with the heading');
    w.removeChecks[0].check.set_active(false);
    w.w.removeConfirm.emit('clicked');
    check(w.confirmDialog !== undefined && fake.count('revoke') === 0, 'Remove asks first');
    w.confirmDialog.emit('response', 'cancel');
    await tick(80);
    check(fake.count('revoke') === 0 && w.page === 'remove', 'Cancel runs nothing');
    w.w.removeConfirm.emit('clicked');
    w.confirmDialog.emit('response', 'go');
    check(await pageIs(w, 'revoking') || w.page === 'revoke-result', 'the revoking page');
    check(JSON.stringify(fake.argv.find(a => a[0] === 'revoke')) === JSON.stringify(['revoke', B]), 'revoke gets exactly the IDs the user left marked (the chosen one only: the explicit keep held)');
    check(await pageIs(w, 'revoke-result'), 'the result page');
    check(labelText(w.w.resRemoved) === S.syncRevokeRemoved(`laptop-b (${compareLine(B)})`), `block 1: removed on this computer, by name and ID start (${labelText(w.w.resRemoved)})`);
    check(w.w.resOffline.get_visible() && labelText(w.w.resOffline) === S.syncRevokeOffline(`office (${compareLine(O)})`), 'block 2: the computers that were offline');
    check(labelText(w.w.resNext) === S.syncRevokeNext() && labelText(w.w.resFinish) === S.syncFinishButton(), 'block 3 and the Finish button');
    const indexOf = widget => { let i = 0; for (let c = widget.get_parent().get_first_child(); c !== null; c = c.get_next_sibling(), i++) { if (c === widget) return i; } return -1; };
    check(indexOf(w.w.resRemoved) >= 0 && indexOf(w.w.resRemoved) < indexOf(w.w.resOffline) && indexOf(w.w.resOffline) < indexOf(w.w.resNext) && indexOf(w.w.resNext) < indexOf(w.w.resFinish.get_parent()), 'the three blocks come in Nicole\'s order, Finish after them');
    check([...Object.values(w.w.revokeSteps)].every(s => s.done.get_visible() && !s.spinner.get_visible()), 'every step ended with its check mark');
    check(w.w.resReturned.get_first_child() === null, 'nothing came back');
    w.w.resFinish.emit('clicked');
    check(fake.count('finish') === 0, 'Finish asks first');
    w.confirmDialog.emit('response', 'go');
    check(await waitFor(() => fake.count('finish') === 1 && fake.count('status') >= 2), 'Finish runs finish and reads the list again');
    await closeWin(w);

    // the nuclear option from the result page, and Stop syncing from the group page: forget --all, nothing else
    w = await open(answers());
    await pageIs(w, 'group');
    w.rowWidgets[0].remove.emit('clicked');
    w.w.removeConfirm.emit('clicked');
    w.confirmDialog.emit('response', 'go');
    check(await pageIs(w, 'revoke-result'), 'again to the result page');
    check(labelText(w.w.resStopAll) === S.syncStopAll(), 'the link "Stop syncing with all computers"');
    w.w.resStopAll.emit('clicked');
    w.confirmDialog.emit('response', 'go');
    check(await waitFor(() => fake.count('forget') === 1), 'it runs forget');
    check(JSON.stringify(fake.argv.find(a => a[0] === 'forget')) === JSON.stringify(['forget', '--all']), 'forget --all, no stop flag');
    await closeWin(w);
    w = await open(answers());
    await pageIs(w, 'group');
    w.w.groupStop.emit('clicked');
    check(w.confirmDialog !== undefined && fake.count('forget') === 0 && w.confirmDialog.get_body() === S.syncStopConfirmBody() && S.syncStopConfirmBody().includes('all your computers'), 'Stop syncing asks first, in the plural; nothing ran yet');
    w.confirmDialog.emit('response', 'cancel');
    await tick(100);
    check(fake.count('forget') === 0, 'Cancel runs nothing');
    w.w.groupStop.emit('clicked');
    w.confirmDialog.emit('response', 'go');
    check(await waitFor(() => fake.count('forget') === 1 && fake.count('status') >= 2), 'confirming runs forget --all and asks the status again');
    check(JSON.stringify(fake.argv.find(a => a[0] === 'forget')) === JSON.stringify(['forget', '--all']), 'the bare forget of 0.2.5 is gone');
    await closeWin(w);

    // a removed computer that came back during the removal: the result page offers to remove it again from a fresh list
    revokeResult = {event: 'result', removed: [B, P], returned: [P], offline: [], remaining: 1, revocation_open: true};
    w = await open(answers());
    await pageIs(w, 'group');
    w.rowWidgets[0].remove.emit('clicked');
    w.w.removeConfirm.emit('clicked');
    w.confirmDialog.emit('response', 'go');
    check(await pageIs(w, 'revoke-result'), 'a revoke where one came back');
    check(!w.w.resOffline.get_visible() && w.resReturnedRows.length === 1 && labelText(w.resReturnedRows[0].label) === S.syncReturned(compareLine(P)), 'the returned computer is named, the offline block is hidden');
    check(JSON.stringify(fake.argv.find(a => a[0] === 'revoke')) === JSON.stringify(['revoke', B, P]), 'revoke got the chosen one first and the marked row');
    w.resReturnedRows[0].button.emit('clicked');
    check(await pageIs(w, 'remove') && w.rm.id === P, 'Remove again: a fresh status, then the remove page for it');
    await closeWin(w);
    revokeResult = {event: 'result', removed: [B], returned: [], offline: [{id: O, name: 'office'}], remaining: 2, revocation_open: true};

    // an engine error during the revoke: the error page, and Try again reads the status (it never repeats the removal by itself)
    w = await open({...answers(), revoke: () => fail('E_CLI_FAILED', 'remove')});
    await pageIs(w, 'group');
    w.rowWidgets[0].remove.emit('clicked');
    w.w.removeConfirm.emit('clicked');
    w.confirmDialog.emit('response', 'go');
    check(await pageIs(w, 'error') && w.w.errAction.get_visible(), 'a failed revoke: the error page');
    const before = fake.count('revoke');
    w.w.errAction.emit('clicked');
    check(await waitFor(() => fake.count('status') === 2) && fake.count('revoke') === before, 'Try again reads the status and does not repeat the removal');
    await closeWin(w);

    // the shortcut path, with the policy switch given as on: "I still have this computer" for a row accepted here, forget <ID>
    fake.reset();
    Object.assign(fake.answers, {status: () => fixture('status-group-3'), forget: () => ({ok: true, result: {event: 'result', state: null, remaining: 2}})});
    const sc = new SyncWizard({ctl: app.ctl, bridge: fake, shortcutRemove: true});
    sc.present();
    await pageIs(sc, 'group');
    sc.rowWidgets[1].remove.emit('clicked');
    check(sc.page === 'remove' && !sc.w.removeHave.get_visible(), 'switch on, an introduced row: only the lost path');
    sc.w.removeBack.emit('clicked');
    sc.rowWidgets[0].remove.emit('clicked');
    check(sc.w.removeHave.get_visible() && sc.w.removeLost.get_active(), 'switch on, a row accepted here: both paths, lost chosen first');
    sc.w.removeHave.set_active(true);
    check(sc.rm.path === 'have' && !sc.w.removeOthers.get_visible() && !sc.w.removeLostDetail.get_visible() && sc.w.removeConfirm.get_sensitive(), 'the shortcut path has no checklist');
    sc.w.removeConfirm.emit('clicked');
    sc.confirmDialog.emit('response', 'go');
    check(await waitFor(() => fake.count('forget') === 1), 'forget runs');
    check(JSON.stringify(fake.argv.find(a => a[0] === 'forget')) === JSON.stringify(['forget', B]), 'forget <ID> with the one listed ID');
    sc.win.close();
    await tick(60);

    // a foreign entry next to computers: the page stays the neutral one, lists the computers (no link), and Remove works from there
    w = await open({status: () => fixture('status-foreign-config'),
        revoke: () => ({ok: true, result: {event: 'result', removed: [P], returned: [], offline: [], remaining: 1, revocation_open: true}})});
    check(await pageIs(w, 'info-foreign'), 'foreign-config: the neutral page');
    check(w.foreignRowWidgets.length === 2 && w.foreignRowWidgets.every(r => !r.link.get_visible()), 'it lists the computers the engine sends, with no link text');
    w.foreignRowWidgets[1].remove.emit('clicked');
    check(w.page === 'remove' && w.rm.id === P, 'Remove from the foreign page opens the remove page');
    w.w.removeBack.emit('clicked');
    check(w.page === 'info-foreign', 'Cancel goes back to the foreign page, not to a group page');
    w.foreignRowWidgets[1].remove.emit('clicked');
    w.w.removeConfirm.emit('clicked');
    w.confirmDialog.emit('response', 'go');
    check(await pageIs(w, 'revoke-result') && JSON.stringify(fake.argv.find(a => a[0] === 'revoke')) === JSON.stringify(['revoke', P]), 'and the removal runs with exactly that ID');
    await closeWin(w);

    // new and returned rows are marked for a look
    w = await open({status: () => fixture('status-group-new', {harden_pending: 0})});
    await pageIs(w, 'group');
    check(w.rowWidgets[1].name.has_css_class('warning') && !w.rowWidgets[0].name.has_css_class('warning'), 'a new row is highlighted, the others are not');
    await closeWin(w);

    // switch off (the default): the same row has no shortcut
    w = await open({status: () => fixture('status-group-3')});
    await pageIs(w, 'group');
    w.rowWidgets[0].remove.emit('clicked');
    check(!w.w.removeHave.get_visible() && !w.w.removeHaveDetail.get_visible(), 'switch off: no "I still have this computer"');
    await closeWin(w);

    // ---- the first start: the consent page and no engine call; "Later" writes exactly the dismissal, mode 0600
    fake.reset();
    const first = new SyncWizard({ctl: app.ctl, bridge: fake, firstStart: true, binaryExists: () => true});
    first.present();
    await tick(100);
    check(first.page === 'consent' && fake.calls.length === 0, 'first start: the consent page, the engine not called at all');
    first.w.consentLater.emit('clicked');
    await tick(150);
    check(readWizardState(dirs.state) === DISMISSED_TEXT, 'closing with Later writes exactly {"version":1,"dismissed":true}');
    const mode = Gio.File.new_for_path(`${dirs.state}/sync-wizard.json`).query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null).get_attribute_uint32('unix::mode') & 0o777;
    check(mode === 0o600, `mode 0600 (${mode.toString(8)})`);
    check(!wantsFirstStart({dirs, homeDir: HOME}), 'and it is not asked again');
    fake.reset();
    const noBinary = new SyncWizard({ctl: app.ctl, bridge: fake, firstStart: true, binaryExists: () => false});
    noBinary.present();
    await tick(100);
    check(noBinary.page === 'missing' && fake.calls.length === 0, 'first start without the program: its own page, still no engine call');
    noBinary.win.close();
    await tick(60);

    // ---- the hook on files: nothing, a broken file, a version 2 file, markers on every level
    GLib.unlink(`${dirs.state}/sync-wizard.json`);
    check(wantsFirstStart({dirs, homeDir: HOME}) === true, 'no state file and no marker: the window is wanted');
    for (const text of ['not json', '{"version":2,"dismissed":false}']) {
        GLib.file_set_contents(`${dirs.state}/sync-wizard.json`, text);
        check(wantsFirstStart({dirs, homeDir: HOME}) === false, `state file ${JSON.stringify(text)}: not shown`);
    }
    GLib.file_set_contents(`${dirs.state}/sync-wizard.json`, new Uint8Array([0xff, 0xfe, 0x7b]));
    check(wantsFirstStart({dirs, homeDir: HOME}) === false, 'a state file that is not UTF-8: not shown');
    GLib.unlink(`${dirs.state}/sync-wizard.json`);
    for (const level of [dirs.notes, `${HOME}/.local/share/cetli`, `${HOME}/.local/share`, `${HOME}/.local`, HOME]) {
        GLib.mkdir_with_parents(level, 0o700);
        GLib.file_set_contents(`${level}/.stfolder`, '');
        check(wantsFirstStart({dirs, homeDir: HOME}) === false, `a marker in ${level.slice(base.length)}: not shown`);
        GLib.unlink(`${level}/.stfolder`);
    }
    GLib.file_set_contents(`${base}/.stfolder`, '');
    check(wantsFirstStart({dirs, homeDir: HOME}) === true, 'a marker ABOVE $HOME is never asked about');
    GLib.unlink(`${base}/.stfolder`);
    writeDismissed(dirs.state);
    check(readWizardState(dirs.state) === DISMISSED_TEXT, 'writeDismissed writes the dismissal');
    check(Gtk.Window.list_toplevels().filter(t => t.get_visible()).length >= 1, 'the note window is still there');
}

scenario().then(() => {}, e => { failed++; print(`FAIL exception ${e}\n${e.stack}`); }).finally(() => {
    print(`${checks - failed}/${checks} checks passed`);
    print(failed === 0 ? 'RESULT PASS' : 'RESULT FAIL');
    GLib.spawn_command_line_async(`rm -rf ${base}`);
    gtkApp.quit();
});
const result = app.run([]);
imports.system.exit(failed === 0 ? result : 1);
