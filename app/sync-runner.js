// SPDX-License-Identifier: GPL-3.0-or-later
// PURE (no gi): one engine run at a time, over an injected process. The window never sees a raw line, never builds an argv and never
// holds anything of the engine but the events (PLAN-WIZARD-INTERFACE 4). The real process is app/sync-bridge.js; the tests give a fake one
// that replays sync-tests/contract/*.ndjson.
//
// The process interface (`openProcess(argv, {env}) -> proc`):
//   proc.onLine(fn(line))   one stdout line, without the newline; the process layer caps a line at MAX_LINE_BYTES and the total
//   proc.onOverflow(fn())   at MAX_TOTAL_BYTES and calls this instead of handing over more
//   proc.onExit(fn(rc))     the process ended; rc 0..255, or a negative number for a signal
//   proc.write(text)        to stdin;  proc.closeStdin();  proc.kill()  (force_exit)
import {acceptLine, argvFor, createRunChecker, isKnownStep, VERBS} from '../sync/protocol.js';
import {scrubEnv} from '../sync/runport.js';

export const STOP_GRACE_MS = 3000;
export const ENGINE_PATH = '/usr/bin/cetli-sync';

// The bridge scrubs the environment too (second layer; the engine's run port is the one the test pins): `environ` is a list of
// "NAME=value" strings, the result the same shape, allowlist only.
export function scrubEnviron(environ) {
    const map = {};
    for (const entry of environ ?? []) {
        const i = typeof entry === 'string' ? entry.indexOf('=') : -1;
        if (i > 0)
            map[entry.slice(0, i)] = entry.slice(i + 1);
    }
    return Object.entries(scrubEnv(map)).map(([k, v]) => `${k}=${v}`);
}

const failure = (code, step = null) => ({ok: false, error: {code, step}});

// `openProcess`, `setTimer(ms, fn) -> handle`, `clearTimer(handle)` and `log(text)` are injected. `environ`: the caller's "NAME=value" list.
export function createRunner({openProcess, exe = ENGINE_PATH, setTimer, clearTimer, log = () => {}, environ = () => []}) {
    let active = null;

    function start(verb, {flags = {}, ids = [], stdin = null, onEvent = () => {}} = {}) {
        if (active !== null) {
            const busy = Promise.resolve(failure('E_BUSY'));
            return {done: busy, accept: () => false, stop: () => busy};
        }
        let argv;
        try {
            argv = [exe, ...argvFor(verb, flags, ids)];
        } catch (e) {
            return {done: Promise.resolve(failure('E_INTERNAL')), accept: () => false, stop: () => Promise.resolve(failure('E_INTERNAL'))};
        }
        const checker = createRunChecker(verb);
        let proc;
        let settle;
        const done = new Promise(res => { settle = res; });
        let finished = false;
        let graceTimer = null;
        let accepted = false;
        const run = {proc: null, handle: null};
        const finish = outcome => {
            if (finished)
                return;
            finished = true;
            if (graceTimer !== null)
                clearTimer(graceTimer);
            if (active === run)
                active = null;
            log(`engine ${verb}: ${outcome.ok ? 'result' : `error ${outcome.error.code}`}`);
            settle(outcome);
        };
        const violate = code => {
            try {
                proc.kill();
            } catch {
                // already gone
            }
            finish(failure(code));
        };
        try {
            proc = openProcess(argv, {env: scrubEnviron(environ())});
        } catch (e) {
            log(`engine ${verb}: not started`);
            return {done: Promise.resolve(failure('E_ENGINE_DIED')), accept: () => false, stop: () => Promise.resolve(failure('E_ENGINE_DIED'))};
        }
        run.proc = proc;
        active = run;
        proc.onLine(line => {
            if (finished)
                return;
            const r = checker.feed(line);
            if (!r.ok) {
                violate(r.code);
                return;
            }
            const ev = r.event;
            if (ev.event === 'result' || ev.event === 'error')
                return;                                   // the terminal line is settled when the process ends (rc must agree)
            if (ev.event === 'progress' && !isKnownStep(ev.step))
                return;                                   // an unknown step is ignored (section 3)
            try {
                onEvent(ev);
            } catch (e) {
                log(`engine ${verb}: an event handler failed`);
            }
        });
        proc.onOverflow(() => violate('E_PROTOCOL'));
        proc.onExit(rc => {
            if (finished)
                return;
            const end = checker.finish(rc);
            if (!end.ok) {
                finish(failure(end.code));
            } else if (end.outcome.kind === 'result') {
                finish({ok: true, result: end.outcome.result});
            } else {
                finish(failure(end.outcome.code, end.outcome.step));
            }
        });
        if (verb === 'join') {
            // ONE line, then EOF (2a). Nothing else is ever written.
            if (typeof stdin === 'string')
                proc.write(stdin);
            proc.closeStdin();
        } else if (verb !== 'host') {
            proc.closeStdin();                            // the other verbs ignore stdin
        }
        const handle = {
            done,
            // host only, once: the ID of the last `candidate` event. Any other use is refused here and again by the engine.
            accept(id) {
                if (verb !== 'host' || finished || accepted)
                    return false;
                let line;
                try {
                    line = acceptLine(id);
                } catch {
                    return false;
                }
                accepted = true;
                proc.write(line);
                return true;
            },
            // EOF on stdin stops `host` at once; a process that is still alive after STOP_GRACE_MS is killed.
            stop() {
                if (!finished && graceTimer === null) {
                    try {
                        proc.closeStdin();
                    } catch {
                        // already closed
                    }
                    graceTimer = setTimer(STOP_GRACE_MS, () => {
                        graceTimer = null;
                        if (!finished)
                            violate('E_ENGINE_DIED');
                    });
                }
                return done;
            },
        };
        run.handle = handle;
        return handle;
    }

    return {
        start,
        run: (verb, opts) => start(verb, opts).done,
        get busy() { return active !== null; },
        // the app quits: the running engine, if any, is stopped
        stop: () => (active === null ? Promise.resolve() : active.handle.stop()),
    };
}

export {VERBS};
