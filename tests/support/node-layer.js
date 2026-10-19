// SPDX-License-Identifier: GPL-3.0-or-later
// Test-side file layer: the same contract as src/gio-layer.js (see store.js), built on the REAL file system through
// node:fs. Differences from GLib that matter and are NOT hidden:
//  - a move without `overwrite` is link(2) + unlink(2) (fails with EEXIST on any entry, a dangling symlink included),
//    GLib does "test, then rename" (PLAN 2.6, [H]); both refuse an existing target, only the race window differs;
//  - EXDEV (rename across filesystems) is mapped to NOT_SUPPORTED, as GLib's NO_FALLBACK_FOR_MOVE would answer
//    G_IO_ERROR_NOT_SUPPORTED [H]; fs.rename never falls back to copy-and-delete.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import {FS, FsError} from '../../src/fs-error.js';

function map(e) {
    if (e instanceof FsError)
        return e;
    const code = {ENOENT: FS.NOT_FOUND, EEXIST: FS.EXISTS, EXDEV: FS.NOT_SUPPORTED, ENOSPC: FS.NO_SPACE}[e.code] ?? FS.IO;
    return new FsError(code, e.message);
}

function describe(st) {
    let type = 'unknown';
    if (st.isFile()) type = 'regular';
    else if (st.isDirectory()) type = 'directory';
    else if (st.isSymbolicLink()) type = 'symlink';
    else if (st.isFIFO() || st.isSocket() || st.isCharacterDevice() || st.isBlockDevice()) type = 'special';
    return {type, size: Number(st.size), mtime: Number(st.mtimeNs / 1000n)};
}

// Node has no renameat2: the exchange is the real system call through python3 ctypes (RENAME_EXCHANGE = 2, AT_FDCWD = -100).
// exit code = errno of the call (0 = swapped). 127 = no python3 / no libc symbol: NOT_SUPPORTED, the store then falls back.
const EXCHANGE_PY = 'import ctypes,sys\nl=ctypes.CDLL(None,use_errno=True)\nr=l.renameat2(-100,sys.argv[1].encode(),-100,sys.argv[2].encode(),2)\nsys.exit(0 if r==0 else ctypes.get_errno())';
const ERRNO = {2: FS.NOT_FOUND, 22: FS.NOT_SUPPORTED, 38: FS.NOT_SUPPORTED, 95: FS.NOT_SUPPORTED, 18: FS.NOT_SUPPORTED};

function exchangeSync(a, b) {
    const r = spawnSync('python3', ['-c', EXCHANGE_PY, a, b], {encoding: 'utf8'});
    const code = r.error ? 127 : r.status;
    if (code !== 0)
        throw new FsError(ERRNO[code] ?? (code === 127 ? FS.NOT_SUPPORTED : FS.IO), `exchange ${a} <-> ${b}: errno ${code}`);
}

export function nodeFs() {
    return {
        async listDir(dir) {
            try {
                const out = [];
                for (const name of await fs.promises.readdir(dir)) {
                    try {
                        out.push({name, ...describe(await fs.promises.lstat(`${dir}/${name}`, {bigint: true}))});
                    } catch (e) {
                        if (e.code !== 'ENOENT')
                            throw e;
                    }
                }
                return out;
            } catch (e) {
                throw map(e);
            }
        },
        async stat(path) {
            try {
                return describe(await fs.promises.lstat(path, {bigint: true}));
            } catch (e) {
                if (e.code === 'ENOENT')
                    return null;
                throw map(e);
            }
        },
        async readBytes(path) {
            try {
                return new Uint8Array(await fs.promises.readFile(path));
            } catch (e) {
                throw map(e);
            }
        },
        async writeTmp(path, bytes) {
            let fh;
            try {
                fh = await fs.promises.open(path, 'wx', 0o600);
                await fh.writeFile(bytes);
                await fh.sync();
                await fh.close();
            } catch (e) {
                try { await fh?.close(); } catch { /* ignore */ }
                try { await fs.promises.unlink(path); } catch { /* ignore */ }
                throw map(e);
            }
        },
        async move(src, dest, {overwrite}) {
            try {
                if (overwrite) {
                    await fs.promises.rename(src, dest);
                } else {
                    await fs.promises.link(src, dest);
                    await fs.promises.unlink(src);
                }
            } catch (e) {
                throw map(e);
            }
        },
        async exchange(a, b) {
            exchangeSync(a, b);
        },
        async remove(path) {
            try {
                await fs.promises.unlink(path);
            } catch (e) {
                throw map(e);
            }
        },
        async ensureDir(dir) {
            try {
                await fs.promises.mkdir(dir, {recursive: true, mode: 0o700});
            } catch (e) {
                throw map(e);
            }
        },
    };
}

// Wraps a layer: records every call and lets a test inject a failure (`before`) or a side effect (`after`).
export function recordingFs(inner) {
    const calls = [];
    const hooks = {before: [], after: []};
    const wrapped = {calls, hooks};
    for (const op of Object.keys(inner)) {
        wrapped[op] = async (...args) => {
            calls.push({op, args});
            for (const h of hooks.before)
                await h(op, args);
            const result = await inner[op](...args);
            for (const h of hooks.after)
                await h(op, args, result);
            return result;
        };
    }
    return wrapped;
}
