// SPDX-License-Identifier: GPL-3.0-or-later
// Negative control of the extension tests: each mutant breaks ONE rule of extension.js in a throwaway copy of
// extension/ and src/; the suite must then FAIL. A mutant whose search text is not found exactly once is BROKEN.
// usage: node tests/mutants.mjs [E01 E02 ...]   (from extension/)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FILE = 'extension.js';
const MUTANTS = [
    {id: 'E01', rule: 'the writes are not serialised (_chain)',
        find: 'this._chain = this._chain.then(() => this._write())', repl: 'this._chain = Promise.resolve().then(() => this._write())'},
    {id: 'E02', rule: 'layout.json is looked at WITH following a link (NOFOLLOW_SYMLINKS -> NONE)',
        find: 'Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS', repl: 'Gio.FileQueryInfoFlags.NONE'},
    {id: 'E03', rule: 'the write makes a backup file',
        find: 'new GLib.Bytes(bytes), null, false,', repl: 'new GLib.Bytes(bytes), null, true,'},
    {id: 'E04', rule: 'the write passes an etag',
        find: 'new GLib.Bytes(bytes), null, false,', repl: "new GLib.Bytes(bytes), 'x', false,"},
    {id: 'E05', rule: 'the stream of a read is not closed',
        find: "await gio(stream, 'close_async', 'close_finish', GLib.PRIORITY_DEFAULT, null).catch(() => {});", repl: ''},
    {id: 'E06', rule: 'an exception in a timer callback is not caught',
        find: "this._guard('timer', fn);", repl: 'fn();'},
    {id: 'E07', rule: 'saving is armed before the placement has settled',
        find: 'win.move_resize_frame(false, target.x, target.y, target.w, target.h);\n        this._timeout(SETTLE_MS, () => this._settle(win, st, target, 0));',
        repl: 'win.move_resize_frame(false, target.x, target.y, target.w, target.h);\n        this._arm(win, st);\n        this._timeout(SETTLE_MS, () => this._settle(win, st, target, 0));'},
    {id: 'E08', rule: 'a written batch stays in _pending',
        find: 'const batch = this._pending;\n        this._pending = new Map();', repl: 'const batch = this._pending;'},
    {id: 'E09', rule: 'the write replaces without REPLACE_DESTINATION',
        find: 'Gio.FileCreateFlags.REPLACE_DESTINATION', repl: 'Gio.FileCreateFlags.NONE'},
];

const run = dir => {
    const r = spawnSync(process.execPath, ['--import', './register.mjs', '--test', 'placement.test.mjs', 'extension.test.mjs', 'static.test.mjs'],
        {cwd: path.join(dir, 'extension/tests'), encoding: 'utf8', maxBuffer: 1 << 28, timeout: 60000, killSignal: 'SIGKILL'});
    const failed = [...r.stdout.matchAll(/^not ok \d+ - (.*)$/gm)].map(m => m[1]);
    if (r.error?.code === 'ETIMEDOUT')
        failed.push('(suite hung and was killed after 60 s)');
    return {failed, pass: Number(/^# pass (\d+)/m.exec(r.stdout)?.[1] ?? NaN), status: r.status};
};

const only = process.argv.slice(2).filter(a => /^E\d+$/.test(a));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cetli-extmut-'));
let killed = 0;
let survived = 0;
let broken = 0;
try {
    const copy = to => {
        fs.mkdirSync(to);
        for (const d of ['extension', 'src'])
            fs.cpSync(path.join(root, d), path.join(to, d), {recursive: true, verbatimSymlinks: true, filter: p => !p.includes('node_modules')});
    };
    const clean = path.join(base, 'clean');
    copy(clean);
    const ref = run(clean);
    console.log(`unmutated suite: ${ref.pass} passed, ${ref.failed.length} failed`);
    if (ref.failed.length > 0 || ref.status !== 0) {
        console.log('the unmutated suite is not green; mutants make no sense');
        process.exit(2);
    }
    for (const m of MUTANTS.filter(x => only.length === 0 || only.includes(x.id))) {
        const dir = path.join(base, m.id);
        copy(dir);
        const file = path.join(dir, 'extension/cetli@trensoft.local', FILE);
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
            console.log(`${m.id} KILLED   ${m.rule}\n         ${r.failed.length} test(s) fail, e.g. "${r.failed[0].slice(0, 70)}"`);
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
