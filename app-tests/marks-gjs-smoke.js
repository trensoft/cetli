// SPDX-License-Identifier: GPL-3.0-or-later
// gjs check of app/marks.js with the REAL hash of GLib (the node tests inject a node:crypto hash): the first 16 lowercase hex of
// the sha256 of the UTF-8 text must be the same under GLib as under node:crypto (the vectors below were made with node:crypto,
// `createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex').slice(0, 16)`, and are checked again against sha256sum
// at run time), also for astral / combining / NUL / lone surrogate text; the module must load under gjs (Object.hasOwn, ...),
// and the code point offsets of marks.js must be the offsets of Gtk.TextBuffer.
// Run like the other smoke tests, inside a headless Wayland compositor (Gtk is only used for the TextBuffer check):
// headless.sh 1920x1080 -- gjs -m app-tests/marks-gjs-smoke.js
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';

import {BOLD, ITALIC, STRIKE, UNDERLINE, MAX_RANGES, decodeMarks, encodeMarks, flagsAt, normalizeRanges, toggleFlag} from '../app/marks.js';

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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The hash function of the app (app/format-bar.js, sha16): GLib on the UTF-8 bytes of the text. NOT compute_checksum_for_string:
// that one stops at the first NUL.
const encoder = new TextEncoder();
const sha16 = text => GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, encoder.encode(text)).slice(0, 16);

// [text, first 16 hex of node:crypto sha256 of Buffer.from(text, 'utf8')]
const VECTORS = [
    ['', 'e3b0c44298fc1c14'],
    ['abc', 'ba7816bf8f01cfea'],
    ['Árvíztűrő tükörfúrógép', 'e97fec1a60c06276'],
    ['a😀b𝒳c', '044554cae8615ba7'],
    ['a\0b', '59b271ae1bbcb1d3'],
    ['é', 'bf12767b0f2a56b2'],
    ['👨‍👩‍👧', 'cc3baf32248d7665'],
    ['\ud800', '83d544ccc223c057'],
    ['x\ud83d', '5f350b94b4920d9b'],
    ['line1\r\nline2\n', '6825eec65a7385d7'],
    ['﻿bom', '2623148f0d047ef6'],
];
const show = t => JSON.stringify(t).replace(/[^\x20-\x7e]/g, c => `\\u${c.codePointAt(0).toString(16).padStart(4, '0')}`);

for (const [text, want] of VECTORS) {
    let got;
    try {
        got = sha16(text);
    } catch (e) {
        got = `threw ${e}`;
    }
    check(got === want, `sha16 under GLib = node:crypto for ${show(text)}: ${got}${got === want ? '' : ` (want ${want})`}`);
}
check(/^[0-9a-f]{16}$/.test(sha16('abc')), 'sha16 is 16 lowercase hex digits');

// Third source: the sha256sum of the system, on a file with the UTF-8 bytes. Lone surrogates have no UTF-8 of their own
// (TextEncoder and Buffer.from both write U+FFFD), so they are written the way the encoder writes them.
function sha256sumOf(text) {
    const tmp = GLib.dir_make_tmp('cetli-marks-XXXXXX');
    try {
        const file = `${tmp}/t.bin`;
        GLib.file_set_contents(file, encoder.encode(text));
        const [ok, out] = GLib.spawn_command_line_sync(`sha256sum ${file}`);
        return ok ? new TextDecoder().decode(out).slice(0, 16) : null;
    } finally {
        Gio.File.new_for_path(`${tmp}/t.bin`).delete(null);
        Gio.File.new_for_path(tmp).delete(null);
    }
}
const hasSha256sum = GLib.find_program_in_path('sha256sum') !== null;
if (hasSha256sum) {
    for (const [text, want] of VECTORS)
        check(sha256sumOf(text) === want, `sha256sum of the UTF-8 bytes = the node:crypto vector for ${show(text)}`);
} else {
    print('info no sha256sum in this container: the third source is skipped');
}

// The module under gjs.
check(typeof Object.hasOwn === 'function', 'Object.hasOwn exists in this gjs');
check(Object.hasOwn({marks: 1}, 'marks') && !Object.hasOwn(Object.create({marks: 1}), 'marks'), 'Object.hasOwn ignores the prototype chain');
check(MAX_RANGES === 256 && BOLD === 1 && ITALIC === 2 && UNDERLINE === 4 && STRIKE === 8, 'the constants are the contract values');

// Code point offsets: astral characters count once, as in Gtk.TextBuffer.
Gtk.init();
const TEXTS = ['plain', 'a😀b𝒳c', 'éx', '👨‍👩‍👧 family', 'tab\tnew\nline'];
for (const text of TEXTS) {
    const buffer = new Gtk.TextBuffer();
    buffer.set_text(text, -1);
    check(buffer.get_char_count() === Array.from(text).length, `Gtk.TextBuffer char count = code point count for ${show(text)}: ${buffer.get_char_count()}`);
}

// Round trip with the real hash, astral text: ranges in code points (b = 2 .. 𝒳 = 3 below).
const ASTRAL = 'a😀b𝒳c';                                    // 5 code points, 7 UTF-16 units
{
    const ranges = [[1, 2, BOLD], [3, 4, ITALIC | UNDERLINE]];
    const enc = encodeMarks(ASTRAL, ranges, sha16);
    check(same(enc, {h: '044554cae8615ba7', r: ranges}), `encodeMarks with GLib gives the node:crypto hash and the code point ranges: ${JSON.stringify(enc)}`);
    check(same(decodeMarks(ASTRAL, {marks: enc}, sha16), ranges), 'decodeMarks with GLib accepts what encodeMarks wrote (round trip, astral text)');
    // through JSON, as a note file carries it
    const viaFile = JSON.parse(JSON.stringify({marks: enc}));
    check(same(decodeMarks(ASTRAL, viaFile, sha16), ranges), 'the round trip survives JSON.stringify / JSON.parse');
    check(decodeMarks(ASTRAL, {marks: {h: '044554cae8615ba7', r: [[1, 2, BOLD], [3, 6, BOLD]]}}, sha16) === null, 'a range past the code point length (6 > 5) is refused with the real hash');
    check(decodeMarks(ASTRAL, {marks: {h: '044554cae8615ba7', r: [[1, 2, BOLD], [3, 7, BOLD]]}}, sha16) === null, 'a range that fits the UTF-16 length (7) but not the code point length is refused');
    check(decodeMarks(`${ASTRAL}!`, {marks: enc}, sha16) === null, 'one added character: the hash no longer fits, the note is plain');
    check(decodeMarks('a😀b𝒳d', {marks: enc}, sha16) === null, 'one changed character: the hash no longer fits');
    check(decodeMarks(ASTRAL, {marks: {...enc, h: enc.h.toUpperCase()}}, sha16) === null, 'an upper case hash is refused');
    check(decodeMarks(ASTRAL, {marks: {...enc, h: enc.h.slice(0, 15)}}, sha16) === null, 'a 15 digit hash is refused');
}

// NUL in the text: the hash covers the whole text (a string-based checksum would stop at the NUL and give the hash of "a").
{
    const text = 'a\0bcd';
    const enc = encodeMarks(text, [[2, 4, STRIKE]], sha16);
    check(enc !== null && enc.h !== sha16('a'), 'a NUL in the text: the hash is not the hash of the text before the NUL');
    check(decodeMarks(text, {marks: enc}, sha16) !== null && decodeMarks('a\0bXY', {marks: enc}, sha16) === null,
        'a NUL in the text: a change after the NUL is seen');
}

// Lone surrogate (cannot come from a UTF-8 file, but a buffer might hold one): marks.js must not throw, whatever the hash does.
{
    let enc;
    let threw = false;
    try {
        enc = encodeMarks('x\ud83dy', [[0, 3, BOLD]], sha16);
    } catch {
        threw = true;
    }
    check(!threw, 'encodeMarks does not throw for a lone surrogate');
    check(enc === null || same(decodeMarks('x\ud83dy', {marks: enc}, sha16), [[0, 3, BOLD]]), 'a lone surrogate: plain or an exact round trip, never a wrong one');
}

// Hostile input with the real hash: never throws, always null.
{
    const enc = encodeMarks('hello world', [[0, 5, BOLD]], sha16);
    const proto = Object.create({marks: enc});
    const hostile = [null, undefined, 5, 'marks', [], [enc], {}, {marks: null}, {marks: []}, {marks: 'x'}, {marks: {h: 5, r: []}},
        {marks: {h: enc.h, r: 'x'}}, {marks: {h: enc.h, r: [[0, 5]]}}, {marks: {h: enc.h, r: [[0, 5, 16]]}}, {marks: {h: enc.h, r: [[0, 5, BOLD, 0]]}},
        {marks: {h: enc.h, r: [[0.5, 5, BOLD]]}}, {marks: {h: enc.h, r: [[-1, 5, BOLD]]}}, {marks: {h: enc.h, r: [[0, 5, BOLD], [3, 8, BOLD]]}},
        {marks: {h: enc.h, r: [[6, 8, BOLD], [0, 5, BOLD]]}}, {marks: {h: enc.h, r: Array.from({length: 257}, (_, i) => [i, i + 1, BOLD])}}, proto];
    let bad = 0;
    for (const extra of hostile) {
        try {
            if (decodeMarks('hello world', extra, sha16) !== null)
                bad++;
        } catch {
            bad++;
        }
    }
    check(bad === 0, `${hostile.length} hostile extras: all answer null, none throws`);
    check(same(decodeMarks('hello world', {marks: enc}, sha16), [[0, 5, BOLD]]), 'the untouched value is accepted by the same harness (the null above is not an empty proof)');
}

// The pure arithmetic is the same under gjs.
check(same(toggleFlag([[0, 3, BOLD]], 1, 5, BOLD), [[0, 5, BOLD]]), 'toggleFlag extends bold over the selection');
check(same(toggleFlag([[0, 5, BOLD]], 1, 3, BOLD), [[0, 1, BOLD], [3, 5, BOLD]]), 'toggleFlag removes bold from the middle');
check(same(normalizeRanges([[0, 4, BOLD], [2, 6, ITALIC]]), [[0, 2, BOLD], [2, 4, BOLD | ITALIC], [4, 6, ITALIC]]), 'normalizeRanges ORs the flags of overlapping ranges');
check(same(flagsAt([[0, 4, BOLD], [2, 6, ITALIC]], 2, 4), {all: BOLD | ITALIC, any: BOLD | ITALIC}), 'flagsAt on the overlap');

print(`${checks - failed}/${checks} checks passed`);
print(failed === 0 ? 'RESULT PASS' : 'RESULT FAIL');
imports.system.exit(failed === 0 ? 0 : 1);
