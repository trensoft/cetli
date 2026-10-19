// SPDX-License-Identifier: GPL-3.0-or-later
// `ensure` (0.2.7): the quiet check at the start of the app. A `pkill -f cetli` stops the sync program with a clean exit, systemd restarts only after a
// failure, so the unit stays inactive until somebody starts it. Against the stub machine of support/world.js. The mutants are in sync-tests/mutants-ensure.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorld, OWN, PEER} from './support/world.js';
import {createEngine} from '../sync/engine.js';
import {emit} from '../sync/protocol.js';
import {createRunner} from '../app/sync-runner.js';

const perform = (w, verb, arg) => w.engine().perform(verb, arg);
const snap = w => JSON.stringify([...w.fsMap.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
const syncthingCalls = w => w.calls.filter(c => c.argv[0] === '/usr/bin/syncthing');
const systemctl = w => w.calls.filter(c => c.argv[0] === '/usr/bin/systemctl').map(c => c.argv.slice(1).join(' ').replace('--user ', '').replace(' cetli-syncthing.service', ''));
const DID_NOT_START = /^systemctl (restart|enable|reset-failed)/;

// a computer that was set up and paired, its sync program running
async function paired(opts = {}) {
    const w = createWorld(opts);
    await w.setUp();
    w.pair(PEER);
    w.note(3);
    return w;
}

test('ensure, Attila\'s way: the sync program was stopped cleanly (unit inactive, enabled), the app starts: reset-failed, restart, the daemon answers, the status is paired', async () => {
    const w = await paired({startDelayMs: 2000});
    w.daemon = false;                                               // pkill: SIGTERM, a clean exit, the unit is inactive (not failed)
    const before = snap(w);
    const r = await perform(w, 'ensure');
    assert.deepEqual(r, {result: {event: 'result', state: 'started'}});
    assert.deepEqual(systemctl(w), ['is-enabled', 'is-active', 'reset-failed', 'restart']);
    assert.equal(w.daemon, true, 'the daemon runs');
    assert.ok(w.mono >= 2000, 'it waited for the daemon');
    assert.equal(snap(w), before, 'no file changed');
    assert.deepEqual(w.events, [], 'quiet: no progress line');
    assert.equal((await perform(w, 'status')).result.state, 'paired');
    emit(r.result, 'ensure');
});

test('ensure: a unit in the failed state (start limit) is started too, after reset-failed', async () => {
    const w = await paired();
    w.daemon = false;
    w.unitFailed = true;
    assert.deepEqual(await perform(w, 'ensure'), {result: {event: 'result', state: 'started'}});
    assert.deepEqual(systemctl(w), ['is-enabled', 'is-active', 'reset-failed', 'restart']);
    assert.equal(w.daemon, true);
});

test('ensure: a daemon that answers is left alone: no is-active, no reset-failed, no restart', async () => {
    const w = await paired();
    const r = await perform(w, 'ensure');
    assert.deepEqual(r, {result: {event: 'result', state: 'running'}});
    assert.deepEqual(systemctl(w), ['is-enabled']);
    assert.equal(w.timeline.some(e => DID_NOT_START.test(e)), false);
    emit(r.result, 'ensure');
});

test('ensure: an orphan child (the parent was killed: the daemon answers, the unit says inactive) is NOT started a second time (Han 9715)', async () => {
    const w = await paired();
    w.daemon = false;
    w.orphan = true;
    assert.deepEqual(await perform(w, 'ensure'), {result: {event: 'result', state: 'running'}});
    assert.deepEqual(systemctl(w), ['is-enabled'], 'the real state decides before the unit state is even asked');
    assert.equal(w.timeline.some(e => DID_NOT_START.test(e)), false);
});

test('ensure: a unit the user switched off (disabled) is not started; masked, not found or no answer from systemd: not started either (fail closed), only a journal line', async () => {
    const off = await paired();
    off.daemon = false;
    off.enabled = false;
    assert.deepEqual(await perform(off, 'ensure'), {result: {event: 'result', state: 'skipped'}});
    assert.deepEqual(systemctl(off), ['is-enabled']);
    assert.equal(off.daemon, false);
    assert.equal(off.enabled, false);
    assert.ok(off.journal.some(l => l.startsWith('ensure:')), 'the journal says why');
    const masked = await paired();
    masked.daemon = false;
    masked.failSystemctl.add('is-enabled cetli-syncthing.service');
    assert.deepEqual(await perform(masked, 'ensure'), {result: {event: 'result', state: 'skipped'}});
    assert.deepEqual(systemctl(masked), ['is-enabled']);
    assert.equal(masked.daemon, false);
    const nobus = await paired();
    nobus.daemon = false;
    nobus.systemd = false;
    assert.deepEqual(await perform(nobus, 'ensure'), {result: {event: 'result', state: 'skipped'}});
    assert.equal(nobus.daemon, false);
});

test('ensure: a unit that is active but silent is left to the window (its own restart), nothing is started here', async () => {
    const w = await paired();
    w.hung = true;
    assert.deepEqual(await perform(w, 'ensure'), {result: {event: 'result', state: 'skipped'}});
    assert.deepEqual(systemctl(w), ['is-enabled', 'is-active']);
    assert.equal(w.timeline.some(e => DID_NOT_START.test(e)), false);
});

test('ensure: no program, no instance, or a folder that is not ours: nothing at all is run', async () => {
    const none = createWorld({backend: false});
    assert.deepEqual(await perform(none, 'ensure'), {result: {event: 'result', state: 'skipped'}});
    assert.equal(none.calls.length, 0);
    const fresh = createWorld();
    assert.deepEqual(await perform(fresh, 'ensure'), {result: {event: 'result', state: 'skipped'}});
    assert.equal(fresh.calls.length, 0);
    const w = await paired();
    w.daemon = false;
    const cfg = w.fsMap.get(`${w.home}/config.xml`);
    cfg.text = cfg.text.replace(/\n {4}<folder id="[^"]*"[\s\S]*?\n {4}<\/folder>/g, '');
    assert.deepEqual(await perform(w, 'ensure'), {result: {event: 'result', state: 'skipped'}});
    assert.equal(w.calls.length, 0, 'a computer with a Syncthing of its own, or one that was never set up by cetli, is not touched');
});

test('ensure: a config that is not what we wrote is E_CONFIG_UNSAFE and nothing is started', async () => {
    const w = await paired();
    w.daemon = false;
    const cfg = w.fsMap.get(`${w.home}/config.xml`);
    cfg.text = cfg.text.replace(`${w.home}/gui.sock`, '0.0.0.0:8384');
    assert.deepEqual(await perform(w, 'ensure'), {error: {code: 'E_CONFIG_UNSAFE'}});
    assert.equal(w.timeline.some(e => DID_NOT_START.test(e)), false);
    assert.equal(w.daemon, false);
});

test('ensure: a refused restart is E_NO_USER_SYSTEMD, a daemon that stays silent after the start is E_SERVICE_TIMEOUT (no second restart inside)', async () => {
    const a = await paired();
    a.daemon = false;
    a.failSystemctl.add('restart cetli-syncthing.service');
    assert.deepEqual(await perform(a, 'ensure'), {error: {code: 'E_NO_USER_SYSTEMD'}});
    const b = await paired();
    b.startDelayMs = 40000;
    b.daemon = false;
    assert.deepEqual(await perform(b, 'ensure'), {error: {code: 'E_SERVICE_TIMEOUT'}});
    assert.equal(systemctl(b).filter(c => c === 'restart').length, 1);
});

test('ensure touches no data and asks the daemon only "show system"; it takes the short wait before it looks at the unit', async () => {
    const w = await paired();
    w.daemon = false;
    const before = snap(w);
    await perform(w, 'ensure');
    assert.equal(snap(w), before);
    assert.equal(w.timeline.some(e => /^(write|rename|remove|rmdir|generate)/.test(e)), false);
    assert.equal(syncthingCalls(w).every(c => c.argv[1] === 'cli' && c.argv.slice(3).join(' ') === 'show system'), true);
    const quiet = await paired();
    quiet.daemon = false;
    quiet.enabled = false;
    await perform(quiet, 'ensure');
    assert.ok(quiet.mono < 3000, 'a unit that is switched off costs no waiting');
});

// The whole chain of the app without a window: runner (argv, the contract checker) -> process line -> the engine on the stub machine.
test('ensure through the app\'s runner: the argv is `ensure`, the lines pass the contract, a stopped sync program is started; a running one is not', async () => {
    const proc = w => argv => {
        const cb = {};
        const verb = argv[1];
        setTimeout(async () => {
            const engine = createEngine({...w.ports(), emit: ev => cb.line(emit(ev, verb))});
            const outcome = await engine.perform(verb);
            cb.line(emit(outcome.result ?? {event: 'error', code: outcome.error.code}, verb));
            cb.exit(outcome.result ? 0 : 1);
        }, 0);
        w.argvs = [...(w.argvs ?? []), argv.slice(1).join(' ')];
        return {onLine: f => { cb.line = f; }, onOverflow: () => {}, onExit: f => { cb.exit = f; }, write() {}, closeStdin() {}, kill() {}};
    };
    const runnerOf = w => createRunner({openProcess: proc(w), setTimer: () => ({}), clearTimer: () => {}});
    const stopped = await paired();
    stopped.daemon = false;
    assert.deepEqual(await runnerOf(stopped).run('ensure'), {ok: true, result: {event: 'result', state: 'started'}});
    assert.deepEqual(stopped.argvs, ['ensure']);
    assert.equal(stopped.daemon, true, 'the sync program runs again without any window');
    const running = await paired();
    assert.deepEqual(await runnerOf(running).run('ensure'), {ok: true, result: {event: 'result', state: 'running'}});
    assert.equal(running.timeline.some(e => DID_NOT_START.test(e)), false);
});
