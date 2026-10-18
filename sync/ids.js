// SPDX-License-Identifier: GPL-3.0-or-later
// PURE: the device ID of a Syncthing instance as the wizard handles it (PLAN-WIZARD 7.1, 0H.1, 0H.4 step 1). No Gio, no ports, no
// clock: strings in, strings out. The engine canonicalises every ID itself (upper case, 8x7 groups) before any comparison or any
// argv; the window never does (PLAN-WIZARD-INTERFACE 2a). Raw user text and raw `cli` text are never compared.

export const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const ID_RAW_MAX = 100;                 // the field is capped before any work (PLAN-WIZARD 7.1 step 4)
export const NAME_RAW_MAX = 96;                // the abuse gate of a pending name, measured on the raw string (0H.1)
export const NAME_SHOWN_MAX = 32;

// The two codes of a typed ID. `E_BAD_CODE` / `E_OWN_CODE` are reserved for 0.2.6 and are not produced anywhere (0H.3).
export const E_BAD_ID = 'E_BAD_ID';
export const E_OWN_ID = 'E_OWN_ID';

const CANON_RE = /^[A-Z2-7]{7}(-[A-Z2-7]{7}){7}$/;      // no m flag: a trailing newline does not match
const COMPACT_RE = /^[A-Z2-7]{56}$/;
const PRINTABLE_ASCII_RE = /^[\x20-\x7E]*$/;           // no m flag

// Syncthing's Luhn mod 32 (lib/protocol/luhn.go): left to right, the factor starts at 1 and alternates, the check character makes
// the sum a multiple of 32. Reproduced from the real IDs of v2 4.6 and of M-W6 log 113 (sync-tests/ids.test.js).
export function luhn32(s) {
    let factor = 1;
    let sum = 0;
    for (const c of s) {
        const cp = ID_ALPHABET.indexOf(c);
        if (cp < 0)
            throw new RangeError('luhn32: character outside A-Z2-7');
        let addend = factor * cp;
        factor = factor === 2 ? 1 : 2;
        addend = Math.floor(addend / 32) + (addend % 32);
        sum += addend;
    }
    return ID_ALPHABET[(32 - (sum % 32)) % 32];
}

// 56 characters = four blocks of 13 data characters, each followed by its check character.
function checkCharsHold(compact) {
    for (let i = 0; i < 4; i++) {
        const block = compact.slice(i * 14, i * 14 + 14);
        if (luhn32(block.slice(0, 13)) !== block[13])
            return false;
    }
    return true;
}

export function groupId(compact) {
    return compact.match(/.{7}/g).join('-');
}

// The canonical ID of what a person typed or pasted, or null. Only leading/trailing whitespace is trimmed; inside, ASCII spaces and
// dashes are dropped; letters are upper-cased by ASCII rule only (String.prototype.toUpperCase would turn 'ß' into 'SS');
// then exactly 56 characters of A-Z2-7 are required and every check character must hold. No character substitution: Syncthing's own
// 0/1/8 tolerance is NOT copied, a wrong character is an error, not a guess (PLAN-WIZARD 7.1).
export function canonicalId(raw) {
    if (typeof raw !== 'string' || raw.length > ID_RAW_MAX)
        return null;
    const compact = raw.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '').replace(/[ -]/g, '').replace(/[a-z]/g, c => c.toUpperCase());
    if (!COMPACT_RE.test(compact) || !checkCharsHold(compact))
        return null;
    return groupId(compact);
}

// A value that already claims to be canonical (the `accept <ID>` line, a `cli` list line): same pattern, same check characters.
export function isCanonicalId(s) {
    return typeof s === 'string' && CANON_RE.test(s) && checkCharsHold(s.replace(/-/g, ''));
}

// `join`: the typed ID against this computer's own canonical ID (`ownId`, null while unknown).
export function parseTypedId(raw, ownId = null) {
    const id = canonicalId(raw);
    if (id === null)
        return {ok: false, code: E_BAD_ID};
    if (ownId !== null && id === ownId)
        return {ok: false, code: E_OWN_ID};
    return {ok: true, id};
}

// The first `n` groups, for the "compare at least the first two groups" line and the button label (0H.2).
export function firstGroups(id, n) {
    return id.split('-').slice(0, n).join('-');
}

// The display name of a pending device (0H.1, the closed function). `null` = "(name not readable)", localised by the window.
// Order matters: the length gate comes first, on the raw string, then the character class, then the cut to 32. Nothing is trimmed.
export function displayName(raw) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > NAME_RAW_MAX)
        return null;
    if (!PRINTABLE_ASCII_RE.test(raw))
        return null;
    return raw.slice(0, NAME_SHOWN_MAX);
}
