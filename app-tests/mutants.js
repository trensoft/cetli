// SPDX-License-Identifier: GPL-3.0-or-later
// Negative control of the app tests: each mutant breaks ONE rule of app/ in a throwaway copy; the tests must then FAIL.
// The node tests run first; a mutant they do not kill goes to the gjs smoke test when CETLI_GTKENV is set (see run.sh),
// else it is reported as SKIPPED (not as survived). A search text not found exactly once is BROKEN.
// usage: node app-tests/mutants.js [A01 A02 ...]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const gtkenv = process.env.CETLI_GTKENV ?? '';

const MUTANTS = [
    {id: 'A01', rule: 'PLAN 8: the text of the dark header strip is dark', file: 'data.js',
        find: "headerbar.cetli-header { background-color: ${p.darkHeader}; color: ${TEXT_DARK}; }", repl: "headerbar.cetli-header { background-color: ${p.darkHeader}; color: ${TEXT_LIGHT}; }"},
    {id: 'A02', rule: 'PLAN 8: the text of the light note is light', file: 'data.js',
        find: "`window.cetli-${name} { background-color: ${p.light}; color: ${TEXT_LIGHT}; }`", repl: "`window.cetli-${name} { background-color: ${p.light}; color: ${TEXT_DARK}; }`"},
    {id: 'A03', rule: 'PLAN 8: the "unresolved" label is faded to 0.7 (3.8-4.2:1 on the light header strips)', file: 'data.js',
        find: "label.cetli-unresolved { font-size: smaller; }", repl: "label.cetli-unresolved { font-size: smaller; opacity: 0.7; }"},
    {id: 'A04', rule: 'PLAN 8: the mark label is faded to 0.5', file: 'data.js',
        find: "label.cetli-mark { font-size: smaller; padding: 2px 8px; opacity: 0.85; }", repl: "label.cetli-mark { font-size: smaller; padding: 2px 8px; opacity: 0.5; }"},
    {id: 'A05', rule: 'layout.json: setOpen calls overlap (no queue)', file: 'layoutfile.js',
        find: "(queues.get(store) ?? Promise.resolve()).then(", repl: "Promise.resolve().then("},
    {id: 'A06', rule: '3: a remote text replaces UNSAVED typing once the window has been quiet', file: 'window.js', gjs: true,
        find: "if (!this._dirty() && quietFor >= REMOTE_QUIET_MS) {", repl: "if (quietFor >= REMOTE_QUIET_MS) {"},
    {id: 'A07', rule: '3: the 2 s quiet rule is gone (a clean window takes a remote text at once)', file: 'window.js', gjs: true,
        find: "if (!this._dirty() && quietFor >= REMOTE_QUIET_MS) {", repl: "if (!this._dirty()) {"},
    {id: 'A08', rule: '3: the colour of a remote version is not applied', file: 'window.js', gjs: true,
        find: "this.color = rec.color;\n        this._applyColorClass();", repl: "this._applyColorClass();"},
    {id: 'A09', rule: '3: saves are not coalesced (0 ms)', file: 'window.js', gjs: true,
        find: "this._saveTimer = once(SAVE_COALESCE_MS, () => {", repl: "this._saveTimer = once(0, () => {"},
    {id: 'A10', rule: '2.5: the result of the core\'s own retry is dropped', file: 'application.js', gjs: true,
        find: "w?.onSaveRetried(ev.result);", repl: ""},
    {id: 'A11', rule: 'strings: BAD_INPUT has no text of its own', file: 'strings.js', gjs: true,
        find: "    case 'BAD_INPUT': return _('Not saved: this note cannot be saved');\n", repl: ""},
    {id: 'A12', rule: 'PLAN 8: the dark theme never gets its class', file: 'window.js', gjs: true,
        find: "if (dark)\n            this.win.add_css_class('cetli-dark');", repl: "if (dark)\n            this.win.add_css_class('cetli-dark-unused');"},
    {id: 'A13', rule: '2.5: closing a window with a refused, unsaved text closes at once', file: 'window.js', gjs: true,
        find: "if (this.mark?.kind === 'refused' && this._dirty() && !this.closeWarned) {", repl: "if (false) {"},
    {id: 'A14', rule: '3: a cursor at the start of the changed region jumps behind the new text', file: 'window.js', gjs: true,
        find: "for (const m of atStart)\n                    this.buffer.move_mark(m, this.buffer.get_iter_at_offset(region.start));", repl: ""},
    {id: 'A16', rule: 'A5: the About text has no authorship sentence', file: 'strings.js', gjs: true,
        find: "export const aboutComments = () => `${aboutDescription()}\\n\\n${aboutAuthorship()}`;", repl: "export const aboutComments = () => aboutDescription();"},
    {id: 'A15', rule: 'start(): a second activation before the core is up starts it again', file: 'application.js', gjs: true,
        find: "const first = startPromise === null;", repl: "const first = true;"},
];

const copyTree = (from, to) => fs.cpSync(from, to, {recursive: true, filter: p => !p.includes('node_modules')});

function runNode(dir) {
    const files = fs.readdirSync(path.join(dir, 'app-tests')).filter(f => f.endsWith('.test.js')).map(f => `app-tests/${f}`);
    const r = spawnSync(process.execPath, ['--test', ...files], {cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 120000, killSignal: 'SIGKILL'});
    const failed = [...r.stdout.matchAll(/^not ok \d+ - (.*)$/gm)].map(m => m[1]);
    return {failed, status: r.status};
}

function runGjs(dir) {
    const cmd = `. "${gtkenv}/gjsenv.sh" && "${gtkenv}/headless.sh" 1920x1080 -- gjs -m app-tests/gtk-smoke.js 2>&1`;
    const r = spawnSync('bash', ['-c', cmd], {cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 180000, killSignal: 'SIGKILL'});
    const out = r.stdout ?? '';
    const failed = [...out.matchAll(/^FAIL (.*)$/gm)].map(m => m[1]);
    if (!/RESULT PASS/.test(out))
        failed.push('(no RESULT PASS)');
    return {failed, status: r.status};
}

const only = process.argv.slice(2).filter(a => /^A\d+$/.test(a));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cetli-appmut-'));
let killed = 0;
let survived = 0;
let broken = 0;
let skipped = 0;
try {
    const clone = to => {
        fs.mkdirSync(to);
        for (const d of ['app', 'app-tests', 'src', 'tests'])
            copyTree(path.join(root, d), path.join(to, d));
        fs.copyFileSync(path.join(root, 'package.json'), path.join(to, 'package.json'));
    };
    const clean = path.join(base, 'clean');
    clone(clean);
    const ref = runNode(clean);
    const refGjs = gtkenv ? runGjs(clean) : {failed: [], status: 0};
    console.log(`unmutated: node ${ref.failed.length} failed; gjs ${gtkenv ? `${refGjs.failed.length} failed` : 'not run (CETLI_GTKENV not set)'}`);
    if (ref.failed.length > 0 || ref.status !== 0 || refGjs.failed.length > 0) {
        console.log('the unmutated tests are not green; mutants make no sense');
        process.exit(2);
    }
    for (const m of MUTANTS.filter(x => only.length === 0 || only.includes(x.id))) {
        const dir = path.join(base, m.id);
        clone(dir);
        const file = path.join(dir, 'app', m.file);
        const text = fs.readFileSync(file, 'utf8');
        const count = text.split(m.find).length - 1;
        if (count !== 1) {
            broken++;
            console.log(`${m.id} BROKEN MUTANT (search text found ${count} times): ${m.rule}`);
            continue;
        }
        fs.writeFileSync(file, text.replace(m.find, () => m.repl));
        let r = runNode(dir);
        let by = 'node';
        if (r.failed.length === 0 && m.gjs) {
            if (!gtkenv) {
                skipped++;
                console.log(`${m.id} SKIPPED  needs the gjs smoke test (CETLI_GTKENV): ${m.rule}`);
                continue;
            }
            r = runGjs(dir);
            by = 'gjs';
        }
        if (r.failed.length > 0) {
            killed++;
            console.log(`${m.id} KILLED   (${by}) ${m.rule}\n         ${r.failed.length} fail, e.g. "${r.failed[0].slice(0, 80)}"`);
        } else {
            survived++;
            console.log(`${m.id} SURVIVED ${m.rule}`);
        }
    }
} finally {
    fs.rmSync(base, {recursive: true, force: true});
}
console.log(`mutants: ${killed} killed, ${survived} survived, ${broken} broken, ${skipped} skipped`);
process.exit(survived + broken > 0 ? 1 : 0);
