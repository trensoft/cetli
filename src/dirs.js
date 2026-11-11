// SPDX-License-Identifier: GPL-3.0-or-later
// Where the data and the state live when cetli runs as a Flatpak. PURE: the environment is an argument (no gi://, no node:).
//
// Inside a Flatpak, GLib.get_user_data_dir() and get_user_state_dir() answer with the app's own directories under
// ~/.var/app/<id>/, so the notes of an RPM user would not be found, and the GNOME Shell extension (on the host, not in the Flatpak)
// would write another layout.json than the one the app reads. The Flatpak is given access to the host directories instead
// (finish-args of the manifest) and this is where they are: HOST_XDG_DATA_HOME / HOST_XDG_STATE_HOME as the Flatpak hands
// them in, and when the host had none set, the XDG defaults under the real home directory.

const absolute = p => typeof p === 'string' && p.startsWith('/');

// FLATPAK_ID is set by Flatpak in every sandbox and in no other place cetli runs.
export const isFlatpak = env => typeof env?.FLATPAK_ID === 'string' && env.FLATPAK_ID !== '';

// `env`: {FLATPAK_ID, HOST_XDG_DATA_HOME, HOST_XDG_STATE_HOME}, an unset variable is null/undefined. `homeDir`: the real home directory.
// Outside a Flatpak: null (the caller keeps the ordinary XDG directories). A relative or empty HOST_* value counts as unset, as GLib
// treats a relative XDG_* value.
export function flatpakHostDirs({env, homeDir}) {
    if (!isFlatpak(env))
        return null;
    if (!absolute(homeDir))
        throw new RangeError('flatpakHostDirs: the home directory must be an absolute path');
    return {
        data: absolute(env.HOST_XDG_DATA_HOME) ? env.HOST_XDG_DATA_HOME : `${homeDir}/.local/share`,
        state: absolute(env.HOST_XDG_STATE_HOME) ? env.HOST_XDG_STATE_HOME : `${homeDir}/.local/state`,
    };
}
