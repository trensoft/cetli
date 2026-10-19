// SPDX-License-Identifier: GPL-3.0-or-later
// PLAN.md section 2.2 (resolution of a group), 2.6 (check-to-rename window), 4 (d) (what may be deleted).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

import {createStore} from '../src/store.js';
import {nodeFs} from './support/node-layer.js';
import {DEV_B, T0, at, conflictName, fmt, jsonBytes, makeEnv, raw, rec, uuid} from './support/helpers.js';

const X = uuid(1);
const mk = over => rec({id: X, ...over});
const D = mk({rev: 1, text: 'old', updated: at(300)});
const W = mk({rev: 2, text: 'new', updated: at(200), device: DEV_B});
const copyOf = l => fmt.expectedCopy(l, X);
const copyName = l => `${copyOf(l).id}.json`;
const S = `${X}.json`;

const withEnv = (opts, fn) => async () => {
    const env = makeEnv(opts);
    try {
        await env.start();
        await fn(env);
    } finally {
        env.cleanup();
    }
};
const sorted = (...n) => n.sort();

test('2.2: the greater version goes to <X>.json, the loser becomes a second cetli, the conflict file goes last', withEnv({}, async env => {
    env.putRec(S, D);
    env.putRec(conflictName(X), W);
    const r = await env.store.refresh();
    assert.equal(env.read(S), W.canon);
    assert.equal(env.read(copyName(D)), copyOf(D).canon);
    assert.deepEqual(env.names(), sorted(S, copyName(D)));
    assert.equal(copyOf(D).conflict_of, X);
    assert.equal(copyOf(D).text, 'old');
    assert.equal(copyOf(D).rev, D.rev, 'the copy equals the loser in every field but id and conflict_of');
    assert.deepEqual(r.changes.map(c => [c.type, c.id]).sort(), [['added', copyOf(D).id], ['added', X]].sort());
    const settled = env.snapshot();
    const r2 = await env.store.refresh();
    assert.deepEqual(env.snapshot(), settled, 'idempotent: resolving again changes nothing');
    assert.deepEqual(r2.changes, []);
}));

test('3 (4)/2.2: the result of a resolution IS announced for an already known note (it is not an own-write echo)', withEnv({}, async env => {
    env.putRec(S, D);
    await env.store.refresh();
    env.events.length = 0;
    env.putRec(conflictName(X), W);
    await env.store.refresh({hint: [conflictName(X)]});
    const ch = env.events.filter(e => e.type === 'changed' && e.id === X);
    assert.equal(ch.length, 1, 'the open note must be told that W replaced D');
    assert.equal(ch[0].record.text, 'new');
}));

test('2.2 step 3(b): when <X>.json already holds W it keeps its own bytes; loser conflict file becomes a copy', withEnv({}, async env => {
    env.put(S, jsonBytes({...W, extra: undefined}, true));          // W in a pretty-printed, differently formatted file
    env.putRec(conflictName(X), D);
    const before = env.read(S);
    await env.store.refresh();
    assert.equal(env.read(S), before, 'the synced file is not rewritten');
    assert.deepEqual(env.names(), sorted(S, copyName(D)));
}));

test('2.2 step 1/4: a tombstone loser gets no copy; a tombstone winner makes the edit a copy', withEnv({}, async env => {
    const T = mk({rev: 3, text: '', deleted: true, updated: at(100)});
    // tombstone loser: S = W, conflict = older tombstone
    env.putRec(S, W);
    env.putRec(conflictName(X), mk({rev: 1, text: '', deleted: true, updated: at(400)}));
    await env.store.refresh();
    assert.deepEqual(env.names(), [S], 'no copy; the tombstone conflict file is deleted (c2)');
    assert.equal(env.read(S), W.canon);
    // tombstone winner: the edit survives as a new cetli
    const env2 = makeEnv();
    try {
        await env2.start();
        env2.putRec(S, D);
        env2.putRec(conflictName(X), T);
        await env2.store.refresh();
        assert.equal(env2.read(S), T.canon);
        assert.equal(env2.read(copyName(D)), copyOf(D).canon);
        assert.deepEqual(env2.names(), sorted(S, copyName(D)));
        assert.equal(env2.store.getNote(X).deleted, true);
    } finally {
        env2.cleanup();
    }
}));

test('2.2: three versions, every non-tombstone non-greatest version is kept, once', withEnv({}, async env => {
    const A = mk({rev: 1, text: 'a', updated: at(300)});
    const B = mk({rev: 1, text: 'b', updated: at(250)});
    const C = mk({rev: 1, text: 'c', updated: at(100)});
    env.putRec(S, B);
    env.putRec(conflictName(X, 1), A);
    env.putRec(conflictName(X, 2), C);
    env.putRec(conflictName(X, 3), C);                 // the same version twice counts once
    await env.store.refresh();
    assert.equal(env.read(S), C.canon);
    assert.deepEqual(env.names(), sorted(S, copyName(A), copyName(B)));
}));

test('[P2-T6] 2.2 step 3(b): W in differently formatted files gives IDENTICAL bytes, canon(W), in every arrival order', async () => {
    const pretty = jsonBytes({...raw({id: X, rev: 2, text: 'new', updated: at(200), device: DEV_B})}, true);
    const reordered = enc2(`{"text":"new","conflict_of":null,"deleted":false,"color":"yellow","device":"${DEV_B}","created":"${at(180)}","updated":"${at(200)}","rev":2,"id":"${X}","schema":1}`);
    const variants = [
        [[S, D.bytes], [conflictName(X, 1), pretty], [conflictName(X, 2), reordered]],
        [[S, D.bytes], [conflictName(X, 1), reordered], [conflictName(X, 2), pretty]],
        [[conflictName(X, 1), pretty], [conflictName(X, 2), reordered]],                     // no <X>.json at all
        [[conflictName(X, 2), pretty], [conflictName(X, 1), reordered], [S, D.bytes]],
    ];
    for (const files of variants) {
        const env = makeEnv();
        try {
            await env.start();
            for (const [n, b] of files)
                env.put(n, b);
            await env.store.refresh();
            assert.equal(env.read(S), W.canon, 'canon(W), a function of V(W) only');
            assert.equal(env.names().filter(n => n.includes('sync-conflict')).length, 0);
        } finally {
            env.cleanup();
        }
    }
});
const enc2 = s => new TextEncoder().encode(`${s}\n`);

test('[P2-T7] 2.2 step 3(c) / 4 (d): only c1, c2, c3 conflict files are deleted; anything else is kept', withEnv({}, async env => {
    const U = mk({rev: 1, text: 'u', updated: at(280)});       // loser, copy possible  -> c3
    const Tomb = mk({rev: 1, text: '', deleted: true, updated: at(290)});   // c2
    const Blocked = mk({rev: 1, text: 'b', updated: at(270)});  // loser whose copy slot is taken -> kept
    env.putRec(S, W);
    env.putRec(conflictName(X, 1), W);                          // c1
    env.putRec(conflictName(X, 2), U);                          // c3
    env.putRec(conflictName(X, 3), Tomb);                       // c2
    env.putRec(conflictName(X, 4), Blocked);                    // kept
    env.putRec(copyName(Blocked), mk({id: copyOf(Blocked).id, text: 'someone else', conflict_of: X}));
    env.put(conflictName(X, 5), 'not a record');                // UNKNOWN: untouched
    env.put(`${X}.sync-conflict-garbage.json`, 'not a candidate name: untouched');
    env.put(conflictName(X, 6), {schema: 2, id: X});            // NEWER: untouched
    env.putRec(conflictName(X, 7), mk({updated: new Date(T0 + 40 * 3600 * 1000).toISOString(), text: 'future'}));   // QUARANTINED
    const blockedBytes = env.read(copyName(Blocked));
    const r = await env.store.refresh();
    assert.deepEqual(env.names(), sorted(S, copyName(U), copyName(Blocked), conflictName(X, 4), conflictName(X, 5),
        `${X}.sync-conflict-garbage.json`, conflictName(X, 6), conflictName(X, 7)));
    assert.equal(env.read(copyName(Blocked)), blockedBytes, 'the occupied slot was not overwritten');
    assert.ok(env.warned(/conflict file .*0001\.sync-conflict.*-ABCDEFG\.json kept|conflict file .*kept: its version is neither/));
    assert.ok(r.stats.unsettled.includes(X));
}));

test('[P2-T5] 2.2 step 1: the copy slot is free, holds the expected copy, or is taken (never overwritten, loser not preserved)', async () => {
    const slotCases = {
        free: null,
        expected: () => copyOf(D).bytes,
        'another valid record': () => rec({id: copyOf(D).id, text: 'planted in advance', conflict_of: X}).bytes,
        'the same text but conflict_of null': () => rec({id: copyOf(D).id, text: D.text, rev: D.rev, updated: D.updated, created: D.created, device: D.device}).bytes,
        'an UNKNOWN file': () => enc2('{garbage'),
        'a NEWER file': () => jsonBytes({schema: 2, id: copyOf(D).id}),
    };
    for (const [label, slot] of Object.entries(slotCases)) {
        const env = makeEnv();
        try {
            await env.start();
            env.putRec(S, W);
            env.putRec(conflictName(X), D);
            if (slot)
                env.put(copyName(D), slot());
            const slotBefore = slot ? env.read(copyName(D)) : null;
            await env.store.refresh();
            if (label === 'free' || label === 'expected') {
                assert.equal(env.read(copyName(D)), copyOf(D).canon, label);
                assert.equal(env.has(conflictName(X)), false, `${label}: L is preserved, its conflict file goes (c3)`);
            } else {
                assert.equal(env.read(copyName(D)), slotBefore, `${label}: never overwritten`);
                assert.equal(env.has(conflictName(X)), true, `${label}: L is NOT preserved, its file stays`);
            }
        } finally {
            env.cleanup();
        }
    }
    // non-regular entries in the slot: a directory and a FIFO
    for (const kind of ['directory', 'fifo']) {
        const env = makeEnv();
        try {
            await env.start();
            env.putRec(S, W);
            env.putRec(conflictName(X), D);
            const p = path.join(env.dirs.notes, copyName(D));
            if (kind === 'directory')
                fs.mkdirSync(p);
            else
                execFileSync('mkfifo', [p]);
            await env.store.refresh();
            assert.equal(env.has(conflictName(X)), true, kind);
            assert.equal(fs.lstatSync(p).isFile(), false, `${kind} untouched`);
        } finally {
            env.cleanup();
        }
    }
});

test('[P2-T4] 2.2 step 0: a FROZEN group writes, overwrites and deletes nothing; it lifts when <X>.json becomes valid', async () => {
    const future = new Date(T0 + 40 * 3600 * 1000).toISOString();
    const makers = {
        unknown: env => env.put(S, 'garbage'),
        newer: env => env.put(S, {schema: 2, id: X, text: 'later'}),
        quarantined: env => env.putRec(S, mk({updated: future})),
        directory: env => fs.mkdirSync(path.join(env.dirs.notes, S)),
        fifo: env => execFileSync('mkfifo', [path.join(env.dirs.notes, S)]),
        'symlink to a valid file': env => {
            env.putRec('target.json.keep', D);
            fs.symlinkSync(path.join(env.dirs.notes, 'target.json.keep'), path.join(env.dirs.notes, S));
        },
    };
    for (const [label, make] of Object.entries(makers)) {
        const env = makeEnv();
        try {
            await env.start();
            make(env);
            env.putRec(conflictName(X, 1), W);
            env.putRec(conflictName(X, 2), mk({rev: 1, text: 'other', updated: at(250)}));
            // another group must still be resolved while this one is frozen
            const Y = uuid(2);
            env.putRec(`${Y}.json`, rec({id: Y, text: 'y-old', updated: at(300)}));
            env.putRec(conflictName(Y), rec({id: Y, text: 'y-new', rev: 2}));
            const before = env.snapshot();
            const r = await env.store.refresh();
            const after = env.snapshot();
            for (const n of Object.keys(before).filter(n => n.startsWith(X)))
                assert.equal(after[n], before[n], `${label}: ${n} untouched`);
            assert.deepEqual(Object.keys(after).filter(n => n.startsWith(X)), Object.keys(before).filter(n => n.startsWith(X)), label);
            assert.equal(Object.keys(after).some(n => n !== 'target.json.keep' && !n.startsWith(X) && !n.startsWith(Y) && !n.startsWith(fmt.cid(Y, rec({id: Y, text: 'y-old', updated: at(300)}).v))), false, `${label}: no copy of X was made`);
            assert.ok(r.stats.frozen.includes(X), label);
            assert.equal(env.store.getNote(Y).text, 'y-new', `${label}: other groups are resolved`);
            // the freeze is stable (a second round writes nothing more)
            const again = env.snapshot();
            await env.store.refresh();
            assert.deepEqual(env.snapshot(), again, `${label}: stable`);

            if (label === 'quarantined') {
                env.clock.t = T0 + 17 * 3600 * 1000;           // 40 h - 17 h = 23 h ahead: the quarantine is over
                await env.store.refresh();
                assert.equal(env.has(conflictName(X, 1)), false, 'lifted by itself when the quarantine time is reached');
            } else {
                fs.rmSync(path.join(env.dirs.notes, S), {recursive: true, force: true});
                env.putRec(S, D);                               // S becomes a valid record
                await env.store.refresh();
                assert.equal(env.has(conflictName(X, 1)), false, `${label}: lifted when <X>.json is valid`);
                assert.equal(env.read(S), W.canon);
            }
        } finally {
            env.cleanup();
        }
    }
});

test('[P2-T12] 2.2: a DANGLING symlink occupies a name: <X>.json freezes the group, <cid>.json blocks the copy; the link stays', async () => {
    // as <X>.json
    let env = makeEnv();
    try {
        await env.start();
        const link = path.join(env.dirs.notes, S);
        fs.symlinkSync('/nonexistent/target', link);
        env.putRec(conflictName(X), W);
        await env.store.refresh();
        assert.equal(fs.readlinkSync(link), '/nonexistent/target');
        assert.equal(env.has(conflictName(X)), true);
        assert.deepEqual(env.names(), sorted(S, conflictName(X)));
        const r = await env.store.saveNote(X, null, {text: 'mine', color: 'yellow', deleted: false});
        assert.equal(r.ok, false, 'a local save does not replace it either');
        assert.equal(fs.readlinkSync(link), '/nonexistent/target');
    } finally {
        env.cleanup();
    }
    // as <cid>.json
    env = makeEnv();
    try {
        await env.start();
        env.putRec(S, W);
        env.putRec(conflictName(X), D);
        const link = path.join(env.dirs.notes, copyName(D));
        fs.symlinkSync('/nonexistent/target', link);
        await env.store.refresh();
        assert.equal(fs.readlinkSync(link), '/nonexistent/target', 'the copy was not written over the link');
        assert.equal(env.has(conflictName(X)), true, 'L is not preserved, its file stays');
    } finally {
        env.cleanup();
    }
});

test('[P2-T8] 2.2 step 3(b): the bytes of <X>.json are canon(W) of the VALIDATED record, not a re-read of the disk', withEnv({wrap: true}, async env => {
    const Z = mk({rev: 9, text: 'changed on disk after validation', updated: at(50)});
    env.putRec(S, D);
    env.putRec(conflictName(X), W);
    let swapped = false;
    env.layer.hooks.after.push((op, args) => {
        if (op === 'readBytes' && args[0].endsWith(conflictName(X)) && !swapped) {
            swapped = true;
            fs.writeFileSync(args[0], Z.bytes);               // the file is replaced right after it was validated
        }
    });
    await env.store.refresh();
    assert.equal(swapped, true);
    const mv = env.layer.calls.find(c => c.op === 'exchange' && c.args[1].endsWith(`/${S}`));   // S held D: the swap puts W in
    const tmpWrite = env.layer.calls.find(c => c.op === 'writeTmp' && c.args[0] === mv.args[0]);
    assert.deepEqual(Array.from(tmpWrite.args[1]), Array.from(W.bytes), 'the bytes written are canon(W)');
    assert.notDeepEqual(Array.from(W.bytes), Array.from(Z.bytes));
    // the changed conflict file is not deleted on the strength of the old read; the next pass sees it as a new version
    assert.ok(env.warned(/changed since it was read/));
    assert.equal(env.store.getNote(X).text, Z.text, 'the later, greater version then wins by the same rules');
}));

test('[P2-T9] 2.2 step 3(b): D is neither tombstone nor preserved: W is NOT installed, no conflict file deleted, stays unsettled', withEnv({}, async env => {
    const planted = mk({id: copyOf(D).id, text: 'the user edited the copy', conflict_of: X, rev: 4, updated: at(10)});
    env.putRec(S, D);
    env.putRec(conflictName(X), W);
    env.putRec(copyName(D), planted);
    const before = env.snapshot();
    const r = await env.store.refresh();
    assert.deepEqual(env.snapshot(), before, 'nothing written, nothing deleted');
    assert.deepEqual(r.stats.unsettled, [X]);
    assert.equal(env.store.getNote(X).text, 'old', 'the user sees the old text; the newer one waits in the conflict file');
    assert.ok(env.warned(/holds version .* without a copy/));
    const stable = env.snapshot();
    await env.store.refresh();
    assert.deepEqual(env.snapshot(), stable, 'stable, no loop');
    // once the slot is usable the group settles by itself
    fs.rmSync(path.join(env.dirs.notes, copyName(D)));
    await env.store.refresh();
    assert.equal(env.read(S), W.canon);
    assert.equal(env.read(copyName(D)), copyOf(D).canon);
    assert.equal(env.has(conflictName(X)), false);
}));

test('2.6: a write into a FREE slot carries no OVERWRITE: a file that appeared since the check is not replaced', withEnv({wrap: true}, async env => {
    env.putRec(S, W);
    env.putRec(conflictName(X), D);
    const planted = enc2('{"someone":"else"}');
    env.layer.hooks.before.push((op, args) => {
        if (op === 'move' && args[1].endsWith(copyName(D)))
            fs.writeFileSync(args[1], planted);                // appears between the check and the move
    });
    await env.store.refresh();
    assert.equal(env.read(copyName(D)), '{"someone":"else"}\n', 'EEXIST, not replaced');
    assert.equal(env.has(conflictName(X)), true, 'L not preserved this round');
    assert.deepEqual(env.tmpNames(), [], 'our tmp file is removed');
    assert.ok(env.warned(/copy .* not written/));
    const flags = env.layer.calls.filter(c => c.op === 'move' && c.args[1].startsWith(env.dirs.notes)).map(c => [path.basename(c.args[1]), c.args[2].overwrite]);
    assert.ok(flags.every(([n, o]) => o === false || n === S), 'OVERWRITE only on <X>.json replacing a known version');
}));

test('2.6: OVERWRITE exactly where W replaces a known valid version over D; absent <X>.json is written without it', async () => {
    for (const [label, hasS, expectOverwrite] of [['S holds D', true, true], ['S absent', false, false]]) {
        const env = makeEnv({wrap: true});
        try {
            await env.start();
            if (hasS)
                env.putRec(S, D);
            else
                env.putRec(conflictName(X, 2), D);
            env.putRec(conflictName(X, 1), W);
            await env.store.refresh();
            const mv = env.layer.calls.filter(c => c.op === 'move' && c.args[1].startsWith(env.dirs.notes));
            const toS = mv.find(c => c.args[1].endsWith(`/${S}`));
            if (expectOverwrite) {
                // over a known valid D the replacement is an atomic exchange, never a move with OVERWRITE
                assert.equal(toS, undefined, `${label}: no overwriting move into <X>.json`);
                assert.equal(env.layer.calls.filter(c => c.op === 'exchange' && c.args[1].endsWith(`/${S}`)).length, 1, label);
            } else {
                assert.equal(toS.args[2].overwrite, false, label);
            }
            assert.equal(env.read(S), W.canon);
            for (const m of mv.filter(c => !c.args[1].endsWith(`/${S}`)))
                assert.equal(m.args[2].overwrite, false, `${label}: copies never overwrite`);
        } finally {
            env.cleanup();
        }
    }
});

test('[P2-T11] V11 end to end: a loser with canon 262110 (conflict_of null) is copied to exactly 262144 bytes, written and read back', withEnv({}, async env => {
    const padded = n => mk({rev: 1, text: 'big', updated: at(300), extra: {pad: 'a'.repeat(n)}});
    const base = padded(0).bytes.length;
    const L = padded(262110 - base);
    assert.equal(L.bytes.length, 262110);
    env.putRec(S, W);
    env.putRec(conflictName(X), L);
    await env.store.refresh();
    const copy = copyOf(L);
    assert.equal(copy.bytes.length, 262144);
    assert.equal(fs.statSync(path.join(env.dirs.notes, `${copy.id}.json`)).size, 262144);
    assert.equal(env.has(conflictName(X)), false);
    assert.equal(env.store.getNote(copy.id).v, copy.v, 'the next read accepts it (a valid record, group of its own)');
    // 262111 would give 262145: UNKNOWN, so the conflict file is untouched and nothing is copied
    const env2 = makeEnv();
    try {
        await env2.start();
        const L2 = padded(262111 - base);
        env2.putRec(S, W);
        env2.putRec(conflictName(X), L2);
        const before = env2.snapshot();
        await env2.store.refresh();
        assert.deepEqual(env2.snapshot(), before);
    } finally {
        env2.cleanup();
    }
}));

test('2.2: a record whose content id differs from the leading UUID of its name is UNKNOWN and untouched', withEnv({}, async env => {
    env.putRec(S, D);
    env.putRec(conflictName(X, 1), W);
    env.put(conflictName(X, 2), rec({id: uuid(5), text: 'wrong id', rev: 50}).bytes);
    await env.store.refresh();
    assert.equal(env.has(conflictName(X, 2)), true);
    assert.equal(env.read(S), W.canon);
}));

test('first version: with resolveConflicts off (the default of the store) a conflict file is kept, not copied, not deleted, and counted', async () => {
    const env = makeEnv({resolveConflicts: false});
    try {
        await env.start();
        const U = uuid(1);
        env.putRec(`${U}.json`, rec({id: U, text: 'old', updated: at(300)}));
        env.putRec(conflictName(U), rec({id: U, text: 'new', rev: 2}));
        await env.store.refresh();
        const before = env.snapshot();
        assert.equal(env.store.status().unresolved, 1);
        assert.equal(env.store.getNote(U).text, 'old', 'the main file is shown as it is');
        await env.store.refresh({hint: [conflictName(U)]});
        assert.deepEqual(env.snapshot(), before, 'nothing written, nothing deleted');
        assert.equal(createStore({fs: nodeFs(), platform: env.platform, dirs: env.dirs}).resolveConflicts, false, 'off by default');
    } finally {
        env.cleanup();
    }
});
