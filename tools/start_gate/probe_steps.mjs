// SPDX-License-Identifier: GPL-3.0-or-later
// Steps (a) to (c) of probe_installed.mjs, with everything they touch passed in: the file system (`read`, `isFile`), the module loader
// (`importModule`), GLib and Gio. Under gjs probe_installed.mjs passes the real ones; node passes stand-ins, so that
// app-tests/rpm-gate-steps.test.js runs the insides of the steps (what a step does to the call it makes, and what it makes of the answer), not
// only the order in which they are called. This file imports no gi:// module, so node can load it.
import {checkLibadwaita, checkVersion, datadirOfLauncher} from './probe_logic.mjs';

// What step (b) imports from the installed copy: the program, the engine of cetli-sync, the Gio adapter of the core, the core.
export const IMPORTED = ['app/application.js', 'sync/engine.js', 'sync/gio-ports.js', 'src/index.js'];
export const LAUNCHER = '/usr/bin/cetli';

// The launcher is read again by the steps that need the data directory.
const datadirOf = read => datadirOfLauncher(read(LAUNCHER));

export function stepInstalled(expected, {read, isFile}) {
    const datadir = datadirOf(read);
    if (!isFile(`${datadir}/app/main.js`))
        throw new Error(`${datadir}/app/main.js is not there`);
    const version = checkVersion(read(`${datadir}/VERSION`), expected);
    return `version ${version} in ${datadir}`;
}

export async function stepImport({read, importModule, gjsVersion}) {
    const dir = datadirOf(read);
    for (const f of IMPORTED)
        await importModule(`file://${dir}/${f}`);
    const Gtk = (await importModule('gi://Gtk?version=4.0')).default;
    const Adw = (await importModule('gi://Adw?version=1')).default;
    checkLibadwaita(Adw.MAJOR_VERSION, Adw.MINOR_VERSION);
    return `application.js, engine.js, gio-ports.js and index.js import; Gtk ${Gtk.MAJOR_VERSION}.${Gtk.MINOR_VERSION}.${Gtk.MICRO_VERSION}, ` +
        `libadwaita ${Adw.MAJOR_VERSION}.${Adw.MINOR_VERSION}.${Adw.MICRO_VERSION}, gjs ${gjsVersion}`;
}

export function stepSignal({GLib, Gio, read}) {
    // the call as application.js makes it: priority default, signal 15, the callback is a one-shot (SOURCE_REMOVE)
    return new Promise((resolve, reject) => {
        const id = GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, 15, () => {
            resolve(`SIGTERM arrived through unix_signal_add, glib ${GLib.MAJOR_VERSION}.${GLib.MINOR_VERSION}.${GLib.MICRO_VERSION}`);
            return GLib.SOURCE_REMOVE;
        });
        if (!id) {
            reject(new Error(`no Unix signal watch was made (id ${id})`));
            return;
        }
        const pid = read('/proc/self/stat').split(' ')[0];
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            Gio.Subprocess.new(['/bin/sh', '-c', `kill -TERM ${pid}`], Gio.SubprocessFlags.NONE);
            return GLib.SOURCE_REMOVE;
        });
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
            reject(new Error('SIGTERM did not arrive in the main loop within 5 s'));
            return GLib.SOURCE_REMOVE;
        });
    });
}

// Runs the steps one after the other, [[name, run], ...], whatever the one before said: one line each, `START-GATE <step> PASS|FAIL <detail>`.
// Returns the exit status of the probe, 1 when a step failed.
export async function runSteps(steps, print) {
    let failed = false;
    for (const [name, run] of steps) {
        try {
            print(`START-GATE ${name} PASS ${await run()}`);
        } catch (e) {   // every kind of failure is a failed step
            failed = true;
            print(`START-GATE ${name} FAIL ${e?.message ?? e}`);
        }
    }
    return failed ? 1 : 0;
}
