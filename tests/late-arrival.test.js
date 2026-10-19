// SPDX-License-Identifier: GPL-3.0-or-later
// 0.2.7.1: the resolution must not destroy a version of a note that the transport brings in WHILE it runs. The slot
// <X>.json is replaced by an atomic exchange; what the exchange takes out and nobody else has a copy of goes to backup/
// (outside the synced folder, at most 32 files). Without an exchange in the layer the stat before the move is all there is.
// The sweep over every injection point is tests/f1prime-late-injection.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {FS, FsError} from '../src/fs-error.js';
import {DEV_B, at, conflictName, fmt, makeEnv, rec, uuid} from './support/helpers.js';

const X = uuid(1);
const S = `${X}.json`;
const mk = over => rec({id: X, ...over});
const D = mk({rev: 1, text: 'old', updated: at(300)});
const W = mk({rev: 2, text: 'new', updated: at(200), device: DEV_B});
const D2 = mk({rev: 3, text: 'THE NEWEST TEXT FROM THE OTHER MACHINE', updated: at(100), device: DEV_B});

const withEnv = (opts, fn) => async () => {
    const env = makeEnv({wrap: true, ...opts});
    try {
        await env.start();
        await fn(env);
    } finally {
        env.cleanup();
    }
};

const backupDir = env => path.join(path.dirname(env.dirs.tmp), 'backup');
const backups = env => {
    try {
        return fs.readdirSync(backupDir(env)).sort();
    } catch {
        return [];
    }
};
const backupText = env => backups(env).map(n => fs.readFileSync(path.join(backupDir(env), n), 'utf8')).join('\n');
// what the transport does: a temp file renamed into place
const arrive = (env, name, bytes) => {
    const tmp = path.join(env.dirs.notes, '.syncthing.late.tmp');
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, path.join(env.dirs.notes, name));
};
const putD2On = (env, op, test) => {
    let done = false;
    env.layer.hooks.before.push((o, args) => {
        if (!done && o === op && test(args)) {
            done = true;
            arrive(env, S, D2.bytes);
        }
    });
    return () => done;
};
const leftovers = env => env.tmpNames().filter(n => n.endsWith('.x') || n.endsWith('.tmp'));

test('F1: a newer version arrives in <X>.json after the scan: its text is kept in backup/, W is in place, tmp/ is clean', withEnv({}, async env => {
    env.putRec(S, D);
    env.putRec(conflictName(X), W);
    const copyId = `${fmt.expectedCopy(D, X).id}.json`;
    const fired = putD2On(env, 'move', args => args[1].endsWith(copyId));
    await env.store.refresh();
    assert.equal(fired(), true);
    assert.equal(env.read(S), W.canon);
    assert.match(backupText(env), /THE NEWEST TEXT FROM THE OTHER MACHINE/);
    assert.equal(backups(env).length, 1);
    assert.deepEqual(leftovers(env), []);
    assert.ok(env.warned(/changed while it was replaced/));
}));

test('no race: the replaced D has its copy, nothing is put in backup/ and nothing is left in tmp/', withEnv({}, async env => {
    env.putRec(S, D);
    env.putRec(conflictName(X), W);
    await env.store.refresh();
    assert.equal(env.read(S), W.canon);
    assert.deepEqual(backups(env), []);
    assert.deepEqual(leftovers(env), []);
}));

test('an arrival that is the same version as D (rewritten by the transport) is not kept: D has its copy', withEnv({}, async env => {
    env.putRec(S, D);
    env.putRec(conflictName(X), W);
    const pretty = Buffer.from(JSON.stringify(JSON.parse(D.canon), null, 2));
    let done = false;
    env.layer.hooks.before.push((op, args) => {
        if (!done && op === 'exchange') {
            done = true;
            arrive(env, S, pretty);
        }
    });
    await env.store.refresh();
    assert.equal(done, true);
    assert.equal(env.read(S), W.canon);
    assert.deepEqual(backups(env), []);
}));

test('empty <X>.json at the scan: the group is FROZEN, nothing is written, nothing is backed up', withEnv({}, async env => {
    env.put(S, '');
    env.putRec(conflictName(X), W);
    const before = env.snapshot();
    const r = await env.store.refresh();
    assert.deepEqual(env.snapshot(), before);
    assert.deepEqual(r.stats.frozen.length, 1);
    assert.deepEqual(backups(env), []);
}));

test('<X>.json becomes empty after the scan: W goes in, an empty file holds no text, nothing is backed up', withEnv({}, async env => {
    env.putRec(S, D);
    env.putRec(conflictName(X), W);
    let done = false;
    env.layer.hooks.before.push((op) => {
        if (!done && op === 'exchange') {
            done = true;
            arrive(env, S, '');
        }
    });
    await env.store.refresh();
    assert.equal(done, true);
    assert.equal(env.read(S), W.canon);
    assert.deepEqual(backups(env), []);
    assert.deepEqual(leftovers(env), []);
}));

test('a late arrival that is not a readable record (garbage text, a newer schema) is kept as well', withEnv({}, async env => {
    env.putRec(S, D);
    env.putRec(conflictName(X), W);
    let done = false;
    env.layer.hooks.before.push((op) => {
        if (!done && op === 'exchange') {
            done = true;
            arrive(env, S, '{"schema": 9, "text": "FROM A NEWER CETLI"}');
        }
    });
    await env.store.refresh();
    assert.equal(env.read(S), W.canon);
    assert.match(backupText(env), /FROM A NEWER CETLI/);
}));

test('<X>.json vanishes after the scan: the exchange finds nothing to swap, W is not installed on that attempt (a later pass does), tmp/ is clean', withEnv({}, async env => {
    env.putRec(S, D);
    env.putRec(conflictName(X), W);
    let done = false;
    env.layer.hooks.before.push((op) => {
        if (!done && op === 'exchange') {
            done = true;
            fs.unlinkSync(path.join(env.dirs.notes, S));
        }
    });
    await env.store.refresh();
    assert.equal(done, true);
    assert.ok(env.warned(/vanished since it was read/));
    assert.ok(env.warned(/exchange CHANGED/), 'the failed attempt is reported');
    assert.equal(env.read(S), W.canon, 'the next pass finds the slot free and installs W');
    assert.deepEqual(leftovers(env), []);
    assert.deepEqual(backups(env), []);
}));

test('no exchange in the layer: the stat before the move catches a late arrival (CHANGED), D2 stays where it is', withEnv({}, async env => {
    delete env.layer.exchange;
    env.putRec(S, D);
    env.putRec(conflictName(X), W);
    const copyId = `${fmt.expectedCopy(D, X).id}.json`;
    const fired = putD2On(env, 'move', args => args[1].endsWith(copyId));
    await env.store.refresh();
    assert.equal(fired(), true);
    assert.ok(env.warned(/check CHANGED/), 'the stat before the move saw the arrival');
    assert.equal(JSON.parse(env.read(S)).text, D2.text, 'D2 was not overwritten; it won the next pass by the usual rule');
    assert.deepEqual(backups(env), []);
    const all = env.names().map(n => env.read(n)).join('\n');
    assert.match(all, /THE NEWEST TEXT FROM THE OTHER MACHINE/, 'the text of D2 is still in notes/');
    assert.deepEqual(leftovers(env), []);
}));

test('an exchange the system cannot do (NOT_SUPPORTED) falls back to the checked move and says so once', withEnv({}, async env => {
    env.layer.hooks.before.push(op => {
        if (op === 'exchange')
            throw new FsError(FS.NOT_SUPPORTED, 'no renameat2');
    });
    env.putRec(S, D);
    env.putRec(conflictName(X), W);
    await env.store.refresh();
    assert.equal(env.read(S), W.canon);
    assert.ok(env.warned(/atomic exchange is not available/));
    assert.deepEqual(leftovers(env), []);
}));

test('a layer that supports the exchange is used: exactly one exchange, no fallback line (a silent fall-back to the check is a failure)', withEnv({wrap: true}, async env => {
    const ops = [];
    const firstArgs = [];
    env.layer.hooks.before.push((op, args) => {
        ops.push(op);
        if (op === 'exchange')
            firstArgs.push(args[0]);
    });
    env.putRec(S, D);
    env.putRec(conflictName(X), W);
    await env.store.refresh();
    assert.equal(env.read(S), W.canon);
    assert.equal(ops.filter(o => o === 'exchange').length, 1, 'the slot was replaced by the swap');
    // the swap partner is what the start-up cleaning keeps in backup/ (the HOLD name), not what it deletes (the .tmp name)
    assert.equal(path.dirname(firstArgs[0]), env.dirs.tmp);
    assert.match(path.basename(firstArgs[0]), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.x$/, 'the partner of the exchange has the HOLD name');
    assert.equal(env.warned(/atomic exchange is not available/), false, 'a supported layer never reports the fall-back');
    assert.deepEqual(leftovers(env), []);
}));

test('EXDEV: tmp/ on another file system, the real swap answers EXDEV -> falls back, loses nothing, says so once', async () => {
    const env = makeEnv({tmpOnOtherFs: true, wrap: true});
    try {
        await env.start();
        env.putRec(S, D);
        env.putRec(conflictName(X), W);
        const copy = fmt.expectedCopy(D, X);
        env.put(`${copy.id}.json`, copy.bytes);           // D already has its copy, so the install of W is reached
        let swaps = 0;
        env.layer.hooks.before.push(op => { if (op === 'exchange') swaps++; });
        await env.store.refresh();
        await env.store.refresh();
        assert.ok(swaps >= 2, 'the swap was tried on every attempt');
        assert.equal(env.lines.filter(l => /atomic exchange is not available/.test(l)).length, 1, 'logged once, not once per attempt');
        assert.equal(env.read(S), D.canon, 'the note in the slot is untouched (the move across file systems is refused too)');
        assert.equal(env.read(conflictName(X)), W.canon, 'the conflict file is untouched: nothing was lost');
        assert.deepEqual(leftovers(env), []);
    } finally {
        env.cleanup();
    }
});

test('backup/ is bounded: 32 files, the oldest go first', withEnv({}, async env => {
    for (let i = 0; i < 40; i++) {
        env.clock.t += 1000;
        const x = uuid(100 + i);
        const d = rec({id: x, rev: 1, text: `old ${i}`, updated: at(300)});
        const w = rec({id: x, rev: 2, text: `new ${i}`, updated: at(200), device: DEV_B});
        const late = rec({id: x, rev: 3, text: `LATE-${i}`, updated: at(100), device: DEV_B});
        env.putRec(`${x}.json`, d);
        env.putRec(conflictName(x), w);
        let done = false;
        const hook = (op) => {
            if (!done && op === 'exchange') {
                done = true;
                arrive(env, `${x}.json`, late.bytes);
            }
        };
        env.layer.hooks.before.push(hook);
        await env.store.refresh();
        env.layer.hooks.before.splice(env.layer.hooks.before.indexOf(hook), 1);
        assert.equal(done, true, `round ${i}`);
    }
    const text = backupText(env);
    assert.equal(backups(env).length, 32);
    assert.match(text, /LATE-39/);
    assert.match(text, /LATE-8\b/);
    assert.doesNotMatch(text, /LATE-7\b/);
}));

// the prune must never drop the file it has just written, and orphans count like every other backup
const lateRound = async (env, i) => {
    env.clock.t += 1000;
    const x = uuid(100 + i);
    env.putRec(`${x}.json`, rec({id: x, rev: 1, text: `old ${i}`, updated: at(300)}));
    env.putRec(conflictName(x), rec({id: x, rev: 2, text: `new ${i}`, updated: at(200), device: DEV_B}));
    const late = rec({id: x, rev: 3, text: `LATE-${i}`, updated: at(100), device: DEV_B});
    let done = false;
    const hook = op => {
        if (!done && op === 'exchange') {
            done = true;
            arrive(env, `${x}.json`, late.bytes);
        }
    };
    env.layer.hooks.before.push(hook);
    await env.store.refresh();
    env.layer.hooks.before.splice(env.layer.hooks.before.indexOf(hook), 1);
    assert.equal(done, true, `round ${i}`);
};

test('backup/: the clock went back and 32 later-stamped backups exist: the new backup is kept, an older-named one goes', withEnv({}, async env => {
    fs.mkdirSync(backupDir(env), {recursive: true});
    for (let i = 0; i < 32; i++)
        fs.writeFileSync(path.join(backupDir(env), `999999999999999-${String(i).padStart(6, '0')}-aaaaaaaa.json`), `FUTURE-${i}`);
    await lateRound(env, 0);
    const text = backupText(env);
    assert.equal(backups(env).length, 32);
    assert.match(text, /LATE-0\b/, 'the backup written now is not the one the prune removes');
    assert.doesNotMatch(text, /FUTURE-0\b/, 'the lowest name of the others went instead');
    assert.match(text, /FUTURE-31\b/);
}));

test('backup/: orphans (a swap partner left by a crash) are counted in the 32 and pruned like the others', async () => {
    const env = makeEnv({wrap: true});
    try {
        fs.mkdirSync(env.dirs.tmp, {recursive: true});
        for (let i = 0; i < 40; i++)
            fs.writeFileSync(path.join(env.dirs.tmp, `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}.x`), `{"text":"ORPHAN-${i}"}`);
        await env.start();
        assert.deepEqual(env.tmpNames(), []);
        assert.equal(backups(env).length, 32, '40 orphans, at most 32 files');
    } finally {
        env.cleanup();
    }
});

test('start-up: a swap partner left by a crash (*.x) is kept in backup/, a *.tmp leftover is deleted', async () => {
    const env = makeEnv({wrap: true});
    try {
        fs.mkdirSync(env.dirs.tmp, {recursive: true});
        fs.writeFileSync(path.join(env.dirs.tmp, 'bbbbbbbb-0000-4000-8000-000000000001.x'), '{"text":"TAKEN OUT BEFORE THE CRASH"}');
        fs.writeFileSync(path.join(env.dirs.tmp, 'bbbbbbbb-0000-4000-8000-000000000002.x'), '');
        fs.writeFileSync(path.join(env.dirs.tmp, 'bbbbbbbb-0000-4000-8000-000000000003.tmp'), 'junk');
        await env.start();
        assert.deepEqual(env.tmpNames(), []);
        assert.match(backupText(env), /TAKEN OUT BEFORE THE CRASH/);
        assert.equal(backups(env).length, 1, 'the empty one holds no text');
    } finally {
        env.cleanup();
    }
});

test('a NEW conflict file arriving while the group is resolved is untouched and loses no text', withEnv({}, async env => {
    env.putRec(S, D);
    env.putRec(conflictName(X, 1), W);
    const late = mk({rev: 5, text: 'TEXT OF THE LATE CONFLICT FILE', updated: at(10), device: DEV_B});
    let done = false;
    env.layer.hooks.before.push((op, args) => {
        if (!done && op === 'exchange') {
            done = true;
            fs.writeFileSync(path.join(env.dirs.notes, conflictName(X, 2, 'LATECOM')), late.bytes);
        }
    });
    await env.store.refresh();
    await env.store.refresh();
    assert.equal(done, true);
    const everywhere = [...env.names().map(n => env.read(n)), backupText(env)].join('\n');
    assert.match(everywhere, /TEXT OF THE LATE CONFLICT FILE/);
    assert.equal(env.store.getNote(X).text, late.text, 'the greater version wins by the usual rule');
}));

test('a conflict file that changes after the scan is put back, not deleted', withEnv({}, async env => {
    env.putRec(S, D);
    env.putRec(conflictName(X, 1), W);
    const newer = mk({rev: 7, text: 'CONFLICT FILE REWRITTEN AFTER THE SCAN', updated: at(5), device: DEV_B});
    let done = false;
    env.layer.hooks.before.push((op, args) => {
        // the deletion of a conflict file is a move to tmp/ (the capture)
        if (!done && op === 'move' && args[0].endsWith(conflictName(X, 1))) {
            done = true;
            fs.writeFileSync(args[0], newer.bytes);
        }
    });
    await env.store.refresh();
    assert.equal(done, true);
    assert.ok(env.warned(/changed since it was read/));
    const everywhere = [...env.names().map(n => env.read(n)), backupText(env)].join('\n');
    assert.match(everywhere, /CONFLICT FILE REWRITTEN AFTER THE SCAN/);
    assert.equal(JSON.parse(env.read(S)).text, newer.text, 'it went back under its own name, so the same run saw it as a new version and it won');
    assert.deepEqual(backups(env), []);
    assert.deepEqual(leftovers(env), []);
}));

test('tmp/ on another file system cannot take a rename: the deletion of a conflict file is the old checked delete', async () => {
    const env = makeEnv({tmpOnOtherFs: true});
    try {
        await env.start();
        env.putRec(S, W);
        env.putRec(conflictName(X), W);
        await env.store.refresh();
        assert.deepEqual(env.names(), [S]);
    } finally {
        env.cleanup();
    }
});

test('tmp/ on another file system: a conflict file that changed after the scan is not deleted (checked stat, then delete)', async () => {
    const env = makeEnv({tmpOnOtherFs: true, wrap: true});
    try {
        await env.start();
        env.putRec(S, W);
        env.putRec(conflictName(X), W);
        const newer = mk({rev: 7, text: 'REWRITTEN ON ANOTHER FILE SYSTEM SETUP', updated: at(5), device: DEV_B});
        let done = false;
        env.layer.hooks.after.push((op, args) => {
            if (!done && op === 'readBytes' && args[0].endsWith(conflictName(X))) {
                done = true;
                fs.writeFileSync(args[0], newer.bytes);
            }
        });
        await env.store.refresh();
        assert.equal(done, true);
        assert.ok(env.warned(/changed since it was read/));
        assert.match(env.names().map(n => env.read(n)).join('\n'), /REWRITTEN ON ANOTHER FILE SYSTEM SETUP/);
    } finally {
        env.cleanup();
    }
});
