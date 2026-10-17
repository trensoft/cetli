// SPDX-License-Identifier: GPL-3.0-or-later
// cetli: a thin GNOME Shell extension (47-49, ES module). A Wayland client cannot place its own window, so this puts
// each cetli note window on the rectangle saved in ~/.local/state/cetli/layout.json when it appears, and saves the
// rectangle again when the user moves or resizes it. It draws nothing, shows no text, starts no process, uses no
// network, and reads and writes nothing but that one file. Every entry point catches its exceptions: nothing may
// throw into the Shell.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {MAX_FILE_BYTES, MAX_NOTES} from './constants.js';
import {parseLayout, serializeLayout} from './layout.js';
import {APP_ID, chooseArea, clampRect, idFromTitle, monitorKey, roundRect, sameRect} from './placement.js';

const POLL_MS = 100;
const WINDOW_WAIT_MS = 10000;
const SETTLE_MS = 700;
const SAVE_DEBOUNCE_MS = 300;
const TOLERANCE_PX = 2;
const CHUNK = 65536;

const decoder = new TextDecoder();

// One GIO async call as a promise (the plain callback form, no _promisify magic).
const gio = (obj, start, finish, ...args) => new Promise((resolve, reject) => {
    obj[start](...args, (_o, res) => {
        try {
            resolve(obj[finish](res));
        } catch (e) {
            reject(e);
        }
    });
});

const rectOf = win => {
    const r = win.get_frame_rect();
    return {x: r.x, y: r.y, w: r.width, h: r.height};
};

// get_maximized() is mutter 47; later versions may only have is_maximized().
function isMaximized(win) {
    if (typeof win.is_maximized === 'function')
        return win.is_maximized();
    if (typeof win.get_maximized === 'function')
        return win.get_maximized() !== 0;
    return win.maximized_horizontally === true || win.maximized_vertically === true;
}

class Placer {
    constructor() {
        this._dir = GLib.build_filenamev([GLib.get_user_state_dir(), 'cetli']);
        this._file = Gio.File.new_for_path(GLib.build_filenamev([this._dir, 'layout.json']));
        this._windows = new Map();  // Meta.Window -> {id, timer, saveTimer, known}
        this._timers = new Set();
        this._pending = new Map();  // id -> entry waiting for the next write
        this._chain = Promise.resolve();
        this._warned = new Set();
        this._on = false;
    }

    start() {
        this._on = true;
        global.display.connectObject('window-created',
            (_display, win) => this._guard('window-created', () => this._track(win)), this);
        for (const actor of global.get_window_actors())
            this._guard('existing window', () => this._track(actor.meta_window));
    }

    stop() {
        this._on = false;
        global.display.disconnectObject(this);
        for (const [win, st] of this._windows) {
            this._guard('flush', () => {
                if (st.saveTimer) {
                    this._cancel(st.saveTimer);
                    this._capture(win, st);
                }
            });
            win.disconnectObject(this);
        }
        this._windows.clear();
        for (const id of this._timers)
            GLib.source_remove(id);
        this._timers.clear();
    }

    // ---- plumbing ---------------------------------------------------------------------------------------------

    _guard(what, fn) {
        try {
            return fn();
        } catch (e) {
            console.error(`[cetli] ${what}: ${e?.message ?? e}`);
            return undefined;
        }
    }

    _warnOnce(key, text) {
        if (!this._warned.has(key)) {
            this._warned.add(key);
            console.warn(`[cetli] ${text}`);
        }
    }

    _later(what, fn) {
        fn().catch(e => console.error(`[cetli] ${what}: ${e?.message ?? e}`));
    }

    _timeout(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timers.delete(id);
            this._guard('timer', fn);
            return GLib.SOURCE_REMOVE;
        });
        this._timers.add(id);
        return id;
    }

    _cancel(id) {
        if (id && this._timers.delete(id))
            GLib.source_remove(id);
    }

    _alive(win, st) {
        return this._on && this._windows.get(win) === st;
    }

    // ---- finding the note windows -----------------------------------------------------------------------------

    _track(win) {
        if (!win || this._windows.has(win))
            return;
        const st = {id: null, timer: 0, saveTimer: 0, known: null};
        this._windows.set(win, st);
        win.connectObject('unmanaging', () => this._guard('unmanaging', () => this._untrack(win)), this);
        this._poll(win, st, 0);
    }

    _untrack(win) {
        const st = this._windows.get(win);
        if (!st)
            return;
        this._cancel(st.timer);
        if (st.saveTimer) {
            this._cancel(st.saveTimer);
            this._capture(win, st);
        }
        win.disconnectObject(this);
        this._windows.delete(win);
    }

    // Watches a new window for at most 10 s: its app id, its title and its first frame may all come after
    // `window-created`. Windows of other apps simply time out.
    _poll(win, st, waited) {
        if (!this._alive(win, st))
            return;
        if (win.get_gtk_application_id() === APP_ID || win.get_wm_class() === APP_ID) {
            const id = idFromTitle(win.get_title());
            if (id !== null && win.get_compositor_private() !== null && rectOf(win).w > 1 && rectOf(win).h > 1) {
                st.id = id;
                this._later('restore', () => this._restore(win, st));
                return;
            }
        }
        if (waited >= WINDOW_WAIT_MS) {
            this._windows.delete(win);
            win.disconnectObject(this);
            return;
        }
        st.timer = this._timeout(POLL_MS, () => this._poll(win, st, waited + POLL_MS));
    }

    // ---- restoring --------------------------------------------------------------------------------------------

    _areas() {
        const lm = Main.layoutManager;
        return lm.monitors.map((m, i) => {
            const a = lm.getWorkAreaForMonitor(i);
            return {key: monitorKey(m), x: a.x, y: a.y, w: a.width, h: a.height};
        });
    }

    async _restore(win, st) {
        const {layout} = await this._readLayout();
        if (!this._alive(win, st))
            return;
        const entry = layout[st.id];
        const areas = this._areas();
        const area = entry && entry.w >= 1 && entry.h >= 1 ? chooseArea(entry, areas, Main.layoutManager.primaryIndex) : null;
        if (!area) {
            st.known = roundRect(rectOf(win));
            this._arm(win, st);
            return;
        }
        const target = clampRect(entry, area);
        win.move_resize_frame(false, target.x, target.y, target.w, target.h);
        this._timeout(SETTLE_MS, () => this._settle(win, st, target, 0));
    }

    // Mutter may have ignored the first request: ask once more. Saving starts only afterwards, so the placement is
    // never mistaken for a move by the user, and a place the compositor chose instead is not written over the
    // saved one until the user really moves the window.
    _settle(win, st, target, attempt) {
        if (!this._alive(win, st))
            return;
        const actual = roundRect(rectOf(win));
        if (!sameRect(target, actual, TOLERANCE_PX) && attempt < 1) {
            win.move_resize_frame(false, target.x, target.y, target.w, target.h);
            this._timeout(SETTLE_MS, () => this._settle(win, st, target, attempt + 1));
            return;
        }
        st.known = actual;
        this._arm(win, st);
    }

    // ---- saving -----------------------------------------------------------------------------------------------

    _arm(win, st) {
        const schedule = () => {
            this._cancel(st.saveTimer);
            st.saveTimer = this._timeout(SAVE_DEBOUNCE_MS, () => {
                st.saveTimer = 0;
                this._capture(win, st);
            });
        };
        win.connectObject('position-changed', schedule, 'size-changed', schedule, this);
    }

    _capture(win, st) {
        if (isMaximized(win) || win.is_fullscreen())
            return;
        const rect = roundRect(rectOf(win));
        if (rect.w < 1 || rect.h < 1 || sameRect(rect, st.known))
            return;
        st.known = rect;
        const area = chooseArea(rect, this._areas(), Main.layoutManager.primaryIndex);
        this._pending.set(st.id, {...rect, monitor: area ? area.key : '', open: true});
        this._chain = this._chain.then(() => this._write()).catch(e => console.error(`[cetli] write: ${e?.message ?? e}`));
    }

    // ---- the layout file --------------------------------------------------------------------------------------

    // {layout, writable}. A missing file is an empty layout; anything that is not a small regular file, or cannot
    // be read, is not touched at all (never written over).
    async _readLayout() {
        const none = Object.create(null);
        try {
            const info = await gio(this._file, 'query_info_async', 'query_info_finish', 'standard::type,standard::size',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, null);
            if (info.get_file_type() !== Gio.FileType.REGULAR || info.get_size() > MAX_FILE_BYTES) {
                console.warn('[cetli] layout.json is not a small regular file: left alone');
                return {layout: none, writable: false};
            }
            const stream = await gio(this._file, 'read_async', 'read_finish', GLib.PRIORITY_DEFAULT, null);
            const chunks = [];
            let total = 0;
            try {
                for (;;) {
                    const bytes = await gio(stream, 'read_bytes_async', 'read_bytes_finish', CHUNK, GLib.PRIORITY_DEFAULT, null);
                    if (bytes.get_size() === 0)
                        break;
                    chunks.push(bytes.toArray());
                    total += bytes.get_size();
                    if (total > MAX_FILE_BYTES) {
                        console.warn('[cetli] layout.json grew past the limit: left alone');
                        return {layout: none, writable: false};
                    }
                }
            } finally {
                await gio(stream, 'close_async', 'close_finish', GLib.PRIORITY_DEFAULT, null).catch(() => {});
            }
            const all = new Uint8Array(total);
            let at = 0;
            for (const c of chunks) {
                all.set(c, at);
                at += c.length;
            }
            const {layout} = parseLayout(decoder.decode(all));
            return {layout, writable: true};
        } catch (e) {
            if (e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                return {layout: none, writable: true};
            console.error(`[cetli] layout.json not read: ${e?.message ?? e}`);
            return {layout: none, writable: false};
        }
    }

    // Read, change only our members, write: the GTK app writes `open` in the same file. Serialised by `_chain`.
    async _write() {
        if (this._pending.size === 0)
            return;
        const batch = this._pending;
        this._pending = new Map();
        const {layout, writable} = await this._readLayout();
        if (!writable)
            return;
        let count = Object.keys(layout).length;
        let changed = false;
        for (const [id, e] of batch) {
            if (!layout[id]) {
                if (count >= MAX_NOTES) {
                    this._warnOnce('notes', 'layout.json already has the maximum number of notes: a new one is not saved');
                    continue;
                }
                count++;
            }
            layout[id] = {...e, open: layout[id] ? layout[id].open : true};
            changed = true;
        }
        if (!changed)
            return;
        // Never write a file that this extension itself would refuse to read.
        const bytes = serializeLayout(layout);
        if (bytes.length > MAX_FILE_BYTES) {
            this._warnOnce('size', 'layout.json would grow past the size limit: not saved');
            return;
        }
        GLib.mkdir_with_parents(this._dir, 0o700);
        // GIO replaces the file through a temporary file in the same directory and a rename.
        await gio(this._file, 'replace_contents_bytes_async', 'replace_contents_finish',
            new GLib.Bytes(bytes), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    }
}

export default class CetliExtension extends Extension {
    enable() {
        try {
            this._placer = new Placer();
            this._placer.start();
        } catch (e) {
            console.error(`[cetli] enable failed: ${e?.message ?? e}`);
            try {
                this._placer?.stop();
            } catch (e2) {
                console.error(`[cetli] cleanup after a failed enable: ${e2?.message ?? e2}`);
            }
            this._placer = null;
        }
    }

    disable() {
        try {
            this._placer?.stop();
        } catch (e) {
            console.error(`[cetli] disable failed: ${e?.message ?? e}`);
        }
        this._placer = null;
    }
}
