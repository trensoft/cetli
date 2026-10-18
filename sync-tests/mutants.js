// SPDX-License-Identifier: GPL-3.0-or-later
// The mutants of the group rule (PLAN-ADMISSION-0.2.6 5.2, X1-X11): one line of the data and sync code is changed in a COPY of the tree and the
// tests must fail. Data and sync code only; no screens, no texts. Run it only when the gate asks: `node sync-tests/mutants.js [X3 X7 ...]`.
// The working tree is never touched. A mutant that is not killed (the tests stay green) is a hole in the tests and exits 1.
import {cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const TESTS = ['engine-setup', 'engine-connect', 'group-admission', 'group-removal', 'policy', 'protocol'].map(n => `sync-tests/${n}.test.js`);

const MUTANTS = [
    ['X1', 'MAX_PEERS = 10 instead of 9 (11 computers allowed)', 'sync/policy.js', 'export const MAX_PEERS = MAX_COMPUTERS - 1;', 'export const MAX_PEERS = MAX_COMPUTERS;'],
    ['X2', 'the count includes the directly accepted devices only', 'sync/engine.js',
        'export const overLimit = (devices, ownId) => devices.filter(d => d.id !== ownId).length > MAX_PEERS;',
        "export const overLimit = (devices, ownId) => devices.filter(d => d.id !== ownId && d.introducedBy === '').length > MAX_PEERS;"],
    ['X3', 'the invariant accepts autoAcceptFolders on an introduced device', 'sync/engine.js',
        "        d.autoAcceptFolders || d.skipIntroductionRemovals ||", "        (d.autoAcceptFolders && d.introducedBy === '') || d.skipIntroductionRemovals ||"],
    ['X4', 'skipIntroductionRemovals is accepted', 'sync/engine.js', 'd.autoAcceptFolders || d.skipIntroductionRemovals ||', 'd.autoAcceptFolders ||'],
    ['X5', 'the read-back after addPeer does not verify the introducer flag', 'sync/engine.js',
        "            if (!peer.introducer || peer.introducedBy !== '')", "            if (false)"],
    ['X6', 'forget <ID> removes every peer instead of the named one', 'sync/engine.js',
        'await deleteIds([id], cfg);\n            const back', 'await deleteIds(cfg.ids.filter(x => x !== own), cfg);\n            const back'],
    ['X7', 'revoke lowers only X flag, not every peer (the freeze is skipped)', 'sync/engine.js',
        'for (const id of freezeSet)\n                await setIntroducer(id, false);', 'for (const id of freezeSet.slice(0, 1))\n                await setIntroducer(id, false);'],
    ['X8', 'the tombstones are not compared before host and join', 'sync/engine.js',
        'if (isFrozen(ls.state) || returnedIds(ls, cfg).length > 0)', 'if (isFrozen(ls.state))'],
    ['X9', 'an introduced name goes to the list unchanged', 'sync/engine.js', 'id: d.id, name: displayName(d.name),', 'id: d.id, name: d.name,'],
    ['X10', 'join is allowed on a computer that already has peers', 'sync/engine.js',
        'if (others.length > 0 && !others.some(d => d.id === peerId))', 'if (false)'],
    ['X11', 'revoke over the freeze cap is not refused (a success that froze only part of the peers)', 'sync/engine.js',
        'if (cfg.ids.filter(id => id !== own).length > FREEZE_MAX)', 'if (cfg.ids.filter(id => id !== own).length > FREEZE_MAX + 1000)'],
];

function run(dir) {
    const r = spawnSync(process.execPath, ['--test', ...TESTS], {cwd: dir, encoding: 'utf8', timeout: 300000});
    const out = `${r.stdout}${r.stderr}`;
    const failed = [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map(m => m[1]);
    return {status: r.status, failed};
}

const wanted = process.argv.slice(2);
const copy = mkdtempSync(join(tmpdir(), 'cetli-mutants-'));
let survivors = 0;
try {
    for (const dir of ['sync', 'sync-tests', 'src', 'app'])
        cpSync(join(root, dir), join(copy, dir), {recursive: true});
    const base = run(copy);
    if (base.status !== 0) {
        console.log(`the unmutated copy is not green: ${base.failed.join(' | ')}`);
        process.exit(2);
    }
    console.log('unmutated copy: green');
    for (const [id, what, file, from, to] of MUTANTS) {
        if (wanted.length > 0 && !wanted.includes(id))
            continue;
        const path = join(copy, file);
        const original = readFileSync(path, 'utf8');
        if (original.split(from).length !== 2)
            throw new Error(`${id}: the line to change is not there exactly once`);
        writeFileSync(path, original.replace(from, () => to));
        const r = run(copy);
        writeFileSync(path, original);
        const killed = r.status !== 0;
        survivors += killed ? 0 : 1;
        console.log(`${killed ? 'KILLED  ' : 'SURVIVED'} ${id} ${what}${killed ? `  (${r.failed.length} test${r.failed.length === 1 ? '' : 's'}: ${r.failed.slice(0, 2).map(s => s.slice(0, 50)).join(' | ')})` : ''}`);
    }
} finally {
    rmSync(copy, {recursive: true, force: true});
}
process.exit(survivors > 0 ? 1 : 0);
