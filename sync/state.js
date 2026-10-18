// SPDX-License-Identifier: GPL-3.0-or-later
// PURE: the engine's own state file `cetli-sync-state.json` in the dedicated Syncthing home (PLAN-0.2.6 2.2). IDs and counters only: no
// names, no paths, no times. The caller reads and writes the file (mode 0600, atomic); this module parses, validates and serialises.
//
//   { "v": 1,
//     "ack":    [ID, ...],              computers the user has seen and accepted (max ACK_MAX)
//     "tomb":   [ID, ...],              removed here: never offered, never counted (max TOMB_MAX, the oldest dropped)
//     "freeze": null | { "ids": [ID, ...] }   a removal is open: the peers whose introducer flag was lowered (max FREEZE_MAX) }
//
// A missing file is a fresh state. A file that does not parse, has the wrong shape or an ID that is not canonical is NOT fresh: it reads as
// an open freeze with empty sets (fail closed: host, join and setup are refused), and `finish` repairs it (PLAN-0.2.6 F6).
import {isCanonicalId} from './ids.js';
import {READ_CAP} from './policy.js';

export const STATE_FILE = 'cetli-sync-state.json';
export const ACK_MAX = 64;
export const TOMB_MAX = 64;
export const FREEZE_MAX = READ_CAP;                 // the read cap, not 10: every peer a revoke can touch is recorded (PLAN-ADMISSION 2.4, 10)

export const freshState = () => ({v: 1, ack: [], tomb: [], freeze: null});
// What an unreadable file means: the freeze is open and nothing is known.
export const brokenState = () => ({v: 1, ack: [], tomb: [], freeze: {ids: []}, broken: true});

const idList = (v, max) => Array.isArray(v) && v.length <= max && v.every(isCanonicalId) && new Set(v).size === v.length;

// {ok: true, state} or {ok: false}. Unknown keys are refused: the file is ours.
export function parseState(text) {
    let o;
    try {
        o = JSON.parse(text);
    } catch {
        return {ok: false};
    }
    if (o === null || typeof o !== 'object' || Array.isArray(o) || o.v !== 1)
        return {ok: false};
    for (const k of Object.keys(o)) {
        if (!['v', 'ack', 'tomb', 'freeze'].includes(k))
            return {ok: false};
    }
    if (!idList(o.ack, ACK_MAX) || !idList(o.tomb, TOMB_MAX))
        return {ok: false};
    let freeze = null;
    if (o.freeze !== null) {
        if (o.freeze === undefined || typeof o.freeze !== 'object' || Array.isArray(o.freeze) || Object.keys(o.freeze).some(k => k !== 'ids') || !idList(o.freeze.ids, FREEZE_MAX))
            return {ok: false};
        freeze = {ids: [...o.freeze.ids]};
    }
    return {ok: true, state: {v: 1, ack: [...o.ack], tomb: [...o.tomb], freeze}};
}

export function serializeState(state) {
    const s = {v: 1, ack: state.ack.slice(-ACK_MAX), tomb: state.tomb.slice(-TOMB_MAX), freeze: state.freeze === null ? null : {ids: state.freeze.ids.slice(0, FREEZE_MAX)}};
    return `${JSON.stringify(s)}\n`;
}

const union = (list, ids, max) => {
    const out = list.filter(x => !ids.includes(x));
    out.push(...ids);
    return out.slice(-max);
};
export const withAck = (state, ids) => ({...state, ack: union(state.ack, ids, ACK_MAX)});
export const withTomb = (state, ids) => ({...state, tomb: union(state.tomb, ids, TOMB_MAX)});
export const withoutTomb = (state, ids) => ({...state, tomb: state.tomb.filter(x => !ids.includes(x))});
export const withFreeze = (state, ids) => ({...state, freeze: {ids: [...new Set([...(state.freeze?.ids ?? []), ...ids])].slice(0, FREEZE_MAX)}});
export const withoutFreeze = state => {
    const {broken, ...rest} = state;                  // an unreadable file that is repaired is not broken any more
    return {...rest, freeze: null};
};
export const isFrozen = state => state.freeze !== null;
