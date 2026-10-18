// SPDX-License-Identifier: GPL-3.0-or-later
// PURE: the fixed places of the dedicated Syncthing instance (PLAN-WIZARD 0F.1, PLAN-ADDENDUM-pairing 179). The home is the same on
// both sides, without XDG_STATE_HOME, so the engine and the unit file cannot disagree; a drift test holds them together.

export const DEDICATED_HOME_REL = '.local/state/cetli/syncthing';
export const UNIT_NAME = 'cetli-syncthing.service';
export const SOCKET_NAME = 'gui.sock';
export const BACKEND_EXE = '/usr/bin/syncthing';          // the literal that run port and static test look for
export const SYSTEMCTL_EXE = '/usr/bin/systemctl';
export const FOLDER_ID = 'cetli-notes';
// What Syncthing may leave inside its own `.stfolder` marker directory: a hint file. The engine's `reset` takes the marker away only when it
// holds nothing else than these (NOT measured on the real binary: it is the only thing besides an empty directory that is accepted).
export const MARKER_HINT_FILE = /^syncthing-folder-[0-9a-z]{1,32}\.txt$/;

const absolute = p => typeof p === 'string' && /^\/[^\0-\x1f\x7f]+$/.test(p) && !p.includes('//') && !p.endsWith('/');

export function dedicatedHome(homeDir) {
    if (!absolute(homeDir))
        throw new RangeError('dedicatedHome: the home directory must be an absolute path');
    return `${homeDir}/${DEDICATED_HOME_REL}`;
}

export const socketPath = home => {
    if (!absolute(home))
        throw new RangeError('socketPath: absolute path expected');
    return `${home}/${SOCKET_NAME}`;
};
