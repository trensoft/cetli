// SPDX-License-Identifier: GPL-3.0-or-later
// The ONLY file of app/ that starts a process (PLAN-WIZARD-INTERFACE 4, PLAN-WIZARD 0F.2, 12). It starts `/usr/bin/cetli-sync` with an argv
// array (no shell, no `-c`), an allowlisted environment and nothing from the user on the command line; the run logic is app/sync-runner.js
// (pure, tested against the contract fixtures), this file is the Gio side: the process, the line reader with its caps, the timers.
// There is NO environment override of the executable: an override would be a second way to start an arbitrary process.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {createRunner} from './sync-runner.js';
import {MAX_LINE_BYTES, MAX_TOTAL_BYTES} from '../sync/protocol.js';

const ENGINE = '/usr/bin/cetli-sync';

// The process of the runner's interface, over a Gio.Subprocess. stdout is read in chunks and cut into lines here, so that a line over
// MAX_LINE_BYTES or a total over MAX_TOTAL_BYTES is stopped BEFORE it is held in memory; stderr is not read (STDERR_SILENCE).
function startProcess(argv, {env}) {
    const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE});
    launcher.set_environ(env);
    const sub = launcher.spawnv(argv);
    const stdin = sub.get_stdin_pipe();
    const stdout = sub.get_stdout_pipe();
    const cb = {line: () => {}, overflow: () => {}, exit: () => {}};
    const decoder = new TextDecoder('utf-8', {fatal: true});
    let pending = new Uint8Array(0);
    let total = 0;
    let stopped = false;
    let readDone = false;
    let rc = null;
    let stdinOpen = true;

    const maybeExit = () => {
        if (readDone && rc !== null && !stopped) {
            stopped = true;
            cb.exit(rc);
        }
    };
    const overflow = () => {
        if (stopped)
            return;
        stopped = true;
        cb.overflow();
    };
    const emit = bytes => {
        let text;
        try {
            text = decoder.decode(bytes);
        } catch {
            overflow();                                   // not UTF-8: a violation like any other
            return false;
        }
        cb.line(text);
        return !stopped;
    };
    const readMore = () => {
        stdout.read_bytes_async(MAX_LINE_BYTES, GLib.PRIORITY_DEFAULT, null, (src, res) => {
            let chunk;
            try {
                chunk = src.read_bytes_finish(res).toArray();
            } catch {
                chunk = new Uint8Array(0);
            }
            if (chunk.length === 0) {
                if (pending.length > 0 && !stopped)
                    emit(pending);
                pending = new Uint8Array(0);
                readDone = true;
                maybeExit();
                return;
            }
            total += chunk.length;
            if (total > MAX_TOTAL_BYTES) {
                overflow();
                return;
            }
            const all = new Uint8Array(pending.length + chunk.length);
            all.set(pending);
            all.set(chunk, pending.length);
            let start = 0;
            for (let i = 0; i < all.length; i++) {
                if (all[i] !== 10)
                    continue;
                if (i - start > MAX_LINE_BYTES) {
                    overflow();
                    return;
                }
                if (!emit(all.subarray(start, i)))
                    return;
                start = i + 1;
            }
            pending = all.slice(start);
            if (pending.length > MAX_LINE_BYTES) {
                overflow();
                return;
            }
            if (!stopped)
                readMore();
        });
    };
    readMore();
    sub.wait_async(null, (s, res) => {
        try {
            s.wait_finish(res);
        } catch {
            // the exit status is read below either way
        }
        rc = s.get_if_exited() ? s.get_exit_status() : -(s.get_term_sig() || 1);
        maybeExit();
    });
    return {
        onLine: f => { cb.line = f; },
        onOverflow: f => { cb.overflow = f; },
        onExit: f => { cb.exit = f; },
        write(text) {
            if (!stdinOpen)
                return;
            try {
                stdin.write_all(new TextEncoder().encode(text), null);
            } catch {
                // the engine is gone; its exit is reported by the reader
            }
        },
        closeStdin() {
            if (!stdinOpen)
                return;
            stdinOpen = false;
            try {
                stdin.close(null);
            } catch {
                // already closed
            }
        },
        kill() {
            sub.force_exit();
        },
    };
}

const setTimer = (ms, fn) => {
    const h = {id: 0, fired: false};
    h.id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        h.fired = true;
        fn();
        return GLib.SOURCE_REMOVE;
    });
    return h;
};
const clearTimer = h => {
    if (!h.fired) {
        h.fired = true;
        GLib.source_remove(h.id);
    }
};

export class SyncBridge {
    // `openProcess` is overridden ONLY by tests; the executable is never. The app passes at most a logger.
    constructor({openProcess = startProcess, log = () => {}} = {}) {
        this._runner = createRunner({openProcess, exe: ENGINE, setTimer, clearTimer, log, environ: () => GLib.get_environ()});
    }

    // -> {done: Promise<{ok: true, result} | {ok: false, error: {code, step}}>, accept(id), stop()}
    start(verb, opts) {
        return this._runner.start(verb, opts);
    }

    run(verb, opts) {
        return this._runner.run(verb, opts);
    }

    get busy() {
        return this._runner.busy;
    }

    // The app quits or the window goes away: close stdin, kill after 3 s.
    stop() {
        return this._runner.stop();
    }
}
