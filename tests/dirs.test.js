// SPDX-License-Identifier: GPL-3.0-or-later
// src/dirs.js: the pure part of the Flatpak data and state directories (the adapter's use of it is in gio-layer.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';

import {flatpakHostDirs, isFlatpak} from '../src/dirs.js';

const ID = 'io.github.trensoft.cetli';

test('isFlatpak: only a non-empty FLATPAK_ID', () => {
    assert.equal(isFlatpak({FLATPAK_ID: ID}), true);
    for (const env of [{}, {FLATPAK_ID: ''}, {FLATPAK_ID: null}, {FLATPAK_ID: undefined}, {FLATPAK_ID: 1}, null, undefined])
        assert.equal(isFlatpak(env), false, JSON.stringify(env));
});

test('flatpakHostDirs: not a Flatpak gives null, whatever HOST_* says', () => {
    assert.equal(flatpakHostDirs({env: {HOST_XDG_DATA_HOME: '/h/d', HOST_XDG_STATE_HOME: '/h/s'}, homeDir: '/home/u'}), null);
    assert.equal(flatpakHostDirs({env: {}, homeDir: 'not even absolute'}), null, 'outside a Flatpak the home is not looked at');
});

test('flatpakHostDirs: HOST_XDG_* wins, each variable on its own', () => {
    assert.deepEqual(flatpakHostDirs({env: {FLATPAK_ID: ID, HOST_XDG_DATA_HOME: '/h/d', HOST_XDG_STATE_HOME: '/h/s'}, homeDir: '/home/u'}), {data: '/h/d', state: '/h/s'});
    assert.deepEqual(flatpakHostDirs({env: {FLATPAK_ID: ID, HOST_XDG_DATA_HOME: '/h/d'}, homeDir: '/home/u'}), {data: '/h/d', state: '/home/u/.local/state'});
    assert.deepEqual(flatpakHostDirs({env: {FLATPAK_ID: ID, HOST_XDG_STATE_HOME: '/h/s'}, homeDir: '/home/u'}), {data: '/home/u/.local/share', state: '/h/s'});
});

test('flatpakHostDirs: without HOST_XDG_* the XDG defaults under the home; an empty or relative value counts as unset', () => {
    const want = {data: '/home/u/.local/share', state: '/home/u/.local/state'};
    assert.deepEqual(flatpakHostDirs({env: {FLATPAK_ID: ID}, homeDir: '/home/u'}), want);
    assert.deepEqual(flatpakHostDirs({env: {FLATPAK_ID: ID, HOST_XDG_DATA_HOME: '', HOST_XDG_STATE_HOME: 'rel/state'}, homeDir: '/home/u'}), want);
    assert.deepEqual(flatpakHostDirs({env: {FLATPAK_ID: ID, HOST_XDG_DATA_HOME: null, HOST_XDG_STATE_HOME: undefined}, homeDir: '/home/u'}), want);
});

test('flatpakHostDirs: in a Flatpak a home that is not absolute is refused', () => {
    for (const homeDir of [undefined, null, '', 'home/u'])
        assert.throws(() => flatpakHostDirs({env: {FLATPAK_ID: ID}, homeDir}), RangeError);
});
