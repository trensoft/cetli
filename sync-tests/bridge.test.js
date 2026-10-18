// SPDX-License-Identifier: GPL-3.0-or-later
// The bridge core (app/sync-runner.js) against a fake process that replays sync-tests/contract/*.ndjson.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRunner, scrubEnviron, STOP_GRACE_MS, ENGINE_PATH} from '../app/sync-runner.js';
import {MAX_LINE_BYTES, MAX_TOTAL_BYTES} from '../sync/protocol.js';

const dir = new URL('./contract/', import.meta.url);
const INDEX = JSON.parse(readFileSync(new URL('index.json', dir), 'utf8'));
const linesOf = file => readFileSync(new URL(file, dir), 'utf8').split('\n').filter(l => l !== '');
const B = 'VTTWEJK-SMIOBMH-3FIWS7V-JFC2CL4-FCR3BU6-PEPADRQ-EYVVD3Z-BIGMUQ5';
const A = 'F6HEWOE-4KSACQ5-5MAX7IC-HAP3EGW-AQYBTIX-V74MXIF-ZB3GZN6-4T3QYQZ';

// A process whose lines and exit are driven by the test.
function fakeProc() {
    const p = {
        written: [], stdinClosed: false, killed: false, lineCb: null, overflowCb: null, exitCb: null,
        onLine(f) { p.lineCb = f; }, onOverflow(f) { p.overflowCb = f; }, onExit(f) { p.exitCb = f; },
        write(t) { p.written.push(t); }, closeStdin() { p.stdinClosed = true; }, kill() { p.killed = true; },
        emit(lines) { for (const l of lines) p.lineCb(l); },
        exit(rc) { p.exitCb(rc); },
    };
    return p;
}
function harness(extra = {}) {
    const procs = [];
    const argvs = [];
    const timers = [];
    const logs = [];
    const spawn = (argv, opts) => { const p = fakeProc(); procs.push(p); argvs.push({argv, opts}); return p; };
    const runner = createRunner({
        spawn, setTimer: (ms, fn) => { const t = {ms, fn, cleared: false}; timers.push(t); return t; }, clearTimer: t => { t.cleared = true; },
        log: m => logs.push(m), environ: () => ['PATH=/usr/bin', 'HOME=/home/u', 'STGUIAPIKEY=k', 'STHOMEDIR=/x', 'XDG_RUNTIME_DIR=/run/user/1', 'JUNK'], ...extra,
    });
    return {runner, procs, argvs, timers, logs};
}

test('every fixture replays through a fake process to the outcome the index states', async () => {
    for (const [file, spec] of Object.entries(INDEX)) {
        const h = harness();
        const events = [];
        const run = h.runner.start(spec.verb, {onEvent: e => events.push(e), stdin: spec.verb === 'join' ? `${B}\n` : null});
        const p = h.procs[0];
        p.emit(linesOf(file));
        p.exit(spec.rc);
        const out = await run.done;
        if (spec.expect === 'result') {
            assert.equal(out.ok, true, file);
        } else if (spec.expect.startsWith('error:')) {
            assert.deepEqual([out.ok, out.error.code], [false, spec.expect.slice(6)], file);
        } else {
            assert.deepEqual([out.ok, out.error.code], [false, spec.expect], file);
        }
        assert.equal(h.runner.busy, false, `${file}: the runner is free again`);
    }
});

test('oversize.ndjson and the like: a violation kills the process at once, before it exits', async () => {
    for (const file of ['oversize.ndjson', 'not-json.ndjson', 'v2.ndjson']) {
        const h = harness();
        const run = h.runner.start('status');
        h.procs[0].emit(linesOf(file));
        assert.equal(h.procs[0].killed, true, file);
        assert.deepEqual(await run.done, {ok: false, error: {code: 'E_PROTOCOL', step: null}});
    }
});

test('the argv is the literal engine path and the closed verb argv; the environment given to the process is the allowlist', () => {
    const h = harness();
    h.runner.start('forget', {flags: {stop: true}});
    assert.deepEqual(h.argvs[0].argv, [ENGINE_PATH, 'forget', '--stop']);
    assert.equal(ENGINE_PATH, '/usr/bin/cetli-sync');
    assert.deepEqual(h.argvs[0].opts.env.sort(), ['HOME=/home/u', 'PATH=/usr/bin', 'XDG_RUNTIME_DIR=/run/user/1']);
    assert.deepEqual(scrubEnviron(['STGUIADDRESS=x', 'STGUIAPIKEY=y', 'STHOMEDIR=z', 'LANG=hu_HU.UTF-8', '=x', 'A']), ['LANG=hu_HU.UTF-8']);
    assert.deepEqual(scrubEnviron(null), []);
});

test('an unknown verb or flag never reaches a process', async () => {
    const h = harness();
    assert.deepEqual(await h.runner.start('connect').done, {ok: false, error: {code: 'E_INTERNAL', step: null}});
    assert.deepEqual(await h.runner.start('host', {flags: {stop: true}}).done, {ok: false, error: {code: 'E_INTERNAL', step: null}});
    assert.equal(h.procs.length, 0);
});

test('stdin: join gets exactly the typed line then EOF; host keeps stdin open; the others close it at once', () => {
    const j = harness();
    j.runner.start('join', {stdin: `${B}\n`});
    assert.deepEqual(j.procs[0].written, [`${B}\n`]);
    assert.equal(j.procs[0].stdinClosed, true);
    const h = harness();
    h.runner.start('host');
    assert.equal(h.procs[0].stdinClosed, false);
    assert.deepEqual(h.procs[0].written, []);
    for (const verb of ['status', 'setup', 'own-id', 'forget']) {
        const x = harness();
        x.runner.start(verb, {stdin: 'ignored'});
        assert.equal(x.procs[0].stdinClosed, true, verb);
        assert.deepEqual(x.procs[0].written, [], verb);
    }
});

test('host: ONE accept line, canonical ID only, once; none for other verbs or after the end', async () => {
    const h = harness();
    const run = h.runner.start('host');
    assert.equal(run.accept(B.toLowerCase()), false);
    assert.equal(run.accept('nope'), false);
    assert.deepEqual(h.procs[0].written, []);
    assert.equal(run.accept(B), true);
    assert.equal(run.accept(B), false);
    assert.deepEqual(h.procs[0].written, [`accept ${B}\n`]);
    h.procs[0].exit(1);
    await run.done;
    const other = harness();
    const j = other.runner.start('join', {stdin: `${B}\n`});
    assert.equal(j.accept(B), false);
    const late = harness();
    const r = late.runner.start('host');
    late.procs[0].exit(1);
    await r.done;
    assert.equal(r.accept(B), false);
});

test('one engine process at a time: a second start is E_BUSY and starts nothing', async () => {
    const h = harness();
    const first = h.runner.start('host');
    assert.equal(h.runner.busy, true);
    const second = h.runner.start('status');
    assert.deepEqual(await second.done, {ok: false, error: {code: 'E_BUSY', step: null}});
    assert.equal(h.procs.length, 1);
    assert.equal(second.accept(B), false);
    h.procs[0].exit(1);
    await first.done;
    assert.equal(h.runner.busy, false);
    h.runner.start('status');
    assert.equal(h.procs.length, 2);
});

test('stop: closes stdin, kills a process that is still alive after the grace period, and a clean end cancels the timer', async () => {
    const h = harness();
    const run = h.runner.start('host');
    const stopped = run.stop();
    assert.equal(h.procs[0].stdinClosed, true);
    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0].ms, STOP_GRACE_MS);
    assert.equal(STOP_GRACE_MS, 3000);
    run.stop();                                             // a second stop does not add a timer
    assert.equal(h.timers.length, 1);
    h.timers[0].fn();
    assert.equal(h.procs[0].killed, true);
    assert.deepEqual(await stopped, {ok: false, error: {code: 'E_ENGINE_DIED', step: null}});
    assert.equal(h.runner.busy, false);
    const g = harness();
    const r = g.runner.start('host');
    r.stop();
    g.procs[0].emit([JSON.stringify({v: 1, event: 'error', code: 'E_EXPIRED'})]);
    g.procs[0].exit(1);
    assert.equal((await r.done).error.code, 'E_EXPIRED');
    assert.equal(g.timers[0].cleared, true);
    assert.equal(g.procs[0].killed, false);
});

test('runner.stop() stops the active run; with none it resolves at once', async () => {
    const h = harness();
    await h.runner.stop();
    const run = h.runner.start('host');
    const p = h.runner.stop();
    assert.equal(h.procs[0].stdinClosed, true);
    h.procs[0].exit(1);
    await run.done;
    await p;
});

test('overflow from the process layer, a failed spawn, a missing terminal line and a bad rc', async () => {
    const o = harness();
    const r = o.runner.start('status');
    o.procs[0].overflowCb();
    assert.equal(o.procs[0].killed, true);
    assert.equal((await r.done).error.code, 'E_PROTOCOL');
    const bad = createRunner({spawn: () => { throw new Error('boom'); }, setTimer() {}, clearTimer() {}});
    assert.deepEqual(await bad.start('status').done, {ok: false, error: {code: 'E_ENGINE_DIED', step: null}});
    assert.equal(bad.busy, false);
    const n = harness();
    const rn = n.runner.start('status');
    n.procs[0].exit(0);
    assert.equal((await rn.done).error.code, 'E_ENGINE_DIED');
    const k = harness();
    const rk = k.runner.start('status');
    k.procs[0].exit(-9);
    assert.equal((await rk.done).error.code, 'E_ENGINE_DIED');
    const u = harness();
    const ru = u.runner.start('status');
    u.procs[0].exit(2);
    assert.equal((await ru.done).error.code, 'E_ENGINE_DIED');
});

test('the line and total caps of the protocol are the ones the process layer must apply', () => {
    assert.equal(MAX_LINE_BYTES, 4096);
    assert.equal(MAX_TOTAL_BYTES, 65536);
});

test('events: unknown progress steps are dropped, the terminal line is not an event, a failing handler does not stop the run', async () => {
    const h = harness();
    const seen = [];
    const run = h.runner.start('host', {onEvent: e => { seen.push(e.event + (e.step ? `:${e.step}` : '')); throw new Error('handler'); }});
    h.procs[0].emit([
        JSON.stringify({v: 1, event: 'progress', step: 'instance', state: 'start'}),
        JSON.stringify({v: 1, event: 'progress', step: 'brand-new', state: 'start'}),
        JSON.stringify({v: 1, event: 'candidate', id: B, name: null}),
        JSON.stringify({v: 1, event: 'error', code: 'E_EXPIRED'}),
    ]);
    h.procs[0].exit(1);
    assert.equal((await run.done).error.code, 'E_EXPIRED');
    assert.deepEqual(seen, ['progress:instance', 'candidate']);
});

test('the log carries the verb and the outcome only: no ID, no name, no event field', async () => {
    const h = harness();
    const run = h.runner.start('host');
    h.procs[0].emit(linesOf('host-ok.ndjson'));
    h.procs[0].exit(0);
    await run.done;
    assert.deepEqual(h.logs, ['engine host: result']);
    for (const l of h.logs) {
        assert.equal(l.includes(B), false);
        assert.equal(l.includes('laptop-b'), false);
    }
    const e = harness();
    const r = e.runner.start('join', {stdin: `${A}\n`});
    e.procs[0].emit(linesOf('join-bad-id.ndjson'));
    e.procs[0].exit(1);
    await r.done;
    assert.deepEqual(e.logs, ['engine join: error E_BAD_ID']);
});
