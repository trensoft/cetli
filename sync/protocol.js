// SPDX-License-Identifier: GPL-3.0-or-later
// PURE: the wire contract between the engine (`cetli-sync`) and the window's bridge (PLAN-WIZARD-INTERFACE 2, 2a, 3). One JSON object per
// line on stdout, `{"v":1,"event":"<name>", ...}`. Both sides use THIS file: the engine to write (emit), the bridge to read (parse and
// the run checker), and the contract fixtures in sync-tests/contract/ are replayed against it on both sides.
//
// Reader rules (section 3): unknown fields are ignored, unknown `progress.step` values are ignored by the window, an unknown error
// `code` is read as the generic E_INTERNAL, `v` other than 1 is refused. Anything else that does not fit is a protocol violation: parse
// returns null and the bridge raises E_PROTOCOL and kills the process. The engine's own text never reaches the window: only codes.
//
// Today's variant is the ID exchange with one button (2a). The code form (events `code` and `attempts`, errors E_BAD_CODE / E_OWN_CODE)
// stays RESERVED here and is neither emitted nor accepted.
//
// 0.2.6 (PLAN-0.2.6 3): a group of up to MAX_COMPUTERS computers. `status` carries a list of peers instead of one; the verbs revoke, finish,
// harden, promote and ack are new; `forget` takes one ID or `--all`; two new information codes. All of it is additive in v 1.

import {displayName, isCanonicalId, ID_RAW_MAX} from './ids.js';
import {MAX_COMPUTERS, MAX_PEERS} from './policy.js';

export const PROTOCOL_VERSION = 1;
export const MAX_LINE_BYTES = 4 * 1024;
export const MAX_TOTAL_BYTES = 64 * 1024;

export const EXIT_RESULT = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

export const VERBS = Object.freeze(['status', 'setup', 'own-id', 'host', 'join', 'forget', 'revoke', 'finish', 'harden', 'promote', 'ack']);
// The verbs that take computer IDs as arguments (`forget` also takes `--all`, `ack` also `--all`).
export const ID_VERBS = Object.freeze(['forget', 'revoke', 'promote', 'ack']);
export const PROGRESS_STEPS = Object.freeze(['instance', 'folder', 'service', 'device', 'share', 'connect', 'sync', 'freeze', 'remove', 'verify', 'dwell']);
export const PROGRESS_STATES = Object.freeze(['start', 'ok']);
export const STATUS_STATES = Object.freeze(['no-syncthing', 'not-set-up', 'stfolder-conflict', 'foreign-config', 'set-up', 'half', 'paired']);
export const LISTENER_STATES = Object.freeze(['ok', 'degraded', 'down']);
export const LINK_STATES = Object.freeze(['none', 'flapping', 'stable']);
// The two wire strings that name the sync program. The window (app/) is not allowed to contain that word in code (static test), so it
// refers to them through these identifiers.
export const STATE_NO_BACKEND = 'no-syncthing';
export const CODE_NO_BACKEND = 'E_NO_SYNCTHING';

// The closed list of error codes (section 3). Information codes are shown neutral by the window: rc 1 and the closed list stay.
export const ERROR_CODES = Object.freeze([
    'E_NO_SYNCTHING', 'E_NO_USER_SYSTEMD', 'E_SERVICE_TIMEOUT', 'E_CONFIG_UNSAFE', 'E_CLI_FAILED',
    'E_STFOLDER_EXISTS', 'E_ALREADY_PAIRED', 'E_HALF_STATE_OTHER', 'E_PEER_TIMEOUT', 'E_EXPIRED',
    'E_PENDING_TOO_LARGE', 'E_PENDING_AMBIGUOUS', 'E_BAD_ID', 'E_OWN_ID', 'E_FOREIGN_DEVICE',
    'E_BUSY', 'E_PROTOCOL', 'E_ENGINE_DIED', 'E_INTERNAL', 'E_GROUP_FULL', 'E_REVOCATION_OPEN',
]);
export const INFORMATION_CODES = Object.freeze(['E_STFOLDER_EXISTS', 'E_ALREADY_PAIRED', 'E_GROUP_FULL', 'E_REVOCATION_OPEN']);
// Reserved for 0.2.6 (the code form; E_NOT_UP_TO_DATE needs a `cli` source for the other computer's completion): in the Interface file's
// closed list, but not emitted today and not accepted on the wire.
export const RESERVED_CODES = Object.freeze(['E_BAD_CODE', 'E_OWN_CODE', 'E_NOT_UP_TO_DATE']);
// Raised by the bridge, never by the engine: an engine line that carries one is a violation.
export const BRIDGE_ONLY_CODES = Object.freeze(['E_BUSY', 'E_PROTOCOL', 'E_ENGINE_DIED']);
export const GENERIC_CODE = 'E_INTERNAL';

// Which verbs may raise a code, where the Interface file fixes it. A code not listed here may come from any verb.
const CODE_SCOPE = Object.freeze({
    E_BAD_ID: ['join', 'forget', 'revoke', 'promote', 'ack'],
    E_OWN_ID: ['join'],
    E_GROUP_FULL: ['host', 'setup'],                          // the group is at (or over) the limit; `status` reports it as over_limit
    E_REVOCATION_OPEN: ['host', 'join', 'setup', 'promote'],  // a removal is not finished on this computer; `status` reports revocation_open
    E_PENDING_TOO_LARGE: ['host'],
    E_PENDING_AMBIGUOUS: ['host'],
    E_EXPIRED: ['host'],
    E_PEER_TIMEOUT: ['host', 'join'],
    E_FOREIGN_DEVICE: ['setup', 'host', 'join', 'promote'],  // `status` reports the state foreign-config instead; own-id, forget, revoke, finish, harden and ack still run
});

export const isNeutralCode = code => INFORMATION_CODES.includes(code);
export const isKnownStep = step => PROGRESS_STEPS.includes(step);

export class ProtocolError extends Error {
    constructor(what) {
        super(`protocol: ${what}`);
        this.name = 'ProtocolError';
    }
}

// ---- field checks -----------------------------------------------------------------------------------------------------------------

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isBool = v => typeof v === 'boolean';
const boolOrNull = v => v === null || isBool(v);
const isCount = v => Number.isInteger(v) && v >= 0 && v <= 1e9;
const idOrNull = v => v === null || isCanonicalId(v);
// A name is already reduced by the engine (ids.js displayName): null, or 1-32 printable ASCII characters. Nothing else crosses.
const isName = v => v === null || (typeof v === 'string' && v.length > 0 && v.length <= 32 && displayName(v) === v);
const isPeer = v => isObj(v) && isCanonicalId(v.id) && isName(v.name);

const isIdList = (v, max) => Array.isArray(v) && v.length <= max && v.every(isCanonicalId) && new Set(v).size === v.length;
const isSmall = v => Number.isInteger(v) && v >= 0 && v <= 99;

// One computer of the group, as `status` lists it (PLAN-0.2.6 3.2). `connected`, `link` and `connected_s` are null together when the link
// was not measured (foreign-config, over-limit); otherwise `link` is a state, `connected` a boolean and `connected_s` follows the link.
const isGroupPeer = p => isObj(p) && isCanonicalId(p.id) && isName(p.name) && idOrNull(p.introduced_by) && isBool(p.introducer) && isBool(p.shared) &&
    isBool(p.new) && isBool(p.returned) && boolOrNull(p.connected) && (p.link === null || LINK_STATES.includes(p.link)) &&
    (p.link === null ? p.connected === null && p.connected_s === null : p.connected !== null && connectedSOk(p));

const RESULT_SCHEMAS = {
    status: r => STATUS_STATES.includes(r.state) && idOrNull(r.own_id) && Array.isArray(r.peers) && r.peers.length <= MAX_COMPUTERS && r.peers.every(isGroupPeer) &&
        (r.computers === null || (Number.isInteger(r.computers) && r.computers >= 1 && r.computers <= 1e6)) && isSmall(r.max_computers) && r.max_computers >= 2 &&
        isBool(r.over_limit) && isBool(r.revocation_open) && isSmall(r.harden_pending) && isSmall(r.promote_pending) &&
        (r.listener === null || LISTENER_STATES.includes(r.listener)) && r.up_to_date === null &&
        (r.notes === null || isCount(r.notes)) && isBool(r.waiting) && statusRules(r),
    setup: r => isCanonicalId(r.own_id) && r.state === 'set-up',
    'own-id': r => isCanonicalId(r.own_id),
    host: r => isPeer(r.peer) && isBool(r.connected) && connectedResult(r) && (r.notes === null || isCount(r.notes)),
    join: r => isPeer(r.peer) && isCanonicalId(r.own_id) && isBool(r.connected) && connectedResult(r) && (r.notes === null || isCount(r.notes)),
    forget: r => (r.state === 'set-up' || r.state === null) && isSmall(r.remaining) && (r.state === 'set-up') === (r.remaining === 0),
    revoke: r => isIdList(r.removed, MAX_PEERS) && isIdList(r.returned, MAX_PEERS) && Array.isArray(r.offline) && r.offline.length <= MAX_COMPUTERS && r.offline.every(isPeer) &&
        isSmall(r.remaining) && r.revocation_open === true,
    finish: r => r.revocation_open === false,
    harden: r => isSmall(r.changed),
    promote: r => isSmall(r.changed),
    ack: r => isSmall(r.changed),
};
const RESULT_KEYS = {
    status: ['state', 'own_id', 'peers', 'computers', 'max_computers', 'over_limit', 'revocation_open', 'harden_pending', 'promote_pending', 'listener', 'up_to_date', 'notes', 'waiting'],
    setup: ['own_id', 'state'],
    'own-id': ['own_id'],
    host: ['peer', 'connected', 'link', 'connected_s', 'up_to_date', 'notes'],
    join: ['peer', 'own_id', 'connected', 'link', 'connected_s', 'up_to_date', 'notes'],
    forget: ['state', 'remaining'],
    revoke: ['removed', 'returned', 'offline', 'remaining', 'revocation_open'],
    finish: ['revocation_open'],
    harden: ['changed'],
    promote: ['changed'],
    ack: ['changed'],
};

// `connected_s` is a count of whole seconds exactly when the link is stable, otherwise null (section 3, `link`).
const connectedSOk = o => (o.link === 'stable') === (o.connected_s !== null && o.connected_s !== undefined) && (o.connected_s === null || isCount(o.connected_s));

// `result` of host and join is already the proof the engine can give: link stable, and nothing about the notes (`up_to_date` is null in
// 0.2.5, there is no `cli` source for it).
const connectedResult = r => r.link === 'stable' && connectedSOk(r) && r.up_to_date === null;

// The list of `status` against its state. set-up = no peer, half = peers and none shared, paired = at least one shared; foreign-config also
// carries the peers (the window offers Remove) but no link and no listener. over_limit: the links are not measured. A list of more than
// READ_CAP devices is not read: peers is empty and the state is `half` (peers exist, nothing is known about the share).
function statusRules(r) {
    const noLink = r.peers.every(p => p.link === null);
    if (r.state === 'foreign-config')
        return noLink && r.listener === null;
    if (r.state === 'set-up')
        return r.peers.length === 0 && !r.over_limit;
    if (r.state === 'half' || r.state === 'paired') {
        if (r.over_limit)
            return noLink;                                  // the list may be cut, the state is the one of the whole list
        const anyShared = r.peers.some(p => p.shared);
        return r.peers.length > 0 && (r.state === 'paired') === anyShared;
    }
    return r.peers.length === 0 && r.listener === null && !r.over_limit && !r.revocation_open && r.harden_pending === 0 && r.promote_pending === 0;
}

const has = (o, keys) => keys.every(k => Object.hasOwn(o, k));

// The fields of one event (without v/event), or false. The same table checks emit and parse.
function fieldsOk(event, verb) {
    switch (event.event) {
    case 'progress':
        return typeof event.step === 'string' && PROGRESS_STATES.includes(event.state);
    case 'candidate':
        return isCanonicalId(event.id) && isName(event.name) && Object.hasOwn(event, 'name');
    case 'link':
        return LINK_STATES.includes(event.state) && Object.hasOwn(event, 'connected_s') && connectedSOk({link: event.state, connected_s: event.connected_s});
    case 'peer':
        return isCanonicalId(event.id) && isName(event.name) && Object.hasOwn(event, 'name');
    case 'error':
        return typeof event.code === 'string' && (event.step === undefined || typeof event.step === 'string');
    case 'result': {
        if (verb === null)
            return true;                                   // the shape is checked once the verb is known
        const keys = RESULT_KEYS[verb];
        return keys !== undefined && has(event, keys) && RESULT_SCHEMAS[verb](event);
    }
    default:
        return false;
    }
}

export const EVENT_NAMES = Object.freeze(['progress', 'candidate', 'link', 'peer', 'result', 'error']);

// The keys an event may carry besides `event` (and `v` on the wire). A result without a known verb carries none.
const EVENT_KEYS = {
    progress: ['step', 'state'], candidate: ['id', 'name'], link: ['state', 'connected_s'], peer: ['id', 'name'], error: ['code', 'step'],
};
const eventKeys = (name, verb) => name === 'result' ? (verb === null ? [] : RESULT_KEYS[verb] ?? []) : EVENT_KEYS[name];

// ---- emit (engine side) -----------------------------------------------------------------------------------------------------------

// The line for an event, without the newline. Strict: an unknown event or field, a reserved or bridge-only code, a value out of shape
// is a bug of the engine and throws. `verb` is needed for a `result` and for an `error` (its per-verb code rules).
export function emit(event, verb = null) {
    if (!isObj(event) || !EVENT_NAMES.includes(event.event))
        throw new ProtocolError('unknown event');
    if ((event.event === 'result' || event.event === 'error') && (verb === null || !VERBS.includes(verb)))
        throw new ProtocolError(`${event.event === 'result' ? 'a result' : 'an error'} needs its verb`);
    const allowed = eventKeys(event.event, verb);
    for (const k of Object.keys(event)) {
        if (k !== 'event' && !allowed.includes(k))
            throw new ProtocolError(`field ${k} is not part of ${event.event}`);
    }
    if (!fieldsOk(event, verb))
        throw new ProtocolError(`${event.event} does not fit the contract`);
    if (event.event === 'progress' && !isKnownStep(event.step))
        throw new ProtocolError('unknown progress step');
    if (event.event === 'error') {
        if (!ERROR_CODES.includes(event.code) || BRIDGE_ONLY_CODES.includes(event.code))
            throw new ProtocolError('error code is not one the engine may raise');
        if (verb !== null && CODE_SCOPE[event.code] && !CODE_SCOPE[event.code].includes(verb))
            throw new ProtocolError(`${event.code} is not raised by ${verb}`);
        if (event.step !== undefined && !isKnownStep(event.step))
            throw new ProtocolError('unknown step on an error');
    }
    const line = JSON.stringify({v: PROTOCOL_VERSION, ...event});
    if (new TextEncoder().encode(line).length > MAX_LINE_BYTES)
        throw new ProtocolError('line too long');
    return line;
}

// ---- parse (bridge side) ----------------------------------------------------------------------------------------------------------

// The event of a line, or null (not JSON, not an object, too long, v != 1, an event or a field out of shape). An unknown error code is
// read as E_INTERNAL; an unknown progress step is returned as it is and ignored by the caller (isKnownStep). `verb` selects the
// schema of a `result`; without it a result is only checked to be an object.
export function parse(line, verb = null) {
    if (typeof line !== 'string' || new TextEncoder().encode(line).length > MAX_LINE_BYTES)
        return null;
    let obj;
    try {
        obj = JSON.parse(line);
    } catch (e) {
        return null;
    }
    if (!isObj(obj) || obj.v !== PROTOCOL_VERSION || !EVENT_NAMES.includes(obj.event))
        return null;
    if (!fieldsOk(obj, verb))
        return null;
    // only the keys of the contract go on (fieldsOk does not look at the others); an unknown step is null
    const event = {event: obj.event};
    for (const k of eventKeys(obj.event, verb))
        if (Object.hasOwn(obj, k))
            event[k] = k === 'step' && !isKnownStep(obj[k]) ? null : obj[k];
    if (event.event === 'error') {
        if (BRIDGE_ONLY_CODES.includes(event.code))
            return null;
        if (!ERROR_CODES.includes(event.code))
            return {...event, code: GENERIC_CODE};
        if (verb !== null && CODE_SCOPE[event.code] && !CODE_SCOPE[event.code].includes(verb))
            return null;
    }
    return event;
}

// ---- one run (bridge side, and the fixture replay) -------------------------------------------------------------------------------

// A state machine for the lines of ONE process run. `feed(line)` for each stdout line; `finish(rc)` when the process has ended.
// feed returns {ok: true, event} or {ok: false, code: 'E_PROTOCOL'} (the bridge kills the process). finish returns
// {ok: true, outcome: {kind: 'result'|'error', ...}} or {ok: false, code}, where a missing terminal line or a code other than 0/1 is
// E_ENGINE_DIED and a line that broke a rule is E_PROTOCOL.
const VERB_EVENTS = {
    status: [], setup: [], 'own-id': [], forget: [], revoke: [], finish: [], harden: [], promote: [], ack: [],
    host: ['candidate', 'link', 'peer'],
    join: ['link', 'peer'],
};

export function createRunChecker(verb) {
    if (!VERBS.includes(verb))
        throw new ProtocolError('unknown verb');
    let total = 0;
    let terminal = null;
    let broken = false;
    const violate = () => {
        broken = true;
        return {ok: false, code: 'E_PROTOCOL'};
    };
    return {
        feed(line) {
            if (broken || terminal !== null)
                return violate();                          // nothing after the terminal line
            total += new TextEncoder().encode(line).length + 1;
            if (total > MAX_TOTAL_BYTES)
                return violate();
            const event = parse(line, verb);
            if (event === null)
                return violate();
            if (event.event !== 'progress' && event.event !== 'result' && event.event !== 'error' && !VERB_EVENTS[verb].includes(event.event))
                return violate();
            if (event.event === 'result' || event.event === 'error')
                terminal = event;
            return {ok: true, event};
        },
        finish(rc) {
            if (broken)
                return {ok: false, code: 'E_PROTOCOL'};
            if (rc === EXIT_USAGE)
                return {ok: false, code: 'E_ENGINE_DIED', usage: true};
            if (terminal === null || (rc !== EXIT_RESULT && rc !== EXIT_ERROR))
                return {ok: false, code: 'E_ENGINE_DIED'};
            if ((terminal.event === 'result') !== (rc === EXIT_RESULT))
                return {ok: false, code: 'E_ENGINE_DIED'};
            return terminal.event === 'result' ? {ok: true, outcome: {kind: 'result', result: terminal}} :
                {ok: true, outcome: {kind: 'error', code: terminal.code, step: terminal.step ?? null}};
        },
    };
}

// All lines of a finished run at once (the fixture replay and the tests).
export function checkRun(verb, lines, rc) {
    const checker = createRunChecker(verb);
    const events = [];
    for (const line of lines) {
        const r = checker.feed(line);
        if (!r.ok)
            return {ok: false, code: r.code, events};
        events.push(r.event);
    }
    const end = checker.finish(rc);
    return end.ok ? {ok: true, events, outcome: end.outcome} : {ok: false, code: end.code, ...(end.usage ? {usage: true} : {}), events};
}

// ---- argv and stdin (what the window may ask for) ---------------------------------------------------------------------------------

// The closed argv of every call: no free-form argument. Nothing the user typed is an argument (the typed ID goes through stdin). The
// computer IDs of 0.2.6 are positional arguments: IDs are not secret (they are on the screen), every one must be canonical (so none can
// look like a flag), at most MAX_PEERS, no duplicates.
//   forget <ID> | forget --all [--stop]     revoke <ID>...     promote <ID>...     ack <ID>... | ack --all
//   status, setup, own-id, host, join, finish, harden: no argument
// `flags`: {all, stop}; `ids`: array of canonical IDs.
export function argvFor(verb, flags = {}, ids = []) {
    if (!VERBS.includes(verb))
        throw new ProtocolError('unknown verb');
    const known = verb === 'forget' ? ['all', 'stop'] : verb === 'ack' ? ['all'] : [];
    for (const k of Object.keys(flags)) {
        if (!known.includes(k) || typeof flags[k] !== 'boolean')
            throw new ProtocolError('unknown flag');
    }
    if (!Array.isArray(ids) || ids.length > MAX_PEERS || new Set(ids).size !== ids.length || !ids.every(isCanonicalId))
        throw new ProtocolError('bad ID argument');
    const all = flags.all === true;
    const stop = flags.stop === true;
    if (!ID_VERBS.includes(verb)) {
        if (ids.length > 0)
            throw new ProtocolError('this verb takes no ID');
        return [verb];
    }
    if (all && ids.length > 0)
        throw new ProtocolError('--all and IDs exclude each other');
    if (stop && !all)
        throw new ProtocolError('--stop needs --all');
    if (verb === 'forget')
        return all ? [verb, '--all', ...(stop ? ['--stop'] : [])] : ids.length === 1 ? [verb, ids[0]] : fail('forget takes one ID or --all');
    if (verb === 'ack')
        return all ? [verb, '--all'] : ids.length >= 1 ? [verb, ...ids] : fail('ack takes IDs or --all');
    if (ids.length === 0)
        throw new ProtocolError(`${verb} takes at least one ID`);
    return [verb, ...ids];
}
function fail(what) {
    throw new ProtocolError(what);
}

// The engine's reading of its own command line (the reverse of argvFor): {verb, flags, ids}, or throws ProtocolError.
export function parseArgs(args) {
    if (!Array.isArray(args) || args.length === 0 || typeof args[0] !== 'string')
        throw new ProtocolError('no verb');
    const [verb, ...rest] = args;
    const flags = {};
    const ids = [];
    for (const a of rest) {
        if (a === '--all' || a === '--stop') {
            const k = a.slice(2);
            if (Object.hasOwn(flags, k))
                throw new ProtocolError('flag twice');
            flags[k] = true;
        } else {
            ids.push(a);                                    // checked as an ID by argvFor
        }
    }
    argvFor(verb, flags, ids);
    return {verb, flags, ids};
}

// `join` reads ONE line: the typed ID, as typed. The window does not canonicalise; it only refuses what cannot be one line.
export function joinStdin(typed) {
    if (typeof typed !== 'string' || typed.length > ID_RAW_MAX + 2)          // the field is capped before any work; two for the line end
        return null;
    let end = typed.length;
    while (end > 0 && (typed[end - 1] === '\r' || typed[end - 1] === '\n'))
        end--;
    const line = typed.slice(0, end);
    return /[\r\n\0]/.test(line) ? null : `${line}\n`;
}

// `host` may be sent ONE line `accept <ID>`.
export function acceptLine(id) {
    if (!isCanonicalId(id))
        throw new ProtocolError('accept needs a canonical ID');
    return `accept ${id}\n`;
}

// The engine's reading of a stdin line of `host`: the ID of an accept, or null (every other line is ignored).
export function parseAcceptLine(line) {
    if (typeof line !== 'string')
        return null;
    const m = /^accept ([^ \r\n]+)\r?\n?$/.exec(line);
    return m !== null && isCanonicalId(m[1]) ? m[1] : null;
}
