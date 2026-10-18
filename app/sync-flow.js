// SPDX-License-Identifier: GPL-3.0-or-later
// PURE (no gi): what the sync window shows for what the engine says (PLAN-WIZARD 2.3, 5, 0H.2; PLAN-WIZARD-INTERFACE 3). The window maps
// codes to texts through strings.js; this file decides WHICH page, which error is neutral information, and which action an error offers.
// Nothing here knows a text, a widget or a process.
import {CODE_NO_BACKEND, INFORMATION_CODES, STATE_NO_BACKEND, isNeutralCode} from '../sync/protocol.js';
import {firstGroups} from '../sync/ids.js';

export const PAGES = Object.freeze([
    'checking', 'missing', 'consent', 'setup', 'ids', 'connecting', 'done', 'paired', 'half', 'info-stfolder', 'info-foreign', 'error',
]);

// The page for a `status` result. `set-up` goes to the ID page: the waiting machine waits, the other one types.
export function pageForStatus(result) {
    switch (result?.state) {
    case STATE_NO_BACKEND: return 'missing';
    case 'not-set-up': return 'consent';
    case 'stfolder-conflict': return 'info-stfolder';
    case 'foreign-config': return 'info-foreign';
    case 'set-up': return 'ids';
    case 'half': return 'half';
    case 'paired': return 'paired';
    default: return 'error';
    }
}

// "Connected" is said only for a paired state whose link is stable (ten unbroken connected samples, Interface 3). Raw `connected` is
// diagnostics, and nothing says "synced": there is no `cli` source for the other computer's completion (`up_to_date` is null).
export function isConnected(status) {
    return status?.state === 'paired' && status.link === 'stable';
}

// Which line the status page shows (a key; strings.js has the text).
export function linkKey(status) {
    if (status?.state !== 'paired')
        return 'none';
    if (status.link === null || status.link === undefined)
        return 'checking';
    if (status.link === 'stable')
        return 'connected';
    if (status.link === 'flapping')
        return 'unstable';
    return 'offline';
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
