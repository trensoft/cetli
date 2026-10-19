// SPDX-License-Identifier: GPL-3.0-or-later
// Negative control of the 0.2.8 start at login (`cetli --autostart`): each mutant breaks ONE rule in a throwaway copy and the tests of that rule must then
// FAIL. A search text not found exactly once is BROKEN. `smokes`: the gjs smokes that must kill it (need CETLI_GTKENV; else SKIPPED); no `smokes`: the node tests.
// usage: node app-tests/mutants-autostart.js [A1 A2 ...]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const gtkenv = process.env.CETLI_GTKENV ?? '';

const MUTANTS = [
    {id: 'A1', rule: 'a start at login falls back to all notes when every note is marked closed', file: 'app/layoutfile.js', smokes: ['autostart-none-smoke.js'],
        find: 'return show.length === 0 && !autostart ? notes : show;', repl: 'return show.length === 0 ? notes : show;'},
    {id: 'A2', rule: 'a start at login without a window makes a new note (unsynchronised folder) or opens the list of notes (synchronised one)', file: 'app/application.js',
        smokes: ['autostart-none-smoke.js', 'autostart-empty-smoke.js'],
        find: '        if (windows.size === 0 && !autostart) {', repl: '        if (windows.size === 0) {'},
    {id: 'A3', rule: 'a start at login opens the first-start sync window', file: 'app/application.js', smokes: ['autostart-empty-smoke.js'],
        find: "        if (!autostart)                                // at login the first-start sync window would come back until somebody answers it\n            maybeShowFirstStartSync();",
        repl: '        maybeShowFirstStartSync();'},
    {id: 'A4', rule: 'a start at login without a window leaves at once, before the start-up check of the sync program is over', file: 'app/application.js', smokes: ['autostart-none-smoke.js'],
        find: "            if (autostart && startupEnsure !== null)\n                startupEnsure.then(() => gtkApp.release());\n            else\n                gtkApp.release();",
        repl: '            gtkApp.release();'},
    {id: 'A5', rule: 'the option --autostart is not taken (a start at login behaves as a start by hand)', file: 'app/application.js', smokes: ['autostart-none-smoke.js', 'autostart-empty-smoke.js'],
        find: '        autostart = true;\n        return -1;', repl: '        return -1;'},
    {id: 'A6', rule: 'an autostart start of a running program activates it (every closed note comes back)', file: 'app/application.js', smokes: ['autostart-remote-smoke.js'],
        find: '            if (gtkApp.get_is_remote())\n                return 0;\n', repl: ''},
    {id: 'A7', rule: 'a start at login does not run the start-up check of the sync program', file: 'app/application.js', smokes: ['autostart-open-smoke.js'],
        find: '            ensureSync();\n            startPromise = start();', repl: '            if (!autostart)\n                ensureSync();\n            startPromise = start();'},
    {id: 'A8', rule: 'the autostart entry starts cetli without --autostart (every login would open a new note or all notes)', file: 'data/io.github.trensoft.cetli.autostart.desktop.in',
        find: 'Exec=@BINDIR@/cetli --autostart', repl: 'Exec=@BINDIR@/cetli'},
    {id: 'A9', rule: 'a window that goes away with the stopped program writes open: false (the notes would not come back at the next login)', file: 'app/window.js',
        smokes: ['autostart-quit-smoke.js', 'autostart-sigterm-smoke.js'],
        find: 'if (!this.deleted && !stopping) {', repl: 'if (!this.deleted) {'},
    {id: 'A10', rule: 'SIGTERM does not mark the program as stopping before the stop begins (a window closed in that turn writes open: false)', file: 'app/application.js',
        smokes: ['autostart-sigterm-smoke.js'],
        find: '        stopping = true;\n        gtkApp.quit();', repl: '        gtkApp.quit();'},
    {id: 'A11', rule: 'quit() does not mark the program as stopping in time (a window closed during the shutdown writes open: false)', file: 'app/application.js',
        smokes: ['autostart-quit-smoke.js'],
        find: "        stopping = true;                               // before GTK takes the windows down (the class handler runs after this one)\n", repl: ''},
];

const copyTree = (from, to) => fs.cpSync(from, to, {recursive: true, filter: p => !p.includes('node_modules')});

function runNode(dir) {
    const files = ['sync-tests', 'app-tests'].flatMap(d => fs.readdirSync(path.join(dir, d)).filter(f => f.endsWith('.test.js')).map(f => `${d}/${f}`));
    const r = spawnSync(process.execPath, ['--test', ...files], {cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 240000, killSignal: 'SIGKILL'});
    return {failed: [...r.stdout.matchAll(/^not ok \d+ - (.*)$/gm)].map(m => m[1]), status: r.status};
}

function runSmoke(dir, smoke) {
    const cmd = `. "${gtkenv}/gjsenv.sh" && "${gtkenv}/headless.sh" 1920x1080 -- gjs -m app-tests/${smoke} 2>&1`;
    const r = spawnSync('bash', ['-c', cmd], {cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 240000, killSignal: 'SIGKILL'});
    const out = r.stdout ?? '';
    const failed = [...out.matchAll(/^FAIL (.*)$/gm)].map(m => `${smoke}: ${m[1]}`);
    if (!/RESULT PASS/.test(out))
        failed.push(`${smoke}: (no RESULT PASS)`);
    return {failed, status: r.status};
}

const only = process.argv.slice(2).filter(a => /^A\d+$/.test(a));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cetli-asmut-'));
let killed = 0;
let survived = 0;
let broken = 0;
let skipped = 0;
try {
    const clone = to => {
        fs.mkdirSync(to);
        for (const d of ['app', 'app-tests', 'po', 'src', 'sync', 'sync-tests', 'tests', 'data', 'packaging'])
            copyTree(path.join(root, d), path.join(to, d));
        for (const f of ['package.json', 'VERSION', 'Makefile', 'README.md'])
            fs.copyFileSync(path.join(root, f), path.join(to, f));
    };
    const clean = path.join(base, 'clean');
    clone(clean);
    const ref = runNode(clean);
    const smokes = [...new Set(MUTANTS.flatMap(m => m.smokes ?? []))];
    const refSmokes = gtkenv ? smokes.map(s => runSmoke(clean, s)) : [];
    console.log(`unmutated: node ${ref.failed.length} failed; gjs ${gtkenv ? `${refSmokes.reduce((n, r) => n + r.failed.length, 0)} failed` : 'not run (CETLI_GTKENV not set)'}`);
    if (ref.failed.length > 0 || ref.status !== 0 || refSmokes.some(r => r.failed.length > 0)) {
        for (const f of [...ref.failed, ...refSmokes.flatMap(r => r.failed)])
            console.log(`  unmutated failure: ${f}`);
        console.log('the unmutated tests are not green; mutants make no sense');
        process.exit(2);
    }
    for (const m of MUTANTS.filter(x => only.length === 0 || only.includes(x.id))) {
        const dir = path.join(base, m.id);
        clone(dir);
        const file = path.join(dir, m.file);
        const text = fs.readFileSync(file, 'utf8');
        const count = text.split(m.find).length - 1;
        if (count !== 1) {
            broken++;
            console.log(`${m.id} BROKEN MUTANT (search text found ${count} times): ${m.rule}`);
            continue;
        }
        fs.writeFileSync(file, text.replace(m.find, () => m.repl));
        const by = [];
        const node = runNode(dir);
        if (node.failed.length > 0)
            by.push(...node.failed.map(f => `node: ${f}`));
        for (const sm of gtkenv ? (m.smokes ?? []) : [])
            by.push(...runSmoke(dir, sm).failed);
        if (by.length > 0) {
            killed++;
            console.log(`${m.id} KILLED   ${m.rule}\n         ${by.length} fail, e.g. "${by[0].slice(0, 100)}"`);
        } else if (m.smokes && !gtkenv) {
            skipped++;
            console.log(`${m.id} SKIPPED  the node tests do not kill it; needs the gjs smokes ${m.smokes.join(', ')} (CETLI_GTKENV): ${m.rule}`);
        } else {
            survived++;
            console.log(`${m.id} SURVIVED ${m.rule}`);
        }
        fs.rmSync(dir, {recursive: true, force: true});
    }
} finally {
    fs.rmSync(base, {recursive: true, force: true});
}
console.log(`mutants: ${killed} killed, ${survived} survived, ${broken} broken, ${skipped} skipped`);
process.exit(survived + broken > 0 ? 1 : 0);
