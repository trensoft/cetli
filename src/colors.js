// SPDX-License-Identifier: GPL-3.0-or-later
// The colour NAMES of the menu and the choice of the base colour of a new note. No hex values and no UI here (those are
// app/data.js); no ambient random source: the only one is the injected platform's `randomBytes` (contract at the top of store.js).

// The named colours of the menu, in the order of the grid (0.2.2). `orange`, `mint` and `peach` are NOT here: they stay known
// values in old note files (app/data.js LEGACY_COLORS) but are neither offered nor drawn for a new note.
export const NOTE_COLOR_IDS = Object.freeze(['yellow', 'pink', 'green', 'purple', 'blue', 'gray']);

// Uniform integer in [0, n) from `randomBytes(len) -> Uint8Array`, by rejection sampling (no modulo bias).
// A source that keeps returning rejected values (a broken stub) ends after 64 draws with a plain modulo.
export function randomIndex(randomBytes, n) {
    if (!Number.isInteger(n) || n < 1 || n > 0x10000)
        throw new RangeError('randomIndex: n out of range');
    const span = 0x100000000;
    const limit = span - (span % n);
    let u = 0;
    for (let i = 0; i < 64; i++) {
        const b = randomBytes(4);
        u = ((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3];
        if (u < limit)
            return u % n;
    }
    return u % n;
}

// The base colour of a new note: a random one of the colours that no live note uses yet; when all are used, one of all.
// `usedColors` is any iterable of the `color` strings of the existing, not deleted notes. A custom colour (`#rrggbb`), a legacy
// name (orange, mint, peach) and any unknown string occupy nothing, because they are not in `ids`.
export function pickNoteColor(usedColors, randomBytes, ids = NOTE_COLOR_IDS) {
    const used = new Set(usedColors);
    const free = ids.filter(id => !used.has(id));
    const pool = free.length > 0 ? free : ids;
    return pool[randomIndex(randomBytes, pool.length)];
}
