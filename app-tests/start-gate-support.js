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

// `marker`: the notes folder carries the `.stfolder` directory Syncthing makes. `deleted`: how many deleted records are in the folder at the start.
// `seed(dirs)`: the caller puts more files into the notes folder before the program starts.
// `scenario(env)` gets {ctl, app (createApp's result), windows, files(), records(), check, tick, waitFor}; its failures are reported, the process exits 0/1.
export function runStartGate({marker, deleted = 0, seed = null}, scenario) {
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
    const app = createApp({dirs, homeDir: base});
    scenario({ctl: app.ctl, app, windows: app.windows, files, records, check, tick, waitFor}).then(() => {}, e => { failed++; print(`FAIL exception ${e}\n${e.stack}`); }).finally(() => {
        print(`${checks - failed}/${checks} checks passed`);
        print(failed === 0 ? 'RESULT PASS' : 'RESULT FAIL');
        GLib.spawn_command_line_async(`rm -rf ${base}`);
        app.gtkApp.quit();
    });
    const status = app.run([]);
    imports.system.exit(failed === 0 ? status : 1);
}
