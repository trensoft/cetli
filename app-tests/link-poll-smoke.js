// SPDX-License-Identifier: GPL-3.0-or-later
// 0.2.6 headless smoke of the link line of the sync window (the false "Not connected right now", Attila 22:50): the group page asks `status` again while it is
// on screen, a failed query is "Checking the connection" and never "Not connected", and a poll never collides with a click of the user. The window talks to a
// FAKE bridge that, like the real runner, refuses a second run while one is active (E_BUSY). Run it inside a headless Wayland compositor, see app-tests/run.sh.
// Not measured here: two real Syncthing instances; the two "computers" below are two windows with fake engines.
import GLib from 'gi://GLib';

import {createApp} from '../app/application.js';
import {SyncWizard} from '../app/sync-wizard.js';
import * as S from '../app/strings.js';

const base = GLib.dir_make_tmp('cetli-linkpoll-XXXXXX');
const dirs = {notes: `${base}/home/.local/share/cetli/notes`, tmp: `${base}/home/.local/share/cetli/tmp`, state: `${base}/home/.local/state/cetli`};
const HOME = `${base}/home`;
const POLL_MS = 250;
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
        await tick(20);
    }
}

const A = 'F6HEWOE-4KSACQ5-5MAX7IC-HAP3EGW-AQYBTIX-V74MXIF-ZB3GZN6-4T3QYQZ';
const B = 'VTTWEJK-SMIOBMH-3FIWS7V-JFC2CL4-FCR3BU6-PEPADRQ-EYVVD3Z-BIGMUQ5';
const status = (state, extra = {}) => ({ok: true, result: {event: 'result', state, own_id: A, peers: [], computers: null, max_computers: 10, over_limit: false, revocation_open: false,
    harden_pending: 0, promote_pending: 0, listener: null, up_to_date: null, notes: null, waiting: false, ...extra}});
const peerOf = (id, o = {}) => ({id, name: 'laptop-b', introduced_by: null, introducer: true, shared: true, connected: true, link: 'stable', connected_s: 9, new: false, returned: false, ...o});
const paired = (peerExtra = {}, extra = {}) => status('paired', {peers: [peerOf(B, peerExtra)], computers: 2, listener: 'ok', notes: 3, ...extra});
const unknown = () => paired({connected: null, link: null, connected_s: null});                  // the query failed: the engine says "unknown"
const none = () => paired({connected: false, link: 'none', connected_s: null});                  // the query answered: not connected

// The fake bridge: one run at a time, like app/sync-runner.js (a second start while one is active answers E_BUSY). `answers[verb]` gives the outcome;
// `delay[verb]` is how long the run takes.
class FakeBridge {
    constructor() {
        this.calls = [];
        this.answers = {};
        this.delay = {};
        this.active = null;
    }

    start(verb) {
        this.calls.push(verb);
        if (this.active !== null) {
            const busy = Promise.resolve({ok: false, error: {code: 'E_BUSY', step: null}});
            return {done: busy, accept: () => false, stop: () => busy};
        }
        const token = {};
        this.active = token;
        const done = (async () => {
            await tick(this.delay[verb] ?? 0);
            const out = (this.answers[verb] ?? (() => ({ok: false, error: {code: 'E_INTERNAL', step: null}})))();
            if (this.active === token)
                this.active = null;
            return out;
        })();
        return {done, accept: () => false, stop: () => done};
    }

    run(verb) {
        return this.start(verb).done;
    }

    stop() {
        return Promise.resolve();
    }

    count(verb) {
        return this.calls.filter(c => c === verb).length;
    }
}

const fake = new FakeBridge();
const app = createApp({dirs, bridge: fake, homeDir: HOME, linkPollMs: POLL_MS});
const {gtkApp} = app;
const text = key => S.syncLinkText(key);

// Every text the link line ever shows, in order.
const linkOf = w => w.rowWidgets[0]?.link ?? null;
function record(w) {
    const seen = [];
    const label = linkOf(w);
    const set = label.set_label.bind(label);
    label.set_label = t => { seen.push(t); set(t); };
    return seen;
}
const shows = (w, key) => linkOf(w) !== null && linkOf(w).get_label() === text(key);

async function scenario() {
    await app.ready;

    // ---- 1. the first query failed: "Checking", then the poll brings the truth; "Not connected" is never shown
    let calls = 0;
    fake.answers.status = () => (++calls === 1 ? unknown() : paired());
    let w = app.showSync();
    await waitFor(() => w.page === 'group');
    check(shows(w, 'checking'), 'a failed query shows "Checking the connection", not "Not connected right now"');
    const seen1 = record(w);
    check(await waitFor(() => shows(w, 'connected')), 'the window asks again by itself and shows "Connected"');
    check(!seen1.includes(text('offline')), 'and "Not connected right now" was never shown on the way');
    w.win.close();
    await tick(80);

    // ---- 2. the first sample was not connected (the computers were still reconnecting): the line does not stay stale
    fake.calls.length = 0;
    calls = 0;
    fake.answers.status = () => (++calls === 1 ? none() : paired());
    w = app.showSync();
    await waitFor(() => w.page === 'group');
    check(shows(w, 'offline'), 'a real not-connected answer shows "Not connected right now"');
    check(await waitFor(() => shows(w, 'connected')), 'once the computers are connected the same window shows "Connected" without being reopened');

    // ---- 3. a link that breaks later is shown within a few polls (the poll is 250 ms here, 3 s in the product)
    fake.answers.status = () => none();
    const t0 = GLib.get_monotonic_time();
    check(await waitFor(() => shows(w, 'offline'), 3000), 'a real break of the link shows "Not connected right now"');
    check((GLib.get_monotonic_time() - t0) / 1000 < 2000, 'within two seconds with a 250 ms poll');
    fake.answers.status = () => paired();
    check(await waitFor(() => shows(w, 'connected')), 'and "Connected" again when it is back');

    // ---- 4. both computers: two windows, both with a connected link, both say "Connected"
    const fakeB = new FakeBridge();
    fakeB.answers.status = () => status('paired', {own_id: B, peers: [peerOf(A, {name: 'pc-a'})], computers: 2, listener: 'ok', notes: 3});
    const second = new SyncWizard({ctl: app.ctl, bridge: fakeB, linkPollMs: POLL_MS});
    second.present();
    check(await waitFor(() => second.page === 'group' && shows(second, 'connected') && shows(w, 'connected')), 'with a connected link both windows say "Connected"');
    second.win.close();
    await tick(80);

    // ---- 5. a click while a poll is running: the poll is stopped, the click runs, no "busy" error page
    fake.delay.status = 500;
    fake.answers.forget = () => ({ok: true, result: {event: 'result', state: 'set-up', remaining: 0}});
    await waitFor(() => fake.active !== null);                                    // a poll is in flight
    const statusBefore = fake.count('status');
    w.w.groupStop.emit('clicked');
    w.confirmDialog.emit('response', 'go');
    check(await waitFor(() => fake.count('forget') === 1, 4000), 'Stop syncing runs even though a poll was running');
    await tick(300);
    check(w.page !== 'error', 'and no error page (no E_BUSY) is shown');
    check(fake.calls.slice(statusBefore).filter(c => c === 'forget').length === 1, 'forget ran exactly once');

    // ---- 6. polling ends with the paired page and with the window
    fake.delay.status = 0;
    fake.answers.status = () => paired();
    w.win.close();
    await tick(100);
    const after = fake.count('status');
    await tick(POLL_MS * 4);
    check(fake.count('status') === after, 'a closed window asks nothing more');

    // ---- 7. a poll that fails after "Connected" (the sync program stops on this computer): the line is "Checking", never the old "Connected", the page stays and
    // the poll goes on; the next answer shows the real state
    fake.answers.status = () => paired();
    w = app.showSync();
    await waitFor(() => w.page === 'group');
    check(await waitFor(() => shows(w, 'connected')), 'a connected pair shows "Connected" before the poll fails');
    const seen7 = record(w);
    fake.answers.status = () => ({ok: false, error: {code: 'E_SERVICE_TIMEOUT', step: null}});
    check(await waitFor(() => shows(w, 'checking')), 'a poll that fails turns the line to "Checking the connection"');
    const failedAt = fake.count('status');
    check(await waitFor(() => fake.count('status') >= failedAt + 2) && w.page === 'group' && shows(w, 'checking'), 'the group page stays and the poll goes on while the call fails');
    check(!shows(w, 'connected') && !shows(w, 'offline'), 'neither "Connected" nor "Not connected right now" is on the line');
    check(!seen7.includes(text('connected')) && !seen7.includes(text('offline')), 'and neither was set on the way');
    fake.answers.status = () => paired();
    check(await waitFor(() => shows(w, 'connected')), 'the next answer that succeeds shows "Connected" again');
    w.win.close();
    await tick(80);
}

scenario().then(() => {}, e => { failed++; print(`FAIL exception ${e}\n${e.stack}`); }).finally(() => {
    print(`${checks - failed}/${checks} checks passed`);
    print(failed === 0 ? 'RESULT PASS' : 'RESULT FAIL');
    GLib.spawn_command_line_async(`rm -rf ${base}`);
    gtkApp.quit();
});
const result = app.run([]);
imports.system.exit(failed === 0 ? result : 1);
