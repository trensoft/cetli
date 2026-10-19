// SPDX-License-Identifier: GPL-3.0-or-later
// F1' meter: implementation-independent check of the "no version text is lost" guarantee of the conflict resolver.
//
// Idea: the resolver's fs call sequence is deterministic for a given scenario. Pass 1 runs the scenario without any
// interference and records every fs-layer call of `store.refresh()`. Pass 2..n re-run the scenario and, right BEFORE
// call number i, let "Syncthing" deliver a new version D3 into <X>.json (temp file + atomic rename, the way Syncthing
// does it). The sweep covers every call index; the point "LAST" is the latest possible moment: right before the last
// mutating call that touches <X>.json, i.e. after every safeguard step the implementation has, whatever it is called.
//
// Exception: D is not counted as lost when D3 replaced <X>.json before the resolver had read it (that is Syncthing's
// own replacement, not a resolver loss); every point from the first read of <X>.json up to the last write of <X>.json counts D, W and D3. Points after that
// last write are not swept (see below).
//
// Green = after the refresh (and after a second, settling refresh) the text of EVERY version (D, W, D3) is found on
// disk: in notes/ (any file), or in any other location under the test root EXCEPT the tmp dir (backup place outside
// the sync folder). A text that is only in the tmp dir does NOT count (a tmp file is not a durable guarantee).
// Extra backup roots outside the env root can be listed in F1P_EXTRA_ROOTS (colon separated).
//
// Run from the cetli tree root (needs tests/support/helpers.js):  node --test tests/f1prime-late-injection.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DEV_B, at, conflictName, makeEnv, rec, uuid} from './support/helpers.js';

const X = uuid(1);
const S = `${X}.json`;
const mk = o => rec({id: X, ...o});
// every fs-layer op except these counts as mutating, so a new op of the fix (exchange, backup, ...) is picked up
const READONLY = new Set(['listDir', 'stat', 'readBytes', 'ensureDir']);

const T_D = 'TEXT-D-main-before-resolve';
const T_W = 'TEXT-W-conflict-file';
const T_D3 = 'TEXT-D3-late-arrival';

function walk(dir, out = []) {
    let ents = [];
    try { ents = fs.readdirSync(dir, {withFileTypes: true}); } catch { return out; }
    for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.isFile()) out.push(p);
    }
    return out;
}

// where is each text? -> {text: [paths]}; tmp dir hits are listed separately
function locate(env, texts) {
    const roots = [env.root, ...(process.env.F1P_EXTRA_ROOTS ?? '').split(':').filter(Boolean)];
    const tmp = path.resolve(env.dirs.tmp);
    const found = {}, tmpOnly = {};
    for (const t of texts) { found[t] = []; tmpOnly[t] = []; }
    for (const root of roots) {
        for (const f of walk(root)) {
            const inTmp = path.resolve(f).startsWith(tmp + path.sep);
            let body;
            try { body = fs.readFileSync(f, 'utf8'); } catch { continue; }
            for (const t of texts) {
                if (!body.includes(t)) continue;
                (inTmp ? tmpOnly : found)[t].push(path.relative(env.root, f));
            }
        }
    }
    return {found, tmpOnly};
}

const touchesS = (args) => args.some(a => typeof a === 'string' && (a === S || a.endsWith(`/${S}`)));

// scenario builders: put D (and W) on disk the way the transport would; `d3` is the late arrival
const SCENARIOS = {
    // main file holds the loser, conflict file holds the winner (resolver must overwrite <X>.json)
    'overwrite-main': {
        setup: (env, v) => { env.putRec(S, v.D); env.putRec(conflictName(X), v.W); },
        d3: (v, kind) => kind === 'newer' ? v.D3new : v.D3old,
    },
};

function versions() {
    return {
        D: mk({rev: 1, text: T_D, updated: at(300)}),
        W: mk({rev: 2, text: T_W, updated: at(200), device: DEV_B}),
        D3new: mk({rev: 4, text: T_D3, updated: at(50), device: DEV_B}),
        D3old: mk({rev: 1, text: T_D3, updated: at(400), device: DEV_B}),
    };
}

async function run(scn, kind, injectAt) {
    const env = makeEnv({wrap: true});
    const v = versions();
    try {
        await env.start();
        SCENARIOS[scn].setup(env, v);
        const d3 = SCENARIOS[scn].d3(v, kind);
        let injected = null;
        const base = env.layer.calls.length;
        env.layer.hooks.before.push((op, args) => {
            const i = env.layer.calls.length - 1 - base;   // the call being made is already recorded
            if (injectAt !== null && injected === null && i === injectAt) {
                injected = {i, op, target: args.filter(a => typeof a === 'string').map(a => path.basename(a)).join(' <- ')};
                const tmp = path.join(env.dirs.notes, '.syncthing.f1p.tmp');
                fs.writeFileSync(tmp, d3.bytes);
                fs.renameSync(tmp, path.join(env.dirs.notes, S));
            }
        });
        await env.store.refresh();
        const calls = env.layer.calls.slice(base).map(c => ({op: c.op, touchesS: touchesS(c.args), args: c.args}));
        const after1 = locate(env, [T_D, T_W, T_D3]);
        await env.store.refresh();
        const after2 = locate(env, [T_D, T_W, T_D3]);
        return {calls, injected, after1, after2};
    } finally { env.cleanup(); }
}

// D that Syncthing itself replaced before the resolver ever read <X>.json is not the resolver's loss
const readsS = c => c.op === 'readBytes' && c.touchesS;
const lost = loc => Object.entries(loc.found).filter(([, p]) => p.length === 0).map(([t]) => t);

for (const scn of Object.keys(SCENARIOS)) {
    for (const kind of ['newer', 'older']) {
        test(`F1' sweep [${scn}, D3 ${kind}]: no version text lost at any injection point`, async () => {
            const base = await run(scn, kind, null);
            const calls = base.calls;
            const lastS = calls.map((c, i) => (!READONLY.has(c.op) && c.touchesS ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
            console.log(`\n[${scn}/${kind}] baseline: ${calls.length} fs calls, last mutating call on ${S}: #${lastS}` +
                (lastS >= 0 ? ` (${calls[lastS].op})` : ' (NONE: the resolver never wrote the main file)'));
            const rows = [];
            for (let i = 0; i < calls.length; i++) {
                // after the resolver's last write of <X>.json a new arrival replaces the resolved winner: that is
                // Syncthing's ordinary update of a finished note, not a resolver loss -> not swept
                if (i > lastS) { rows.push({i, op: calls[i].op, tag: 'after', red: [], skipped: true}); continue; }
                const r = await run(scn, kind, i);
                if (r.injected === null) { rows.push({i, op: calls[i].op, tag: 'not-reached', red: []}); continue; }
                const dSeen = calls.slice(0, i).some(readsS);   // the prefix of the run is identical to the baseline
                const red = [...new Set([...lost(r.after1), ...lost(r.after2)])].filter(t => dSeen || t !== T_D);
                rows.push({
                    i, op: r.injected.op, target: r.injected.target, tag: i === lastS ? 'LAST' : '',
                    red: red.map(t => t.split('-')[1]),
                    tmpOnly: Object.entries(r.after2.tmpOnly).filter(([t, p]) => p.length && !r.after2.found[t].length).map(([t]) => t.split('-')[1]),
                    where: Object.fromEntries(Object.entries(r.after2.found).map(([t, p]) => [t.split('-')[1], p])),
                });
            }
            console.log('  baseline calls: ' + calls.map((c, i) => `${i}:${c.op}${c.touchesS ? '*' : ''}`).join(' ') + '   (* = touches <X>.json)');
            for (const r of rows)
                if (r.skipped) { console.log(`  #${String(r.i).padStart(2)} after final <X>.json write: not swept`); continue; }
                else console.log(`  #${String(r.i).padStart(2)} ${r.tag.padEnd(5)} before ${r.op.padEnd(9)} ${(r.target ?? '').padEnd(60).slice(0, 60)} ${r.red.length ? `LOST: ${r.red.join(',')}` : 'ok'}${r.tmpOnly?.length ? ` (tmp-only: ${r.tmpOnly.join(',')})` : ''}`);
            const last = rows.find(r => r.tag === 'LAST');
            if (last) console.log(`  where texts live at LAST: ${JSON.stringify(last.where)}`);
            const bad = rows.filter(r => r.red.length);
            console.log(`  RESULT [${scn}/${kind}]: ${bad.length === 0 ? 'GREEN' : `RED at ${bad.length} of ${rows.filter(r => !r.skipped).length} swept points: #${bad.map(r => r.i).join(', #')}`}`);
            assert.equal(lastS >= 0, true, 'meter sanity: the resolver must write <X>.json in this scenario');
            assert.equal(bad.length, 0, `version text lost when D3 arrives before call(s) #${bad.map(r => r.i).join(', #')}`);
        });
    }
}

// Sanity of the meter itself: with no injection, nothing may be lost (otherwise the meter, not the code, is wrong)
test("F1' meter sanity: no injection -> all of D and W present", async () => {
    const r = await run('overwrite-main', 'newer', null);
    const l = lost(r.after2).filter(t => t !== T_D3);
    assert.deepEqual(l, []);
});
