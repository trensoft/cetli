// SPDX-License-Identifier: GPL-3.0-or-later
// PLAN.md section 1 (format, validation V1-V11, canonical form, version identity) and the pure parts of section 2
// (order, copy id, expected copy). No file access, no Gio, no GLib: the two hash functions are injected.

import {
    CID_NAMESPACE, DEVICE_RE, FUTURE_TOLERANCE_MS, KNOWN_KEYS, MAX_FILE_BYTES, MAX_REV, MAX_TEXT_BYTES,
    MAX_UNKNOWN_DEPTH, MAX_UNKNOWN_KEYS, PLACEHOLDER_UUID, SCHEMA, ST, UNKNOWN_KEY_RE, UPDATED_RE, UUID_RE,
    YEAR_MAX, YEAR_MIN,
} from './constants.js';

const KNOWN = new Set(KNOWN_KEYS);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
// ignoreBOM: true keeps a BOM in the string, so JSON.parse rejects it (the file is UNKNOWN, not silently repaired).
const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
const encoder = new TextEncoder();

export const utf8Len = s => encoder.encode(s).length;
export const isoOf = ms => new Date(ms).toISOString();

const unknown = reason => ({state: ST.UNKNOWN, reason});

// V1, the part that is decided from the directory entry BEFORE the file is opened.
export function entryProblem(type, size) {
    if (type !== 'regular')
        return `not a regular file (${type})`;
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES)
        return `size ${size} over ${MAX_FILE_BYTES}`;
    return null;
}

// V6: "real dates", year 2000 to 2100. Returns the instant in ms, or null.
export function parseUpdated(s) {
    if (typeof s !== 'string' || !UPDATED_RE.test(s))
        return null;
    const year = Number(s.slice(0, 4));
    if (year < YEAR_MIN || year > YEAR_MAX)
        return null;
    const ms = Date.parse(s);
    if (!Number.isFinite(ms) || new Date(ms).toISOString() !== s)
        return null;
    return ms;
}

// V10: iterative walk with an explicit stack; a recursive check overflows on the input it has to reject.
function depthWithinLimit(value) {
    if (typeof value !== 'object' || value === null)
        return true;
    const stack = [[value, 1]];
    while (stack.length > 0) {
        const [node, depth] = stack.pop();
        if (depth > MAX_UNKNOWN_DEPTH)
            return false;
        const children = Array.isArray(node) ? node : Object.keys(node).map(k => node[k]);
        for (const child of children) {
            if (typeof child === 'object' && child !== null)
                stack.push([child, depth + 1]);
        }
    }
    return true;
}

export function makeFormat({sha256Hex, sha1}) {
    // canon(record) section 1.3: fixed order, then unknown keys by code point, then one "\n". Built by concatenation
    // key by key, never by JSON.stringify of an object assembled from unknown keys (V10).
    function canonString(rec) {
        const parts = [];
        for (const k of KNOWN_KEYS)
            parts.push(`${JSON.stringify(k)}:${JSON.stringify(rec[k])}`);
        for (const k of [...rec.extra.keys()].sort())
            parts.push(`${JSON.stringify(k)}:${JSON.stringify(rec.extra.get(k))}`);
        return `{${parts.join(',')}}\n`;
    }

    // Fills the derived members: canon (string), bytes (Uint8Array) and v (hex sha256 of the bytes).
    function finalize(rec) {
        rec.canon = canonString(rec);
        rec.bytes = encoder.encode(rec.canon);
        rec.v = sha256Hex(rec.bytes);
        return rec;
    }

    // Section 1.1 V11: the size of the form that a copy would have.
    function canonESize(rec) {
        const probe = rec.conflict_of === null ? {...rec, conflict_of: PLACEHOLDER_UUID} : rec;
        return utf8Len(canonString(probe));
    }

    function makeRecord(fields, extra = new Map()) {
        return finalize({
            schema: SCHEMA, id: fields.id, rev: fields.rev, updated: fields.updated, created: fields.created,
            device: fields.device, color: fields.color, text: fields.text, deleted: fields.deleted,
            conflict_of: fields.conflict_of, extra: new Map(extra),
        });
    }

    // Does a record that was built locally (a save, a copy) fit V11? Same arithmetic as the read side.
    const fitsV11 = rec => canonESize(rec) <= MAX_FILE_BYTES;

    // Validates the CONTENT of one file (V2 to V11). `leadingUuid` is the UUID of the file name (V4), `nowMs` the local
    // clock at read time (V6). Never throws. Result: {state, reason, rec?, until?, shownText?}.
    function classify(bytes, leadingUuid, nowMs) {
        try {
            return classifyInner(bytes, leadingUuid, nowMs);
        } catch (e) {
            // "ANY exception ... makes the record UNKNOWN" (1.3).
            return unknown(`exception: ${e?.name ?? 'Error'}`);
        }
    }

    function classifyInner(bytes, leadingUuid, nowMs) {
        if (bytes.length > MAX_FILE_BYTES)
            return unknown(`V1 size ${bytes.length}`);
        let parsed;
        try {
            parsed = JSON.parse(decoder.decode(bytes));
        } catch {
            return unknown('V2 not UTF-8 JSON');
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
            return unknown('V2 not an object');

        const get = k => (hasOwn(parsed, k) ? parsed[k] : undefined);

        // V3
        const schema = get('schema');
        if (Number.isInteger(schema) && schema > SCHEMA) {
            const t = get('text');
            return {
                state: ST.NEWER, reason: `V3 schema ${schema}`,
                shownText: typeof t === 'string' && utf8Len(t) <= MAX_TEXT_BYTES ? t : null,
            };
        }
        if (schema !== SCHEMA)
            return unknown('V3 schema');

        // V4
        const id = get('id');
        if (typeof id !== 'string' || !UUID_RE.test(id) || id !== leadingUuid)
            return unknown('V4 id');
        // V5
        const rev = get('rev');
        if (!Number.isInteger(rev) || rev < 1 || rev > MAX_REV)
            return unknown('V5 rev');
        // V6 (the 24 h quarantine is decided last, after every other rule)
        const updatedMs = parseUpdated(get('updated'));
        const createdMs = parseUpdated(get('created'));
        if (updatedMs === null || createdMs === null)
            return unknown('V6 date');
        // V7
        const device = get('device');
        if (typeof device !== 'string' || !DEVICE_RE.test(device))
            return unknown('V7 device');
        // V8
        const color = get('color');
        if (typeof color !== 'string')
            return unknown('V8 color');
        // V9
        const text = get('text');
        if (typeof text !== 'string' || utf8Len(text) > MAX_TEXT_BYTES)
            return unknown('V9 text');
        const deleted = get('deleted');
        if (typeof deleted !== 'boolean')
            return unknown('V9 deleted');
        const conflictOf = get('conflict_of');
        if (conflictOf !== null && !(typeof conflictOf === 'string' && UUID_RE.test(conflictOf)))
            return unknown('V9 conflict_of');
        // V10
        const extra = new Map();
        for (const k of Object.keys(parsed)) {
            if (KNOWN.has(k))
                continue;
            if (extra.size >= MAX_UNKNOWN_KEYS)
                return unknown('V10 too many keys');
            if (!UNKNOWN_KEY_RE.test(k))
                return unknown('V10 key pattern');
            const value = parsed[k];
            if (!depthWithinLimit(value))
                return unknown('V10 depth');
            extra.set(k, value);
        }

        const rec = finalize({
            schema: SCHEMA, id, rev, updated: get('updated'), created: get('created'), device, color, text, deleted,
            conflict_of: conflictOf, extra,
        });
        // V11
        if (canonESize(rec) > MAX_FILE_BYTES)
            return unknown('V11 canonical form too large');

        // V6, quarantine: not applied now, looked at again later.
        if (updatedMs > nowMs + FUTURE_TOLERANCE_MS)
            return {state: ST.QUARANTINED, reason: 'V6 updated in the future', rec, until: updatedMs - FUTURE_TOLERANCE_MS};
        return {state: ST.VALID, rec};
    }

    // Section 2.1: total order on distinct versions, uses only the record.
    function compare(a, b) {
        const ua = Date.parse(a.updated);
        const ub = Date.parse(b.updated);
        if (ua !== ub)
            return ua < ub ? -1 : 1;
        if (a.rev !== b.rev)
            return a.rev < b.rev ? -1 : 1;
        if (a.device !== b.device)
            return a.device < b.device ? -1 : 1;
        if (a.v !== b.v)
            return a.v < b.v ? -1 : 1;
        return 0;
    }

    const nsBytes = (() => {
        const hex = CID_NAMESPACE.replaceAll('-', '');
        return Uint8Array.from({length: 16}, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
    })();

    // Section 2.2 step 2: a name-based UUID (version 5 layout) built by hand.
    function cid(x, vHex) {
        const name = encoder.encode(`${x}\n${vHex}`);
        const input = new Uint8Array(nsBytes.length + name.length);
        input.set(nsBytes, 0);
        input.set(name, nsBytes.length);
        const h = Uint8Array.from(sha1(input).subarray(0, 16));
        h[6] = (h[6] & 0x0f) | 0x50;
        h[8] = (h[8] & 0x3f) | 0x80;
        const hex = Array.from(h, b => b.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    // Section 2.2 step 1: E(L), equal to L in every field except id = cid(L) and conflict_of = X.
    function expectedCopy(loser, x) {
        return makeRecord({...loser, id: cid(x, loser.v), conflict_of: x}, loser.extra);
    }

    return {classify, canonString, canonESize, makeRecord, fitsV11, finalize, compare, cid, expectedCopy};
}
