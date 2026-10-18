// SPDX-License-Identifier: GPL-3.0-or-later
// Headless smoke test of the sync window (0.2.5): run it inside a headless Wayland compositor, see app-tests/run.sh. The window talks to a
// FAKE bridge (no engine, no process, no Syncthing): the fake answers what the contract fixtures say and records every call. Every wait is a
// poll on a condition with a generous limit, never a fixed sleep.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';

import {createApp} from '../app/application.js';
import {readWizardState, wantsFirstStart, writeDismissed} from '../app/sync-hook.js';
import {SyncWizard} from '../app/sync-wizard.js';
import {DISMISSED_TEXT} from '../app/sync-start.js';
import * as S from '../app/strings.js';

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
const status = (state, extra = {}) => ({ok: true, result: {event: 'result', state, own_id: A, peer: null, connected: null, link: null, connected_s: null, listener: null, shared: null, up_to_date: null, notes: null, waiting: false, ...extra}});
const paired = (extra = {}) => status('paired', {peer: {id: B, name: 'laptop-b'}, connected: true, link: 'stable', connected_s: 9, listener: 'ok', shared: true, up_to_date: null, notes: 3, ...extra});
const fail = (code, step = null) => ({ok: false, error: {code, step}});

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
    }

    start(verb, opts = {}) {
        this.calls.push({verb, opts});
        if (verb === 'host') {
            let resolve;
            const done = new Promise(r => { resolve = r; });
            const h = {opts, done, accepted: [], stopCalls: 0, finish: resolve, emit: ev => opts.onEvent?.(ev),
                accept(id) { h.accepted.push(id); return true; }, stop() { h.stopCalls++; resolve(fail('E_EXPIRED')); return done; }};
            this.hosts.push(h);
            return h;
        }
        const answer = this.answers[verb] ?? (() => fail('E_INTERNAL'));
        const done = Promise.resolve().then(() => answer(opts));
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
        ['foreign config', status('foreign-config', {peer: {id: B, name: null}, connected: true}), 'info-foreign'],
        ['set up', status('set-up'), 'ids'],
        ['half', status('half', {peer: {id: B, name: null}, connected: false, link: 'none', connected_s: null, shared: false, up_to_date: null}), 'half'],
        ['paired', paired(), 'paired'],
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
        ['E_SERVICE_TIMEOUT', {neutral: false, button: S.syncTryAgain()}],
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
        // only the sync program that does not answer has a way out beyond the first button
        check(w.w.errSecondary.get_visible() === (code === 'E_SERVICE_TIMEOUT') && (code !== 'E_SERVICE_TIMEOUT' || labelText(w.w.errSecondary) === S.syncResetButton()),
            `${code}: ${code === 'E_SERVICE_TIMEOUT' ? 'a second button "Reset sync"' : 'no second button'}`);
        await closeWin(w);
    }

    // ---- the sync program does not answer: Try again restarts it (no data touched), and if that does not help there is Reset sync after a confirmation
    let statusAnswer = fail('E_SERVICE_TIMEOUT');
    w = await open({
        status: () => statusAnswer,
        restart: () => ({ok: true, result: {event: 'result', state: 'restarted'}}),
        reset: () => ({ok: true, result: {event: 'result', state: 'not-set-up'}}),
        setup: () => ({ok: true, result: {event: 'result', own_id: A, state: 'set-up'}}),
    });
    await pageIs(w, 'error');
    w.w.errAction.emit('clicked');
    check(await waitFor(() => fake.count('restart') === 1 && fake.count('status') === 2), 'Try again on E_SERVICE_TIMEOUT runs restart, then asks the status');
    check(fake.count('setup') === 0 && fake.count('reset') === 0 && fake.count('forget') === 0, 'and nothing else');
    check(await pageIs(w, 'error') && w.w.errSecondary.get_visible(), 'the daemon still silent: the error page again, the way out still there');
    statusAnswer = status('set-up');
    w.w.errAction.emit('clicked');
    check(await pageIs(w, 'ids') && fake.count('restart') === 2, 'a restart that helps ends on the ID page');
    await closeWin(w);
    statusAnswer = fail('E_SERVICE_TIMEOUT');
    w = await open({
        status: () => statusAnswer,
        restart: () => fail('E_SERVICE_TIMEOUT', 'service'),
        reset: () => ({ok: true, result: {event: 'result', state: 'not-set-up'}}),
        setup: () => ({ok: true, result: {event: 'result', own_id: B, state: 'set-up'}}),
    });
    await pageIs(w, 'error');
    w.w.errAction.emit('clicked');
    check(await waitFor(() => fake.count('restart') === 1) && await pageIs(w, 'error') && w.w.errSecondary.get_visible(), 'a restart that fails with the same code: both buttons stay');
    w.w.errSecondary.emit('clicked');
    check(w.confirmDialog !== undefined && fake.count('reset') === 0, 'Reset sync asks first; nothing ran yet');
    const body = w.confirmDialog.get_body();
    check(w.confirmDialog.get_heading() === S.syncResetConfirmTitle() && body === S.syncResetConfirmBody(), 'the confirmation carries its own title and text');
    check(body.includes('new ID') && body.includes('Stop syncing') && body.includes('notes stay'), 'it says: a new ID, Stop syncing on the other computer, the notes stay');
    w.confirmDialog.emit('response', 'cancel');
    await tick(150);
    check(fake.count('reset') === 0 && w.page === 'error', 'Cancel runs nothing');
    w.w.errSecondary.emit('clicked');
    w.confirmDialog.emit('response', 'reset');
    check(await waitFor(() => fake.count('reset') === 1), 'confirming runs reset');
    check(await pageIs(w, 'ids') && fake.count('setup') === 1, 'then setup and the ID page (a new ID, the entry of the other ID), not another status question');
    check(rowsText(w.w.ownId) === B && fake.count('host') === 1, 'the new ID of this computer is shown and a waiting run started');
    check(fake.calls.map(c => c.verb).join() === 'status,restart,reset,setup,host', `the order of the calls (${fake.calls.map(c => c.verb).join()})`);
    await closeWin(w);
    // a reset that fails shows its error and goes on from the status
    w = await open({status: () => fail('E_SERVICE_TIMEOUT'), reset: () => fail('E_NO_USER_SYSTEMD', 'service')});
    await pageIs(w, 'error');
    w.w.errSecondary.emit('clicked');
    w.confirmDialog.emit('response', 'reset');
    check(await waitFor(() => fake.count('reset') === 1) && await waitFor(() => labelText(w.w.errText) === S.syncErrorText('E_NO_USER_SYSTEMD')), 'a failed reset shows its own error');
    check(fake.count('setup') === 0, 'and starts no set-up');
    await closeWin(w);

    // ---- the ambiguity error offers a new waiting run
    w = await open({status: () => status('set-up')});
    await pageIs(w, 'ids');
    fake.hosts[0].finish(fail('E_PENDING_AMBIGUOUS'));
    check(await pageIs(w, 'error'), 'the waiting run ends with an error page');
    w.w.errAction.emit('clicked');
    check(await pageIs(w, 'ids') && fake.hosts.length === 2, 'Try again goes back to the ID page and waits again');
    await closeWin(w);

    // ---- a timeout after the accept: Try again asks the status (the other computer is already added), it does not start a second opening
    w = await open({status: () => status('half', {peer: {id: B, name: null}, connected: false, link: 'none', connected_s: null, shared: true, up_to_date: null})});
    await pageIs(w, 'half');
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

    // ---- the paired page and Stop syncing
    w = await open({status: () => paired(), forget: () => ({ok: true, result: {event: 'result', state: 'set-up'}})});
    await pageIs(w, 'paired');
    check(labelText(w.w.pairedLink) === S.syncLinkText('connected'), 'stable: "Connected" (and no count on the status page)');
    check(rowsText(w.w.pairedPeerId) === B, 'the peer ID in full');
    check(!w.w.pairedOwn.get_visible(), 'the own ID is hidden until asked');
    w.w.pairedShowOwn.emit('clicked');
    check(w.w.pairedOwn.get_visible() && rowsText(w.w.pairedOwnId) === A, 'then shown in full');
    await closeWin(w);
    for (const [extra, key] of [[{link: 'flapping', connected_s: null}, 'unstable'], [{link: 'none', connected_s: null}, 'offline'], [{link: null, connected_s: null}, 'checking']]) {
        w = await open({status: () => paired(extra)});
        await pageIs(w, 'paired');
        check(labelText(w.w.pairedLink) === S.syncLinkText(key) && labelText(w.w.pairedLink) !== S.syncLinkText('connected'), `link ${JSON.stringify(extra)}: ${key}, never "Connected"`);
        await closeWin(w);
    }
    // the listener note: neutral (no error style), only for degraded and down, hidden for ok and null
    for (const [listener, shown] of [['degraded', true], ['down', true], ['ok', false], [null, false]]) {
        w = await open({status: () => paired({listener})});
        await pageIs(w, 'paired');
        check(w.w.pairedListener.get_visible() === shown && (labelText(w.w.pairedListener) !== '') === shown, `listener ${listener}: ${shown ? 'a note' : 'no note'} on the paired page`);
        check(!w.w.pairedListener.has_css_class('error') && !w.w.pairedStop.has_css_class('suggested-action'), `listener ${listener}: neutral, no red`);
        check(labelText(w.w.pairedLink) === S.syncLinkText('connected'), `listener ${listener}: the link line is unchanged`);
        await closeWin(w);
    }
    w = await open({status: () => status('set-up', {listener: 'degraded'})});
    await pageIs(w, 'ids');
    check(w.w.idsListener.get_visible() && labelText(w.w.idsListener) === S.syncListenerText('degraded') && !w.w.idsListener.has_css_class('error'), 'the ID page carries the same neutral note');
    await closeWin(w);
    w = await open({status: () => paired(), forget: () => ({ok: true, result: {event: 'result', state: 'set-up'}})});
    await pageIs(w, 'paired');
    w.w.pairedStop.emit('clicked');
    check(w.confirmDialog !== undefined && fake.count('forget') === 0, 'Stop syncing asks first; nothing ran yet');
    w.confirmDialog.emit('response', 'cancel');
    await tick(100);
    check(fake.count('forget') === 0, 'Cancel runs nothing');
    w.w.pairedStop.emit('clicked');
    w.confirmDialog.emit('response', 'stop');
    check(await waitFor(() => fake.count('forget') === 1 && fake.count('status') >= 2), 'confirming runs forget and asks the status again');
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
