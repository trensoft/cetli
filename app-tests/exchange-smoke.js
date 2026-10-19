// SPDX-License-Identifier: GPL-3.0-or-later
// gjs test (no display) of the REAL atomic exchange of src/gio-layer.js (0.2.7.1): `mv --exchange` started through Gio.Subprocess, then the
// store on top of the real file layer. It answers one question: does the exchange happen on a system that has it, and does the store
// say so (and lose nothing) on a system that has not? A silent fall-back to the checked move would pass every node test.
//
// gio-layer.js starts the ABSOLUTE /usr/bin/mv (no PATH search, on purpose: the core starts one fixed program). To test it with another
// coreutils the smoke runs a COPY of src/ in which that one constant line is replaced; the copy is checked to differ in exactly that line.
//
// Two modes (one of them is required, otherwise the smoke FAILS: a smoke that skips proves nothing):
//   CETLI_MV_ROOT=<root>          positive: <root> is an unpacked root with coreutils >= 9.5 (usr/bin/mv, usr/lib64/ld-linux-x86-64.so.2),
//                                 started through its own loader. The exchange must happen, the fall-back line must NOT appear.
//   CETLI_MV_EXPECT_FALLBACK=1    negative control: the system /usr/bin/mv as it is. It must NOT support --exchange (coreutils < 9.5);
//                                 the store must say so once and lose nothing. If this mv does support it, the control FAILS (it proves nothing).
// Run: . $CETLI_GTKENV/gjsenv.sh; CETLI_MV_ROOT=/path/to/f43root gjs -m app-tests/exchange-smoke.js
//      . $CETLI_GTKENV/gjsenv.sh; CETLI_MV_EXPECT_FALLBACK=1 gjs -m app-tests/exchange-smoke.js
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

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

const here = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_path();
const base = GLib.dir_make_tmp('cetli-exchange-XXXXXX');
const MV_ROOT = GLib.getenv('CETLI_MV_ROOT');
const EXPECT_FALLBACK = GLib.getenv('CETLI_MV_EXPECT_FALLBACK') === '1';

// null for a file that is not there: a missing file must be a failed check, not an exception that hides the others
const readText = path => {
    try {
        return new TextDecoder().decode(GLib.file_get_contents(path)[1]);
    } catch {
        return null;
    }
};
const write = (path, text) => GLib.file_set_contents(path, text);
const names = dir => {
    const out = [];
    const en = Gio.File.new_for_path(dir).enumerate_children('standard::name', 0, null);
    for (let i = en.next_file(null); i !== null; i = en.next_file(null))
        out.push(i.get_name());
    return out.sort();
};
const exists = path => GLib.file_test(path, GLib.FileTest.EXISTS);

function copyOfSrc(mvPath) {
    const dst = `${base}/src`;
    GLib.mkdir_with_parents(dst, 0o700);
    for (const n of names(`${here}/src`))
        write(`${dst}/${n}`, readText(`${here}/src/${n}`));
    const file = `${dst}/gio-layer.js`;
    const text = readText(file);
    const line = "const MV = '/usr/bin/mv';";
    if (text.split(line).length !== 2)
        throw new Error(`gio-layer.js must contain exactly one \`${line}\` (the smoke replaces it in a copy)`);
    const swapped = `const MV = ${JSON.stringify(mvPath)};`;
    write(file, text.replace(line, () => swapped));
    // the copy must be the original with that one line changed: put the line back and compare every file byte for byte
    for (const n of names(`${here}/src`)) {
        const original = readText(`${here}/src/${n}`);
        const copy = readText(`${dst}/${n}`);
        const restored = n === 'gio-layer.js' && copy !== null ? copy.replace(swapped, () => line) : copy;
        if (restored !== original)
            throw new Error(`the copy of src/${n} differs from the original beyond the replaced line`);
    }
    if (names(dst).length !== names(`${here}/src`).length)
        throw new Error('the copy of src/ has other files than the original');
    return dst;
}

function makeWrapper(root) {
    const loader = `${root}/usr/lib64/ld-linux-x86-64.so.2`;
    for (const p of [loader, `${root}/usr/bin/mv`]) {
        if (!exists(p))
            throw new Error(`CETLI_MV_ROOT=${root}: ${p} does not exist`);
    }
    const wrapper = `${base}/mv-wrapper`;
    write(wrapper, `#!/bin/sh\nexec '${loader}' --library-path '${root}/usr/lib64' '${root}/usr/bin/mv' "$@"\n`);
    Gio.File.new_for_path(wrapper).set_attribute_uint32('unix::mode', 0o755, Gio.FileQueryInfoFlags.NONE, null);
    return wrapper;
}

async function scenario() {
    if (!MV_ROOT && !EXPECT_FALLBACK) {
        check(false, 'no mode: set CETLI_MV_ROOT=<root with coreutils >= 9.5> (positive) or CETLI_MV_EXPECT_FALLBACK=1 (negative control); this smoke never skips');
        return;
    }
    if (MV_ROOT && EXPECT_FALLBACK) {
        check(false, 'CETLI_MV_ROOT and CETLI_MV_EXPECT_FALLBACK=1 are exclusive');
        return;
    }
    const positive = Boolean(MV_ROOT);
    const mv = positive ? makeWrapper(MV_ROOT) : '/usr/bin/mv';
    const src = copyOfSrc(mv);
    const {fs, platform} = await import(`file://${src}/gio-layer.js`);
    const {createStore} = await import(`file://${src}/store.js`);
    const {makeFormat} = await import(`file://${src}/format.js`);
    const {FS, FsError} = await import(`file://${src}/fs-error.js`);
    print(`info mode ${positive ? `positive (mv from ${MV_ROOT})` : 'negative control (system /usr/bin/mv)'}`);

    // ---- the layer itself
    const t = `${base}/layer`;
    GLib.mkdir_with_parents(t, 0o700);
    write(`${t}/a`, 'content of a');
    write(`${t}/b`, 'content of b');
    let err = null;
    try {
        await fs.exchange(`${t}/a`, `${t}/b`);
    } catch (e) {
        err = e;
    }
    if (positive) {
        check(err === null, `fs.exchange of two existing files does not fail (${err?.code ?? err ?? 'no error'})`);
        check(readText(`${t}/a`) === 'content of b' && readText(`${t}/b`) === 'content of a', 'the two files swapped their contents (one atomic step)');
        err = null;
        try {
            await fs.exchange(`${t}/a`, `${t}/nope`);
        } catch (e) {
            err = e;
        }
        check(err instanceof FsError && err.code === FS.NOT_FOUND, `fs.exchange with a missing partner is NOT_FOUND (${err?.code ?? err})`);
    } else {
        check(err instanceof FsError && err.code === FS.NOT_SUPPORTED, `this mv cannot --exchange: fs.exchange is NOT_SUPPORTED (${err?.code ?? err ?? 'no error'}); if it succeeded, this system is not a negative control`);
        check(readText(`${t}/a`) === 'content of a' && readText(`${t}/b`) === 'content of b', 'a failed exchange changed nothing');
    }

    // ---- the store on the real file layer
    const fmt = makeFormat({sha256Hex: platform.sha256Hex, sha1: platform.sha1});
    const X = '00000000-0000-4000-8000-000000000001';
    const S = `${X}.json`;
    const CONFLICT = `${X}.sync-conflict-20261017-120001-ABCDEFG.json`;
    const ago = min => new Date(Date.now() - min * 60000).toISOString();
    const mk = over => fmt.makeRecord({
        schema: 1, id: X, rev: 1, updated: ago(300), created: ago(500), device: 'a1b2c3d4', color: 'yellow', text: 'old',
        deleted: false, conflict_of: null, ...over,
    }, new Map());
    const D = mk({rev: 1, text: 'old', updated: ago(300)});
    const W = mk({rev: 2, text: 'new', updated: ago(200), device: 'b5b5b5b5'});
    const D2 = mk({rev: 3, text: 'THE NEWEST TEXT FROM THE OTHER MACHINE', updated: ago(100), device: 'b5b5b5b5'});

    async function run(label, {inject}) {
        const root = `${base}/${label}`;
        const dirs = {notes: `${root}/data/notes`, tmp: `${root}/data/tmp`, state: `${root}/state`};
        const backup = `${root}/data/backup`;
        const lines = [];
        const ops = [];
        let injected = false;
        const arrive = () => {
            injected = true;
            write(`${dirs.notes}/.syncthing.late.tmp`, new TextDecoder().decode(D2.bytes));
            Gio.File.new_for_path(`${dirs.notes}/.syncthing.late.tmp`).move(Gio.File.new_for_path(`${dirs.notes}/${S}`), Gio.FileCopyFlags.OVERWRITE, null, null);
        };
        const wrapped = {
            ...fs,
            async exchange(a, b) {
                ops.push('exchange');
                if (inject === 'before-exchange' && !injected)
                    arrive();
                return fs.exchange(a, b);
            },
            async writeTmp(path, bytes) {
                await fs.writeTmp(path, bytes);
                // the fall-back reads the slot right after the durable write of the swap partner (*.x)
                if (inject === 'after-write' && !injected && path.endsWith('.x'))
                    arrive();
            },
        };
        const store = createStore({
            fs: wrapped,
            platform: {...platform, log: {warn: m => lines.push(`WARN ${m}`), info: m => lines.push(`INFO ${m}`)}},
            dirs,
            resolveConflicts: true,
        });
        await store.start();
        write(`${dirs.notes}/${S}`, new TextDecoder().decode(D.bytes));
        write(`${dirs.notes}/${CONFLICT}`, new TextDecoder().decode(W.bytes));
        await store.refresh();
        return {dirs, backup, lines, ops, injected: () => injected};
    }
    const fallbackLines = r => r.lines.filter(l => /atomic exchange is not available/.test(l));
    const backupText = r => (exists(r.backup) ? names(r.backup).map(n => readText(`${r.backup}/${n}`)).join('\n') : '');
    const hasNoLeftovers = r => names(r.dirs.tmp).length === 0;

    // 1. nothing arrives meanwhile
    let r = await run('quiet', {inject: null});
    check(readText(`${r.dirs.notes}/${S}`) === W.canon, 'no race: the note holds the version the resolution settled on');
    check(!exists(r.backup) || names(r.backup).length === 0, 'no race: nothing is put in backup/ (the replaced version has its copy)');
    check(hasNoLeftovers(r), 'no race: tmp/ is clean');
    if (positive) {
        check(r.ops.filter(o => o === 'exchange').length === 1 && fallbackLines(r).length === 0,
            `the swap was done by mv --exchange and the log does not report a fall-back (exchange calls ${r.ops.length}, fall-back lines ${fallbackLines(r).length})`);
    } else {
        check(fallbackLines(r).length === 1, `the fall-back is reported exactly once in the log (${fallbackLines(r).length} line(s))`);
    }

    // 2. a newer version arrives from the transport right before the swap / right before the move
    r = await run(positive ? 'late-positive' : 'late-negative', {inject: positive ? 'before-exchange' : 'after-write'});
    check(r.injected(), 'the newer version was put into the slot by the test at the chosen moment');
    if (positive) {
        check(readText(`${r.dirs.notes}/${S}`) === W.canon, 'late arrival: the note holds the settled version');
        check(/THE NEWEST TEXT FROM THE OTHER MACHINE/.test(backupText(r)), 'late arrival: the text that mv --exchange took out is kept in backup/, outside the synced folder');
        check(fallbackLines(r).length === 0, 'late arrival: no fall-back line');
    } else {
        check(/THE NEWEST TEXT FROM THE OTHER MACHINE/.test(readText(`${r.dirs.notes}/${S}`) ?? ''), 'late arrival, fall-back: the checked move saw the change and left the newer version where it is (narrower window, not closed)');
        check(fallbackLines(r).length === 1, 'late arrival, fall-back: reported once');
    }
    check(hasNoLeftovers(r), 'late arrival: tmp/ is clean');
}

scenario().then(() => {}, e => { failed++; print(`FAIL exception ${e}\n${e.stack}`); }).finally(() => {
    print(`${checks - failed}/${checks} checks passed`);
    print(failed === 0 ? 'RESULT PASS' : 'RESULT FAIL');
    GLib.spawn_command_line_async(`rm -rf ${base}`);
    loop.quit();
});
const loop = GLib.MainLoop.new(null, false);
loop.run();
imports.system.exit(failed === 0 ? 0 : 1);
