// SPDX-License-Identifier: GPL-3.0-or-later
// Negative control of the 0.2.7 start-up check (`ensure`): each mutant breaks ONE rule in a throwaway copy and the tests of that rule must then FAIL. A search
// text not found exactly once is BROKEN. `smoke`: the gjs smoke that must kill it (needs CETLI_GTKENV; else SKIPPED); no `smoke`: the node tests.
// usage: node sync-tests/mutants-ensure.js [E1 E2 ...]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const gtkenv = process.env.CETLI_GTKENV ?? '';

const MUTANTS = [
    {id: 'E1', rule: 'the app does not ask ensure at its start (a stopped sync program stays stopped until somebody opens the window)', file: 'app/application.js', smoke: 'ensure-start-smoke.js',
        find: '            ensureSync();\n            startPromise = start();', repl: '            startPromise = start();'},
    {id: 'E2', rule: 'the app asks ensure also when the notes folder is not synchronised', file: 'app/application.js', smoke: 'ensure-start-unsynced-smoke.js',
        find: '            if (!synced())\n                return;\n            startupEnsure', repl: '            startupEnsure'},
    {id: 'E3', rule: 'the first status of the sync window does not wait for the start-up check (E_BUSY, a second restart)', file: 'app/sync-wizard.js', smoke: 'ensure-start-smoke.js',
        find: '            await this.startup;\n', repl: ''},
    {id: 'E4', rule: 'ensure does not look at the real state first: an orphan child that answers is started a second time', file: 'sync/engine.js',
        find: "        if (await daemonAnswers(t.ensureWaitMs))\n            return {result: {event: 'result', state: 'running'}};\n", repl: ''},
    {id: 'E5', rule: 'ensure starts a unit that is not enabled (switched off by the user, masked, no answer from systemd)', file: 'sync/engine.js',
        find: "        if (was.rc !== 0)\n            return skipped(", repl: "        if (false)\n            return skipped("},
    {id: 'E6', rule: 'ensure restarts a unit that is active (a silent daemon of an active unit is the window\'s business)', file: 'sync/engine.js',
        find: "if (word !== 'inactive' && word !== 'failed')", repl: 'if (false)'},
    {id: 'E7', rule: 'ensure acts on a folder that is not ours (a Syncthing of the user\'s own)', file: 'sync/engine.js',
        find: ' || !holdsFolder())\n            return skipped(', repl: ')\n            return skipped('},
    {id: 'E8', rule: 'ensure starts without checking the config again', file: 'sync/engine.js',
        find: "        recheckConfig();\n        await run.systemctl(['--user', 'reset-failed', UNIT_NAME], {timeoutMs: t.systemctlMs});\n        const on = await run.systemctl(['--user', 'restart'",
        repl: "        await run.systemctl(['--user', 'reset-failed', UNIT_NAME], {timeoutMs: t.systemctlMs});\n        const on = await run.systemctl(['--user', 'restart'"},
    {id: 'E9', rule: 'ensure does not clear the failed state (start limit) before the restart', file: 'sync/engine.js',
        find: "        recheckConfig();\n        await run.systemctl(['--user', 'reset-failed', UNIT_NAME], {timeoutMs: t.systemctlMs});\n        const on", repl: "        recheckConfig();\n        const on"},
    {id: 'E10', rule: 'ensure restarts every unit that is not `active` (an `activating` unit is on its way up: a restart would kill the start)', file: 'sync/engine.js',
        find: "if (word !== 'inactive' && word !== 'failed')", repl: "if (word === 'active')"},
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

const only = process.argv.slice(2).filter(a => /^E\d+$/.test(a));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cetli-ensmut-'));
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
    const smokes = [...new Set(MUTANTS.filter(m => m.smoke).map(m => m.smoke))];
    const refSmokes = gtkenv ? smokes.map(s => runSmoke(clean, s)) : [];
    console.log(`unmutated: node ${ref.failed.length} failed; gjs ${gtkenv ? `${refSmokes.reduce((n, r) => n + r.failed.length, 0)} failed` : 'not run (CETLI_GTKENV not set)'}`);
    if (ref.failed.length > 0 || ref.status !== 0 || refSmokes.some(r => r.failed.length > 0)) {
        console.log('the unmutated tests are not green; mutants make no sense');
        process.exit(2);
    }
    for (const m of MUTANTS.filter(x => only.length === 0 || only.includes(x.id))) {
        if (m.smoke && !gtkenv) {
            skipped++;
            console.log(`${m.id} SKIPPED  needs the gjs smoke ${m.smoke} (CETLI_GTKENV): ${m.rule}`);
            continue;
        }
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
        const r = m.smoke ? runSmoke(dir, m.smoke) : runNode(dir);
        if (r.failed.length > 0) {
            killed++;
            console.log(`${m.id} KILLED   (${m.smoke ?? 'node'}) ${m.rule}\n         ${r.failed.length} fail, e.g. "${r.failed[0].slice(0, 90)}"`);
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
