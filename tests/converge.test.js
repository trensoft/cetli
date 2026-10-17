// SPDX-License-Identifier: GPL-3.0-or-later
// PLAN.md section 2.3: two machines that see the same versions in different orders end in the same state.
// The plan's throwaway model (evidence/model/resolve_model.py) is the REFERENCE: it is run, not copied.
//
// Named differences between the model and this code (the model is not product code):
//  1. The model compares `canon` strings only; the core writes and compares BYTES, on a real file system.
//  2. The model deletes every conflict file and always replaces <id>.json by W. The core deletes only the three cases
//     of 4 (d) (c1 W in <X>.json, c2 tombstone, c3 preserved) and installs W only if D is absent, a tombstone or
//     preserved (2.2 step 3(b)). The last test below shows the case where the two part ways.
//  3. The model skips a copy if ANY file sits in the slot; the core compares V with the expected copy.
//  4. The model has no frozen group, no NEWER/QUARANTINED/UNKNOWN files, no crash between steps, no Syncthing exchange.
//  5. Numbers: the model goes through Python json (arbitrary-size ints), the core through a JS double (V10).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

import {T0, at, conflictName, fmt, jsonBytes, makeEnv, prng, uuid} from './support/helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.CETLI_MODEL ?? path.join(here, '../../evidence/model/resolve_model.py');
const RUNNER = path.join(here, 'support/model-ref.py');

function runModel(scenarios) {
    const r = spawnSync('python3', [RUNNER, MODEL], {input: JSON.stringify(scenarios), encoding: 'utf8', maxBuffer: 1 << 28});
    if (r.error || r.status !== 0)
        throw new Error(`model runner failed: ${r.error?.message ?? r.stderr}`);
    return JSON.parse(r.stdout);
}
const modelAvailable = () => fs.existsSync(MODEL) && spawnSync('python3', ['--version']).status === 0;

// the model's rec(), driven by a seeded PRNG
function makeVersions(seed) {
    const rnd = prng(seed);
    const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
    const x = uuid(1000 + seed);
    const vs = Array.from({length: int(2, 6)}, (_, i) => ({
        schema: 1, id: x, rev: int(1, 5),
        updated: `2026-10-16T20:${String(int(0, 59)).padStart(2, '0')}:${String(int(0, 59)).padStart(2, '0')}.${String(int(0, 999)).padStart(3, '0')}Z`,
        created: '2026-10-16T19:00:00.000Z', device: Array.from({length: 8}, () => int(0, 15).toString(16)).join(''),
        color: rnd() < 0.5 ? 'yellow' : 'pink', text: `v${i}-${int(0, 3)}`, deleted: rnd() < 0.15, conflict_of: null,
    }));
    if (rnd() < 0.3)
        vs.push({...vs[0]});                           // the same version twice
    return {x, vs, rnd};
}

function shuffled(arr, rnd) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

async function runMachine(x, order, rnd) {
    const env = makeEnv();
    try {
        await env.start();
        const first = fmt.classify(jsonBytes(order[0]), x, T0).rec;
        env.put(`${x}.json`, first.bytes);                                    // the synced file: canonical bytes
        await env.store.refresh();
        let n = 0;
        for (const v of order.slice(1)) {
            n++;
            env.put(conflictName(x, n), jsonBytes(v, rnd() < 0.5));           // arrival as a conflict file, any formatting
            await env.store.refresh();
        }
        await env.store.refresh();
        const settled = env.snapshot();
        await env.store.refresh();
        assert.deepEqual(env.snapshot(), settled, 'resolving a result again is a no-op');
        return settled;
    } finally {
        env.cleanup();
    }
}

test('[P2-T6] 2.3: 300 random scenarios: two machines, different arrival orders, byte-identical results, equal to the plan model', async t => {
    if (!modelAvailable()) {
        t.skip(`reference model or python3 not available (${MODEL})`);
        return;
    }
    const N = 300;
    const scenarios = [];
    const runs = [];
    for (let seed = 0; seed < N; seed++) {
        const {x, vs, rnd} = makeVersions(seed);
        scenarios.push({x, versions: vs});
        runs.push({x, vs, rnd});
    }
    const reference = runModel(scenarios);
    let tombstoneWinners = 0;
    let withCopies = 0;
    for (let i = 0; i < N; i++) {
        const {x, vs, rnd} = runs[i];
        const a = await runMachine(x, shuffled(vs, rnd), rnd);
        const b = await runMachine(x, shuffled(vs, rnd), rnd);
        assert.deepEqual(a, b, `seed ${i}: the two machines diverged`);
        assert.deepEqual(a, reference[i], `seed ${i}: the core differs from the plan's model`);
        assert.ok(Object.keys(a).every(n => !n.includes('sync-conflict')), `seed ${i}: no conflict file is left`);
        if (Object.keys(a).length > 1)
            withCopies++;
        if (JSON.parse(a[`${x}.json`]).deleted)
            tombstoneWinners++;
    }
    assert.ok(withCopies > N / 3 && tombstoneWinners > 0, `the scenarios exercise copies (${withCopies}) and tombstone winners (${tombstoneWinners})`);
});

test('2.3 named divergence from the model: with the copy slot of D occupied the model LOSES D, the core keeps it (2.2 step 3(b), 2.5)', async t => {
    if (!modelAvailable()) {
        t.skip('reference model or python3 not available');
        return;
    }
    const x = uuid(3);
    const base = {schema: 1, id: x, created: at(400), color: 'yellow', deleted: false, conflict_of: null};
    const D = {...base, rev: 1, updated: at(300), device: 'a1b2c3d4', text: 'old text that must survive'};
    const W = {...base, rev: 2, updated: at(200), device: 'b5b5b5b5', text: 'new'};
    const Dr = fmt.classify(jsonBytes(D), x, T0).rec;
    const cid = fmt.cid(x, Dr.v);
    const planted = {...base, id: cid, rev: 4, updated: at(10), device: 'c0c0c0c0', text: 'planted in the copy slot', conflict_of: x};
    const [model] = runModel([{files: {[`${x}.json`]: D, [`${x}.conflict-1.json`]: W, [`${cid}.json`]: planted}}]);
    assert.equal(Object.values(model).some(c => c.includes('old text that must survive')), false, 'the model dropped D');
    const env = makeEnv();
    try {
        await env.start();
        env.put(`${x}.json`, jsonBytes(D));
        env.put(conflictName(x), jsonBytes(W));
        env.put(`${cid}.json`, jsonBytes(planted));
        await env.store.refresh();
        const files = Object.values(env.snapshot()).join('\n');
        assert.ok(files.includes('old text that must survive'), 'the core keeps D (a stuck group, not a loss)');
        assert.ok(files.includes('"text":"new"'), 'W stays in its conflict file');
    } finally {
        env.cleanup();
    }
});
