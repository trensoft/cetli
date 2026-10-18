// SPDX-License-Identifier: GPL-3.0-or-later
// PURE: where a foreign Syncthing leaves its mark (PLAN-WIZARD 0H.7 (1)). ONE function serves the engine (`setup`: refuse with
// E_STFOLDER_EXISTS) and the window's first-start hook (0H.11): they cannot disagree. Existence queries only; the caller does them.
export const MARKER_NAME = '.stfolder';

const trimSlash = p => (p.length > 1 ? p.replace(/\/+$/, '') : p);

// The `.stfolder` paths to ask about: in `notesDir` and in each parent directory up to and INCLUDING `homeDir`, nearest first. Nothing
// above `homeDir` is ever named. A notes directory outside the home is checked alone (there is no parent chain we may look at).
export function markerPaths(notesDir, homeDir) {
    for (const p of [notesDir, homeDir]) {
        if (typeof p !== 'string' || !/^\/[^\0-\x1f\x7f]*$/.test(p) || p.includes('//') || p.split('/').includes('..'))
            throw new RangeError('markerPaths: absolute, normalised paths expected');
    }
    const notes = trimSlash(notesDir);
    const home = trimSlash(homeDir);
    const out = [`${notes}/${MARKER_NAME}`];
    const prefix = home === '/' ? '/' : `${home}/`;
    if (notes === home || !notes.startsWith(prefix))
        return out;
    let dir = notes;
    for (;;) {
        dir = dir.slice(0, dir.lastIndexOf('/')) || '/';
        out.push(`${dir === '/' ? '' : dir}/${MARKER_NAME}`);
        if (dir === home)
            return out;
    }
}
