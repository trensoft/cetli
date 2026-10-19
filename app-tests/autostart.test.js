// SPDX-License-Identifier: GPL-3.0-or-later
// 0.2.8: which notes open at the start (app/layoutfile.js startNotes), by hand and at login (`cetli --autostart`).
import assert from 'node:assert/strict';
import test from 'node:test';

import {shouldOpen, startNotes} from '../app/layoutfile.js';

const entry = open => ({x: 1, y: 2, w: 300, h: 200, monitor: 'm', open});
const notes = ['a', 'b', 'c'].map(id => ({id}));
const ids = list => list.map(n => n.id).join();

test('a start by hand opens the notes not marked closed; a note without an entry counts as open', () => {
    assert.equal(ids(startNotes({a: entry(true), b: entry(false)}, notes)), 'a,c');
    assert.equal(ids(startNotes({}, notes)), 'a,b,c');
});

test('a start by hand with every note marked closed opens all of them (the fall-back, as before 0.2.8)', () => {
    const layout = {a: entry(false), b: entry(false), c: entry(false)};
    assert.equal(ids(startNotes(layout, notes)), 'a,b,c');
    assert.equal(ids(startNotes(layout, notes, {autostart: false})), 'a,b,c');
});

test('a start at login opens exactly the notes not marked closed: the same set, and NO fall-back when every note is closed', () => {
    assert.equal(ids(startNotes({a: entry(true), b: entry(false)}, notes, {autostart: true})), 'a,c');
    assert.equal(ids(startNotes({}, notes, {autostart: true})), 'a,b,c');
    const closed = {a: entry(false), b: entry(false), c: entry(false)};
    assert.deepEqual(startNotes(closed, notes, {autostart: true}), []);
    assert.deepEqual(startNotes({}, [], {autostart: true}), []);
    assert.deepEqual(startNotes({}, [], {}), []);
});

test('the set at login is the set shouldOpen gives, note by note', () => {
    const layout = {a: entry(true), b: entry(false), c: entry(true)};
    assert.deepEqual(startNotes(layout, notes, {autostart: true}).map(n => n.id), notes.filter(n => shouldOpen(layout, n.id)).map(n => n.id));
});
