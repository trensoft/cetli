// SPDX-License-Identifier: GPL-3.0-or-later
// The fake desktop: a virtual clock, signals, windows, monitors and a state directory on the real disk.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function emitter(obj) {
    const conns = [];
    obj.connectObject = (...args) => {
        const owner = args.pop();
        for (let i = 0; i < args.length; i += 2)
            conns.push({name: args[i], fn: args[i + 1], owner});
    };
    obj.disconnectObject = owner => {
        for (let i = conns.length - 1; i >= 0; i--) {
            if (conns[i].owner === owner)
                conns.splice(i, 1);
        }
    };
    obj.emit = (name, ...a) => {
        for (const c of [...conns]) {
            if (c.name === name)
                c.fn(obj, ...a);
        }
    };
    obj.connectionCount = () => conns.length;
    return obj;
}

export class FakeWindow {
    constructor({appId = 'io.github.trensoft.cetli', title = '', rect, mapped = true}) {
        this.appId = appId;
        this.title = title;
        this.rect = {...rect};
        this.mapped = mapped;
        this.maximized = 0;
        this.fullscreen = false;
        this.moveCalls = [];
        emitter(this);
    }

    get_title() {
        return this.title;
    }

    get_frame_rect() {
        return {x: this.rect.x, y: this.rect.y, width: this.rect.w, height: this.rect.h};
    }

    get_compositor_private() {
        return this.mapped ? {} : null;
    }

    get_gtk_application_id() {
        return this.appId;
    }

    get_wm_class() {
        return this.appId;
    }

    get_maximized() {
        return this.maximized;
    }

    is_fullscreen() {
        return this.fullscreen;
    }

    move_resize_frame(userOp, x, y, w, h) {
        this.moveCalls.push({userOp, x, y, w, h});
        const mode = world.moveMode;
        if (mode === 'throw')
            throw new TypeError('move_resize_frame is not a function');
        const obey = mode === 'obey' || (mode === 'ignore-first' && this.moveCalls.length > 1);
        if (mode === 'clamp-y')
            this.#set({x, y: Math.max(y, 400), w, h});
        else if (obey)
            this.#set({x, y, w, h});
    }

    #set(rect) {
        this.rect = rect;
        this.emit('position-changed');
        this.emit('size-changed');
    }

    // What the user does with the mouse.
    drag(rect) {
        this.rect = {...rect};
        this.emit('position-changed');
        this.emit('size-changed');
    }

    close() {
        this.emit('unmanaging');
        world.windows.splice(world.windows.indexOf(this), 1);
    }
}

export const world = {
    reset() {
        this.now = 0;
        this.timers = new Map();
        this.nextTimer = 1;
        this.stateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cetli-ext-test-'));
        this.display = emitter({});
        this.windows = [];
        // One 1920x1080 monitor with a 32 px panel on top.
        this.monitors = [{x: 0, y: 0, width: 1920, height: 1080}];
        this.workAreas = [{x: 0, y: 32, width: 1920, height: 1048}];
        this.primaryIndex = 0;
        this.moveMode = 'obey';
        this.ioCalls = [];
        this.failRead = null;
        this.failWrite = false;
        this.growOnRead = 0;
        this.chunk = 0;
        this.ioDelay = 0;       // real ms before a query_info / read_async callback
        this.openStreams = 0;   // streams opened and not yet closed
        this.errors = [];
        this.warnings = [];
        globalThis.global = {
            display: this.display,
            get_window_actors: () => this.windows.map(w => ({meta_window: w})),
        };
        console.error = (...a) => this.errors.push(a.join(' '));
        console.warn = (...a) => this.warnings.push(a.join(' '));
    },

    // Runs the virtual timers up to `ms` later; between them the pending promises (the fake IO is immediate) settle.
    async advance(ms) {
        const target = this.now + ms;
        await flush();
        for (;;) {
            let next = null;
            for (const [id, t] of this.timers) {
                if (t.at <= target && (!next || t.at < next.t.at))
                    next = {id, t};
            }
            if (!next)
                break;
            this.now = next.t.at;
            this.timers.delete(next.id);
            next.t.fn();
            await flush();
        }
        this.now = target;
    },

    addWindow(opts) {
        const win = new FakeWindow(opts);
        this.windows.push(win);
        this.display.emit('window-created', win);
        return win;
    },

    layoutPath() {
        return path.join(this.stateHome, 'cetli', 'layout.json');
    },

    readLayout() {
        return JSON.parse(fs.readFileSync(this.layoutPath(), 'utf8'));
    },

    writeLayout(obj) {
        fs.mkdirSync(path.dirname(this.layoutPath()), {recursive: true});
        fs.writeFileSync(this.layoutPath(), typeof obj === 'string' ? obj : JSON.stringify(obj));
    },

    writes() {
        return this.ioCalls.filter(c => c === 'write').length;
    },
};

export const flush = () => new Promise(resolve => setImmediate(resolve));
