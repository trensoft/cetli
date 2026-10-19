// SPDX-License-Identifier: GPL-3.0-or-later
// src/gio-layer.js against recording fakes of Gio and GLib (tests/support/gi/): WHAT the adapter asks Gio/GLib for
// (flags, modes, arguments), not how real GLib answers. That stays NOT MEASURED (no gjs here, CORE.md).
import test, {before, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {register} from 'node:module';

import {FS, FsError} from '../src/fs-error.js';
import {calls, plan, reset} from './support/gi/calls.mjs';
import Gio, {info} from './support/gi/Gio.mjs';
import GLib, {FileError} from './support/gi/GLib.mjs';

let layer;
before(async () => {
    register('./support/gi-loader.mjs', import.meta.url);
    layer = await import('../src/gio-layer.js');
});
beforeEach(reset);

const only = name => calls.filter(c => c[0] === name);

test('[P2-T13] 1.5: the tmp write is CONSISTENT | DURABLE with mode 0600, on the path and bytes it was given', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await layer.fs.writeTmp('/t/a.tmp', bytes);
    const [c] = only('file_set_contents_full');
    assert.equal(c[1], '/t/a.tmp');
    assert.equal(c[2], bytes);
    assert.equal(c[3], GLib.FileSetContentsFlags.CONSISTENT | GLib.FileSetContentsFlags.DURABLE);
    assert.equal(c[4], 0o600, 'the note is private to the user');
});

test('[P2-T13] 1.5 / 2.6: EVERY move has NO_FALLBACK_FOR_MOVE; OVERWRITE only when the caller says so', async () => {
    await layer.fs.move('/t/a.tmp', '/n/a.json', {overwrite: false});
    await layer.fs.move('/t/b.tmp', '/n/b.json', {overwrite: true});
    const [free, over] = only('move');
    assert.deepEqual([free[1], free[2]], ['/t/a.tmp', '/n/a.json']);
    assert.equal(free[3], Gio.FileCopyFlags.NO_FALLBACK_FOR_MOVE, 'a free slot: no OVERWRITE (the move fails if an entry appeared)');
    assert.equal(over[3], Gio.FileCopyFlags.NO_FALLBACK_FOR_MOVE | Gio.FileCopyFlags.OVERWRITE);
    assert.deepEqual([over[1], over[2]], ['/t/b.tmp', '/n/b.json']);
});

test('[P2-T13] 1.1 V1: entries are looked at WITHOUT following a link (listing and stat)', async () => {
    plan.listing = [info('a.json'), info('b.json', Gio.FileType.SYMBOLIC_LINK, 0)];
    const list = await layer.fs.listDir('/n');
    assert.deepEqual(list.map(e => [e.name, e.type]), [['a.json', 'regular'], ['b.json', 'symlink']]);
    assert.equal(only('enumerate_children_async')[0][3], Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS);
    await layer.fs.stat('/n/a.json');
    assert.equal(only('query_info_async')[0][3], Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS);
});

test('[P2-T13] 1.4: the folders are created with mode 0700, and a failure is an error', async () => {
    await layer.fs.ensureDir('/d/notes');
    assert.deepEqual(only('mkdir_with_parents')[0].slice(1), ['/d/notes', 0o700]);
    plan.mkdirResult = -1;
    await assert.rejects(layer.fs.ensureDir('/d/notes'), e => e instanceof FsError && e.code === FS.IO);
});

test('[P2-T13] 3: the directory monitor is created WITHOUT WATCH_MOVES (a rename into notes/ is reported as CREATED)', () => {
    const seen = [];
    const mon = layer.monitorFactory('/n', ev => seen.push(ev));
    const [c] = only('monitor_directory');
    assert.equal(c[1], '/n');
    assert.equal(c[2], Gio.FileMonitorFlags.NONE);
    assert.equal(c[2] & Gio.FileMonitorFlags.WATCH_MOVES, 0);
    mon.cancel();
    assert.deepEqual(calls.map(x => x[0]).filter(n => n.startsWith('monitor.')), ['monitor.connect', 'monitor.disconnect', 'monitor.cancel']);
});

test('1.5: a Gio / GLib error is mapped to the FS code the store works with; a missing entry is null for stat', async () => {
    plan.queryError = new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND, 'gone');
    assert.equal(await layer.fs.stat('/n/x.json'), null);
    for (const [err, code] of [
        [new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS, 'x'), FS.EXISTS],
        [new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_SUPPORTED, 'x'), FS.NOT_SUPPORTED],
        [new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.NO_SPACE, 'x'), FS.NO_SPACE],
        [new GLib.Error(FileError, FileError.NOSPC, 'x'), FS.NO_SPACE],
        [new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.FAILED, 'x'), FS.IO],
    ]) {
        plan.moveError = err;
        await assert.rejects(layer.fs.move('/t/a', '/n/a', {overwrite: false}), e => e instanceof FsError && e.code === code);
    }
});

test('exchange: one fixed argv, absolute mv, -T and --, no shell; success is silent', async () => {
    await layer.fs.exchange('/t/a.x', '/n/a.json');
    const [c] = only('subprocess.new');
    assert.deepEqual(c[1], ['/usr/bin/mv', '-T', '--exchange', '--', '/t/a.x', '/n/a.json']);
    assert.equal(c[2], Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
    assert.equal(only('wait_check_async').length, 1);
});

test('exchange: a failed mv is NOT_FOUND when one of the two entries is missing (mv does not say), else NOT_SUPPORTED', async () => {
    plan.waitError = new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.FAILED, 'Child process exited with code 1');
    plan.missing = ['/n/a.json'];
    await assert.rejects(layer.fs.exchange('/t/a.x', '/n/a.json'), e => e instanceof FsError && e.code === FS.NOT_FOUND);
    plan.missing = [];
    await assert.rejects(layer.fs.exchange('/t/a.x', '/n/a.json'), e => e instanceof FsError && e.code === FS.NOT_SUPPORTED);
    plan.spawnError = new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND, 'No such file or directory');   // no /usr/bin/mv
    plan.missing = [];
    await assert.rejects(layer.fs.exchange('/t/a.x', '/n/a.json'), e => e instanceof FsError && e.code === FS.NOT_SUPPORTED);
});
