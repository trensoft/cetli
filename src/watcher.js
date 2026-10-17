// SPDX-License-Identifier: GPL-3.0-or-later
// PLAN.md section 3: watch `notes/`, react only to events of candidate names, debounce about 100 ms, then refresh.
// The monitor and the timers are injected (Gio.FileMonitor and GLib timeouts in gio-layer.js), so the logic runs headless.
//
//   monitorFactory(dir, onEvent) -> {cancel()}      onEvent({event, name, otherName?}); `event` is the Gio.FileMonitorEvent
//                                                   nick in upper case: CREATED, MOVED_IN, CHANGES_DONE_HINT, DELETED, ...
//   timers.set(fn, ms) -> handle                    timers.clear(handle)
//   now() -> ms                                     clock, for the quarantine release timer

import {DEBOUNCE_MS, NAME_CONFLICT, NAME_MAIN} from './constants.js';

// The events of section 3. RENAMED / MOVED are accepted too, when either name is a candidate: a monitor created with
// WATCH_MOVES reports a Syncthing rename (`.syncthing.<name>.tmp` -> `<name>`) that way, and only the second name matches.
const REACT_TO = new Set(['CREATED', 'MOVED_IN', 'CHANGES_DONE_HINT', 'DELETED']);
const REACT_TO_PAIR = new Set(['RENAMED', 'MOVED']);
const MAX_TIMER_MS = 2 ** 31 - 1;
const isCandidate = n => typeof n === 'string' && (NAME_MAIN.test(n) || NAME_CONFLICT.test(n));

export function createWatcher({store, monitorFactory, timers, notesDir, debounceMs = DEBOUNCE_MS, now = () => Date.now(), onError = () => {}}) {
    let monitor = null;
    let timer = null;
    let running = false;
    let current = Promise.resolve();
    let again = false;
    let stopped = false;
    let releaseTimer = null;
    const hint = new Set();

    function relevant({event, name, otherName}) {
        if (REACT_TO.has(event))
            return isCandidate(name);
        if (REACT_TO_PAIR.has(event))
            return isCandidate(name) || isCandidate(otherName);
        return false;
    }

    function schedule(ms) {
        if (stopped)
            return;
        if (timer !== null)
            timers.clear(timer);
        timer = timers.set(() => {
            timer = null;
            current = tick();
        }, ms);
    }

    async function tick() {
        if (running) {
            again = true;
            return;
        }
        running = true;
        try {
            do {
                again = false;
                const names = [...hint];
                hint.clear();
                const r = await store.refresh({hint: names});
                // Cost bound (section 3): what did not fit into this tick waits for the next one.
                if (r.pending > 0)
                    again = true;
            } while (again && !stopped);
        } catch (e) {
            onError(e);
        } finally {
            running = false;
            armRelease();
        }
    }

    // V6 / 2.2 step 0: a QUARANTINED file turns valid when its time comes, with no event. One one-shot timer for the
    // earliest release (the trigger is only this timer: store.refresh() does the release and may be called by anything).
    function armRelease() {
        if (releaseTimer !== null)
            timers.clear(releaseTimer);
        releaseTimer = null;
        const at = stopped ? null : store.nextQuarantineRelease();
        if (at === null)
            return;
        // +1 ms so that the instant is surely past; capped, because timers have a maximum delay.
        const ms = Math.min(Math.max(at - now() + 1, 1), MAX_TIMER_MS);
        releaseTimer = timers.set(() => {
            releaseTimer = null;
            schedule(0);
        }, ms);
    }

    return {
        // The first load at start uses the same budget, in batches.
        // Resolves when no refresh is running (a pending debounce timer is not waited for).
        idle: async () => {
            await current;
        },
        async start() {
            monitor = monitorFactory(notesDir, ev => {
                if (!relevant(ev))
                    return;
                for (const n of [ev.name, ev.otherName]) {
                    if (isCandidate(n))
                        hint.add(n);
                }
                schedule(debounceMs);
            });
            current = tick();
            await current;
        },
        stop() {
            stopped = true;
            if (timer !== null)
                timers.clear(timer);
            timer = null;
            if (releaseTimer !== null)
                timers.clear(releaseTimer);
            releaseTimer = null;
            monitor?.cancel();
            monitor = null;
        },
        relevant,
    };
}
