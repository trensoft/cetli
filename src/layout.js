// SPDX-License-Identifier: GPL-3.0-or-later
// PLAN.md section 1.5 (last paragraph): the per-machine layout file `~/.local/state/cetli/layout.json`, plain data
// `{ "<id>": {"x","y","w","h","monitor","open"} }`. Local, NOT synced. The core only stores and returns it; clamping into
// the work area is the front end's job (D3). The shape of `monitor` is not fixed by the plan ("connector +
// vendor/product/serial as strings supplied by the front end"): a string, or a flat object of strings, is accepted.

import {UUID_RE} from './constants.js';

const MAX_MONITOR_STRING = 256;
const MAX_MONITOR_KEYS = 8;

const isFiniteNumber = v => typeof v === 'number' && Number.isFinite(v);
const isShortString = v => typeof v === 'string' && v.length <= MAX_MONITOR_STRING;

function cleanMonitor(m) {
    if (isShortString(m))
        return m;
    if (m !== null && typeof m === 'object' && !Array.isArray(m)) {
        const keys = Object.keys(m);
        if (keys.length > MAX_MONITOR_KEYS || !keys.every(k => isShortString(k) && isShortString(m[k])))
            return undefined;
        return Object.fromEntries(keys.map(k => [k, m[k]]));
    }
    return undefined;
}

// Returns {layout, dropped}: `layout` is a null-prototype object keyed by valid ids, `dropped` the number of entries
// that were not usable (bad id, bad member). Never throws.
export function parseLayout(text) {
    const layout = Object.create(null);
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        return {layout, dropped: 0, error: 'not JSON'};
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        return {layout, dropped: 0, error: 'not an object'};
    let dropped = 0;
    for (const id of Object.keys(parsed)) {
        const e = parsed[id];
        const monitor = e !== null && typeof e === 'object' ? cleanMonitor(e.monitor) : undefined;
        if (!UUID_RE.test(id) || e === null || typeof e !== 'object' || Array.isArray(e) ||
            !isFiniteNumber(e.x) || !isFiniteNumber(e.y) || !isFiniteNumber(e.w) || !isFiniteNumber(e.h) ||
            e.w < 0 || e.h < 0 || monitor === undefined || typeof e.open !== 'boolean') {
            dropped++;
            continue;
        }
        layout[id] = {x: e.x, y: e.y, w: e.w, h: e.h, monitor, open: e.open};
    }
    return {layout, dropped, error: null};
}

// Deterministic bytes: ids sorted, members in fixed order, one trailing newline.
export function serializeLayout(layout) {
    const {layout: clean} = parseLayout(JSON.stringify(layout));
    const out = {};
    for (const id of Object.keys(clean).sort())
        out[id] = clean[id];
    return new TextEncoder().encode(`${JSON.stringify(out)}\n`);
}
