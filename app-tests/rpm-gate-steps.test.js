// SPDX-License-Identifier: GPL-3.0-or-later
// The insides of the steps (a) to (c) of the probe of the installed package (tools/start_gate/probe_steps.mjs), run against stand-ins for GLib,
// Gio, the file system and the module loader: what a step does to the call it makes (the SIGTERM watch: priority, signal 15, a one-shot callback,
// the kill that follows, the time limit) and what it makes of the answer (a call that throws, a watch that is not made, a signal that does not
// come). The real GLib runs in the gate itself, under gjs (probe_installed.mjs wires it in); here is what keeps the decisions of the probe from
// going soft unnoticed: a step that cannot fail is not a step.
import test from 'node:test';
import assert from 'node:assert/strict';
import {IMPORTED, runSteps, stepImport, stepInstalled, stepSignal} from '../tools/start_gate/probe_steps.mjs';

// ---------------------------------------------------------------------------------------------------------------------------- step (c)

// A main loop in a table: the signal watch the step installs, the timers it sets (fired by run() in the order of their time), and the processes
// it starts. `deliver` says whether the kill the step sends makes the signal reach the watch.
function world({signal = 'ok', deliver = true} = {}) {
    const w = {signalCalls: [], timers: [], started: [], handlerReturns: [], watch: null, throwsLeft: signal === 'throws-once' ? 1 : 0};
    w.GLib = {
        PRIORITY_DEFAULT: 0,
        SOURCE_REMOVE: false,
        MAJOR_VERSION: 2,
        MINOR_VERSION: 80,
        MICRO_VERSION: 4,
        unix_signal_add(priority, number, callback) {
            w.signalCalls.push([priority, number]);
            if (w.throwsLeft > 0) {
                w.throwsLeft--;
                throw new TypeError('GLib.unix_signal_add is not a function');
            }
            if (signal === 'zero')
                return 0;
            w.watch = callback;
            return 7;
        },
        timeout_add(priority, milliseconds, callback) {
            w.timers.push({milliseconds, callback});
            return w.timers.length;
        },
    };
    w.Gio = {
        SubprocessFlags: {NONE: 0},
        Subprocess: {
            new(argv, flags) {
                w.started.push({argv, flags});
                if (deliver && w.watch)
                    w.handlerReturns.push(w.watch());
            },
        },
    };
    w.read = path => {
        assert.equal(path, '/proc/self/stat');
        return '4242 (gjs) S 1 4242 4242 0 -1 4194560 100 0 0 0';
    };
    w.run = () => {   // the time passes: every timer fires once, the earliest first
        for (const t of [...w.timers].sort((a, b) => a.milliseconds - b.milliseconds))
            t.callback();
    };
    return w;
}

test('step (c): the watch is made as application.js makes it (priority default, signal 15), the kill goes to this process after 200 ms, the signal comes', async () => {
    const w = world();
    const done = stepSignal(w);
    assert.deepEqual(w.signalCalls, [[0, 15]]);
    assert.deepEqual(w.timers.map(t => t.milliseconds), [200, 5000]);
    w.run();
    assert.equal(await done, 'SIGTERM arrived through unix_signal_add, glib 2.80.4');
    assert.equal(w.started.length, 1);
    assert.deepEqual(w.started[0].argv, ['/bin/sh', '-c', 'kill -TERM 4242']);
});

test('step (c): the callback of the watch is a one-shot: it returns SOURCE_REMOVE, so the watch does not stay in the loop', async () => {
    const w = world();
    const done = stepSignal(w);
    w.run();
    await done;
    assert.deepEqual(w.handlerReturns, [false]);
});

test('step (c): the signal is 15, not another one', async () => {
    const w = world();
    stepSignal(w).catch(() => {});
    assert.equal(w.signalCalls[0][1], 15);
});

test('step (c): a call that throws (a function that is not there on this platform) fails the step with its message, and nothing is sent or waited for', async () => {
    const w = world({signal: 'throws-once'});
    await assert.rejects(stepSignal(w), /GLib\.unix_signal_add is not a function/);
    assert.equal(w.signalCalls.length, 1, 'the step does not call it again');
    assert.equal(w.timers.length, 0);
    assert.equal(w.started.length, 0);
});

test('step (c): a watch that was not made (id 0) fails the step, and nothing is sent', async () => {
    const w = world({signal: 'zero'});
    await assert.rejects(stepSignal(w), /no Unix signal watch was made \(id 0\)/);
    assert.equal(w.timers.length, 0);
    assert.equal(w.started.length, 0);
});

test('step (c): a signal that does not arrive fails the step after 5 s, and the kill was sent', async () => {
    const w = world({deliver: false});
    const done = stepSignal(w);
    w.run();
    await assert.rejects(done, /SIGTERM did not arrive in the main loop within 5 s/);
    assert.equal(w.started.length, 1);
});

// ---------------------------------------------------------------------------------------------------------------------------- step (a)

const LAUNCHER = '#!/usr/bin/sh\nexec gjs -m /usr/share/cetli/app/main.js "$@"\n';
function files(map) {
    const reads = [];
    return {
        reads,
        read: path => {
            reads.push(path);
            if (!(path in map))
                throw new Error(`no such file ${path}`);
            return map[path];
        },
        isFile: path => path in map,
    };
}

test('step (a): the launcher, the main.js and the VERSION of the installed copy are read, and the version is the RPM\'s', () => {
    const fs = files({'/usr/bin/cetli': LAUNCHER, '/usr/share/cetli/app/main.js': 'x', '/usr/share/cetli/VERSION': '1.0.1\n'});
    assert.equal(stepInstalled('1.0.1', fs), 'version 1.0.1 in /usr/share/cetli');
    assert.deepEqual(fs.reads, ['/usr/bin/cetli', '/usr/share/cetli/VERSION']);
});

test('step (a): a missing main.js, another version, and a launcher of a checkout fail the step', () => {
    const base = {'/usr/bin/cetli': LAUNCHER, '/usr/share/cetli/app/main.js': 'x', '/usr/share/cetli/VERSION': '1.0.1\n'};
    const noMain = {...base};
    delete noMain['/usr/share/cetli/app/main.js'];
    assert.throws(() => stepInstalled('1.0.1', files(noMain)), /\/usr\/share\/cetli\/app\/main\.js is not there/);
    assert.throws(() => stepInstalled('1.0.2', files(base)), /installed version 1\.0\.1, the RPM has 1\.0\.2/);
    assert.throws(() => stepInstalled('1.0.1', files({...base, '/usr/bin/cetli': '#!/bin/sh\nexec gjs -m /home/u/cetli/app/main.js "$@"\n'})), /not an installed copy under \/usr/);
    assert.throws(() => stepInstalled('1.0.1', files({...base, '/usr/bin/cetli': ''})), /does not start gjs/);
});

// ---------------------------------------------------------------------------------------------------------------------------- step (b)

function loader({failOn = null, adw = {MAJOR_VERSION: 1, MINOR_VERSION: 6, MICRO_VERSION: 10}} = {}) {
    const imported = [];
    return {
        imported,
        read: path => {
            assert.equal(path, '/usr/bin/cetli');
            return LAUNCHER;
        },
        gjsVersion: 18002,
        importModule: async specifier => {
            imported.push(specifier);
            if (failOn && specifier.includes(failOn))
                throw new Error(`Error importing ${specifier}`);
            if (specifier === 'gi://Gtk?version=4.0')
                return {default: {MAJOR_VERSION: 4, MINOR_VERSION: 16, MICRO_VERSION: 7}};
            if (specifier === 'gi://Adw?version=1')
                return {default: adw};
            return {};
        },
    };
}

test('step (b): the four modules of the installed copy, then Gtk 4 and libadwaita 1, are imported, and the versions are in the line', async () => {
    const l = loader();
    const line = await stepImport(l);
    assert.deepEqual(l.imported, [
        'file:///usr/share/cetli/app/application.js', 'file:///usr/share/cetli/sync/engine.js',
        'file:///usr/share/cetli/sync/gio-ports.js', 'file:///usr/share/cetli/src/index.js',
        'gi://Gtk?version=4.0', 'gi://Adw?version=1',
    ]);
    assert.deepEqual(IMPORTED, ['app/application.js', 'sync/engine.js', 'sync/gio-ports.js', 'src/index.js']);
    assert.match(line, /Gtk 4\.16\.7, libadwaita 1\.6\.10, gjs 18002$/);
});

test('step (b): a module that does not import fails the step with the error of the import, the rest is not tried', async () => {
    const l = loader({failOn: 'sync/engine.js'});
    await assert.rejects(stepImport(l), /Error importing file:\/\/\/usr\/share\/cetli\/sync\/engine\.js/);
    assert.deepEqual(l.imported.length, 2);
});

test('step (b): libadwaita older than 1.5 fails the step', async () => {
    await assert.rejects(stepImport(loader({adw: {MAJOR_VERSION: 1, MINOR_VERSION: 4, MICRO_VERSION: 0}})), /libadwaita 1\.4, the program needs 1\.5 or later/);
});

// ---------------------------------------------------------------------------------------------------------------------------- the steps together

test('runSteps: one line a step, a failed step does not stop the next, the status is 1 when one failed and 0 when none did', async () => {
    const lines = [];
    const print = l => lines.push(l);
    let status = await runSteps([['a', () => 'one'], ['b', async () => { throw new Error('two'); }], ['c', async () => 'three']], print);
    assert.equal(status, 1);
    assert.deepEqual(lines, ['START-GATE a PASS one', 'START-GATE b FAIL two', 'START-GATE c PASS three']);
    lines.length = 0;
    status = await runSteps([['a', () => 'one'], ['c', async () => 'three']], print);
    assert.equal(status, 0);
    assert.deepEqual(lines, ['START-GATE a PASS one', 'START-GATE c PASS three']);
});

test('runSteps: a failure that is not an Error is a failed step too, with its text', async () => {
    const lines = [];
    const status = await runSteps([['x', () => Promise.reject('plain text')], ['y', () => { throw undefined; }]], l => lines.push(l));
    assert.equal(status, 1);
    assert.deepEqual(lines, ['START-GATE x FAIL plain text', 'START-GATE y FAIL undefined']);
});
