// SPDX-License-Identifier: GPL-3.0-or-later
// The decisions of probe_installed.mjs that need no GLib, so that node can test them (app-tests/rpm-gate-logic.test.js). The probe runs under gjs
// in the clean container and imports this file from its own directory.

// The launcher /usr/bin/cetli is `exec gjs -m <datadir>/app/main.js "$@"` (the Makefile writes it). Returns <datadir>; throws when the text is not
// that, or when <datadir> is not an installed copy under /usr.
export function datadirOfLauncher(text) {
    const m = text.match(/^exec gjs -m (\/\S+)\/app\/main\.js "\$@"$/m);
    if (!m)
        throw new Error(`the launcher /usr/bin/cetli does not start gjs -m <datadir>/app/main.js: ${JSON.stringify(text.slice(0, 200))}`);
    if (!m[1].startsWith('/usr/'))
        throw new Error(`the launcher starts ${m[1]}, not an installed copy under /usr`);
    return m[1];
}

// The VERSION file of the installed copy is the version of the RPM.
export function checkVersion(installed, expected) {
    const version = installed.trim();
    if (version !== expected)
        throw new Error(`installed version ${version}, the RPM has ${expected}`);
    return version;
}

// libadwaita 1.5 is the first with Adw.AboutDialog (the spec: Requires: libadwaita >= 1.5).
export function checkLibadwaita(major, minor) {
    if (major !== 1 || minor < 5)
        throw new Error(`libadwaita ${major}.${minor}, the program needs 1.5 or later`);
}
