// SPDX-License-Identifier: GPL-3.0-or-later
// Pure helpers of the cetli extension: which window is a cetli note, and where it may sit. No GNOME imports on
// purpose: the same file is unit-tested with node (tests/).

import {UUID_RE} from './constants.js';

export const APP_ID = 'io.github.trensoft.cetli';

// The GTK app sets the title of a note window to `cetli-<uuid>`; the uuid is the key of layout.json.
const TITLE_RE = new RegExp(`^cetli-(${UUID_RE.source.slice(1, -1)})$`);

export function idFromTitle(title) {
    if (typeof title !== 'string')
        return null;
    const m = TITLE_RE.exec(title);
    return m === null ? null : m[1];
}

// Stored in the `monitor` member of layout.json: the geometry of the monitor the window was on.
export const monitorKey = m => `${m.width}x${m.height}+${m.x}+${m.y}`;

export const roundRect = r => ({x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h)});

export function sameRect(a, b, tolerance = 0) {
    return a !== null && b !== null && ['x', 'y', 'w', 'h'].every(k => Math.abs(a[k] - b[k]) <= tolerance);
}

function overlap(r, a) {
    const w = Math.min(r.x + r.w, a.x + a.w) - Math.max(r.x, a.x);
    const h = Math.min(r.y + r.h, a.y + a.h) - Math.max(r.y, a.y);
    return w > 0 && h > 0 ? w * h : 0;
}

/**
 * The work area a rectangle belongs to: the monitor named by `monitor` if it is still there, else the one with
 * the largest overlap, else the primary one.
 *
 * @param {{x:number,y:number,w:number,h:number,monitor?:*}} rect
 * @param {{key:string,x:number,y:number,w:number,h:number}[]} areas - work areas, one per monitor
 * @param {number} primary - index of the primary monitor in `areas`
 * @returns {object|null} - null only when there is no monitor
 */
export function chooseArea(rect, areas, primary) {
    if (areas.length === 0)
        return null;
    if (typeof rect.monitor === 'string') {
        const named = areas.find(a => a.key === rect.monitor);
        if (named)
            return named;
    }
    let best = null;
    let bestOverlap = 0;
    for (const a of areas) {
        const o = overlap(rect, a);
        if (o > bestOverlap) {
            best = a;
            bestOverlap = o;
        }
    }
    return best ?? areas[primary] ?? areas[0];
}

// D3: a window that sticks out (or sits on a monitor that is gone) is moved into the work area; one that is too
// big is made as big as the work area.
export function clampRect(rect, area) {
    const r = roundRect(rect);
    const w = Math.min(r.w, area.w);
    const h = Math.min(r.h, area.h);
    return {
        x: Math.min(Math.max(r.x, area.x), area.x + area.w - w),
        y: Math.min(Math.max(r.y, area.y), area.y + area.h - h),
        w,
        h,
    };
}
