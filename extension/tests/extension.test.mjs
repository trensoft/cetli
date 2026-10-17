// SPDX-License-Identifier: GPL-3.0-or-later
// Runs the real extension.js against fakes of the GNOME APIs (see stubs/). This proves the logic of the extension;
// it does not prove how mutter 47-49 behaves.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {beforeEach, test} from 'node:test';

import CetliExtension from '../cetli@trensoft.local/extension.js';
import {MAX_FILE_BYTES, MAX_NOTES} from '../cetli@trensoft.local/constants.js';
import {parseLayout, serializeLayout} from '../cetli@trensoft.local/layout.js';
import {world} from './stubs/world.mjs';

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const APP = 'io.github.trensoft.cetli';
const MON1 = '1920x1080+0+0';
const DEFAULT = {x: 790, y: 430, w: 340, h: 220};
const SAVED = {x: 300, y: 200, w: 400, h: 260};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const entry = (rect, over = {}) => ({...rect, monitor: MON1, open: true, ...over});

beforeEach(() => world.reset());

function enable() {
    const ext = new CetliExtension({path: '/ext'});
    ext.enable();
    return ext;
}

const note = (n, rect = DEFAULT, over = {}) => world.addWindow({title: `cetli-${uuid(n)}`, appId: APP, rect, ...over});

// ---------------------------------------------------------------- finding the windows

test('a note window is put on its saved rectangle, once, without being saved again', async () => {
    world.writeLayout({[uuid(1)]: entry(SAVED)});
    const ext = enable();
    const win = note(1);
    await world.advance(3000);
    assert.deepEqual(win.moveCalls, [{userOp: false, ...SAVED}]);
    assert.equal(world.writes(), 0, 'the restore itself is not a move by the user');
    assert.deepEqual(world.errors, []);
    ext.disable();
});

test('the window is told apart by app id and title, not by order: two notes get their own rectangles', async () => {
    const other = {x: 900, y: 100, w: 300, h: 300};
    world.writeLayout({[uuid(1)]: entry(SAVED), [uuid(2)]: entry(other)});
    const ext = enable();
    const w2 = note(2);
    const w1 = note(1);
    await world.advance(3000);
    assert.deepEqual(w1.rect, SAVED);
    assert.deepEqual(w2.rect, other);
    ext.disable();
});

test('windows of other apps, and cetli windows with another title, are never moved and stop being watched', async () => {
    world.writeLayout({[uuid(1)]: entry(SAVED)});
    const ext = enable();
    const a = world.addWindow({appId: 'org.gnome.Terminal', title: `cetli-${uuid(1)}`, rect: DEFAULT});
    const b = world.addWindow({appId: APP, title: 'cetli', rect: DEFAULT});
    const c = world.addWindow({appId: APP, title: `cetli-${uuid(1)} (copy)`, rect: DEFAULT});
    await world.advance(10200);
    for (const w of [a, b, c])
        assert.equal(w.moveCalls.length, 0);
    assert.equal(world.timers.size, 0, 'the 10 s watch is over: no timer left');
    assert.equal(a.connectionCount(), 0, 'and no signal connection left on the window');
    ext.disable();
});

test('a window that already exists when the extension is enabled is found', async () => {
    world.writeLayout({[uuid(1)]: entry(SAVED)});
    const win = note(1);
    const ext = enable();
    await world.advance(3000);
    assert.deepEqual(win.rect, SAVED);
    ext.disable();
});

test('a title that arrives late is accepted within 10 s, not after', async () => {
    world.writeLayout({[uuid(1)]: entry(SAVED), [uuid(2)]: entry(SAVED)});
    const ext = enable();
    const late = note(1, DEFAULT, {title: ''});
    const tooLate = note(2, DEFAULT, {title: ''});
    await world.advance(5000);
    late.title = `cetli-${uuid(1)}`;
    await world.advance(100);
    await world.advance(2000);
    assert.deepEqual(late.rect, SAVED);
    await world.advance(4000);
    tooLate.title = `cetli-${uuid(2)}`;
    await world.advance(3000);
    assert.equal(tooLate.moveCalls.length, 0);
    ext.disable();
});

test('the window is not touched before it has a frame', async () => {
    world.writeLayout({[uuid(1)]: entry(SAVED)});
    const ext = enable();
    const win = note(1, DEFAULT, {mapped: false});
    await world.advance(1000);
    assert.equal(win.moveCalls.length, 0);
    win.mapped = true;
    await world.advance(2000);
    assert.deepEqual(win.rect, SAVED);
    ext.disable();
});

// ---------------------------------------------------------------- clamping (D3)

test('a rectangle off every monitor is moved into the work area of the primary monitor', async () => {
    world.writeLayout({[uuid(1)]: entry({x: 4000, y: 100, w: 300, h: 200}, {monitor: '1280x1024+1920+0'})});
    world.monitors = [{x: 0, y: 0, width: 1920, height: 1080}];
    const ext = enable();
    const win = note(1);
    await world.advance(3000);
    assert.deepEqual(win.moveCalls[0], {userOp: false, x: 1620, y: 100, w: 300, h: 200});
    ext.disable();
});

test('a rectangle under the panel or bigger than the work area is brought inside', async () => {
    world.writeLayout({[uuid(1)]: entry({x: -50, y: 0, w: 5000, h: 300}), [uuid(2)]: entry({x: 1800, y: 1070, w: 300, h: 300})});
    const ext = enable();
    const a = note(1);
    const b = note(2);
    await world.advance(3000);
    assert.deepEqual(a.moveCalls[0], {userOp: false, x: 0, y: 32, w: 1920, h: 300});
    assert.deepEqual(b.moveCalls[0], {userOp: false, x: 1620, y: 780, w: 300, h: 300});
    ext.disable();
});

test('with two monitors the saved monitor is used when it is there, and the overlap when it is not', async () => {
    world.monitors = [{x: 0, y: 0, width: 1920, height: 1080}, {x: 1920, y: 0, width: 1280, height: 1024}];
    world.workAreas = [{x: 0, y: 32, width: 1920, height: 1048}, {x: 1920, y: 0, width: 1280, height: 1024}];
    world.writeLayout({
        [uuid(1)]: entry({x: 2000, y: 50, w: 300, h: 200}, {monitor: '1280x1024+1920+0'}),
        [uuid(2)]: entry({x: 1500, y: 50, w: 600, h: 200}, {monitor: 'gone'}),
    });
    const ext = enable();
    const a = note(1);
    const b = note(2);
    await world.advance(3000);
    assert.deepEqual(a.rect, {x: 2000, y: 50, w: 300, h: 200});
    assert.deepEqual(b.rect, {x: 1320, y: 50, w: 600, h: 200}, 'mostly on the first monitor: pulled inside it');
    ext.disable();
});

test('the monitor member may be an object of strings, as the core allows', async () => {
    world.writeLayout({[uuid(1)]: entry(SAVED, {monitor: {connector: 'DP-1', vendor: 'ACR'}})});
    const ext = enable();
    const win = note(1);
    await world.advance(3000);
    assert.deepEqual(win.rect, SAVED);
    ext.disable();
});

// ---------------------------------------------------------------- the restore itself

test('a compositor that ignores the first request is asked a second time, and no more', async () => {
    world.writeLayout({[uuid(1)]: entry(SAVED)});
    world.moveMode = 'ignore-first';
    const ext = enable();
    const win = note(1);
    await world.advance(5000);
    assert.equal(win.moveCalls.length, 2);
    assert.deepEqual(win.rect, SAVED);
    ext.disable();
});

test('a compositor that never moves the window: two requests, nothing is written over the saved rectangle', async () => {
    world.writeLayout({[uuid(1)]: entry(SAVED)});
    world.moveMode = 'ignore';
    const ext = enable();
    const win = note(1);
    await world.advance(5000);
    assert.equal(win.moveCalls.length, 2);
    // A late signal from the place the compositor chose must not become the saved place.
    win.drag(DEFAULT);
    await world.advance(1000);
    assert.equal(world.writes(), 0);
    assert.deepEqual(parseLayout(fs.readFileSync(world.layoutPath(), 'utf8')).layout[uuid(1)].x, SAVED.x);
    // The next real move is saved.
    win.drag({...DEFAULT, x: 100});
    await world.advance(1000);
    assert.equal(world.readLayout()[uuid(1)].x, 100);
    ext.disable();
});

test('a note without a saved place stays where the compositor put it and is not saved for that', async () => {
    const ext = enable();
    const win = note(1);
    await world.advance(3000);
    assert.equal(win.moveCalls.length, 0);
    assert.equal(world.writes(), 0);
    assert.ok(!fs.existsSync(world.layoutPath()));
    ext.disable();
});

test('entries that are not valid (bad size, bad member) are not used', async () => {
    world.writeLayout({[uuid(1)]: {...entry(SAVED), w: -5}, [uuid(2)]: {x: 1, y: 2}, [uuid(3)]: entry(SAVED, {w: 0})});
    const ext = enable();
    const wins = [note(1), note(2), note(3)];
    await world.advance(3000);
    for (const w of wins)
        assert.equal(w.moveCalls.length, 0);
    ext.disable();
});

test('move_resize_frame that throws is logged, never thrown into the Shell, and the note is still saved later', async () => {
    world.writeLayout({[uuid(1)]: entry(SAVED)});
    world.moveMode = 'throw';
    const ext = enable();
    const win = note(1);
    await world.advance(3000);
    assert.ok(world.errors.some(e => e.includes('restore')), world.errors.join('|'));
    world.moveMode = 'obey';
    win.drag({x: 50, y: 60, w: 300, h: 200});
    await world.advance(1000);
    ext.disable();
});

// ---------------------------------------------------------------- saving

test('moving and resizing is saved in the core format, after a debounce, once per burst', async () => {
    const ext = enable();
    const win = note(1);
    await world.advance(3000);
    win.drag(SAVED);
    win.drag({...SAVED, x: 310});
    win.drag({...SAVED, x: 320, w: 410});
    await world.advance(299);
    assert.equal(world.writes(), 0, 'nothing before 300 ms');
    await world.advance(2);
    assert.equal(world.writes(), 1, 'one write for the burst');
    const text = fs.readFileSync(world.layoutPath(), 'utf8');
    assert.deepEqual(new TextEncoder().encode(text), serializeLayout(parseLayout(text).layout), 'byte-for-byte what the core writes');
    assert.deepEqual(parseLayout(text).layout[uuid(1)], {x: 320, y: 200, w: 410, h: 260, monitor: MON1, open: true});
    assert.deepEqual(world.errors, []);
    ext.disable();
});

test('the saved monitor is the one the window is on', async () => {
    world.monitors = [{x: 0, y: 0, width: 1920, height: 1080}, {x: 1920, y: 0, width: 1280, height: 1024}];
    world.workAreas = [{x: 0, y: 32, width: 1920, height: 1048}, {x: 1920, y: 0, width: 1280, height: 1024}];
    const ext = enable();
    const win = note(1);
    await world.advance(3000);
    win.drag({x: 2100, y: 100, w: 300, h: 200});
    await world.advance(1000);
    assert.equal(world.readLayout()[uuid(1)].monitor, '1280x1024+1920+0');
    ext.disable();
});

test('a write keeps the other notes and the `open` flag the GTK app wrote, even if it wrote them after we started', async () => {
    world.writeLayout({[uuid(1)]: entry(SAVED, {open: false})});
    const ext = enable();
    const win = note(1);
    await world.advance(3000);
    // The app adds a second note while the extension is running.
    world.writeLayout({[uuid(1)]: entry(SAVED, {open: false}), [uuid(2)]: entry({x: 5, y: 6, w: 70, h: 80}, {open: true})});
    win.drag({...SAVED, x: 333});
    await world.advance(1000);
    const out = world.readLayout();
    assert.equal(out[uuid(1)].x, 333);
    assert.equal(out[uuid(1)].open, false, '`open` is the app\'s');
    assert.deepEqual(out[uuid(2)], entry({x: 5, y: 6, w: 70, h: 80}));
    ext.disable();
});

test('the layout directory is created, with a new file, on the first save', async () => {
    const ext = enable();
    const win = note(1);
    await world.advance(3000);
    assert.ok(!fs.existsSync(`${world.stateHome}/cetli`));
    win.drag(SAVED);
    await world.advance(1000);
    assert.deepEqual(world.readLayout()[uuid(1)], entry(SAVED));
    assert.deepEqual(fs.readdirSync(`${world.stateHome}/cetli`), ['layout.json'], 'no temporary file left behind');
    ext.disable();
});

test('maximized and fullscreen windows are not saved', async () => {
    const ext = enable();
    const win = note(1);
    await world.advance(3000);
    win.maximized = 3;
    win.drag({x: 0, y: 32, w: 1920, h: 1048});
    await world.advance(1000);
    win.maximized = 0;
    win.fullscreen = true;
    win.drag({x: 0, y: 0, w: 1920, h: 1080});
    await world.advance(1000);
    assert.equal(world.writes(), 0);
    ext.disable();
});

test('a move back to the very same rectangle is not written again', async () => {
    world.writeLayout({[uuid(1)]: entry(SAVED)});
    const ext = enable();
    const win = note(1);
    await world.advance(3000);
    win.drag({...SAVED, x: 10});
    await world.advance(1000);
    win.drag({...SAVED, x: 10});
    await world.advance(1000);
    assert.equal(world.writes(), 1);
    ext.disable();
});

test('two notes saved at the same time both end up in the file', async () => {
    const ext = enable();
    const a = note(1);
    const b = note(2);
    await world.advance(3000);
    a.drag(SAVED);
    b.drag({x: 900, y: 100, w: 300, h: 300});
    await world.advance(1000);
    const out = world.readLayout();
    assert.deepEqual([out[uuid(1)].x, out[uuid(2)].x], [300, 900]);
    ext.disable();
});

test('two notes saved while the first write is still reading are written one after the other, none is lost', async () => {
    const ext = enable();
    const a = note(1);
    const b = note(2);
    await world.advance(3000);
    world.ioDelay = 10;     // every read of the layout file takes 10 real ms: the two writes would overlap
    a.drag(SAVED);
    b.drag({x: 900, y: 100, w: 300, h: 300});
    await world.advance(1000);
    await sleep(150);
    const out = world.readLayout();
    assert.deepEqual([out[uuid(1)]?.x, out[uuid(2)]?.x], [300, 900]);
    assert.equal(world.writes(), 2);
    assert.deepEqual(world.errors, []);
    ext.disable();
});

test('a write only changes what is waiting: entries written before are not written again over newer data', async () => {
    const ext = enable();
    const a = note(1);
    const b = note(2);
    await world.advance(3000);
    a.drag(SAVED);
    await world.advance(1000);
    assert.equal(world.readLayout()[uuid(1)].x, 300);
    // Somebody else changes the note of `a` (the app, or the user by hand) ...
    world.writeLayout({[uuid(1)]: entry({...SAVED, x: 777}, {open: false})});
    // ... and `b` is saved: the old entry of `a` must not come back.
    b.drag({x: 900, y: 100, w: 300, h: 300});
    await world.advance(1000);
    const out = world.readLayout();
    assert.equal(out[uuid(1)].x, 777);
    assert.equal(out[uuid(1)].open, false);
    assert.equal(out[uuid(2)].x, 900);
    ext.disable();
});

// ---------------------------------------------------------------- a bad layout file

test('a file that is not JSON gives no restore and is replaced by the first save', async () => {
    world.writeLayout('{"half');
    const ext = enable();
    const win = note(1);
    await world.advance(3000);
    assert.equal(win.moveCalls.length, 0);
    win.drag(SAVED);
    await world.advance(1000);
    assert.deepEqual(world.readLayout(), {[uuid(1)]: entry(SAVED)});
    ext.disable();
});

test('a file that cannot be read, is too big or is not a regular file is never written over', async () => {
    const big = JSON.stringify({[uuid(9)]: entry(SAVED)}) + ' '.repeat(256 * 1024);
    const cases = {
        'too big': () => world.writeLayout(big),
        'a directory': () => fs.mkdirSync(world.layoutPath(), {recursive: true}),
        'a symlink': () => {
            fs.mkdirSync(`${world.stateHome}/cetli`, {recursive: true});
            fs.writeFileSync(`${world.stateHome}/elsewhere.json`, '{}');
            fs.symlinkSync(`${world.stateHome}/elsewhere.json`, world.layoutPath());
        },
        'unreadable': () => {
            world.writeLayout({});
            world.failRead = 'permission denied';
        },
    };
    for (const [name, setup] of Object.entries(cases)) {
        world.reset();
        setup();
        const before = fs.existsSync(world.layoutPath()) && fs.lstatSync(world.layoutPath()).isFile() ? fs.readFileSync(world.layoutPath(), 'utf8') : null;
        const ext = enable();
        const win = note(1);
        await world.advance(3000);
        win.drag(SAVED);
        await world.advance(1000);
        assert.equal(win.moveCalls.length, 0, name);
        assert.equal(world.writes(), 0, `${name}: nothing written`);
        if (before !== null)
            assert.equal(fs.readFileSync(world.layoutPath(), 'utf8'), before, `${name}: file unchanged`);
        ext.disable();
    }
});

test('a file that grows past the limit while it is read is left alone (chunked, bounded read)', async () => {
    const small = JSON.stringify({[uuid(9)]: entry(SAVED)});
    world.writeLayout(small + ' '.repeat(256 * 1024 - small.length));   // exactly the limit: allowed
    world.chunk = 1000;
    const ext = enable();
    const win = note(1);
    await world.advance(3000);
    assert.equal(win.moveCalls.length, 0);
    assert.ok(world.ioCalls.filter(c => c === 'read-chunk').length > 200, 'read in many short chunks');
    win.drag(SAVED);
    await world.advance(1000);
    assert.equal(world.readLayout()[uuid(1)].x, 300, 'at the limit it is still read and written');
    ext.disable();
});

test('a file that grows past the limit after the size check is left alone', async () => {
    const small = JSON.stringify({[uuid(9)]: entry(SAVED)});
    world.writeLayout(small + ' '.repeat(250 * 1024));
    world.growOnRead = 20 * 1024;
    const ext = enable();
    const win = note(1);
    await world.advance(3000);
    win.drag(SAVED);
    await world.advance(1000);
    assert.equal(win.moveCalls.length, 0);
    assert.equal(world.writes(), 0);
    assert.ok(world.warnings.some(w => w.includes('past the limit')), world.warnings.join('|'));
    ext.disable();
});

test('a failing write is logged and the next save still works', async () => {
    const ext = enable();
    const win = note(1);
    await world.advance(3000);
    world.failWrite = true;
    win.drag(SAVED);
    await world.advance(1000);
    assert.ok(world.errors.some(e => e.includes('write')), world.errors.join('|'));
    world.failWrite = false;
    win.drag({...SAVED, x: 11});
    await world.advance(1000);
    assert.equal(world.readLayout()[uuid(1)].x, 11);
    ext.disable();
});

test('the layout file is looked at without following a link: a link is never read through or written over', async () => {
    fs.mkdirSync(`${world.stateHome}/cetli`, {recursive: true});
    const target = `${world.stateHome}/elsewhere.json`;
    fs.writeFileSync(target, JSON.stringify({[uuid(1)]: entry(SAVED)}));
    fs.symlinkSync(target, world.layoutPath());
    const ext = enable();
    const win = note(1);
    await world.advance(3000);
    win.drag({...SAVED, x: 5});
    await world.advance(1000);
    assert.equal(win.moveCalls.length, 0, 'the entry behind the link is not used');
    assert.equal(world.writes(), 0);
    assert.ok(fs.lstatSync(world.layoutPath()).isSymbolicLink(), 'still a link');
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8'))[uuid(1)].x, SAVED.x, 'the target is untouched');
    assert.ok(world.warnings.some(w => w.includes('not a small regular file')), world.warnings.join('|'));
    ext.disable();
});

test('every stream that is opened is closed again: after a read, after a write, and when the read is given up', async () => {
    const small = JSON.stringify({[uuid(9)]: entry(SAVED)});
    world.writeLayout({[uuid(1)]: entry(SAVED)});
    let ext = enable();
    let win = note(1);
    await world.advance(3000);
    assert.equal(world.ioCalls.filter(c => c === 'read').length, 1);
    assert.equal(world.openStreams, 0, 'closed after the restore read');
    win.drag({...SAVED, x: 20});
    await world.advance(1000);
    assert.equal(world.ioCalls.filter(c => c === 'read').length, 2, 'the save read the file again');
    assert.equal(world.openStreams, 0, 'closed after the read of the save');
    assert.equal(world.ioCalls.filter(c => c === 'close').length, 2);
    ext.disable();

    world.reset();
    world.writeLayout(small + ' '.repeat(250 * 1024));
    world.growOnRead = 20 * 1024;
    ext = enable();
    win = note(1);
    await world.advance(3000);
    assert.equal(world.ioCalls.filter(c => c === 'read').length, 1, 'the stream was opened');
    assert.equal(world.openStreams, 0, 'and closed although the read was abandoned half way');
    ext.disable();
});

// ---------------------------------------------------------------- the limits of the file the extension writes

// Notes `uuid(1000 + i)` with a large `monitor` (an object of long strings, as the core allows) plus the entry of
// `uuid(1)` that the test makes the extension write: the layout serialises to exactly `target` bytes, with
// `uuid(1)`. The returned file content is the same without the entry of `uuid(1)`.
function layoutOfSize(target, mine) {
    const fat = lens => ({...SAVED, open: true, monitor: Object.fromEntries(lens.map((n, i) => [`k${i}`, 'a'.repeat(n)]))});
    const spread = extra => Array.from({length: 8}, (_v, i) => Math.max(0, Math.min(256, extra - 256 * i)));
    const size = l => serializeLayout(l).length;
    for (let n = 0; n < MAX_NOTES - 4; n++) {
        const base = {[uuid(1)]: mine};
        for (let i = 0; i < n; i++)
            base[uuid(1000 + i)] = fat(spread(2048));
        base[uuid(2000)] = fat(spread(0));
        base[uuid(2001)] = fat(spread(0));
        const rest = target - size(base);
        if (rest < 0 || rest > 4096)
            continue;
        base[uuid(2000)] = fat(spread(Math.min(rest, 2048)));
        base[uuid(2001)] = fat(spread(rest - Math.min(rest, 2048)));
        assert.equal(size(base), target);
        const without = {...base};
        delete without[uuid(1)];
        return {full: base, without};
    }
    throw new Error('no layout of that size');
}

const mine = entry(SAVED);

test('a save that makes the file exactly as big as the reader accepts is written', async () => {
    const {without} = layoutOfSize(MAX_FILE_BYTES, mine);
    world.writeLayout(without);
    assert.ok(fs.statSync(world.layoutPath()).size < MAX_FILE_BYTES, 'the file before is readable');
    const ext = enable();
    const win = note(1);
    await world.advance(3000);
    win.drag(SAVED);
    await world.advance(1000);
    assert.equal(world.writes(), 1);
    assert.equal(fs.statSync(world.layoutPath()).size, MAX_FILE_BYTES);
    assert.deepEqual(world.readLayout()[uuid(1)], mine);
    assert.deepEqual(world.warnings, []);
    ext.disable();
});

test('a save that would make the file one byte too big is not written; one warning, however often it is tried', async () => {
    const {without} = layoutOfSize(MAX_FILE_BYTES + 1, mine);
    world.writeLayout(without);
    const before = fs.readFileSync(world.layoutPath(), 'utf8');
    const ext = enable();
    const win = note(1);
    await world.advance(3000);
    win.drag(SAVED);
    await world.advance(1000);
    win.drag({...SAVED, x: 301});
    await world.advance(1000);
    win.drag({...SAVED, x: 302});
    await world.advance(1000);
    assert.equal(world.writes(), 0);
    assert.equal(fs.readFileSync(world.layoutPath(), 'utf8'), before, 'the file is as it was');
    assert.equal(world.warnings.filter(w => w.includes('size limit')).length, 1, world.warnings.join('|'));
    assert.deepEqual(world.errors, []);
    ext.disable();
});

const crowd = (count, extra = {}) => Object.fromEntries(Array.from({length: count}, (_v, i) => [uuid(1000 + i), entry({x: i, y: i, w: 100, h: 100})]).concat(Object.entries(extra)));

test('a new note is saved while the file has fewer than MAX_NOTES notes, and not when it already has that many', async () => {
    world.writeLayout(crowd(MAX_NOTES - 1));
    let ext = enable();
    let win = note(1);
    await world.advance(3000);
    win.drag(SAVED);
    await world.advance(1000);
    assert.equal(Object.keys(world.readLayout()).length, MAX_NOTES, 'the last free place is used');
    assert.deepEqual(world.warnings, []);
    ext.disable();

    world.reset();
    const full = crowd(MAX_NOTES);
    world.writeLayout(full);
    const before = fs.readFileSync(world.layoutPath(), 'utf8');
    ext = enable();
    win = note(1);
    await world.advance(3000);
    win.drag(SAVED);
    await world.advance(1000);
    win.drag({...SAVED, x: 301});
    await world.advance(1000);
    assert.equal(world.writes(), 0, 'no write at all (the file would not change)');
    assert.equal(fs.readFileSync(world.layoutPath(), 'utf8'), before);
    assert.equal(world.warnings.filter(w => w.includes('maximum number')).length, 1, world.warnings.join('|'));
    ext.disable();
});

test('with MAX_NOTES notes in the file the note that is already in it is still updated', async () => {
    world.writeLayout(crowd(MAX_NOTES - 1, {[uuid(1)]: entry(SAVED)}));
    const ext = enable();
    const win = note(1);
    await world.advance(3000);
    win.drag({...SAVED, x: 411});
    await world.advance(1000);
    const out = world.readLayout();
    assert.equal(Object.keys(out).length, MAX_NOTES);
    assert.equal(out[uuid(1)].x, 411);
    assert.deepEqual(world.warnings, []);
    ext.disable();
});

// ---------------------------------------------------------------- closing and switching off

test('closing a note with a move still waiting saves it, and leaves no timer or signal behind', async () => {
    const ext = enable();
    const win = note(1);
    await world.advance(3000);
    win.drag(SAVED);
    win.close();
    await world.advance(10);
    assert.equal(world.readLayout()[uuid(1)].x, 300);
    assert.equal(world.timers.size, 0);
    assert.equal(win.connectionCount(), 0);
    ext.disable();
});

test('a window that closes while it is still being watched takes its timer with it', async () => {
    const ext = enable();
    const win = note(1, DEFAULT, {title: ''});
    await world.advance(250);
    assert.equal(world.timers.size, 1);
    win.close();
    assert.equal(world.timers.size, 0);
    assert.equal(win.connectionCount(), 0);
    ext.disable();
});

test('disable() flushes a waiting move and removes every timer and signal; later moves do nothing', async () => {
    const ext = enable();
    const win = note(1);
    const other = world.addWindow({appId: 'x', title: '', rect: DEFAULT});
    await world.advance(3000);
    win.drag(SAVED);
    ext.disable();
    await world.advance(10);
    assert.equal(world.readLayout()[uuid(1)].x, 300, 'flushed');
    assert.equal(world.timers.size, 0);
    assert.equal(win.connectionCount(), 0);
    assert.equal(other.connectionCount(), 0);
    assert.equal(world.display.connectionCount(), 0);
    win.drag({...SAVED, x: 5});
    await world.advance(1000);
    assert.equal(world.readLayout()[uuid(1)].x, 300);
});

test('disable() before a restore finished: the window is left alone and nothing throws', async () => {
    world.writeLayout({[uuid(1)]: entry(SAVED)});
    const ext = enable();
    const win = note(1);
    ext.disable();          // the layout file is still being read
    await world.advance(3000);
    assert.equal(win.moveCalls.length, 0);
    assert.deepEqual(world.errors, []);
});

test('enable() and disable() twice in a row, and disable() without enable(), are safe', async () => {
    const ext = new CetliExtension({path: '/ext'});
    ext.disable();
    ext.enable();
    ext.disable();
    ext.enable();
    ext.disable();
    ext.disable();
    assert.equal(world.display.connectionCount(), 0);
    assert.deepEqual(world.errors, []);
});

test('enable() that fails inside the Shell is caught', () => {
    globalThis.global.get_window_actors = () => {
        throw new Error('no actors');
    };
    const ext = enable();
    ext.disable();
    assert.ok(world.errors.length >= 1);
});
