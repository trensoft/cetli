// SPDX-License-Identifier: GPL-3.0-or-later
// Negative control: each mutant breaks ONE rule of the core in a throwaway copy; the suite must then FAIL.
// usage: node tests/mutants.js [<src dir> <tests dir>]   (run.sh calls it on the clean copy)
// A mutant whose search text is not found exactly once is reported as BROKEN (a mutant that silently changes nothing
// would prove nothing).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const MUTANTS = [
    {id: 'M01', rule: '2.5 refusal (ii): copy slot taken -> save goes on', file: 'store.js',
        find: "if (slot.kind === 'other')\n                return this._refuse(CAUSE.COPY_PLACE_TAKEN", repl: "if (false)\n                return this._refuse(CAUSE.COPY_PLACE_TAKEN"},
    {id: 'M02', rule: '2.5 refusal (i): <X>.json not a valid record -> save goes on', file: 'store.js',
        find: "// Condition (i): `<X>.json` absent or a valid record of the group.\n        if (s && s.state !== ST.VALID) {", repl: "// Condition (i)\n        if (false) {"},
    {id: 'M03', rule: 'V11 on the read side switched off', file: 'format.js',
        find: "if (canonESize(rec) > MAX_FILE_BYTES)\n            return unknown('V11", repl: "if (false)\n            return unknown('V11"},
    {id: 'M04', rule: 'V11 measured on canon instead of canonE (the revision 3 rule)', file: 'format.js',
        find: "return utf8Len(canonString(probe));", repl: "return utf8Len(canonString(rec));"},
    {id: 'M05', rule: 'V11 on the local save switched off', file: 'format.js',
        find: "const fitsV11 = rec => canonESize(rec) <= MAX_FILE_BYTES;", repl: "const fitsV11 = rec => true;"},
    {id: 'M06', rule: 'V4: content id need not equal the id of the file name', file: 'format.js',
        find: " || id !== leadingUuid)", repl: ")"},
    {id: 'M07', rule: '2.2 step 1: ANY valid record in the copy slot counts as the expected copy', file: 'store.js',
        find: "c.rec.v === expected.v)", repl: "true)"},
    {id: 'M08', rule: '2.2 step 3(b): W installed although D has no copy', file: 'store.js',
        find: "if (d !== null && !d.deleted && !preserved.has(d.v)) {", repl: "if (false) {"},
    {id: 'M09', rule: '2.2 step 3(b): bytes of <X>.json taken from the file on disk, not canon(W)', file: 'store.js',
        find: "const r = await this._install(mainName(x), w.rec, {overwrite: s !== null});",
        repl: "const fresh = w.conflicts.length ? await this.fs.readBytes(this._notePath(w.conflicts[0].name)) : w.rec.bytes;\n            const r = await this._install(mainName(x), {...w.rec, bytes: fresh}, {overwrite: s !== null});"},
    {id: 'M10', rule: '2.2 step 3(c): conflict files are deleted whatever their version', file: 'store.js',
        find: "if (!(c1 || c2 || c3)) {", repl: "if (false) {"},
    {id: 'M11', rule: '4 (d): the deletion does not check that the file is unchanged since it was read', file: 'store.js',
        find: "if (st === null || sigOf(st) !== entry.sig) {", repl: "if (st === null) {"},
    {id: 'M12', rule: '2.2 step 0: a frozen group is resolved anyway', file: 'store.js',
        find: "// Step 0: FROZEN group.\n        if (s && s.state !== ST.VALID) {", repl: "// Step 0\n        if (false) {"},
    {id: 'M13', rule: '2.2 step 1: a tombstone loser gets a copy too', file: 'store.js',
        find: "if (l.rec.deleted)\n                continue;                                 // nothing to preserve", repl: ""},
    {id: 'M14', rule: '2.6: copies are written WITH the OVERWRITE flag', file: 'store.js',
        find: "const r = await this._install(mainName(copy.id), copy, {overwrite: false});", repl: "const r = await this._install(mainName(copy.id), copy, {overwrite: true});"},
    {id: 'M15', rule: '3 (4)/2.5: a write is remembered in the own-write filter BEFORE it succeeded', file: 'store.js',
        find: "const tmp = `${this.dirs.tmp}/${this.p.randomUuid()}.tmp`;\n        try {\n            await this.fs.writeTmp(tmp, rec.bytes);",
        repl: "const tmp = `${this.dirs.tmp}/${this.p.randomUuid()}.tmp`;\n        if (own) this._ownWrites.set(rec.id, rec.v);\n        try {\n            await this.fs.writeTmp(tmp, rec.bytes);"},
    {id: 'M16', rule: '3 (4): the result of a resolution is filtered as an own-write echo', file: 'store.js',
        find: "const r = await this._install(mainName(x), w.rec, {overwrite: s !== null});", repl: "const r = await this._install(mainName(x), w.rec, {overwrite: s !== null, own: true});"},
    {id: 'M17', rule: '2.1: the order picks the SMALLEST version', file: 'format.js',
        find: "return ua < ub ? -1 : 1;", repl: "return ua < ub ? 1 : -1;"},
    {id: 'M18', rule: '2.2 step 2: cid(L) depends on a random value', file: 'format.js',
        find: "const name = encoder.encode(`${x}\\n${vHex}`);", repl: "const name = encoder.encode(`${x}\\n${vHex}${Math.random()}`);"},
    {id: 'M19', rule: 'V10: depth limit effectively off', file: 'format.js',
        find: "if (depth > MAX_UNKNOWN_DEPTH)", repl: "if (depth > 10000000)"},
    {id: 'M20', rule: 'V1: the size is not checked from the entry', file: 'format.js',
        find: "size > MAX_FILE_BYTES)\n        return `size", repl: "size > 1e12)\n        return `size"},
    {id: 'M21', rule: '1.4: the note limit is not applied', file: 'store.js',
        find: "if (next.size < this.maxNotes) {", repl: "if (true) {"},
    {id: 'M22', rule: '3: the 64-file cost bound is not applied', file: 'store.js',
        find: "if (!exempt && (files >= TICK_MAX_FILES || bytes + e.size > TICK_MAX_BYTES))", repl: "if (false)"},
    {id: 'M23', rule: 'V6: no quarantine for a date far in the future', file: 'format.js',
        find: "if (updatedMs > nowMs + FUTURE_TOLERANCE_MS)", repl: "if (false)"},
    {id: 'M24', rule: 'V3: a NEWER schema is treated like any record (not NEWER)', file: 'format.js',
        find: "if (Number.isInteger(schema) && schema > SCHEMA) {", repl: "if (false) {"},
    {id: 'M25', rule: '1.5: a failed move leaves its tmp file behind', file: 'store.js',
        find: "} catch (e) {\n            try { await this.fs.remove(tmp); } catch { /* already gone */ }\n            return {ok: false, code: e.code ?? FS.IO, stage: 'move'};", repl: "} catch (e) {\n            return {ok: false, code: e.code ?? FS.IO, stage: 'move'};"},
    {id: 'M26', rule: '2.5: the copy write failure is ignored and the local record is written anyway', file: 'store.js',
        find: "if (!r.ok) {\n                    // The version of a write that did not succeed", repl: "if (false) {\n                    // The version of a write that did not succeed"},
    {id: 'M27', rule: '2.2 step 0: S directory/FIFO/symlink is read like a file (V1 type check off)', file: 'format.js',
        find: "if (type !== 'regular')", repl: "if (false)"},
    {id: 'M28', rule: '1.5: the adapter moves WITHOUT NO_FALLBACK_FOR_MOVE', file: 'gio-layer.js',
        find: "Gio.FileCopyFlags.NO_FALLBACK_FOR_MOVE | (overwrite", repl: "Gio.FileCopyFlags.NONE | (overwrite"},
    {id: 'M29', rule: '2.5: a refusal without a blocking file (ENOSPC, move failed) is retried like the others', file: 'store.js',
        find: "} else if (result.cause.watch && RETRY_CAUSES.has(result.cause.code)) {", repl: "} else if (result.cause.watch) {"},
    {id: 'M30', rule: 'not in the plan: updated above year 2100 is not refused', file: 'store.js',
        find: "if (new Date(updatedMs).getUTCFullYear() > YEAR_MAX)", repl: "if (false)"},
    {id: 'M31', rule: '1.5: the tmp write is CONSISTENT only (no fsync of a new file)', file: 'gio-layer.js',
        find: "GLib.FileSetContentsFlags.CONSISTENT | GLib.FileSetContentsFlags.DURABLE", repl: "GLib.FileSetContentsFlags.CONSISTENT"},
    {id: 'M32', rule: '2.5: a save writes a record that our own reader would reject (no classify check before the write)', file: 'store.js',
        find: "if (check.state !== ST.VALID) {", repl: "if (false) {"},
    {id: 'M33', rule: 'V6: the release timer delay is not capped at 2^31-1 ms', file: 'watcher.js',
        find: "const ms = Math.min(Math.max(at - now() + 1, 1), MAX_TIMER_MS);", repl: "const ms = Math.max(at - now() + 1, 1);"},
    {id: 'M34', rule: '2.5: a failed copy write is not retried on a change of the copy slot', file: 'store.js',
        find: "CAUSE.COPY_PLACE_TAKEN, CAUSE.COPY_NOT_WRITTEN]);", repl: "CAUSE.COPY_PLACE_TAKEN]);"},
];

function copyTree(from, to) {
    fs.cpSync(from, to, {recursive: true, filter: p => !p.includes('node_modules')});
}

function run(dir) {
    const r = spawnSync(process.execPath, ['--test', ...fs.readdirSync(path.join(dir, 'tests')).filter(f => f.endsWith('.test.js')).map(f => `tests/${f}`)],
        {cwd: dir, encoding: 'utf8', env: {...process.env, CETLI_MUTANT_RUN: '1'}, maxBuffer: 1 << 28, timeout: 60000, killSignal: 'SIGKILL'});
    const failed = [...r.stdout.matchAll(/^not ok \d+ - (.*)$/gm)].map(m => m[1]);
    const pass = Number(/^# pass (\d+)/m.exec(r.stdout)?.[1] ?? NaN);
    // a hang (the mutant opens a FIFO and blocks) is a failure of the suite too
    if (r.error?.code === 'ETIMEDOUT')
        failed.push('(suite hung and was killed after 60 s)');
    return {failed, pass, status: r.status};
}

const only = process.argv.slice(2).filter(a => /^M\d+$/.test(a));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cetli-mut-'));
let killed = 0;
let survived = 0;
let broken = 0;
try {
    const clean = path.join(base, 'clean');
    fs.mkdirSync(clean);
    for (const d of ['src', 'tests'])
        copyTree(path.join(root, d), path.join(clean, d));
    fs.copyFileSync(path.join(root, 'package.json'), path.join(clean, 'package.json'));
    const ref = run(clean);
    console.log(`unmutated suite: ${ref.pass} passed, ${ref.failed.length} failed`);
    if (ref.failed.length > 0 || ref.status !== 0) {
        console.log('the unmutated suite is not green; mutants make no sense');
        process.exit(2);
    }
    for (const m of MUTANTS.filter(x => only.length === 0 || only.includes(x.id))) {
        const dir = path.join(base, m.id);
        fs.mkdirSync(dir);
        for (const d of ['src', 'tests'])
            copyTree(path.join(clean, d), path.join(dir, d));
        fs.copyFileSync(path.join(clean, 'package.json'), path.join(dir, 'package.json'));
        const file = path.join(dir, 'src', m.file);
        const text = fs.readFileSync(file, 'utf8');
        const count = text.split(m.find).length - 1;
        if (count !== 1) {
            broken++;
            console.log(`${m.id} BROKEN MUTANT (search text found ${count} times): ${m.rule}`);
            continue;
        }
        fs.writeFileSync(file, text.replace(m.find, () => m.repl));
        const r = run(dir);
        if (r.failed.length > 0) {
            killed++;
            console.log(`${m.id} KILLED   ${m.rule}\n         ${r.failed.length} test(s) fail, e.g. ${r.failed.slice(0, 2).map(n => `"${n.slice(0, 70)}"`).join('; ')}`);
        } else {
            survived++;
            console.log(`${m.id} SURVIVED ${m.rule}`);
        }
    }
} finally {
    fs.rmSync(base, {recursive: true, force: true});
}
console.log(`mutants: ${killed} killed, ${survived} survived, ${broken} broken`);
process.exit(survived + broken > 0 ? 1 : 0);
