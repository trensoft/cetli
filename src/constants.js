// SPDX-License-Identifier: GPL-3.0-or-later
// Constants of PLAN.md (revision 5). No imports: this file is shared by the core and the tests.

export const SCHEMA = 1;

// Section 1: UUID_RE, NAME_MAIN, NAME_CONFLICT. Matched with RegExp.prototype.test WITHOUT the m flag,
// so that "<UUID>.json\n" does not match (section 1, "Regex engine"). [0-9], never \d.
const UUID_SRC = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const UUID_RE = new RegExp(`^${UUID_SRC}$`);
export const NAME_MAIN = new RegExp(`^${UUID_SRC}\\.json$`);
export const NAME_CONFLICT = new RegExp(`^${UUID_SRC}\\.sync-conflict-[0-9]{8}-[0-9]{6}-[A-Za-z0-9]{1,16}\\.json$`);
export const UUID_LEN = 36;

export const DEVICE_RE = /^[0-9a-f]{8}$/;
export const UPDATED_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
export const UNKNOWN_KEY_RE = /^[a-z0-9_]{1,32}$/;

// Known top-level keys in canonical order (section 1.3).
export const KNOWN_KEYS = ['schema', 'id', 'rev', 'updated', 'created', 'device', 'color', 'text', 'deleted', 'conflict_of'];

export const MAX_FILE_BYTES = 256 * 1024;            // V1, V11
export const MAX_TEXT_BYTES = 65536;                 // V9
export const MAX_REV = 1000000000;                   // V5
export const MAX_UNKNOWN_KEYS = 16;                  // V10
export const MAX_UNKNOWN_DEPTH = 8;                  // V10
export const FUTURE_TOLERANCE_MS = 24 * 3600 * 1000; // V6
export const YEAR_MIN = 2000;
export const YEAR_MAX = 2100;

export const MAX_NOTES = 500;                        // 1.4
export const TICK_MAX_FILES = 64;                    // 3, cost bound
export const TICK_MAX_BYTES = 4 * 1024 * 1024;       // 3, cost bound
export const TOMBSTONE_PURGE_MS = 90 * 24 * 3600 * 1000; // 1.2, 4 (d) (ii)
export const DEBOUNCE_MS = 100;                      // 3
export const SAVE_COALESCE_MS = 250;                 // 3, save granularity (front end uses it)

// Section 2.2 step 2: namespace of cid(L), 16 raw bytes.
export const CID_NAMESPACE = '6f1d2c84-3b7a-4e5d-9c10-a8e4b2d70f93';

// Placeholder used only to measure canonE (V11): any UUID has the same length as the real one.
export const PLACEHOLDER_UUID = '00000000-0000-4000-8000-000000000000';

// Record states (section 1.1).
export const ST = Object.freeze({
    VALID: 'valid',
    UNKNOWN: 'unknown',
    NEWER: 'newer',
    QUARANTINED: 'quarantined',
});

// Causes of a refused save (section 2.5, 1.5, 1.4). `text` is the proposal the front end may show.
export const CAUSE = Object.freeze({
    QUARANTINE: 'QUARANTINE',
    NOT_READABLE: 'NOT_READABLE',
    NEWER_SCHEMA: 'NEWER_SCHEMA',
    COPY_PLACE_TAKEN: 'COPY_PLACE_TAKEN',
    COPY_NOT_WRITTEN: 'COPY_NOT_WRITTEN',
    MOVE_FAILED: 'MOVE_FAILED',
    TOO_LARGE: 'TOO_LARGE',
    TOO_MANY: 'TOO_MANY',
    REV_LIMIT: 'REV_LIMIT',
    BAD_INPUT: 'BAD_INPUT',
});
