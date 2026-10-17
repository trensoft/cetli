// SPDX-License-Identifier: GPL-3.0-or-later
// The text formatting of a note (bold, italic, underline, strikethrough) as it is stored in `origin.extra.marks`, and the pure
// arithmetic on its ranges. No Gtk/Gio/GLib import, so that a test can check it without a display; the hash is a parameter.
//
// Stored shape:  extra.marks = {h: <first 16 lowercase hex of sha256 of the text, UTF-8, as stored>, r: [[start, end, flags], ...]}
//   start/end are offsets in code points (Gtk.TextBuffer offsets; the index of `[...text]`, NOT the UTF-16 index), 0 <= start < end
//   <= code point length of the text. flags is a bitmask, 1..15. r is sorted by start, does not overlap, adjacent ranges with equal
//   flags are merged, at most MAX_RANGES. A plain note has no `marks` key at all (encodeMarks returns null, never an empty `r`).
//
// The note FILE is untrusted (another computer, an old client, a hand edit): decodeMarks never throws and answers null for anything
// it does not fully understand, and then the note is shown plain. The text is never touched here.

export const MAX_RANGES = 256;
export const BOLD = 1;
export const ITALIC = 2;
export const UNDERLINE = 4;
export const STRIKE = 8;
const ALL_FLAGS = 15;
const SINGLE_FLAGS = [BOLD, ITALIC, UNDERLINE, STRIKE];
const HASH_RE = /^[0-9a-f]{16}$/;

const isOffset = v => Number.isSafeInteger(v) && v >= 0;
const isFlags = v => Number.isSafeInteger(v) && v >= 1 && v <= ALL_FLAGS;
const isTriple = t => Array.isArray(t) && isOffset(t[0]) && isOffset(t[1]) && t[1] > t[0] && isFlags(t[2]);

// The ranges of a list of segments [start, end, flags] that follow each other: touching segments with equal flags become one.
function pushMerged(out, start, end, flags) {
    const last = out[out.length - 1];
    if (last !== undefined && last[1] === start && last[2] === flags)
        last[1] = end;
    else
        out.push([start, end, flags]);
}

// Any list of ranges -> the canonical stored form: sorted, non-overlapping, flags OR-ed where ranges overlap (GTK tags are
// independent, a bold and an italic tag may cover the same text), touching ranges with equal flags merged. An entry that is not a
// [start, end, flags] of integers with 0 <= start < end and flags 1..15 is dropped. Not an array -> []. Does not change its argument.
export function normalizeRanges(ranges) {
    if (!Array.isArray(ranges))
        return [];
    // difference counts per flag bit at each boundary position
    const at = new Map();
    for (const t of ranges) {
        if (!isTriple(t))
            continue;
        for (const [pos, sign] of [[t[0], 1], [t[1], -1]]) {
            let d = at.get(pos);
            if (d === undefined)
                at.set(pos, d = [0, 0, 0, 0]);
            SINGLE_FLAGS.forEach((bit, i) => {
                if (t[2] & bit)
                    d[i] += sign;
            });
        }
    }
    const out = [];
    const count = [0, 0, 0, 0];
    const positions = [...at.keys()].sort((a, b) => a - b);
    positions.forEach((pos, k) => {
        at.get(pos).forEach((v, i) => {
            count[i] += v;
        });
        if (k + 1 === positions.length)
            return;
        const flags = SINGLE_FLAGS.reduce((acc, bit, i) => (count[i] > 0 ? acc | bit : acc), 0);
        if (flags !== 0)
            pushMerged(out, pos, positions[k + 1], flags);
    });
    return out;
}

const codePointLength = text => Array.from(text).length;

// The value for extra.marks of `text` with these (tag) ranges, or null when nothing is formatted (then the key must be absent:
// the caller sets `extra.marks = null`). Ranges are normalized and cut to the text; more than MAX_RANGES keeps the first MAX_RANGES.
// `sha16(text)` is the first 16 lowercase hex of the sha256 of the UTF-8 text. Never throws; a bad input gives null (plain note).
export function encodeMarks(text, ranges, sha16) {
    try {
        if (typeof text !== 'string' || typeof sha16 !== 'function')
            return null;
        const len = codePointLength(text);
        const cut = [];
        for (const [s, e, f] of normalizeRanges(ranges)) {
            if (s < len)
                cut.push([s, Math.min(e, len), f]);
        }
        const r = normalizeRanges(cut).slice(0, MAX_RANGES);
        if (r.length === 0)
            return null;
        const h = sha16(text);
        return typeof h === 'string' && HASH_RE.test(h) ? {h, r} : null;
    } catch {
        return null;
    }
}

// The ranges of `extra.marks` for this exact `text`, or null (note shown plain) when `extra` has no marks, or the marks are
// malformed in ANY way: wrong types, a non-integer / negative / out of range / overlapping / unsorted range, flags outside 1..15,
// no range or more than MAX_RANGES, a hash that is not the hash of `text` (an old client rewrote the text). Never throws.
export function decodeMarks(text, extra, sha16) {
    try {
        if (typeof text !== 'string' || typeof sha16 !== 'function')
            return null;
        if (extra === null || typeof extra !== 'object' || Array.isArray(extra) || !Object.hasOwn(extra, 'marks'))
            return null;
        const marks = extra.marks;
        if (marks === null || typeof marks !== 'object' || Array.isArray(marks))
            return null;
        const {h, r} = marks;
        if (typeof h !== 'string' || !HASH_RE.test(h))
            return null;
        if (!Array.isArray(r) || r.length === 0 || r.length > MAX_RANGES)
            return null;
        const len = codePointLength(text);
        let prevEnd = 0;
        for (const t of r) {
            if (!isTriple(t) || t.length !== 3 || t[0] < prevEnd || t[1] > len)
                return null;
            prevEnd = t[1];
        }
        if (sha16(text) !== h)
            return null;
        return normalizeRanges(r);
    } catch {
        return null;
    }
}

// Both flagsAt and toggleFlag read the canonical form; a bad selection (not integers, start >= end, below 0) is "nothing".
const isSelection = (start, end) => isOffset(start) && isOffset(end) && end > start;

// Which flags the selection [start, end) has: `all` is the bitmask of the flags that EVERY code point of it has (a code point
// with no formatting gives 0), `any` the flags that at least one code point has. An empty or bad selection: {all: 0, any: 0}.
export function flagsAt(ranges, start, end) {
    if (!isSelection(start, end))
        return {all: 0, any: 0};
    let all = ALL_FLAGS;
    let any = 0;
    let pos = start;
    for (const [s, e, f] of normalizeRanges(ranges)) {
        if (e <= start)
            continue;
        if (s >= end)
            break;
        if (s > pos)
            all = 0;                         // a gap of unformatted text inside the selection
        all &= f;
        any |= f;
        pos = e;
    }
    if (pos < end)
        all = 0;
    return {all, any};
}

// New ranges where `flag` (1, 2, 4 or 8) is switched for the selection [start, end): when EVERY code point of the selection has
// it, it is removed from all of them, otherwise it is added to all of them. A bad selection or flag: the normalized ranges.
export function toggleFlag(ranges, start, end, flag) {
    const norm = normalizeRanges(ranges);
    if (!isSelection(start, end) || !SINGLE_FLAGS.includes(flag))
        return norm;
    const remove = (flagsAt(norm, start, end).all & flag) !== 0;
    const points = new Set([start, end]);
    for (const [s, e] of norm) {
        points.add(s);
        points.add(e);
    }
    const sorted = [...points].sort((a, b) => a - b);
    const out = [];
    let i = 0;
    for (let k = 0; k + 1 < sorted.length; k++) {
        const a = sorted[k];
        const b = sorted[k + 1];
        while (i < norm.length && norm[i][1] <= a)
            i++;
        let flags = i < norm.length && norm[i][0] <= a ? norm[i][2] : 0;
        if (a >= start && b <= end)
            flags = remove ? flags & ~flag : flags | flag;
        if (flags !== 0)
            pushMerged(out, a, b, flags);
    }
    return out;
}
