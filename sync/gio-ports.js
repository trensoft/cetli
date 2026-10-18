// SPDX-License-Identifier: GPL-3.0-or-later
// The real ports of the engine (Gio and GLib): the process start under the run port, the file operations, the clock, the log and the stdin
// reader. Everything that makes a call safe is in sync/runport.js (the allowlisted environment, the argv); this file only does what it is told.
// Tested in gjs without a display (sync-tests/gio-ports-smoke.js).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');
const fileOf = p => Gio.File.new_for_path(p);

export const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE; }));
export const monotonic = () => GLib.get_monotonic_time() / 1000;
export const now = () => Date.now();

// `spawn(argv, env, {stdin, maxBytes, timeoutMs}) -> Promise<{rc, out, tooLarge?}>`. The child's stdin is a pipe that is written (or just
// closed), never the engine's own stdin; stderr is not read; the output is cut at maxBytes (the child is killed, tooLarge is set).
export function spawn(argv, env, {stdin = null, maxBytes, timeoutMs}) {
    return new Promise(resolve => {
        const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE});
        launcher.set_environ(Object.entries(env).map(([k, v]) => `${k}=${v}`));
        let sub;
        try {
            sub = launcher.spawnv(argv);
        } catch {
            resolve({rc: -1, out: ''});
            return;
        }
        const chunks = [];
        let size = 0;
        let tooLarge = false;
        let timedOut = false;
        let readDone = false;
        let rc = null;
        let timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
            timer = 0;
            timedOut = true;
            sub.force_exit();
            return GLib.SOURCE_REMOVE;
        });
        const finish = () => {
            if (!readDone || rc === null)
                return;
            if (timer !== 0)
                GLib.source_remove(timer);
            const all = new Uint8Array(size);
            let at = 0;
            for (const c of chunks) {
                all.set(c, at);
                at += c.length;
            }
            resolve({rc: timedOut ? -1 : rc, out: tooLarge ? '' : decoder.decode(all), ...(tooLarge ? {tooLarge: true} : {})});
        };
        const stdinPipe = sub.get_stdin_pipe();
        try {
            if (typeof stdin === 'string')
                stdinPipe.write_all(encoder.encode(stdin), null);
            stdinPipe.close(null);
        } catch {
            // the child may be gone already
        }
        const stdout = sub.get_stdout_pipe();
        const readMore = () => {
            stdout.read_bytes_async(65536, GLib.PRIORITY_DEFAULT, null, (src, res) => {
                let bytes;
                try {
                    bytes = src.read_bytes_finish(res).toArray();
                } catch {
                    bytes = new Uint8Array(0);
                }
                if (bytes.length === 0) {
                    readDone = true;
                    finish();
                    return;
                }
                size += bytes.length;
                if (size > maxBytes) {
                    tooLarge = true;
                    sub.force_exit();
                    size = 0;
                    chunks.length = 0;
                    readDone = true;
                    finish();
                    return;
                }
                chunks.push(bytes);
                readMore();
            });
        };
        readMore();
        sub.wait_async(null, (s, res) => {
            try {
                s.wait_finish(res);
            } catch {
                // the status is read below either way
            }
            rc = s.get_if_exited() ? s.get_exit_status() : -(s.get_term_sig() || 1);
            finish();
        });
    });
}

// The file port of the engine. Modes are the permission bits only (0o7777).
export const files = {
    exists: p => fileOf(p).query_exists(null),
    readText: p => decoder.decode(fileOf(p).load_contents(null)[1]),
    // a temporary file in the same directory, created with the mode, then renamed over the target
    writeText: (p, text, mode) => GLib.file_set_contents_full(p, encoder.encode(text), GLib.FileSetContentsFlags.CONSISTENT, mode),
    mkdirp: (p, mode) => {
        if (GLib.mkdir_with_parents(p, mode) !== 0)
            throw new Error('mkdir failed');
    },
    modeOf: p => {
        try {
            return fileOf(p).query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null).get_attribute_uint32('unix::mode') & 0o7777;
        } catch {
            return null;
        }
    },
    isDir: p => fileOf(p).query_file_type(Gio.FileQueryInfoFlags.NONE, null) === Gio.FileType.DIRECTORY,
    isSymlink: p => {
        try {
            return fileOf(p).query_info('standard::is-symlink', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null).get_is_symlink();
        } catch {
            return false;
        }
    },
    listNames: p => {
        const out = [];
        const en = fileOf(p).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        let info;
        while ((info = en.next_file(null)) !== null)
            out.push(info.get_name());
        en.close(null);
        return out;
    },
};

// A journal line: codes and field names only (the engine guarantees that).
export const log = text => GLib.log_structured('cetli-sync', GLib.LogLevelFlags.LEVEL_WARNING, {MESSAGE: text});

export const hostEnvironment = () => {
    const env = {};
    for (const entry of GLib.get_environ()) {
        const i = entry.indexOf('=');
        if (i > 0)
            env[entry.slice(0, i)] = entry.slice(i + 1);
    }
    return env;
};

// The engine's stdin. `join` reads exactly ONE line and then does not look again; `host` reads lines in the background (the window may write
// `accept <ID>`) and sees the end of the input (EOF = stop at once). A line is cut at 4 KiB: the engine's own length gate does the judging.
const STDIN_CHUNK = 4096;
export function openInput() {
    const stream = Gio.UnixInputStream.new(0, false);
    const queue = [];
    let eof = false;
    let pending = '';
    const feed = text => {
        pending += text;
        let i;
        while ((i = pending.indexOf('\n')) >= 0) {
            queue.push(pending.slice(0, i));
            pending = pending.slice(i + 1);
        }
        if (pending.length > STDIN_CHUNK)
            pending = pending.slice(0, STDIN_CHUNK);
    };
    const waiters = [];
    const wake = () => { while (waiters.length > 0) waiters.shift()(); };
    const readMore = () => {
        stream.read_bytes_async(STDIN_CHUNK, GLib.PRIORITY_DEFAULT, null, (src, res) => {
            let bytes;
            try {
                bytes = src.read_bytes_finish(res).toArray();
            } catch {
                bytes = new Uint8Array(0);
            }
            if (bytes.length === 0) {
                if (pending !== '')
                    queue.push(pending);
                pending = '';
                eof = true;
                wake();
                return;
            }
            feed(decoder.decode(bytes));
            wake();
            readMore();
        });
    };
    readMore();
    return {
        lines: () => queue.splice(0),
        eof: () => eof && queue.length === 0,
        // for `join`: the first line (or what came before EOF), "" when nothing came
        firstLine: async () => {
            while (queue.length === 0 && !eof)
                await new Promise(r => waiters.push(r));
            return queue.length > 0 ? queue.shift() : '';
        },
    };
}
