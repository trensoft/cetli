// SPDX-License-Identifier: GPL-3.0-or-later
// The ONLY module of the core that imports `gi://` (Gio, GLib; nothing else, D3). It implements the file layer and the
// platform that store.js and watcher.js expect (see the contract in store.js) on top of Gio/GLib, as thinly as possible.
//
// STATUS: NOT RUN. There is no gjs in the fleet containers (measured 2026-10-17), so no line of this file has been
// executed; it is only syntax-checked (`node --check`) and read against the GLib/Gio documentation. The rename, fsync,
// NO_FALLBACK_FOR_MOVE, NOFOLLOW_SYMLINKS and FileMonitor behaviour named in PLAN.md are NOT MEASURED. The first real run
// is P4 (`%check` under gjs) or Attila's machine.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {FS, FsError} from './fs-error.js';

Gio._promisify(Gio.File.prototype, 'enumerate_children_async', 'enumerate_children_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async', 'next_files_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async', 'close_finish');
Gio._promisify(Gio.File.prototype, 'query_info_async', 'query_info_finish');
Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.Subprocess.prototype, 'wait_check_async', 'wait_check_finish');

const ATTRS = 'standard::name,standard::type,standard::size,time::modified,time::modified-usec';
const NOFOLLOW = Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS;
const PRIO = GLib.PRIORITY_DEFAULT;
// The only process the core starts (see exchange()): a fixed argv, no shell, an absolute path, no PATH search.
const MV = '/usr/bin/mv';

function mapError(e) {
    if (e instanceof FsError)
        return e;
    let code = FS.IO;
    if (e instanceof GLib.Error) {
        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) || e.matches(GLib.FileError, GLib.FileError.NOENT))
            code = FS.NOT_FOUND;
        else if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS) || e.matches(GLib.FileError, GLib.FileError.EXIST))
            code = FS.EXISTS;
        else if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_SUPPORTED))
            code = FS.NOT_SUPPORTED;
        else if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NO_SPACE) || e.matches(GLib.FileError, GLib.FileError.NOSPC))
            code = FS.NO_SPACE;
    }
    return new FsError(code, e?.message);
}

const TYPE = {
    [Gio.FileType.REGULAR]: 'regular',
    [Gio.FileType.DIRECTORY]: 'directory',
    [Gio.FileType.SYMBOLIC_LINK]: 'symlink',
    [Gio.FileType.SPECIAL]: 'special',
};

function describe(info) {
    const dt = info.get_modification_date_time();
    return {
        type: TYPE[info.get_file_type()] ?? 'unknown',
        size: info.get_size(),
        mtime: dt === null ? 0 : dt.to_unix() * 1e6 + dt.get_microsecond(),
    };
}

const fileOf = path => Gio.File.new_for_path(path);

export const fs = {
    async listDir(dir) {
        try {
            const en = await fileOf(dir).enumerate_children_async(ATTRS, NOFOLLOW, PRIO, null);
            const out = [];
            for (;;) {
                const infos = await en.next_files_async(64, PRIO, null);
                if (infos.length === 0)
                    break;
                for (const info of infos)
                    out.push({name: info.get_name(), ...describe(info)});
            }
            await en.close_async(PRIO, null);
            return out;
        } catch (e) {
            throw mapError(e);
        }
    },

    // null only if there is no entry at all; a dangling symlink is an entry (NOFOLLOW_SYMLINKS).
    async stat(path) {
        try {
            return describe(await fileOf(path).query_info_async(ATTRS, NOFOLLOW, PRIO, null));
        } catch (e) {
            const m = mapError(e);
            if (m.code === FS.NOT_FOUND)
                return null;
            throw m;
        }
    },

    async readBytes(path) {
        try {
            const res = await fileOf(path).load_contents_async(null);
            // GJS returns [contents, etag] for the promisified call (older docs show [ok, contents, etag]):
            // take the Uint8Array wherever it is.
            const contents = Array.isArray(res) ? res.find(x => x instanceof Uint8Array) : res;
            if (!(contents instanceof Uint8Array))
                throw new FsError(FS.IO, 'load_contents returned no bytes');
            return contents;
        } catch (e) {
            throw mapError(e);
        }
    },

    // Section 1.5: data is written and fsync-ed before the file is in place (GLib 2.66 and later). CONSISTENT alone does
    // not fsync a NEW file (and every tmp name is new); DURABLE does.
    async writeTmp(path, bytes) {
        try {
            GLib.file_set_contents_full(path, bytes, GLib.FileSetContentsFlags.CONSISTENT | GLib.FileSetContentsFlags.DURABLE, 0o600);
        } catch (e) {
            throw mapError(e);
        }
    },

    // Section 1.5 / 2.6: EVERY move carries NO_FALLBACK_FOR_MOVE; OVERWRITE only where the caller says so.
    async move(src, dest, {overwrite}) {
        try {
            const flags = Gio.FileCopyFlags.NO_FALLBACK_FOR_MOVE | (overwrite ? Gio.FileCopyFlags.OVERWRITE : Gio.FileCopyFlags.NONE);
            fileOf(src).move(fileOf(dest), flags, null, null);
        } catch (e) {
            throw mapError(e);
        }
    },

    // Atomic swap of two existing entries (renameat2 RENAME_EXCHANGE). GLib/Gio has no binding for it; coreutils 9.5 and later
    // has `mv --exchange` (measured: CentOS Stream 10 root 9.5, Fedora 43 root 9.7, outside gjs). mv does not say WHY it
    // failed ("Unknown error -1"), so a missing entry is found by looking. Any other failure is NOT_SUPPORTED (an older mv, a
    // file system without the call): the store then replaces after a check instead.
    async exchange(a, b) {
        try {
            const p = Gio.Subprocess.new([MV, '-T', '--exchange', '--', a, b],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            await p.wait_check_async(null);
        } catch (e) {
            for (const path of [a, b]) {
                try {
                    fileOf(path).query_info(ATTRS, NOFOLLOW, null);
                } catch (e2) {
                    if (e2 instanceof GLib.Error && e2.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                        throw new FsError(FS.NOT_FOUND, `${path} does not exist`);
                }
            }
            throw new FsError(FS.NOT_SUPPORTED, e?.message);
        }
    },

    async remove(path) {
        try {
            fileOf(path).delete(null);
        } catch (e) {
            throw mapError(e);
        }
    },

    async ensureDir(dir) {
        if (GLib.mkdir_with_parents(dir, 0o700) !== 0)
            throw new FsError(FS.IO, `cannot create ${dir}`);
    },
};


export const platform = {
    sha256Hex: bytes => GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, new GLib.Bytes(bytes)),
    sha1(bytes) {
        const cs = new GLib.Checksum(GLib.ChecksumType.SHA1);
        cs.update(bytes);
        const h = cs.get_string();
        return Uint8Array.from({length: 20}, (_, i) => parseInt(h.slice(i * 2, i * 2 + 2), 16));
    },
    now: () => Math.floor(GLib.get_real_time() / 1000),
    randomUuid: () => GLib.uuid_string_random(),
    // Not for secrets: only the 8-hex device tie-break (section 1.2) is drawn from it.
    randomBytes: n => Uint8Array.from({length: n}, () => GLib.random_int_range(0, 256)),
    log: {warn: m => console.warn(`cetli: ${m}`), info: m => console.log(`cetli: ${m}`)},
};

export function defaultDirs() {
    return {
        notes: GLib.build_filenamev([GLib.get_user_data_dir(), 'cetli', 'notes']),
        tmp: GLib.build_filenamev([GLib.get_user_data_dir(), 'cetli', 'tmp']),
        state: GLib.build_filenamev([GLib.get_user_state_dir(), 'cetli']),
    };
}

const EVENT_NAMES = {
    [Gio.FileMonitorEvent.CHANGED]: 'CHANGED',
    [Gio.FileMonitorEvent.CHANGES_DONE_HINT]: 'CHANGES_DONE_HINT',
    [Gio.FileMonitorEvent.DELETED]: 'DELETED',
    [Gio.FileMonitorEvent.CREATED]: 'CREATED',
    [Gio.FileMonitorEvent.ATTRIBUTE_CHANGED]: 'ATTRIBUTE_CHANGED',
    [Gio.FileMonitorEvent.MOVED]: 'MOVED',
    [Gio.FileMonitorEvent.RENAMED]: 'RENAMED',
    [Gio.FileMonitorEvent.MOVED_IN]: 'MOVED_IN',
    [Gio.FileMonitorEvent.MOVED_OUT]: 'MOVED_OUT',
};

// Section 3: a directory monitor WITHOUT WATCH_MOVES, so that a rename into notes/ is reported as CREATED (the plan's list).
export function monitorFactory(dir, onEvent) {
    const monitor = fileOf(dir).monitor_directory(Gio.FileMonitorFlags.NONE, null);
    const id = monitor.connect('changed', (_m, file, other, type) => {
        onEvent({event: EVENT_NAMES[type] ?? 'OTHER', name: file?.get_basename() ?? null, otherName: other?.get_basename() ?? null});
    });
    return {
        cancel() {
            monitor.disconnect(id);
            monitor.cancel();
        },
    };
}

export const timers = {
    set: (fn, ms) => GLib.timeout_add(PRIO, ms, () => {
        fn();
        return GLib.SOURCE_REMOVE;
    }),
    clear: id => GLib.source_remove(id),
};

