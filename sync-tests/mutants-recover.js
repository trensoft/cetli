// SPDX-License-Identifier: GPL-3.0-or-later
// Negative control of the 0.2.5.2 recovery code (restart, reset and the buttons of the error window): each mutant breaks ONE rule in a throwaway
// copy and the tests must then FAIL. A search text not found exactly once is BROKEN. A mutant the node tests do not kill goes to the window's
// gjs smoke test when CETLI_GTKENV is set (else SKIPPED).
// usage: node sync-tests/mutants-recover.js [R1 R2 ...]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const gtkenv = process.env.CETLI_GTKENV ?? '';

const MUTANTS = [
    {id: 'R1', rule: '(g) the dead end of E_CONFIG_UNSAFE after a restart has no way out: Reset sync is not offered', file: 'app/sync-wizard.js', gjs: true,
        find: 'this._showError(out.error.code, () => this.refresh(), {afterRestart: true});', repl: 'this._showError(out.error.code, () => this.refresh());'},
    {id: 'R2', rule: '(f) the automatic restart is skipped: a set-up computer whose sync program does not answer waits for a click', file: 'app/sync-wizard.js', gjs: true,
        find: "if (out.error.code === 'E_SERVICE_TIMEOUT' && !this.restartTried) {", repl: 'if (false) {'},
    {id: 'R3', rule: '(b) reset deletes the instance directory instead of moving it', file: 'sync/engine.js',
        find: 'files.rename(dirs.home, target);', repl: 'files.removeDir(dirs.home);'},
    {id: 'R4', rule: '(b) reset writes a file into the notes folder', file: 'sync/engine.js',
        find: "log('reset: the instance directory was moved aside');", repl: "log('reset: the instance directory was moved aside'); files.writeText(`${dirs.notes}/.reset`, '', 0o600);"},
    {id: 'R5', rule: '(c) reset takes away a marker with anything inside, not only the hint file', file: 'sync/engine.js',
        find: 'return names.every(n => MARKER_HINT_FILE.test(n) && !files.isSymlink(`${path}/${n}`) && !files.isDir(`${path}/${n}`)) ? names : null;', repl: 'return names;'},
    {id: 'R6', rule: '(c) reset takes away a marker without asking whose it is (our folder, the notes path)', file: 'sync/engine.js',
        find: 'if (!folder || folder.path !== dirs.notes || files.isSymlink(dirs.notes))', repl: 'if (false)'},
    {id: 'R7', rule: '(d) restart does not clear the failed state of the unit first', file: 'sync/engine.js',
        find: "            await run.systemctl(['--user', 'reset-failed', UNIT_NAME], {timeoutMs: t.systemctlMs});     // nothing to clear is not an error\n", repl: ''},
    {id: 'R8', rule: '(h) a unit the user switched off (disabled) is started by the automatic try', file: 'sync/engine.js',
        find: 'if (disabled && !enable) {', repl: 'if (false) {'},
    {id: 'R9', rule: '(e) after a reset the window asks the status instead of going to the ID page by a new set-up', file: 'app/sync-wizard.js', gjs: true,
        find: '        this._setup();\n    }\n', repl: '        this.refresh();\n    }\n'},
    {id: 'R10', rule: 'reset goes on when the unit could not be stopped', file: 'sync/engine.js',
        find: "            const off = await run.systemctl(['--user', 'disable', '--now', UNIT_NAME], {timeoutMs: t.systemctlMs});\n            if (off.rc !== 0)\n                throw new Fail('E_NO_USER_SYSTEMD');                         // nothing was changed\n",
        repl: "            await run.systemctl(['--user', 'disable', '--now', UNIT_NAME], {timeoutMs: t.systemctlMs});\n"},
    {id: 'R11', rule: '0.2.6: an is-enabled that is not clearly "disabled" (masked, error) no longer stops the start (fail closed)', file: 'sync/engine.js',
        find: "            if (was.rc !== 0 && !disabled)\n                throw new Fail('E_NO_USER_SYSTEMD');                              // masked, not found, timed out, unreadable: nothing is started (fail closed)\n", repl: ''},
    {id: 'R12', rule: '0.2.6: reset takes the marker away from the list read before the unit stopped, without measuring it again', file: 'sync/engine.js',
        find: 'const names = plainMarkerNames(marker.path);                // measured again now, not the list from before the unit was stopped', repl: 'const names = marker.names;'},
    {id: 'R13', rule: '0.2.6: a failed `show connections` call is told as "not connected" (link none) instead of unknown', file: 'sync/engine.js',
        find: "            if (s.failed)\n                return {link: null, connected: null, connectedS: null};\n", repl: ''},
];

const copyTree = (from, to) => fs.cpSync(from, to, {recursive: true, filter: p => !p.includes('node_modules')});

function runNode(dir) {
    const files = ['sync-tests', 'app-tests'].flatMap(d => fs.readdirSync(path.join(dir, d)).filter(f => f.endsWith('.test.js')).map(f => `${d}/${f}`));
    const r = spawnSync(process.execPath, ['--test', ...files], {cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 240000, killSignal: 'SIGKILL'});
    const failed = [...r.stdout.matchAll(/^not ok \d+ - (.*)$/gm)].map(m => m[1]);
    return {failed, status: r.status};
}

function runGjs(dir) {
    const cmd = `. "${gtkenv}/gjsenv.sh" && "${gtkenv}/headless.sh" 1920x1080 -- gjs -m app-tests/sync-wizard-smoke.js 2>&1`;
    const r = spawnSync('bash', ['-c', cmd], {cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28, timeout: Number(process.env.CETLI_MUTANT_TIMEOUT_MS) || 240000, killSignal: 'SIGKILL'});
    const out = r.stdout ?? '';
    const failed = [...out.matchAll(/^FAIL (.*)$/gm)].map(m => `sync-wizard-smoke.js: ${m[1]}`);
    if (!/RESULT PASS/.test(out))
        failed.push('sync-wizard-smoke.js: (no RESULT PASS)');
    return {failed, status: r.status};
}

const only = process.argv.slice(2).filter(a => /^R\d+$/.test(a));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cetli-recmut-'));
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
    const refGjs = gtkenv ? runGjs(clean) : {failed: [], status: 0};
    console.log(`unmutated: node ${ref.failed.length} failed; gjs ${gtkenv ? `${refGjs.failed.length} failed` : 'not run (CETLI_GTKENV not set)'}`);
    if (ref.failed.length > 0 || ref.status !== 0 || refGjs.failed.length > 0) {
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
            console.log(`${m.id} KILLED   (${by}) ${m.rule}\n         ${r.failed.length} fail, e.g. "${r.failed[0].slice(0, 90)}"`);
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
