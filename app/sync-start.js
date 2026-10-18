// SPDX-License-Identifier: GPL-3.0-or-later
// PURE: whether the sync window opens by itself at the first start (PLAN-WIZARD 2.2, 0H.11). The caller reads the state file and asks
// about the `.stfolder` markers; this decides. Rules that keep it harmless: it reads nothing foreign, it never starts anything (the window
// opens at the consent page and nothing runs before the click), and a state file it cannot read means "do not show".
import {markerPaths} from '../sync/markers.js';

export const STATE_VERSION = 1;
// What closing the window with "Later" writes: exactly this, no ID, no label, nothing else (mode 0600 is the writer's).
export const DISMISSED_TEXT = JSON.stringify({version: STATE_VERSION, dismissed: true});

export {markerPaths};

// `stateText`: the file content as text, or null when there is no file. `markerExists(path) -> boolean` for each path of markerPaths.
// Returns true only for: no file (or a version-1 file that does not say dismissed) AND no marker anywhere on the chain.
export function shouldShowFirstStart({stateText, markerExists, notesDir, homeDir}) {
    if (stateText !== null) {
        let state;
        try {
            state = JSON.parse(stateText);
        } catch {
            return false;                                   // fail quiet: a broken file must not make the window reappear at every start
        }
        if (state === null || typeof state !== 'object' || Array.isArray(state) || state.version !== STATE_VERSION || typeof state.dismissed !== 'boolean')
            return false;
        if (state.dismissed)
            return false;
    }
    let paths;
    try {
        paths = markerPaths(notesDir, homeDir);
    } catch {
        return false;
    }
    return !paths.some(p => markerExists(p));
}
