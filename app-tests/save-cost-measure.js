// SPDX-License-Identifier: GPL-3.0-or-later
// gjs MEASUREMENT (no display, not part of `make check`): what does one SAVE cost, and does the main loop keep running
// while it is done. Written for 1.0.0 (the save replaces <X>.json with the atomic exchange: one `mv --exchange`
// subprocess more per save). It prints numbers, it does not judge them.
//
// Run it on the tree WITH the change and on the tree WITHOUT it (v0.2.8, 6d163c5) and compare the two outputs:
//   . $CETLI_GTKENV/gjsenv.sh
//   CETLI_MV_ROOT=<unpacked root with coreutils >= 9.5> CETLI_TREE=<tree> gjs -m app-tests/save-cost-measure.js
// CETLI_TREE   the tree whose src/ is measured (default: the tree this file is in). The file itself is not read from it.
// CETLI_MV_ROOT  like exchange-smoke.js: usr/bin/mv and usr/lib64/ld-linux-x86-64.so.2 of a root with coreutils >= 9.5,
//                started through its own loader. Without it the system /usr/bin/mv is used (it must support --exchange).
// CETLI_N      saves per series (default 200).
//
// STEP 0 is a positive control: gjs runs, and `mv --exchange` really swaps two files. If it does not, the script prints
// "CONTROL FAIL" and measures NOTHING (exit 2).
// Output: one `RESULT` line per series: n, median / p95 / max in ms, the number of exchange calls (0 on the tree without
// the change: that proves which path was measured), the longest gap between two ticks of a 5 ms main-loop timer.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const N = Number(GLib.getenv('CETLI_N') ?? 200);
const MV_ROOT = GLib.getenv('CETLI_MV_ROOT');
const here = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_path();
const tree = GLib.getenv('CETLI_TREE') ?? here;
const base = GLib.dir_make_tmp('cetli-cost-XXXXXX');
const sh = cmd => new TextDecoder().decode(GLib.spawn_command_line_sync(cmd)[1]).trim();

const readText = path => {
    try {
        return new TextDecoder().decode(GLib.file_get_contents(path)[1]);
    } catch {
        return null;
    }
};
const write = (path, text) => GLib.file_set_contents(path, text);
const nowMs = () => GLib.get_monotonic_time() / 1000;
const stats = xs => {
    const a = [...xs].sort((x, y) => x - y);
    const q = p => a[Math.min(a.length - 1, Math.floor(a.length * p))];
    return `median ${q(0.5).toFixed(2)} ms, p95 ${q(0.95).toFixed(2)} ms, max ${a[a.length - 1].toFixed(2)} ms`;
};

function makeMv() {
    if (!MV_ROOT)
        return '/usr/bin/mv';
    const loader = `${MV_ROOT}/usr/lib64/ld-linux-x86-64.so.2`;
    const wrapper = `${base}/mv-wrapper`;
    write(wrapper, `#!/bin/sh\nexec '${loader}' --library-path '${MV_ROOT}/usr/lib64' '${MV_ROOT}/usr/bin/mv' "$@"\n`);
    Gio.File.new_for_path(wrapper).set_attribute_uint32('unix::mode', 0o755, Gio.FileQueryInfoFlags.NONE, null);
    return wrapper;
}

// a copy of <tree>/src in which the one line `const MV = '/usr/bin/mv';` names the chosen mv
function copyOfSrc(mvPath) {
    const dst = `${base}/src`;
    GLib.mkdir_with_parents(dst, 0o700);
    const en = Gio.File.new_for_path(`${tree}/src`).enumerate_children('standard::name', 0, null);
    for (let i = en.next_file(null); i !== null; i = en.next_file(null))
        write(`${dst}/${i.get_name()}`, readText(`${tree}/src/${i.get_name()}`));
    const line = "const MV = '/usr/bin/mv';";
    const text = readText(`${dst}/gio-layer.js`);
    if (text.split(line).length !== 2)
        throw new Error(`${tree}/src/gio-layer.js must contain exactly one \`${line}\``);
    write(`${dst}/gio-layer.js`, text.replace(line, () => `const MV = ${JSON.stringify(mvPath)};`));
    return dst;
}

async function main() {
    const mv = makeMv();
    print(`info tree ${tree}`);
    print(`info gjs ${sh('gjs --version')}; glib ${GLib.MAJOR_VERSION}.${GLib.MINOR_VERSION}.${GLib.MICRO_VERSION}`);
    print(`info mv ${mv}: ${sh(`${mv} --version`).split('\n')[0]}`);
    print(`info file system of the test dir: ${sh(`stat -f -c %T ${base}`)}; N=${N}`);
    const src = copyOfSrc(mv);
    const {fs, platform} = await import(`file://${src}/gio-layer.js`);
    const {createStore} = await import(`file://${src}/store.js`);

    // ---- STEP 0: positive control
    write(`${base}/a`, 'content of a');
    write(`${base}/b`, 'content of b');
    let err = null;
    try {
        await fs.exchange(`${base}/a`, `${base}/b`);
    } catch (e) {
        err = e;
    }
    if (err !== null || readText(`${base}/a`) !== 'content of b' || readText(`${base}/b`) !== 'content of a') {
        print(`CONTROL FAIL: mv --exchange did not swap two files (${err?.code ?? err ?? 'no error, contents unchanged'}); nothing is measured`);
        return 2;
    }
    print('CONTROL PASS: gjs runs and mv --exchange swapped two files');

    // ---- series A: the layer call alone
    const ex = [];
    for (let i = 0; i < N; i++) {
        const t0 = nowMs();
        await fs.exchange(`${base}/a`, `${base}/b`);
        ex.push(nowMs() - t0);
    }
    print(`RESULT layer.exchange x${N}: ${stats(ex)}`);

    // ---- series B: the whole save on the real file layer, with a 5 ms main-loop ticker running
    const dirs = {notes: `${base}/data/notes`, tmp: `${base}/data/tmp`, state: `${base}/state`};
    let exchanges = 0;
    const counted = {...fs, async exchange(a, b) { exchanges++; return fs.exchange(a, b); }};
    const store = createStore({fs: counted, platform: {...platform, log: {warn: () => {}, info: () => {}}}, dirs, resolveConflicts: true});
    await store.start();
    const created = await store.createNote({text: 'first', color: 'yellow'});
    if (!created.ok) {
        print(`CONTROL FAIL: createNote failed (${created.cause?.code})`);
        return 2;
    }
    let last = nowMs();
    let maxGap = 0;
    const tick = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5, () => {
        const t = nowMs();
        maxGap = Math.max(maxGap, t - last);
        last = t;
        return GLib.SOURCE_CONTINUE;
    });
    exchanges = 0;
    const saves = [];
    let rec = created.record;
    for (let i = 0; i < N; i++) {
        const t0 = nowMs();
        const r = await store.saveNote(rec.id, rec, {text: `save ${i}`, color: 'yellow', deleted: false});
        saves.push(nowMs() - t0);
        if (!r.ok) {
            print(`CONTROL FAIL: save ${i} was refused (${r.cause?.code})`);
            GLib.source_remove(tick);
            return 2;
        }
        rec = r.record;
        // the pace of the app: one save per 250 ms at most; the ticker runs in the pauses
        await new Promise(res => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => { res(); return GLib.SOURCE_REMOVE; }));
    }
    GLib.source_remove(tick);
    print(`RESULT store.saveNote x${N}: ${stats(saves)}; exchange calls ${exchanges}; longest gap between two 5 ms ticks ${maxGap.toFixed(2)} ms`);
    return 0;
}

let status = 1;
const loop = GLib.MainLoop.new(null, false);
main().then(s => { status = s; }, e => { print(`FAIL exception ${e}\n${e.stack}`); status = 1; }).finally(() => {
    GLib.spawn_command_line_async(`rm -rf ${base}`);
    loop.quit();
});
loop.run();
imports.system.exit(status);
