// SPDX-License-Identifier: GPL-3.0-or-later
// The two ways out of "the sync program does not answer" (0.2.5.2): `restart` (touches no data) and `reset` (moves the instance aside, takes away
// the marker of OUR folder, needs no daemon). Against the stub machine of support/world.js. The mutants of these tests are in sync-tests/mutants-recover.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorld, FAKE_KEY, OWN, PEER} from './support/world.js';
import {createEngine} from '../sync/engine.js';
import {emit} from '../sync/protocol.js';

const perform = (w, verb, arg) => w.engine().perform(verb, arg);
const snap = w => JSON.stringify([...w.fsMap.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
const syncthingCalls = w => w.calls.filter(c => c.argv[0] === '/usr/bin/syncthing');
const systemctl = w => w.calls.filter(c => c.argv[0] === '/usr/bin/systemctl').map(c => c.argv.slice(1).join(' ').replace('--user ', '').replace(' cetli-syncthing.service', ''));
const STAMP = '20270115T080000Z';                                   // the stub clock: 1_800_000_000_000 ms

// a machine that was set up and paired, whose daemon then stopped answering, with the unit in the failed state
async function stuck(opts = {}) {
    const w = createWorld(opts);
    await w.setUp();
    w.pair(PEER);
    w.note(3);
    w.hung = true;
    w.unitFailed = true;
    return w;
}

// ---- restart ------------------------------------------------------------------------------------------------------------------

test('restart: reset-failed, then restart, then it waits for the daemon; the order is the contract', async () => {
    const w = await stuck({startDelayMs: 3000});
    w.hung = false;
    w.daemon = false;
    const r = await perform(w, 'restart');
    assert.deepEqual(r, {result: {event: 'result', state: 'restarted'}});
    const t = w.timeline;
    assert.ok(t.indexOf('systemctl reset-failed') >= 0 && t.indexOf('systemctl reset-failed') < t.indexOf('systemctl restart'), 'reset-failed before restart');
    assert.ok(t.findIndex(e => e.startsWith('cli show system')) > t.indexOf('systemctl restart'), 'the daemon is asked after the restart');
    assert.ok(w.mono >= 3000, `it waited for the daemon (${w.mono} ms)`);
    assert.ok(w.sleeps > 0);
    assert.deepEqual(systemctl(w), ['is-enabled', 'reset-failed', 'restart']);
    assert.deepEqual(w.events.map(e => `${e.step}:${e.state}`), ['service:start', 'service:ok']);
    for (const e of w.events)
        emit(e, 'restart');
    emit(r.result, 'restart');
});

test('restart: a daemon that stays silent is E_SERVICE_TIMEOUT after the service wait, not a success', async () => {
    const w = await stuck();
    w.unitFailed = false;                                           // started, but silent
    const r = await perform(w, 'restart');
    assert.deepEqual(r, {error: {code: 'E_SERVICE_TIMEOUT', step: 'service'}});
    assert.ok(w.mono >= 30000, `waited ${w.mono} ms`);
    assert.deepEqual(systemctl(w), ['is-enabled', 'reset-failed', 'restart']);
});

test('restart touches no data: no write, no rename, no removal, no change of the file system, no cli write', async () => {
    const w = await stuck();
    w.hung = false;
    w.daemon = false;
    const before = snap(w);
    assert.equal((await perform(w, 'restart')).result.state, 'restarted');
    assert.equal(snap(w), before);
    assert.equal(w.timeline.some(e => /^(write|rename|remove|rmdir|generate)/.test(e)), false);
    assert.equal(syncthingCalls(w).every(c => c.argv[1] === 'cli' && c.argv.slice(3).join(' ') === 'show system'), true, 'the daemon is only asked "show system"');
});

test('restart: systemctl waits for the stop of the unit, so it gets a long time limit; the other calls keep theirs', async () => {
    const w = await stuck();
    w.hung = false;
    w.daemon = false;
    await perform(w, 'restart');
    const sc = w.calls.filter(c => c.argv[0] === '/usr/bin/systemctl');
    assert.equal(sc.length, 3);
    for (const c of sc)
        assert.equal(c.opts.timeoutMs, 120000);
});

test('restart: a refused restart is E_NO_USER_SYSTEMD; a reset-failed that fails does not stop it', async () => {
    const w = await stuck();
    w.hung = false;
    w.failSystemctl.add('restart cetli-syncthing.service');
    assert.deepEqual(await perform(w, 'restart'), {error: {code: 'E_NO_USER_SYSTEMD', step: 'service'}});
    const x = await stuck();
    x.hung = false;
    x.daemon = false;
    x.failSystemctl.add('reset-failed cetli-syncthing.service');
    x.unitFailed = false;
    assert.equal((await perform(x, 'restart')).result.state, 'restarted');
});

test('restart: no program, no instance, or a config that is not what we wrote: nothing is started', async () => {
    const none = createWorld({backend: false});
    assert.deepEqual(await perform(none, 'restart'), {error: {code: 'E_NO_SYNCTHING'}});
    assert.equal(none.calls.length, 0);
    const fresh = createWorld();
    assert.deepEqual(await perform(fresh, 'restart'), {error: {code: 'E_CLI_FAILED'}});
    assert.equal(fresh.calls.length, 0);
    const w = await stuck();
    const cfg = w.fsMap.get(`${w.home}/config.xml`);
    cfg.text = cfg.text.replace(`${w.home}/gui.sock`, '0.0.0.0:8384');
    assert.deepEqual(await perform(w, 'restart'), {error: {code: 'E_CONFIG_UNSAFE', step: 'service'}});
    assert.deepEqual(systemctl(w), []);
});

// ---- a unit that is not running (John 8844, a real Syncthing 2.1.6): inactive, failed, start limit, disabled ---------------------------------

// A set-up, paired machine whose UNIT is not running: `status` waits and ends on E_SERVICE_TIMEOUT (measured: 5-6 s).
async function notRunning(kind, opts = {}) {
    const w = await stuck(opts);
    w.hung = false;
    w.daemon = false;
    w.unitFailed = kind === 'start-limit';
    w.enabled = kind !== 'disabled';
    return w;
}

test('a unit that is not running makes status say E_SERVICE_TIMEOUT, in every one of the four states (the case the window starts from)', async () => {
    for (const kind of ['inactive', 'failed', 'start-limit', 'disabled']) {
        const w = await notRunning(kind);
        assert.deepEqual(await perform(w, 'status'), {error: {code: 'E_SERVICE_TIMEOUT'}}, kind);
        assert.deepEqual(systemctl(w), [], `${kind}: status starts nothing`);
    }
});

for (const [kind, why] of [['inactive', 'the unit was stopped'], ['failed', 'the unit ended in the failed state'], ['start-limit', 'the start limit refuses a start until reset-failed']]) {
    test(`restart (the automatic try, no flag), unit ${kind} (${why}): is-enabled, reset-failed, restart, then the daemon answers`, async () => {
        const w = await notRunning(kind, {startDelayMs: 2000});
        const r = await perform(w, 'restart');
        assert.deepEqual(r, {result: {event: 'result', state: 'restarted'}}, kind);
        assert.deepEqual(systemctl(w), ['is-enabled', 'reset-failed', 'restart'], kind);
        assert.equal(w.daemon, true, `${kind}: the daemon runs`);
        assert.ok(w.mono >= 2000, `${kind}: it waited for the daemon`);
        assert.equal((await perform(w, 'status')).result.state, 'paired', `${kind}: and the status is the paired page again`);
        emit(r.result, 'restart');
    });
}

test('restart (the automatic try), unit DISABLED: the user switched it off, so NOTHING is started; only the read-only question runs', async () => {
    const w = await notRunning('disabled');
    const before = snap(w);
    const r = await perform(w, 'restart');
    assert.deepEqual(r, {result: {event: 'result', state: 'disabled'}});
    assert.deepEqual(systemctl(w), ['is-enabled'], 'no reset-failed, no restart, no enable');
    assert.equal(w.daemon, false, 'the daemon does not run');
    assert.equal(w.enabled, false, 'and the unit is still disabled');
    assert.equal(w.timeline.some(e => /^systemctl (restart|enable|reset-failed)/.test(e)), false);
    assert.equal(snap(w), before);
    assert.equal(w.mono < 30000, true, 'it did not wait for a daemon that was not started');
    emit(r.result, 'restart');
});

test('restart --enable (the button), unit DISABLED: the user decides, so reset-failed, enable --now, then the daemon answers', async () => {
    const w = await notRunning('disabled', {startDelayMs: 2000});
    const r = await perform(w, 'restart', {enable: true});
    assert.deepEqual(r, {result: {event: 'result', state: 'restarted'}});
    assert.deepEqual(systemctl(w), ['is-enabled', 'reset-failed', 'enable --now']);
    assert.equal(w.enabled, true);
    assert.equal(w.daemon, true);
    assert.equal((await perform(w, 'status')).result.state, 'paired');
    const x = await notRunning('disabled');
    x.failSystemctl.add('enable --now cetli-syncthing.service');
    assert.deepEqual(await perform(x, 'restart', {enable: true}), {error: {code: 'E_NO_USER_SYSTEMD', step: 'service'}});
});

test('restart --enable on a unit that is enabled is the same restart as without the flag (is-enabled, reset-failed, restart)', async () => {
    for (const kind of ['inactive', 'failed', 'start-limit']) {
        const w = await notRunning(kind);
        assert.equal((await perform(w, 'restart', {enable: true})).result.state, 'restarted', kind);
        assert.deepEqual(systemctl(w), ['is-enabled', 'reset-failed', 'restart'], kind);
    }
});

test('restart: only the word "disabled" counts. An is-enabled that fails some other way (no answer, masked, an error) does not stop the restart', async () => {
    const a = await notRunning('inactive');
    a.failSystemctl.add('is-enabled cetli-syncthing.service');                     // rc 1, the text "Failed"
    assert.equal((await perform(a, 'restart')).result.state, 'restarted');
    assert.deepEqual(systemctl(a), ['is-enabled', 'reset-failed', 'restart']);
    const b = await notRunning('disabled');
    b.systemd = false;                                                             // no user service manager at all
    assert.deepEqual(await perform(b, 'restart'), {error: {code: 'E_NO_USER_SYSTEMD', step: 'service'}});
});

test('restart: the unit not running, then silent after the start: E_SERVICE_TIMEOUT again (the buttons stay), the automatic try does not loop in the engine', async () => {
    const w = await notRunning('inactive');
    w.startDelayMs = 40000;                                        // set after the set-up: the start is slower than the service wait
    assert.deepEqual(await perform(w, 'restart'), {error: {code: 'E_SERVICE_TIMEOUT', step: 'service'}});
    assert.deepEqual(systemctl(w), ['is-enabled', 'reset-failed', 'restart'], 'one pass, no second restart inside');
});

test('restart: a config that is not what we wrote is E_CONFIG_UNSAFE before ANY systemctl call, the automatic try and the button alike', async () => {
    for (const arg of [undefined, {enable: true}]) {
        const w = await notRunning('disabled');
        const cfg = w.fsMap.get(`${w.home}/config.xml`);
        cfg.text = cfg.text.replace(`${w.home}/gui.sock`, '0.0.0.0:8384');
        assert.deepEqual(await perform(w, 'restart', arg), {error: {code: 'E_CONFIG_UNSAFE', step: 'service'}});
        assert.deepEqual(systemctl(w), []);
    }
});

// ---- reset --------------------------------------------------------------------------------------------------------------------

test('reset: the unit is stopped, the instance is MOVED (not deleted), the marker of our folder goes, the notes stay; no daemon is asked', async () => {
    const w = await stuck();
    const home = w.home;
    const kept = new Map([...w.fsMap.entries()].filter(([k]) => k === home || k.startsWith(`${home}/`)));
    const notesBefore = w.files.listNames(w.notes).filter(n => n !== '.stfolder').sort();
    assert.equal(notesBefore.length, 3);
    assert.ok(w.fsMap.get(`${w.notes}/.stfolder`).dir);
    const r = await perform(w, 'reset');
    assert.deepEqual(r, {result: {event: 'result', state: 'not-set-up'}});
    const bak = `${home}.bak-${STAMP}`;
    assert.equal(w.fsMap.has(home), false, 'the old place is empty');
    for (const [k, v] of kept)
        assert.deepEqual(w.fsMap.get(bak + k.slice(home.length)), v, `${k} is in the backup, unchanged`);
    assert.ok(w.fsMap.get(`${bak}/key.pem`) && w.fsMap.get(`${bak}/config.xml`).text.includes(FAKE_KEY), 'identity and config are in the backup');
    assert.equal(w.fsMap.get(bak).mode, 0o700, 'the backup directory is as private as the instance was');
    assert.equal(w.fsMap.has(`${w.notes}/.stfolder`), false, 'the marker of our own folder is gone');
    assert.deepEqual(w.files.listNames(w.notes).sort(), notesBefore, 'the notes are exactly as they were');
    assert.equal(syncthingCalls(w).length, 0, 'not one call to the sync program: reset works without the daemon');
    assert.deepEqual(systemctl(w), ['disable --now', 'reset-failed']);
    const t = w.timeline;
    assert.deepEqual(t.filter(e => /^(write|remove|rename|rmdir|generate)/.test(e)), [`rename ${home} ${bak}`, `rmdir ${w.notes}/.stfolder`]);
    assert.ok(t.indexOf('systemctl disable') < t.findIndex(e => e.startsWith('rename')), 'the unit is stopped before the directory moves');
    assert.deepEqual(w.events.map(e => `${e.step}:${e.state}`), ['service:start', 'service:ok', 'instance:start', 'instance:ok', 'folder:start', 'folder:ok']);
    for (const e of w.events)
        emit(e, 'reset');
    emit(r.result, 'reset');
    assert.equal(JSON.stringify([w.events, w.journal]).includes(FAKE_KEY), false);
});

test('reset moves, never deletes: every file of the instance exists once under the new name, and the only thing removed anywhere is the marker', async () => {
    const w = await stuck();
    const before = [...w.fsMap.keys()].sort();
    await perform(w, 'reset');
    const after = [...w.fsMap.keys()].sort();
    const bak = `${w.home}.bak-${STAMP}`;
    const expected = before.filter(k => k !== `${w.notes}/.stfolder`).map(k => (k === w.home || k.startsWith(`${w.home}/`) ? bak + k.slice(w.home.length) : k)).sort();
    assert.deepEqual(after, expected);
    assert.equal(w.timeline.filter(e => e.startsWith('remove ') || e.startsWith('rmdir ')).every(e => e === `rmdir ${w.notes}/.stfolder`), true);
    assert.equal(w.timeline.filter(e => e.startsWith('rename ')).every(e => e.startsWith(`rename ${w.home} `)), true, 'the only thing moved is the instance directory');
});

test('reset leaves the notes folder alone: nothing is written there, no note is touched, whatever else lies in it', async () => {
    const w = await stuck();
    w.put(`${w.notes}/notes.txt`, 'mine');
    w.put(`${w.notes}/.hidden`, 'x');
    const keys = [...w.fsMap.keys()].filter(k => k.startsWith(`${w.notes}/`) && !k.endsWith('/.stfolder'));
    const values = keys.map(k => JSON.stringify(w.fsMap.get(k)));
    await perform(w, 'reset');
    assert.deepEqual(keys.map(k => JSON.stringify(w.fsMap.get(k))), values);
    assert.equal(w.timeline.some(e => e.startsWith('write ')), false);
});

test('reset: a marker is taken away only when it is provably ours and holds nothing but Syncthing\'s hint file', async () => {
    const keepsMarker = async (prepare, label) => {
        const w = await stuck();
        prepare(w);
        const marker = `${w.notes}/.stfolder`;
        const before = JSON.stringify([...w.fsMap.entries()].filter(([k]) => k === marker || k.startsWith(`${marker}/`)).sort());
        assert.equal((await perform(w, 'reset')).result.state, 'not-set-up', label);
        assert.equal(w.fsMap.has(marker), true, `${label}: the marker stays`);
        assert.equal(JSON.stringify([...w.fsMap.entries()].filter(([k]) => k === marker || k.startsWith(`${marker}/`)).sort()), before, `${label}: and is unchanged`);
        assert.equal(w.timeline.some(e => e.startsWith('remove ') || e.startsWith('rmdir ')), false, label);
        return w;
    };
    await keepsMarker(w => w.put(`${w.notes}/.stfolder/notes.txt`, 'x'), 'a file of another name inside');
    await keepsMarker(w => w.put(`${w.notes}/.stfolder/syncthing-folder-abc123.txt.bak`, 'x'), 'a name that only looks like the hint');
    await keepsMarker(w => w.mkdir(`${w.notes}/.stfolder/syncthing-folder-abc123.txt`), 'a directory with the name of the hint');
    await keepsMarker(w => { w.fsMap.delete(`${w.notes}/.stfolder`); w.put(`${w.notes}/.stfolder`, ''); }, 'a plain file instead of a directory');
    await keepsMarker(w => { w.fsMap.get(`${w.notes}/.stfolder`).link = true; }, 'a link');
    await keepsMarker(w => { w.fsMap.get(w.notes).link = true; }, 'a notes folder that is a link');
    await keepsMarker(w => { const c = w.fsMap.get(`${w.home}/config.xml`); c.text = c.text.replace(`path="${w.notes}"`, 'path="/home/u/elsewhere"'); }, 'our folder is somewhere else');
    await keepsMarker(w => { const c = w.fsMap.get(`${w.home}/config.xml`); c.text = c.text.replace('id="cetli-notes"', 'id="their-notes"'); }, 'the folder in our config is not ours');
    await keepsMarker(w => { w.fsMap.get(`${w.home}/config.xml`).text = 'not xml'; }, 'a config that cannot be read');
    // after such a reset the guard of `setup` says what it always said
    const w = await keepsMarker(w2 => w2.put(`${w2.notes}/.stfolder/notes.txt`, 'x'), 'setup after');
    assert.deepEqual(await perform(w, 'setup'), {error: {code: 'E_STFOLDER_EXISTS'}});
});

test('reset: the boundary of the marker rule: wrong names, a link, a subdirectory, two files', async () => {
    const stays = async (prepare, label) => {
        const w = await stuck();
        prepare(w);
        const marker = `${w.notes}/.stfolder`;
        assert.equal((await perform(w, 'reset')).result.state, 'not-set-up', label);
        assert.equal(w.fsMap.has(marker), true, `${label}: the marker stays`);
        assert.equal(w.timeline.some(e => e.startsWith('remove ') || e.startsWith('rmdir ')), false, `${label}: nothing removed`);
    };
    await stays(w => w.put(`${w.notes}/.stfolder/Syncthing-Folder-abc.txt`, 'x'), 'a name in capitals');
    await stays(w => w.put(`${w.notes}/.stfolder/syncthing-folder-.txt`, 'x'), 'no letters or digits between the dashes and the dot');
    await stays(w => w.put(`${w.notes}/.stfolder/syncthing-folder-${'a'.repeat(33)}.txt`, 'x'), 'a name longer than the pattern allows');
    await stays(w => w.put(`${w.notes}/.stfolder/syncthing-folder-ab-cd.txt`, 'x'), 'a dash inside the id part');
    await stays(w => { w.put(`${w.notes}/.stfolder/syncthing-folder-abc.txt`, 'x'); w.fsMap.get(`${w.notes}/.stfolder/syncthing-folder-abc.txt`).link = true; }, 'the hint file is a link');
    await stays(w => { w.mkdir(`${w.notes}/.stfolder/sub`); w.put(`${w.notes}/.stfolder/sub/syncthing-folder-abc.txt`, 'x'); }, 'a subdirectory with a hint file inside');
    await stays(w => { w.put(`${w.notes}/.stfolder/syncthing-folder-abc.txt`, 'x'); w.put(`${w.notes}/.stfolder/other.txt`, 'x'); }, 'one good file and one wrong one');
    await stays(w => { w.put(`${w.notes}/.stfolder/syncthing-folder-abc.txt`, 'x'); w.mkdir(`${w.notes}/.stfolder/syncthing-folder-def.txt`); }, 'one good file and a directory of the same pattern');
    // the good cases: empty, one file, two files of the pattern
    for (const names of [[], ['syncthing-folder-abc123.txt'], ['syncthing-folder-abc123.txt', 'syncthing-folder-k3x9a2.txt']]) {
        const w = await stuck();
        for (const n of names)
            w.put(`${w.notes}/.stfolder/${n}`, '# marker');
        assert.equal((await perform(w, 'reset')).result.state, 'not-set-up', names.join());
        assert.equal(w.fsMap.has(`${w.notes}/.stfolder`), false, `${names.length} hint file(s): the marker goes`);
        assert.deepEqual(w.timeline.filter(e => /^(remove|rmdir)/.test(e)).length, names.length + 1);
    }
});

test('reset: a marker that never was ours (no instance of ours) is not touched either', async () => {
    const w = createWorld();
    w.mkdir(`${w.notes}/.stfolder`);
    assert.equal((await perform(w, 'reset')).result.state, 'not-set-up');
    assert.equal(w.fsMap.has(`${w.notes}/.stfolder`), true);
    assert.equal(w.timeline.some(e => /^(rename|remove|rmdir)/.test(e)), false);
    assert.deepEqual(systemctl(w), ['disable --now', 'reset-failed']);
});

test('reset: the hint file of Syncthing inside our own marker goes with it', async () => {
    const w = await stuck();
    w.put(`${w.notes}/.stfolder/syncthing-folder-k3x9a2.txt`, '# marker');
    assert.equal((await perform(w, 'reset')).result.state, 'not-set-up');
    assert.equal(w.fsMap.has(`${w.notes}/.stfolder`), false);
    assert.deepEqual(w.timeline.filter(e => /^(remove|rmdir)/.test(e)), [`remove ${w.notes}/.stfolder/syncthing-folder-k3x9a2.txt`, `rmdir ${w.notes}/.stfolder`]);
});

test('reset then setup: the window starts from the beginning with a fresh instance and the same notes (the ID page)', async () => {
    const w = await stuck();
    await perform(w, 'reset');
    w.hung = false;
    w.daemon = false;
    const s = await perform(w, 'setup');
    assert.deepEqual(s, {result: {event: 'result', own_id: OWN, state: 'set-up'}});
    assert.equal(w.timeline.includes('generate'), true, 'a new instance is generated');
    assert.equal(w.fsMap.has(`${w.home}.bak-${STAMP}/config.xml`), true, 'the backup is still there');
    const st = (await perform(w, 'status')).result;
    assert.equal(st.state, 'set-up');
    assert.equal(st.peer, null, 'no partner: the other computer must be entered again');
    assert.equal(st.notes, 3);
});

test('reset: the unit cannot be stopped: E_NO_USER_SYSTEMD and nothing was changed at all', async () => {
    const w = await stuck();
    w.failSystemctl.add('disable --now cetli-syncthing.service');
    const before = snap(w);
    assert.deepEqual(await perform(w, 'reset'), {error: {code: 'E_NO_USER_SYSTEMD', step: 'service'}});
    assert.equal(snap(w), before);
    assert.equal(w.timeline.some(e => /^(rename|remove|rmdir|write)/.test(e)), false);
});

test('reset: a second run, or one on a machine that was never set up, is fine and moves nothing', async () => {
    const w = await stuck();
    await perform(w, 'reset');
    w.timeline.length = 0;
    const again = snap(w);
    assert.equal((await perform(w, 'reset')).result.state, 'not-set-up');
    assert.equal(snap(w), again);
    assert.equal(w.timeline.some(e => /^(rename|remove|rmdir|write)/.test(e)), false);
    const fresh = createWorld();
    assert.equal((await perform(fresh, 'reset')).result.state, 'not-set-up');
});

test('reset: the backup name never overwrites an older backup', async () => {
    const w = await stuck();
    w.put(`${w.home}.bak-${STAMP}`, 'older');
    w.mkdir(`${w.home}.bak-${STAMP}-1`);
    await perform(w, 'reset');
    assert.equal(w.fsMap.get(`${w.home}.bak-${STAMP}`).text, 'older');
    assert.equal(w.fsMap.has(`${w.home}.bak-${STAMP}-2/config.xml`), true);
});

test('reset: a link or a plain file where the instance should be, or a home that is not the dedicated one: refused before anything is done', async () => {
    const link = await stuck();
    link.fsMap.get(link.home).link = true;
    assert.deepEqual(await perform(link, 'reset'), {error: {code: 'E_CONFIG_UNSAFE'}});
    assert.equal(link.calls.length, 0);
    const file = createWorld();
    file.put(file.home, 'x');
    assert.deepEqual(await perform(file, 'reset'), {error: {code: 'E_CONFIG_UNSAFE'}});
    assert.equal(file.calls.length, 0);
    const other = await stuck();
    const ports = other.ports();
    ports.dirs = {...ports.dirs, home: `${other.homeDir}/Documents`};
    assert.deepEqual(await createEngine(ports).perform('reset'), {error: {code: 'E_INTERNAL'}});
    assert.equal(other.calls.length, 0);
});

test('reset: a move that fails is an error and the marker is not touched; a marker that cannot be removed is no error', async () => {
    const w = await stuck();
    const ports = w.ports();
    ports.files = {...ports.files, rename: () => { throw new Error('EXDEV'); }};
    assert.deepEqual(await createEngine(ports).perform('reset'), {error: {code: 'E_CONFIG_UNSAFE', step: 'instance'}});
    assert.equal(w.fsMap.has(`${w.notes}/.stfolder`), true);
    const v = await stuck();
    const p2 = v.ports();
    p2.files = {...p2.files, removeDir: () => { throw new Error('ENOTEMPTY'); }};
    assert.equal((await createEngine(p2).perform('reset')).result.state, 'not-set-up');
    assert.ok(v.journal.includes('reset: the marker was not removed'));
});

test('reset does not leak: no ID, key or peer on any command line or in the journal', async () => {
    const w = await stuck();
    await perform(w, 'reset');
    const all = JSON.stringify([w.events, w.journal, w.calls.map(c => c.argv)]);
    assert.equal(all.includes(FAKE_KEY) || all.includes(PEER), false);
});
