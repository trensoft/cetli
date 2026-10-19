// SPDX-License-Identifier: GPL-3.0-or-later
// Shared by the start-gate smokes (synced-start-deleted-smoke.js, synced-start-empty-smoke.js, unsynced-start-smoke.js): one real application.js in
// a temporary XDG tree with the real core and Gio layer, started on a notes folder of the caller's choosing. One program per process, so every
// scenario is a file of its own; run them inside a headless Wayland compositor, see app-tests/run.sh.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {createApp} from '../app/application.js';
import {NOTE_RHEL_RED} from '../app/data.js';

export {NOTE_RHEL_RED};

export const tick = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE; }));

export async function waitFor(cond, limit = 8000) {
    const t0 = GLib.get_monotonic_time();
    for (;;) {
        if (cond())
            return true;
        if ((GLib.get_monotonic_time() - t0) / 1000 > limit)
            return false;
        await tick(40);
    }
}

// A bridge that runs no process (the product's SyncBridge would start /usr/bin/cetli-sync of the machine the test runs on). One run at a time like the real
// runner (the second is E_BUSY, counted in `busy`); `answer[verb]` is the outcome or a function of it (it may return a promise); every run is in `calls`.
export function fakeBridge(answer = {}) {
    const b = {calls: [], busy: 0, active: false};
    b.run = async verb => {
        if (b.active) {
            b.busy++;
            return {ok: false, error: {code: 'E_BUSY', step: null}};
        }
        b.calls.push(verb);
        b.active = true;
        try {
            const a = answer[verb] ?? (() => ({ok: false, error: {code: 'E_SERVICE_TIMEOUT', step: null}}));
            return await (typeof a === 'function' ? a() : a);
        } finally {
            b.active = false;
        }
    };
    b.start = (verb, opts) => ({done: b.run(verb, opts), accept: () => false, stop: () => Promise.resolve()});
    b.stop = () => Promise.resolve();
    return b;
}

// `bridge`: what the app talks to (default: a fakeBridge that answers every verb with E_SERVICE_TIMEOUT). `marker`: the notes folder carries the `.stfolder` directory Syncthing makes. `deleted`: how many deleted records are in the folder at the start.
// `seed(dirs)`: the caller puts more files into the notes folder before the program starts.
// 0.2.8: `argv`: the command line given to app.run (e.g. ['cetli', '--autostart']). `firstStartSync`: createApp's switch of the first-start sync window.
// `ownExit`: the program is NOT quit by the test: it must end by itself once the scenario is over (a start at login without a window); the result is
// printed from the 'shutdown' of the program, and a program that is still running 5 s after the scenario fails. `extra`: more createApp options.
// `scenario(env)` gets {ctl, app (createApp's result), windows, files(), records(), check, tick, waitFor, dirs, base}; its failures are reported, the process exits 0/1.
export function runStartGate({marker, deleted = 0, seed = null, bridge = fakeBridge(), argv = [], firstStartSync = false, ownExit = false, extra = {}}, scenario) {
    const base = GLib.dir_make_tmp('cetli-start-XXXXXX');
    const dirs = {notes: `${base}/data/notes`, tmp: `${base}/data/tmp`, state: `${base}/state`};
    GLib.mkdir_with_parents(dirs.notes, 0o755);
    if (marker)
        GLib.mkdir_with_parents(`${dirs.notes}/.stfolder`, 0o755);
    const now = new Date().toISOString();
    for (let i = 0; i < deleted; i++) {
        const id = `00000000-0000-4000-8000-00000000000${i + 1}`;
        GLib.file_set_contents(`${dirs.notes}/${id}.json`,
            `${JSON.stringify({schema: 1, id, rev: 2, updated: now, created: now, device: 'b5b5b5b5', color: 'yellow', text: '', deleted: true, conflict_of: null})}\n`);
    }
    if (seed)
        seed(dirs);
    let failed = 0;
    let checks = 0;
    const check = (cond, label) => {
        checks++;
        if (cond) {
            print(`ok   ${label}`);
        } else {
            failed++;
            print(`FAIL ${label}`);
        }
    };
    const files = (all = false) => {
        const out = [];
        const en = Gio.File.new_for_path(dirs.notes).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        for (let i = en.next_file(null); i !== null; i = en.next_file(null))
            if (all || i.get_name().endsWith('.json'))
                out.push(i.get_name());
        return out.sort();
    };
    const records = () => files().map(f => JSON.parse(new TextDecoder().decode(GLib.file_get_contents(`${dirs.notes}/${f}`)[1])));
    const app = createApp({dirs, homeDir: base, bridge, firstStartSync, ...extra});
    const report = () => {
        print(`${checks - failed}/${checks} checks passed`);
        print(failed === 0 ? 'RESULT PASS' : 'RESULT FAIL');
        GLib.spawn_command_line_async(`rm -rf ${base}`);
    };
    let scenarioOver = false;
    let reported = false;
    if (ownExit) {
        app.gtkApp.connect('shutdown', () => {
            if (reported)
                return;
            reported = true;
            check(scenarioOver, 'the program ended by itself, not before the scenario was over');
            report();
        });
    }
    scenario({ctl: app.ctl, app, bridge, windows: app.windows, files, records, check, tick, waitFor, dirs, base}).then(() => {}, e => { failed++; print(`FAIL exception ${e}\n${e.stack}`); }).finally(() => {
        scenarioOver = true;
        if (!ownExit) {
            reported = true;
            report();
            app.gtkApp.quit();
            return;
        }
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
            if (!reported) {
                reported = true;
                check(false, 'the program ended by itself within 5 s after the scenario');
                report();
                app.gtkApp.quit();
            }
            return GLib.SOURCE_REMOVE;
        });
    });
    const status = app.run(argv);
    if (!reported) {
        print('FAIL the program ended before the scenario was over');
        print('RESULT FAIL');
        imports.system.exit(1);
    }
    imports.system.exit(failed === 0 ? status : 1);
}
