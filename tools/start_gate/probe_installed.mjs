// SPDX-License-Identifier: GPL-3.0-or-later
// Start gate, steps (a) to (c), on the INSTALLED package, run by gjs in the clean container (check.sh).
//
// (a) the installed cetli has the version the RPM was built with, and the launcher /usr/bin/cetli starts the
//     copy under /usr, not a checkout;
// (b) the modules of the program (application.js and everything it imports, the engine of cetli-sync, the
//     Gio adapter of the core) import from there, with the typelibs the RPM pulled in: Gtk 4, libadwaita 1.5
//     or later, Gdk, Pango;
// (c) a real SIGTERM reaches the signal watch GLib.unix_signal_add(PRIORITY_DEFAULT, 15, ...) that
//     application.js installs for the session's SIGTERM, in a real GLib main loop. An import check and a
//     typelib check do not run this call (the start-up error of slideshow-lock 1.0.11 was of this kind).
//
// The steps themselves are in probe_steps.mjs (so that node can run them against stand-ins); this file only wires the real GLib, Gio, file system and
// module loader in.
// usage: gjs -m probe_installed.mjs EXPECTED_VERSION
// Prints one line per step, `START-GATE <step> PASS|FAIL <detail>`; exits 1 when a step failed.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';

import {runSteps, stepImport, stepInstalled, stepSignal} from './probe_steps.mjs';

const decoder = new TextDecoder();
const read = path => decoder.decode(GLib.file_get_contents(path)[1]);

async function main() {
    if (ARGV.length !== 1) {
        printerr('usage: gjs -m probe_installed.mjs EXPECTED_VERSION');
        return 2;
    }
    return runSteps([
        ['a', () => stepInstalled(ARGV[0], {read, isFile: path => GLib.file_test(path, GLib.FileTest.IS_REGULAR)})],
        ['b', () => stepImport({read, importModule: specifier => import(specifier), gjsVersion: System.version})],
        ['c', () => stepSignal({GLib, Gio, read})],
    ], print);
}

let rc = 1;
const loop = GLib.MainLoop.new(null, false);
main().then(code => { rc = code; }, e => { printerr(`probe_installed.mjs: ${e}`); rc = 1; }).finally(() => loop.quit());
loop.run();
System.exit(rc);
