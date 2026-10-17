// SPDX-License-Identifier: GPL-3.0-or-later
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {makeFormat} from '../../src/format.js';
import {createStore} from '../../src/store.js';
import {nodeFs, recordingFs} from './node-layer.js';
import {nodePlatform, sha1, sha256Hex, T0} from './node-platform.js';

export const fmt = makeFormat({sha256Hex, sha1});
export {T0};

export const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const DEV_A = 'a1b2c3d4';
export const DEV_B = 'b5b5b5b5';

const iso = ms => new Date(ms).toISOString();
export const at = (minutesBeforeNow) => iso(T0 - minutesBeforeNow * 60000);

// A raw record object (what a file holds), with overrides. Plain object: tests may break any rule on purpose.
export function raw(over = {}) {
    return {
        schema: 1, id: uuid(1), rev: 1, updated: at(120), created: at(180), device: DEV_A, color: 'yellow',
        text: 'milk, bread', deleted: false, conflict_of: null, ...over,
    };
}

// A validated record (with canon/bytes/v) built the way the core builds it.
export function rec(over = {}) {
    const r = raw(over);
    const {extra, ...fields} = r;
    return fmt.makeRecord(fields, new Map(Object.entries(extra ?? {})));
}

export const enc = s => new TextEncoder().encode(s);
export const jsonBytes = (obj, pretty = false) => enc(`${JSON.stringify(obj, null, pretty ? 2 : 0)}\n`);

export function makeEnv({wrap = false, maxNotes, tmpOnOtherFs = false, resolveConflicts = true} = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetli-t-'));
    const dirs = {
        notes: path.join(root, 'data/notes'),
        tmp: path.join(root, 'data/tmp'),
        state: path.join(root, 'state'),
    };
    let shm = null;
    if (tmpOnOtherFs) {
        shm = fs.mkdtempSync('/dev/shm/cetli-t-');
        dirs.tmp = shm;
    }
    const inner = nodeFs();
    const layer = wrap ? recordingFs(inner) : inner;
    const {platform, clock, lines} = nodePlatform();
    const store = createStore({fs: layer, platform, dirs, maxNotes, resolveConflicts});
    const env = {
        root, dirs, store, layer, clock, lines, platform, shm,
        events: [],
        async start() {
            store.onEvent(ev => env.events.push(ev));
            await store.start();
            return env;
        },
        // What the transport does: put bytes into notes/ (not through the core).
        put(name, content) {
            fs.mkdirSync(dirs.notes, {recursive: true});
            const data = typeof content === 'string' || content instanceof Uint8Array ? content : jsonBytes(content);
            fs.writeFileSync(path.join(dirs.notes, name), data);
        },
        putRec(name, r) {
            env.put(name, r.bytes);
        },
        read: name => fs.readFileSync(path.join(dirs.notes, name), 'utf8'),
        has: name => fs.existsSync(path.join(dirs.notes, name)) || isLink(path.join(dirs.notes, name)),
        names: () => fs.readdirSync(dirs.notes).sort(),
        tmpNames: () => fs.readdirSync(dirs.tmp).sort(),
        snapshot() {
            const out = {};
            for (const n of fs.readdirSync(dirs.notes).sort()) {
                const p = path.join(dirs.notes, n);
                const st = fs.lstatSync(p);
                out[n] = st.isFile() ? fs.readFileSync(p, 'utf8') : st.isSymbolicLink() ? `->${fs.readlinkSync(p)}` : `<${st.isDirectory() ? 'dir' : 'special'}>`;
            }
            return out;
        },
        warned: re => lines.some(l => re.test(l)),
        cleanup() {
            fs.rmSync(root, {recursive: true, force: true});
            if (shm)
                fs.rmSync(shm, {recursive: true, force: true});
        },
    };
    return env;
}

function isLink(p) {
    try {
        fs.lstatSync(p);
        return true;
    } catch {
        return false;
    }
}

export function conflictName(id, n = 1, by = 'ABCDEFG') {
    return `${id}.sync-conflict-20261017-1200${String(n).padStart(2, '0')}-${by}.json`;
}

// Mulberry32: tiny seeded PRNG for the convergence test.
export function prng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
