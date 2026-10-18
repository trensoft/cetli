// SPDX-License-Identifier: GPL-3.0-or-later
// PURE (no gi): what the sync window shows for what the engine says (PLAN-WIZARD 2.3, 5, 0H.2; PLAN-WIZARD-INTERFACE 3). The window maps
// codes to texts through strings.js; this file decides WHICH page, which error is neutral information, and which action an error offers.
// Nothing here knows a text, a widget or a process.
import {CODE_NO_BACKEND, INFORMATION_CODES, STATE_NO_BACKEND, isNeutralCode} from '../sync/protocol.js';
import {firstGroups} from '../sync/ids.js';
import {SHORTCUT_REMOVE} from '../sync/policy.js';

export const PAGES = Object.freeze([
    'checking', 'missing', 'consent', 'setup', 'ids', 'add', 'connecting', 'done', 'group', 'remove', 'revoking', 'revoke-result',
    'info-stfolder', 'info-foreign', 'error',
]);

// The page for a `status` result. `set-up` (no other computer yet) goes to the ID page: the waiting machine waits, the other one types.
// `half` and `paired` are one page since 0.2.6: the list of the group, each computer with its own link.
export function pageForStatus(status) {
    switch (status?.state) {
    case STATE_NO_BACKEND: return 'missing';
    case 'not-set-up': return 'consent';
    case 'stfolder-conflict': return 'info-stfolder';
    case 'foreign-config': return 'info-foreign';
    case 'set-up': return 'ids';
    case 'half':
    case 'paired': return 'group';
    default: return 'error';
    }
}

const peersOf = status => Array.isArray(status?.peers) ? status.peers : [];

// "Connected" is said of ONE computer, and only when its link is stable (ten unbroken connected samples, Interface 3). Raw `connected` is
// diagnostics, and nothing says "synced": there is no `cli` source for the other computer's completion (`up_to_date` is null).
export function isConnected(peer) {
    return peer?.link === 'stable';
}

// Which line a row shows (a key; strings.js has the text). `unmeasured`: the engine did not measure the link (a foreign entry, a group over
// the limit): the row says nothing about it.
export function linkKey(peer) {
    if (peer === null || peer === undefined || typeof peer !== 'object')
        return 'none';
    if (peer.link === null || peer.link === undefined)
        return 'unmeasured';
    if (peer.link === 'stable')
        return 'connected';
    if (peer.link === 'flapping')
        return 'unstable';
    return 'offline';
}

// The group as one summary, derived from the list alone: how many computers are in each situation. The window never says "the group is
// connected"; it shows these counts to whoever wants them.
export function groupSummary(status) {
    const sum = {total: 0, connected: 0, unstable: 0, offline: 0, unmeasured: 0};
    for (const p of peersOf(status)) {
        sum.total++;
        const k = linkKey(p);
        sum[k === 'none' ? 'unmeasured' : k]++;
    }
    return sum;
}

// ---- the list of the group -------------------------------------------------------------------------------------------------------------

// One row. `how`: how this computer came in (Nicole 3.3): `accepted` (introduced_by null), `through` (the introducer is in the list: its
// name hint and the start of its ID), `gone` (the introducer is not in the list). A name is a hint and may be null; the short ID is the
// identifier. `limited`: a removal is open and this computer is no longer taken from. `sameName`: another row has the same name.
export function peerRow(status, peer) {
    const peers = peersOf(status);
    let how;
    if (peer.introduced_by === null || peer.introduced_by === undefined) {
        how = {kind: 'accepted'};
    } else {
        const via = peers.find(p => p.id === peer.introduced_by);
        how = via === undefined ? {kind: 'gone'} : {kind: 'through', name: via.name ?? null, idStart: compareLine(via.id)};
    }
    return {
        id: peer.id,
        name: peer.name ?? null,
        compare: compareLine(peer.id),
        how,
        link: linkKey(peer),
        connected: isConnected(peer),
        limited: status?.revocation_open === true && peer.introducer === false,
        sameName: typeof peer.name === 'string' && peers.some(p => p.id !== peer.id && p.name === peer.name),
        isNew: peer.new === true,
        returned: peer.returned === true,
    };
}

export const peerRows = status => peersOf(status).map(p => peerRow(status, p));

// The direct peers whose introducer flag is off: the computers the one-time consent of 0.2.6 is about. Not offered while a removal is open
// or over the limit (the engine refuses `promote` then).
export function promoteIds(status) {
    if (!(status?.promote_pending > 0) || status.revocation_open === true || status.over_limit === true)
        return [];
    return peersOf(status).filter(p => (p.introduced_by === null || p.introduced_by === undefined) && p.introducer === false).map(p => p.id);
}

// The computers this computer removed and that are not in the list now (tombstones, newest first): the page offers "add again" for them.
export const removedIds = status => Array.isArray(status?.removed) ? status.removed : [];

// What the group page shows besides the rows. Every banner is hidden when its flag is false.
export function groupView(status) {
    const peers = peersOf(status);
    const max = Number.isInteger(status?.max_computers) ? status.max_computers : null;
    const computers = Number.isInteger(status?.computers) ? status.computers : peers.length + 1;
    const overLimit = status?.over_limit === true;
    const revocationOpen = status?.revocation_open === true;
    const newIds = peers.filter(p => p.new === true).map(p => p.id);
    const returnedIds = peers.filter(p => p.returned === true).map(p => p.id);
    const full = !overLimit && max !== null && computers >= max;
    return {
        computers,
        max,
        rows: peerRows(status),
        revocationOpen,
        overLimit,
        full,
        promoteIds: promoteIds(status),
        newIds,
        returnedIds,
        removedIds: removedIds(status),
        // the cases in which the engine refuses `host` (full, over the limit, a removal open or a removed computer back); the button says so
        // up front, the engine stays the one that decides
        addBlocked: full || overLimit || revocationOpen || returnedIds.length > 0,
    };
}

// ---- removing a computer ---------------------------------------------------------------------------------------------------------------

const listed = (status, id) => peersOf(status).find(p => p.id === id);

// The ways to remove one row. 'lost' (lost or stolen, or not known: the freeze path) is always there. 'have' ("I still have this
// computer": one deletion, no freeze) only when the policy switch is on and the row was accepted on this computer, and never for a row that
// is new or came back.
export function removePaths(status, id, shortcut = SHORTCUT_REMOVE) {
    const p = listed(status, id);
    if (p === undefined)
        return [];
    const direct = p.introduced_by === null || p.introduced_by === undefined;
    return shortcut && direct && p.new !== true && p.returned !== true ? ['have', 'lost'] : ['lost'];
}

// The rows pre-marked "not mine" when `chosenId` is removed as lost: the rows it introduced, the rows that are new, and what those
// introduced in turn (Nicole 2.4 step 3). The chosen row itself is not in the set. A row is kept only by an explicit click.
export function removeDefaults(status, chosenId) {
    const peers = peersOf(status);
    const marked = new Set([chosenId, ...peers.filter(p => p.new === true).map(p => p.id)]);
    for (let grew = true; grew;) {
        grew = false;
        for (const p of peers) {
            if (!marked.has(p.id) && marked.has(p.introduced_by)) {
                marked.add(p.id);
                grew = true;
            }
        }
    }
    marked.delete(chosenId);
    return marked;
}

// The IDs `revoke` gets: the chosen one first, then the marked rows in the order of the list. Only IDs the displayed status lists; at most
// max_computers - 1 (the engine's argument limit). `tooMany`: the choice is longer than that, nothing is sent.
export function revokeIds(status, chosenId, marked) {
    const max = Number.isInteger(status?.max_computers) ? status.max_computers - 1 : 0;
    if (listed(status, chosenId) === undefined)
        return {ids: [], tooMany: false, max};
    const chosen = new Set(marked);
    const ids = [chosenId, ...peersOf(status).filter(p => p.id !== chosenId && chosen.has(p.id)).map(p => p.id)];
    const tooMany = ids.length > max;
    return {ids: tooMany ? [] : ids, tooMany, max};
}

// The one ID `forget <ID>` gets, or null when the shortcut is not offered for that row.
export function forgetId(status, id, shortcut = SHORTCUT_REMOVE) {
    return removePaths(status, id, shortcut).includes('have') ? id : null;
}

// What a revoke result names, for the three blocks of the result page: the computers removed (the displayed name, or null), those that were
// offline (the engine's sanitised name), those that came back.
export function revokeSummary(status, result) {
    const nameOf = id => listed(status, id)?.name ?? null;
    return {
        removed: (result?.removed ?? []).map(id => ({id, name: nameOf(id)})),
        offline: (result?.offline ?? []).map(p => ({id: p.id, name: p.name ?? null})),
        returned: (result?.returned ?? []).map(id => ({id, name: nameOf(id)})),
    };
}

// What an error offers. 'edit' = the message sits under the field; 'stop' = offer "Stop syncing"; 'check' = "Check again"; 'retry' = "Try
// again"; 'none' = nothing (the foreign entry stays after a retry, so no button: Robert 8389).
const ACTIONS = Object.freeze({
    [CODE_NO_BACKEND]: 'check',
    E_NO_USER_SYSTEMD: 'none',
    E_SERVICE_TIMEOUT: 'retry',
    E_CONFIG_UNSAFE: 'none',
    E_CLI_FAILED: 'retry',
    E_STFOLDER_EXISTS: 'none',
    E_ALREADY_PAIRED: 'none',
    E_HALF_STATE_OTHER: 'stop',
    E_PEER_TIMEOUT: 'retry',
    E_EXPIRED: 'retry',
    E_PENDING_TOO_LARGE: 'none',
    E_PENDING_AMBIGUOUS: 'retry',
    E_BAD_ID: 'edit',
    E_OWN_ID: 'edit',
    E_FOREIGN_DEVICE: 'none',
    E_GROUP_FULL: 'none',
    E_REVOCATION_OPEN: 'none',
    E_BUSY: 'none',
    E_PROTOCOL: 'retry',
    E_ENGINE_DIED: 'retry',
    E_INTERNAL: 'retry',
});

export function errorView(code) {
    const known = Object.hasOwn(ACTIONS, code);
    const c = known ? code : 'E_INTERNAL';
    return {code: c, neutral: isNeutralCode(c), action: ACTIONS[c]};
}

// The ID in two rows of four groups for a monospace label, and the short line to compare (the first two groups).
export function idRows(id) {
    const g = id.split('-');
    return [g.slice(0, 4).join('-'), g.slice(4).join('-')];
}
export const compareLine = id => firstGroups(id, 2);
export const buttonGroup = id => firstGroups(id, 1);

export {INFORMATION_CODES};

// The state of the ID page as events arrive (the pure part of the wizard). Events are the validated events of the protocol.
// One candidate at a time; a new `candidate` replaces the old one; `peer` and `link` follow the accept.
export function idsReducer(state, event) {
    switch (event.event) {
    case 'candidate':
        return {...state, candidate: {id: event.id, name: event.name}};
    case 'peer':
        return {...state, peer: {id: event.id, name: event.name}, candidate: null};
    case 'link':
        return {...state, link: {state: event.state, connectedS: event.connected_s}};
    case 'progress':
        return {...state, step: event.step, stepState: event.state};
    default:
        return state;
    }
}
export const initialIdsState = Object.freeze({candidate: null, peer: null, link: null, step: null, stepState: null});
