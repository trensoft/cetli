// SPDX-License-Identifier: GPL-3.0-or-later
// sync/markers.js and app/sync-start.js: T9b (a marker in each parent up to $HOME, none above), T14-T17 (the first-start window).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {markerPaths} from '../sync/markers.js';
import {DISMISSED_TEXT, firstStartAction, shouldShowFirstStart, syncMarked} from '../app/sync-start.js';

const HOME = '/home/u';
const NOTES = '/home/u/.local/share/cetli/notes';

test('T9b: the chain runs from notes/ up to and including $HOME, nearest first, and stops there', () => {
    assert.deepEqual(markerPaths(NOTES, HOME), [
        '/home/u/.local/share/cetli/notes/.stfolder', '/home/u/.local/share/cetli/.stfolder', '/home/u/.local/share/.stfolder',
        '/home/u/.local/.stfolder', '/home/u/.stfolder',
    ]);
    for (const p of markerPaths(NOTES, HOME))
        assert.equal(p === '/home/.stfolder' || p === '/.stfolder', false, `${p} is above $HOME`);
});

test('T9b: a notes directory outside $HOME, or equal to it, is checked alone; trailing slashes do not matter', () => {
    assert.deepEqual(markerPaths('/srv/notes', HOME), ['/srv/notes/.stfolder']);
    assert.deepEqual(markerPaths(HOME, HOME), ['/home/u/.stfolder']);
    assert.deepEqual(markerPaths('/home/user2/notes', HOME), ['/home/user2/notes/.stfolder']);    // /home/u is not a prefix of /home/user2
    assert.deepEqual(markerPaths(`${NOTES}/`, `${HOME}/`), markerPaths(NOTES, HOME));
    assert.deepEqual(markerPaths('/home/u/n', '/'), ['/home/u/n/.stfolder', '/home/u/.stfolder', '/home/.stfolder', '/.stfolder']);
});

test('markerPaths: relative, odd and dotted paths are refused', () => {
    for (const bad of [['notes', HOME], [NOTES, 'home'], ['/a//b', HOME], ['/a/../b', HOME], [NOTES, '/h\nx'], [5, HOME], [NOTES, null]])
        assert.throws(() => markerPaths(...bad), RangeError, JSON.stringify(bad));
});

const ARGS = {notesDir: NOTES, homeDir: HOME};
const none = () => false;

test('T14: no state file and no marker: the window is requested', () => {
    assert.equal(shouldShowFirstStart({stateText: null, markerExists: none, ...ARGS}), true);
    assert.equal(shouldShowFirstStart({stateText: '{"version":1,"dismissed":false}', markerExists: none, ...ARGS}), true);
});

test('T15: dismissed, a marker in notes/ or in any parent level: not shown', () => {
    assert.equal(shouldShowFirstStart({stateText: DISMISSED_TEXT, markerExists: none, ...ARGS}), false);
    for (const level of markerPaths(NOTES, HOME))
        assert.equal(shouldShowFirstStart({stateText: null, markerExists: p => p === level, ...ARGS}), false, level);
    assert.equal(shouldShowFirstStart({stateText: null, markerExists: p => p === '/home/.stfolder', ...ARGS}), true);       // above $HOME is never asked
    const asked = [];
    shouldShowFirstStart({stateText: null, markerExists: p => { asked.push(p); return false; }, ...ARGS});
    assert.deepEqual(asked, markerPaths(NOTES, HOME));
});

test('T16: an unreadable or foreign-version state file: not shown', () => {
    for (const text of ['', 'not json', '{', '[]', 'null', '5', '{"version":2,"dismissed":false}', '{"version":"1","dismissed":false}', '{"dismissed":false}',
        '{"version":1}', '{"version":1,"dismissed":"no"}', '{"version":1,"dismissed":0}'])
        assert.equal(shouldShowFirstStart({stateText: text, markerExists: none, ...ARGS}), false, text);
});

test('T17: what "Later" writes is exactly {"version":1,"dismissed":true}', () => {
    assert.equal(DISMISSED_TEXT, '{"version":1,"dismissed":true}');
});

test('bad paths: fail quiet, not shown', () => {
    assert.equal(shouldShowFirstStart({stateText: null, markerExists: none, notesDir: 'x', homeDir: HOME}), false);
});

test('0.2.5.1: a marker anywhere on the chain means synchronised (no note at the start); none means not; odd paths count as synchronised', () => {
    const only = path => p => p === path;
    assert.equal(syncMarked({markerExists: () => false, notesDir: NOTES, homeDir: HOME}), false);
    assert.equal(syncMarked({markerExists: only(`${NOTES}/.stfolder`), notesDir: NOTES, homeDir: HOME}), true);
    assert.equal(syncMarked({markerExists: only('/home/u/.stfolder'), notesDir: NOTES, homeDir: HOME}), true);
    assert.equal(syncMarked({markerExists: only('/home/.stfolder'), notesDir: NOTES, homeDir: HOME}), false);    // above $HOME: not asked
    assert.equal(syncMarked({markerExists: () => false, notesDir: 'notes', homeDir: HOME}), true);
});

// app/application.js needs GTK, so the behaviour is in the start-gate smokes in app-tests/ (synced-start-deleted, synced-start-empty, unsynced-start; gjs, headless). Here only the wiring is pinned in node:
// both starts (showStartWindows, showAll) ask the one `synced()`, which asks notesSynced, and neither makes a note on a synchronised folder.
test('0.2.5.1: both starts of application.js go through synced() and open the list, not a new note', () => {
    const src = readFileSync(new URL('../app/application.js', import.meta.url), 'utf8');
    assert.match(src, /const synced = \(\) => notesSynced\(\{dirs, homeDir\}\);/);
    for (const fn of ['showStartWindows', 'showAll']) {
        const body = src.slice(src.indexOf(`async function ${fn}()`));
        const gate = body.slice(0, body.indexOf('\n    }\n'));
        assert.match(gate, /if \(synced\(\)\)\s+showAllNotes\(\);[^\n]*\n\s+else\s+await newNote\(null\);/, fn);
    }
});

// The Flatpak: no sync engine in the sandbox, so the first start shows a one-time notice instead of the sync window.
test('Flatpak first start: no "Later", no marker: the notice; not a Flatpak: the sync window as before', () => {
    assert.equal(firstStartAction({flatpak: true, stateText: null, markerExists: none, ...ARGS}), 'notice');
    assert.equal(firstStartAction({flatpak: true, stateText: '{"version":1,"dismissed":false}', markerExists: none, ...ARGS}), 'notice');
    for (const flatpak of [false, undefined, null, 'yes', 1])
        assert.equal(firstStartAction({flatpak, stateText: null, markerExists: none, ...ARGS}), 'wizard', String(flatpak));
});

test('Flatpak first start: closed once (the "Later" file), a synchronised folder (a marker on the chain), or an unreadable state: nothing', () => {
    for (const flatpak of [true, false]) {
        assert.equal(firstStartAction({flatpak, stateText: DISMISSED_TEXT, markerExists: none, ...ARGS}), 'none');
        assert.equal(firstStartAction({flatpak, stateText: 'not json', markerExists: none, ...ARGS}), 'none');
        assert.equal(firstStartAction({flatpak, stateText: null, notesDir: 'x', homeDir: HOME, markerExists: none}), 'none');
        for (const level of markerPaths(NOTES, HOME))
            assert.equal(firstStartAction({flatpak, stateText: null, markerExists: p => p === level, ...ARGS}), 'none', `${flatpak} ${level}`);
    }
});

test('Flatpak first start: the same answer as shouldShowFirstStart for every state, the Flatpak only picks which window', () => {
    for (const stateText of [null, DISMISSED_TEXT, '{', '{"version":1,"dismissed":false}'])
        for (const marked of [false, true])
            for (const flatpak of [false, true]) {
                const markerExists = () => marked;
                const want = shouldShowFirstStart({stateText, markerExists, ...ARGS});
                assert.equal(firstStartAction({flatpak, stateText, markerExists, ...ARGS}) !== 'none', want);
            }
});

test('Flatpak: application.js asks the environment, skips the start-up check of the sync program, and the notice branch never opens the sync window', () => {
    const src = readFileSync(new URL('../app/application.js', import.meta.url), 'utf8');
    assert.match(src, /flatpak = isFlatpak\(\{FLATPAK_ID: GLib\.getenv\('FLATPAK_ID'\)\}\)\} = \{\}\) \{/);
    const ensure = src.slice(src.indexOf('function ensureSync()'));
    assert.match(ensure.slice(0, ensure.indexOf('\n    }\n')), /if \(startupEnsure !== null \|\| flatpak\)\s+return;/);
    const first = src.slice(src.indexOf('function maybeShowFirstStartSync()'));
    const body = first.slice(0, first.indexOf('\n    }\n'));
    assert.match(body, /startAction\(\{dirs, flatpak, homeDir\}\)/);
    assert.match(body, /if \(action === 'wizard'\)\s+showSync\(\{firstStart: true\}\);\s+else if \(action === 'notice'\)\s+showSyncNotice\(\);/);
    const notice = src.slice(src.indexOf('function showSyncNotice()'));
    assert.equal(/showSync\(|SyncWizard/.test(notice.slice(0, notice.indexOf('\n    }\n'))), false);
});
