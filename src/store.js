// SPDX-License-Identifier: GPL-3.0-or-later
// PLAN.md sections 1.2, 1.4, 1.5, 2.2, 2.5, 2.6, 3, 4 (d): the stateful part of the core. It talks to exactly two
// things: the directory `notes/` (with `tmp/` beside it) through the injected file layer, and the injected platform
// (hashes, clock, random, log). It has no Gio, Gtk or network import and no transport knowledge (D3, D4).
//
// File layer (all async, all paths are strings; every layer maps its errors to FsError, see fs-error.js):
//   listDir(dir)               -> [{name, type, size, mtime}]  non-recursive, symlinks NOT followed; type is one of
//                                 'regular' | 'directory' | 'symlink' | 'special' | 'unknown'; mtime is any comparable number
//   stat(path)                 -> null (no entry of any kind, a dangling symlink IS an entry) | {type, size, mtime}
//   readBytes(path)            -> Uint8Array
//   writeTmp(path, bytes)      -> void   durable (data written and fsync-ed before the file is in place), mode 0600
//   move(src, dest, {overwrite}) -> void  a rename, NEVER a copy-and-delete fallback (NO_FALLBACK_FOR_MOVE); without
//                                 `overwrite` an existing dest entry (of any kind) makes it fail with EXISTS
//   remove(path)               -> void
//   ensureDir(dir)             -> void
//   exchange(a, b)             -> void   OPTIONAL. Atomic swap of two existing entries (renameat2 RENAME_EXCHANGE): at no moment is
//                                 either name absent. NOT_FOUND if one of them does not exist, NOT_SUPPORTED if the system cannot
//                                 do it; the store then falls back to a check right before the move (a narrower, not a closed window)
// Platform: {sha256Hex(bytes), sha1(bytes) -> Uint8Array(20), now() -> ms, randomUuid(), randomBytes(n), log: {warn, info}}

import {
    CAUSE, KNOWN_KEYS, MAX_FILE_BYTES, MAX_NOTES, MAX_REV, MAX_TEXT_BYTES, NAME_CONFLICT, NAME_MAIN, DEVICE_RE, ST,
    TICK_MAX_BYTES, TICK_MAX_FILES, TOMBSTONE_PURGE_MS, UNKNOWN_KEY_RE, UUID_LEN, UUID_RE, YEAR_MAX,
} from './constants.js';
import {FS} from './fs-error.js';
import {entryProblem, isoOf, makeFormat, utf8Len} from './format.js';
import {parseLayout, serializeLayout} from './layout.js';
import {pickNoteColor} from './colors.js';

const MAX_PASSES = 4;

// The `extra` argument of a local save (2.5): a plain object whose keys are unknown keys of the record (V10 key pattern,
// never one of the known keys, or canon would write the key twice). A value sets the key, `null` removes it, an absent
// key is left alone. Values are taken through JSON so that the record in memory is what a reader of the file would see.
// Result: a Map (null = remove) or null when the argument is not acceptable (the save is then refused as BAD_INPUT).
function extraChanges(extra) {
    if (typeof extra !== 'object' || extra === null || Array.isArray(extra))
        return null;
    const proto = Object.getPrototypeOf(extra);
    if (proto !== Object.prototype && proto !== null)
        return null;
    const out = new Map();
    for (const k of Object.keys(extra)) {
        if (!UNKNOWN_KEY_RE.test(k) || KNOWN_KEYS.includes(k))
            return null;
        const v = extra[k];
        if (v === null) {
            out.set(k, null);
            continue;
        }
        let json;
        try {
            json = JSON.stringify(v);
        } catch {
            return null;                                  // a cycle, a BigInt, a throwing getter
        }
        if (typeof json !== 'string')
            return null;                                  // undefined, a function, a symbol: nothing to write
        out.set(k, JSON.parse(json));
    }
    return out;
}

// Same keys, same values by their canonical text (what canon() writes), so equal here means equal bytes.
function sameExtra(a, b) {
    if (a.size !== b.size)
        return false;
    for (const [k, v] of a) {
        if (!b.has(k) || JSON.stringify(b.get(k)) !== JSON.stringify(v))
            return false;
    }
    return true;
}
const TMP_NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
// The partner of an exchange or the capture of a deletion: after the swap it may hold a version nobody else has a copy of,
// so the start-up cleaning keeps it (in backup/) instead of deleting it like a `.tmp` leftover.
const HOLD_NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.x$/;
// backup/ holds file versions that left notes/ without another copy; at most BACKUP_KEEP files, the oldest go first.
const BACKUP_KEEP = 32;
const BACKUP_NAME_RE = /^[0-9]{15}-[0-9]{6}-[0-9a-z-]+\.json$/;      // the label is a note id or 'orphan'
const CAUSE_TEXT = Object.freeze({
    [CAUSE.QUARANTINE]: t => `newer date: quarantine until ${t}`,
    [CAUSE.NOT_READABLE]: () => 'file not readable',
    [CAUSE.NEWER_SCHEMA]: () => 'file needs a newer cetli',
    [CAUSE.COPY_PLACE_TAKEN]: () => 'copy place taken',
    [CAUSE.COPY_NOT_WRITTEN]: () => 'copy not written',
    [CAUSE.MOVE_FAILED]: () => 'move failed',
    [CAUSE.TOO_LARGE]: () => 'too large',
    [CAUSE.TOO_MANY]: () => 'too many cetli',
    [CAUSE.REV_LIMIT]: () => 'revision limit reached',
    [CAUSE.BAD_INPUT]: () => 'bad input',
});

const SAVE_RERUNS = 3;                          // reads of <X>.json one save may start over on, see _saveLocked
const RETRY_CAUSES = new Set([CAUSE.QUARANTINE, CAUSE.NOT_READABLE, CAUSE.NEWER_SCHEMA, CAUSE.COPY_PLACE_TAKEN, CAUSE.COPY_NOT_WRITTEN]);

const mainName = id => `${id}.json`;
const sigOf = st => (st === null ? 'absent' : `${st.type}|${st.size}|${st.mtime}`);

export function createStore(options) {
    return new Store(options);
}

export class Store {
    // `resolveConflicts` (default false, first version): the resolution of PLAN 2.2/2.3 (copy write, deletion of conflict files)
    // is built but NOT called. A NAME_CONFLICT file is kept untouched and counted in status().unresolved.
    constructor({fs, platform, dirs, maxNotes = MAX_NOTES, resolveConflicts = false}) {
        this.resolveConflicts = resolveConflicts;
        this.fs = fs;
        this.p = platform;
        this.dirs = dirs;                 // {notes, tmp, state, backup?}: backup is beside tmp/ (same file system) unless given
        this._backupDir = dirs.backup ?? `${dirs.tmp.replace(/\/[^/]*$/, '')}/backup`;
        this._backupSeq = 0;
        this.maxNotes = maxNotes;
        this.fmt = makeFormat({sha256Hex: platform.sha256Hex, sha1: platform.sha1});
        this.deviceId = null;

        this._entries = new Map();        // name -> entry (cache of the last scan)
        this._admitted = new Set();       // ids that are loaded (limit of 1.4)
        this._view = new Map();           // id -> record held by a valid `<id>.json`
        this._ownWrites = new Map();      // id -> V of our own last COMPLETED write (section 3 (4))
        this._refused = new Map();        // id -> {request, watchName, sig}: refused saves that retry on a change
        this._logged = new Set();
        this._listeners = new Set();
        this._chain = Promise.resolve();
        this._last = {ignoredNames: 0, pending: 0, overLimit: 0, frozen: [], unsettled: []};
    }

    // ---- public API -------------------------------------------------------------------------------------------

    onEvent(fn) {
        this._listeners.add(fn);
        return () => this._listeners.delete(fn);
    }

    // First start: directories, leftovers in tmp/, device id, first load.
    start() {
        return this._serial(async () => {
            await this.fs.ensureDir(this.dirs.notes);
            await this.fs.ensureDir(this.dirs.tmp);
            await this.fs.ensureDir(this.dirs.state);
            await this._cleanTmp();
            await this._loadDeviceId();
            return this._refreshLocked({});
        });
    }

    // `hint`: names whose cached content must be read again (events of the monitor).
    refresh({hint = []} = {}) {
        return this._serial(() => this._refreshLocked({invalidate: new Set(hint)}));
    }

    // The V of our own last completed save-path write for `id` (the filter of section 3 (4)), or null.
    ownWrite(id) {
        return this._ownWrites.get(id) ?? null;
    }

    getNote(id) {
        return this._view.get(id) ?? null;
    }

    listNotes() {
        return [...this._view.values()];
    }

    status() {
        const count = {valid: 0, unknown: 0, newer: 0, quarantined: 0};
        let unresolved = 0;
        for (const e of this._entries.values()) {
            if (e.state in count)
                count[e.state]++;
            if (e.kind === 'conflict')
                unresolved++;
        }
        return {...count, ...this._last, notes: this._view.size, loaded: this._admitted.size, unresolved};
    }

    // Section 1.1 V3: the front end may show a NEWER file read-only, only its text and only if the text is a string
    // of at most 65536 bytes (`text` is null otherwise; the file is counted anyway).
    newerNotes() {
        return [...this._entries.values()].filter(e => e.state === ST.NEWER).map(e => ({name: e.name, text: e.shownText}));
    }

    // V6 / 2.2 step 0: instant (ms) at which the earliest QUARANTINED file becomes valid, or null. The release itself
    // happens in refresh() (it needs no event); WHO calls refresh() at that instant is the caller's choice (watcher.js
    // arms a one-shot timer; a front end may do it differently).
    nextQuarantineRelease() {
        let next = null;
        for (const e of this._entries.values()) {
            if (e.state === ST.QUARANTINED && (next === null || e.until < next))
                next = e.until;
        }
        return next;
    }

    // Section 1.4: the 501st local "new cetli" is refused with a visible message.
    // `color` missing: the core picks the base colour (colors.js: a random one that no live note uses yet).
    createNote({text = '', color} = {}) {
        return this._serial(async () => {
            if (this._admitted.size >= this.maxNotes)
                return this._refuse(CAUSE.TOO_MANY, {});
            const chosen = color ?? pickNoteColor(this.listNotes().filter(n => !n.deleted).map(n => n.color), this.p.randomBytes);
            return this._saveLocked({id: this.p.randomUuid(), base: null, text, color: chosen, deleted: false});
        });
    }

    // Section 2.5. `base` is the record the user started from (as returned by getNote / createNote / saveNote), or null.
    saveNote(id, base, changes = {}) {
        return this._serial(() => this._saveLocked({id, base, ...changes}));
    }

    deleteNote(id, base) {
        return this._serial(() => this._saveLocked({id, base, text: '', color: base?.color ?? 'yellow', deleted: true}));
    }

    // Section 1.2 / 4 (d) (ii): a valid tombstone older than 90 days that is alone in its group. Only on explicit call.
    purgeTombstones() {
        return this._serial(async () => {
            await this._scan({});
            const now = this.p.now();
            let purged = 0;
            for (const [id, g] of this._groups()) {
                const s = g.main;
                if (!this._admitted.has(id) || g.pending || g.conflicts.length > 0 || !s || s.state !== ST.VALID)
                    continue;
                if (!s.rec.deleted || now - Date.parse(s.rec.updated) <= TOMBSTONE_PURGE_MS)
                    continue;
                if (await this._removeIfUnchanged(s)) {
                    purged++;
                    this._ownWrites.delete(id);
                }
            }
            await this._refreshLocked({});
            return purged;
        });
    }

    // Layout file (local, not synced). Reading never throws: a missing or broken file gives an empty layout.
    loadLayout() {
        return this._serial(async () => {
            const path = `${this.dirs.state}/layout.json`;
            try {
                const st = await this.fs.stat(path);
                if (st === null)
                    return Object.create(null);
                if (st.type !== 'regular' || st.size > MAX_FILE_BYTES) {
                    this.p.log.warn(`layout.json ignored: ${st.type}, ${st.size} bytes`);
                    return Object.create(null);
                }
                const {layout, dropped, error} = parseLayout(new TextDecoder().decode(await this.fs.readBytes(path)));
                if (error || dropped)
                    this.p.log.warn(`layout.json: ${error ?? `${dropped} entries dropped`}`);
                return layout;
            } catch (e) {
                this.p.log.warn(`layout.json not read: ${e.code ?? e.message}`);
                return Object.create(null);
            }
        });
    }

    saveLayout(layout) {
        return this._serial(() => this._writeStateFile('layout.json', serializeLayout(layout)));
    }

    // ---- internals --------------------------------------------------------------------------------------------

    _serial(fn) {
        const run = this._chain.then(fn);
        this._chain = run.catch(() => {});
        return run;
    }

    _emit(ev) {
        for (const fn of this._listeners) {
            try {
                fn(ev);
            } catch (e) {
                this.p.log.warn(`listener failed: ${e?.message}`);
            }
        }
    }

    _logOnce(key, msg) {
        if (this._logged.has(key))
            return;
        this._logged.add(key);
        this.p.log.warn(msg);
    }

    // Section 7 "Paths": a path under notes/ is built only from an enumerated or computed NAME_MAIN / NAME_CONFLICT name.
    _notePath(name) {
        if (!NAME_MAIN.test(name) && !NAME_CONFLICT.test(name))
            throw new Error(`refusing to build a path from ${JSON.stringify(name)}`);
        return `${this.dirs.notes}/${name}`;
    }

    async _cleanTmp() {
        let list;
        try {
            list = await this.fs.listDir(this.dirs.tmp);
        } catch {
            return;
        }
        for (const item of list) {
            if (item.type === 'regular' && TMP_NAME_RE.test(item.name)) {
                try {
                    await this.fs.remove(`${this.dirs.tmp}/${item.name}`);
                } catch { /* our own leftover; the next start tries again */ }
            } else if (item.type === 'regular' && HOLD_NAME_RE.test(item.name)) {
                // a crash between the swap and the check of what it took out: keep that, whatever it is
                await this._keepOrDrop(`${this.dirs.tmp}/${item.name}`, 'orphan', null);
            }
        }
    }

    async _loadDeviceId() {
        const path = `${this.dirs.state}/device`;
        try {
            const st = await this.fs.stat(path);
            if (st !== null && st.type === 'regular' && st.size <= 64) {
                const text = new TextDecoder().decode(await this.fs.readBytes(path)).replace(/\n$/, '');
                if (DEVICE_RE.test(text)) {
                    this.deviceId = text;
                    return;
                }
            }
        } catch { /* fall through: generate */ }
        // Section 1.2: 8 hex characters from random bytes, ONCE, kept in ~/.local/state/cetli/device.
        this.deviceId = Array.from(this.p.randomBytes(4), b => b.toString(16).padStart(2, '0')).join('');
        const r = await this._writeStateFile('device', new TextEncoder().encode(`${this.deviceId}\n`));
        if (!r.ok)
            this.p.log.warn(`device id not persisted: ${r.code}`);
    }

    // tmp file beside the target (the state directory may be on another filesystem than notes/), then a rename.
    async _writeStateFile(name, bytes) {
        const tmp = `${this.dirs.state}/${name}.${this.p.randomUuid()}.tmp`;
        try {
            await this.fs.writeTmp(tmp, bytes);
            await this.fs.move(tmp, `${this.dirs.state}/${name}`, {overwrite: true});
            return {ok: true};
        } catch (e) {
            try { await this.fs.remove(tmp); } catch { /* may not exist */ }
            return {ok: false, code: e.code ?? 'IO'};
        }
    }

    // Section 1.5: canonical bytes to tmp/ (outside the synced folder), then Gio.File.move without fallback. The
    // OVERWRITE flag only where a rule replaces a known valid version (2.6). A failed write leaves the slot as it was
    // and removes our tmp file (4 (d) (iii)). Only a COMPLETED write of the save path (`own`) enters the own-write
    // filter (2.5, 3 (4)); the installs of the resolution do not, because the front end has to apply their result.
    //
    // `expect` (an entry of the last scan, with `overwrite`): the slot must still hold that entry. The transport can put a
    // new version into the slot at any moment, so a stat before the rename leaves a window. With `fs.exchange` there is
    // none: the swap takes whatever is in the slot out to tmp/, and what came out is looked at AFTERWARDS (_keepDisplaced):
    // a version that is not the one we read goes to backup/. Without `fs.exchange` the stat right before the move is all
    // there is (the window stays, only narrower).
    async _install(name, rec, {overwrite, own = false, expect = null}) {
        const dest = this._notePath(name);
        const swap = overwrite && expect !== null && typeof this.fs.exchange === 'function';
        const tmp = `${this.dirs.tmp}/${this.p.randomUuid()}.${swap ? 'x' : 'tmp'}`;
        try {
            await this.fs.writeTmp(tmp, rec.bytes);
        } catch (e) {
            try { await this.fs.remove(tmp); } catch { /* partial file may not exist */ }
            return {ok: false, code: e.code ?? FS.IO, stage: 'write'};
        }
        let done = false;
        if (swap) {
            try {
                await this.fs.exchange(tmp, dest);
                done = true;
            } catch (e) {
                if (e.code === FS.NOT_FOUND) {
                    try { await this.fs.remove(tmp); } catch { /* already gone */ }
                    this._logOnce(`gone|${name}`, `${name} vanished since it was read; not replaced this round`);
                    return {ok: false, code: 'CHANGED', stage: 'exchange'};
                }
                this._logOnce('noexchange', `atomic exchange is not available (${e.code ?? e.message}): ${name} is replaced after a check only`);
            }
        }
        if (done) {
            const outcome = await this._keepDisplaced(tmp, name, expect);
            if (outcome === 'kept')
                this.p.log.warn(`${name} changed while it was replaced: the version that was there is in ${this._backupDir}`);
        } else {
            if (expect !== null) {
                // the slot must still be the entry we read, checked right before the rename (after the durable tmp write)
                const st = await this.fs.stat(dest).catch(() => null);
                if (st === null || sigOf(st) !== expect.sig) {
                    try { await this.fs.remove(tmp); } catch { /* already gone */ }
                    return {ok: false, code: 'CHANGED', stage: 'check'};
                }
            }
            try {
                await this.fs.move(tmp, dest, {overwrite});
            } catch (e) {
                try { await this.fs.remove(tmp); } catch { /* already gone */ }
                return {ok: false, code: e.code ?? FS.IO, stage: 'move'};
            }
        }
        if (own)
            this._ownWrites.set(rec.id, rec.v);
        return {ok: true};
    }

    // What an exchange took out of `<name>` (it lies at `path` now): gone for good only if it holds no text or is the very
    // version we read (that one has its copy, or is a tombstone: the precondition of the install). Anything else is moved to
    // backup/, outside the synced folder. Returns 'gone' | 'same' | 'kept' | 'left'.
    async _keepDisplaced(path, name, expect) {
        return this._keepOrDrop(path, name.slice(0, UUID_LEN), expect);
    }

    async _keepOrDrop(path, label, expect) {
        try {
            const st = await this.fs.stat(path);
            if (st === null)
                return 'gone';
            if (st.type === 'directory') {
                this.p.log.warn(`${path} is a directory that took the place of a note; left where it is`);
                return 'left';
            }
            if (st.type !== 'regular' || st.size === 0) {
                await this.fs.remove(path);              // a symlink or an empty file holds no note text
                return 'gone';
            }
            if (expect !== null) {
                const c = this.fmt.classify(await this.fs.readBytes(path), label, this.p.now());
                if (c.state === ST.VALID && c.rec.v === expect.rec.v) {
                    await this.fs.remove(path);
                    return 'same';
                }
            }
            await this._backup(path, label);
            return 'kept';
        } catch (e) {
            this.p.log.warn(`what was taken out of ${label} could not be kept (${e.code ?? e.message}); it stays in ${path}`);
            return 'left';
        }
    }

    // Move one file into backup/ (same file system as tmp/ and notes/: a rename) and drop the oldest beyond BACKUP_KEEP.
    // The name sorts by time: 15 digits of ms, a sequence number for the same ms. The file just written is never the one
    // that goes (the clock may have stepped back, so older-looking names can be newer files).
    async _backup(path, label) {
        await this.fs.ensureDir(this._backupDir);
        const seq = String(this._backupSeq++ % 1000000).padStart(6, '0');
        const dest = `${this._backupDir}/${String(this.p.now()).padStart(15, '0')}-${seq}-${label}.json`;
        await this.fs.move(path, dest, {overwrite: false});
        try {
            const mine = dest.slice(dest.lastIndexOf('/') + 1);
            const names = (await this.fs.listDir(this._backupDir))
                .filter(i => i.type === 'regular' && BACKUP_NAME_RE.test(i.name)).map(i => i.name).sort();
            for (const old of names.filter(n => n !== mine).slice(0, Math.max(0, names.length - BACKUP_KEEP)))
                await this.fs.remove(`${this._backupDir}/${old}`);
        } catch { /* the copy is in place; the next backup prunes */ }
    }

    // Delete one file of notes/ only if it is still the entry we read. The rename takes exactly the file that is there at
    // that instant (no window between a check and a delete); what was taken is compared afterwards and put back, or kept in
    // backup/, if it is not the entry we read. A tmp/ on another file system cannot take a rename: the old stat-then-delete.
    async _removeIfUnchanged(entry) {
        const path = this._notePath(entry.name);
        try {
            const hold = `${this.dirs.tmp}/${this.p.randomUuid()}.x`;
            let captured = true;
            try {
                await this.fs.move(path, hold, {overwrite: false});
            } catch (e) {
                if (e.code === FS.NOT_FOUND) {
                    this._logOnce(`chg|${entry.name}|absent`, `${entry.name} changed since it was read; not deleted this round`);
                    return false;
                }
                if (e.code !== FS.NOT_SUPPORTED)
                    throw e;
                captured = false;
            }
            if (!captured) {
                const st = await this.fs.stat(path);
                if (st === null || sigOf(st) !== entry.sig) {
                    this._logOnce(`chg|${entry.name}|${sigOf(st)}`, `${entry.name} changed since it was read; not deleted this round`);
                    return false;
                }
                await this.fs.remove(path);
                return true;
            }
            const st = await this.fs.stat(hold);
            if (st !== null && sigOf(st) === entry.sig) {
                await this.fs.remove(hold);
                return true;
            }
            this._logOnce(`chg|${entry.name}|${sigOf(st)}`, `${entry.name} changed since it was read; not deleted this round`);
            try {
                await this.fs.move(hold, path, {overwrite: false});    // its name is its own: put it back
            } catch {
                await this._keepOrDrop(hold, entry.name.slice(0, UUID_LEN), null);
            }
            return false;
        } catch (e) {
            this.p.log.warn(`delete of ${entry.name} failed: ${e.code ?? e.message}`);
            return false;
        }
    }

    // ---- scanning (section 3) ---------------------------------------------------------------------------------

    async _scan({invalidate = new Set(), force = null} = {}) {
        const now = this.p.now();
        const list = await this.fs.listDir(this.dirs.notes);
        const seen = new Set();
        const need = [];
        let ignoredNames = 0;
        for (const item of list) {
            const name = item.name;
            if (name.startsWith('.'))
                continue;                                  // transport dotfiles: never read, written or deleted
            const main = NAME_MAIN.test(name);
            if (!main && !NAME_CONFLICT.test(name)) {
                ignoredNames++;
                this._logOnce(`name|${name}|${item.size}|${item.mtime}`, `ignored file name ${JSON.stringify(name)}`);
                continue;
            }
            seen.add(name);
            const sig = `${item.type}|${item.size}|${item.mtime}`;
            const old = this._entries.get(name);
            if (old && old.sig === sig && !old.retry && !invalidate.has(name) && old.state !== 'pending') {
                if (old.state === ST.QUARANTINED && now >= old.until) {
                    old.state = ST.VALID;                  // V6: the time has come, no re-read needed
                    old.reason = '';
                    delete old.until;
                }
                continue;
            }
            const e = {
                name, uuid: name.slice(0, UUID_LEN), kind: main ? 'main' : 'conflict', type: item.type, size: item.size,
                mtime: item.mtime, sig, state: 'pending', reason: '',
            };
            this._entries.set(name, e);
            const problem = entryProblem(item.type, item.size);   // V1, decided BEFORE the file is opened
            if (problem !== null) {
                e.state = ST.UNKNOWN;
                e.reason = `V1 ${problem}`;
                this._warnBad(e);
            } else {
                need.push(e);
            }
        }
        for (const name of [...this._entries.keys()]) {
            if (!seen.has(name))
                this._entries.delete(name);
        }

        // Cost bound: per tick at most 64 files and 4 MiB are read; the rest stays pending for the next tick.
        need.sort((a, b) => (a.name < b.name ? -1 : 1));
        let files = 0;
        let bytes = 0;
        for (const e of need) {
            const exempt = force !== null && e.uuid === force;
            if (!exempt && (files >= TICK_MAX_FILES || bytes + e.size > TICK_MAX_BYTES))
                continue;
            files++;
            bytes += e.size;
            await this._readEntry(e, now);
        }
        this._last.ignoredNames = ignoredNames;
    }

    async _readEntry(e, now) {
        let data;
        try {
            data = await this.fs.readBytes(this._notePath(e.name));
        } catch (ex) {
            if (ex.code === FS.NOT_FOUND) {
                this._entries.delete(e.name);              // gone between listing and read; the next event lists again
            } else {
                e.state = ST.UNKNOWN;
                e.reason = `read error ${ex.code ?? ex.message}`;
                e.retry = true;
                this._warnBad(e);
            }
            return;
        }
        const c = this.fmt.classify(data, e.uuid, now);
        e.state = c.state;
        e.reason = c.reason ?? '';
        e.rec = c.rec ?? null;
        e.until = c.until;
        e.shownText = c.shownText ?? null;
        if (c.state !== ST.VALID)
            this._warnBad(e);
    }

    _warnBad(e) {
        this._logOnce(`bad|${e.name}|${e.size}|${e.mtime}`, `${e.name}: ${e.state} (${e.reason})`);
    }

    _groups() {
        const groups = new Map();
        for (const e of this._entries.values()) {
            let g = groups.get(e.uuid);
            if (!g) {
                g = {main: null, conflicts: [], pending: false};
                groups.set(e.uuid, g);
            }
            if (e.kind === 'main')
                g.main = e;
            else
                g.conflicts.push(e);
            if (e.state === 'pending')
                g.pending = true;
        }
        for (const g of groups.values())
            g.conflicts.sort((a, b) => (a.name < b.name ? -1 : 1));
        return new Map([...groups].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
    }

    // Section 1.4: at most `maxNotes` valid notes are loaded. Already loaded ids stay; new ones are admitted in id order.
    _admit(groups) {
        const hasValid = g => (g.main?.state === ST.VALID) || g.conflicts.some(c => c.state === ST.VALID);
        const next = new Set([...this._admitted].filter(id => groups.has(id) && hasValid(groups.get(id))));
        let over = 0;
        for (const [id, g] of groups) {
            if (next.has(id) || !hasValid(g))
                continue;
            if (next.size < this.maxNotes) {
                next.add(id);
            } else {
                over++;
                this._logOnce(`over|${id}`, `note limit ${this.maxNotes} reached: ${id} is not loaded and stays on disk`);
            }
        }
        this._admitted = next;
        this._last.overLimit = over;
    }

    // ---- refresh = scan + resolve until nothing is written ----------------------------------------------------

    async _refreshLocked({invalidate = new Set()}) {
        let inv = invalidate;
        for (let pass = 0; pass < MAX_PASSES; pass++) {
            await this._scan({invalidate: inv});
            inv = new Set();
            const groups = this._groups();
            this._admit(groups);
            let work = 0;
            const frozen = [];
            const unsettled = [];
            for (const [id, g] of groups) {
                if (!this.resolveConflicts || !this._admitted.has(id) || g.pending || g.conflicts.length === 0)
                    continue;
                const r = await this._resolveGroup(id, g);
                work += r.work;
                if (r.frozen)
                    frozen.push(id);
                if (r.unsettled)
                    unsettled.push(id);
            }
            this._last.frozen = frozen;
            this._last.unsettled = unsettled;
            if (work === 0)
                break;
        }
        const result = this._publish();
        await this._retryRefused();
        return result;
    }

    _publish() {
        const groups = this._groups();
        let pending = 0;
        const next = new Map();
        for (const [id, g] of groups) {
            if (g.pending)
                pending += [g.main, ...g.conflicts].filter(e => e?.state === 'pending').length;
            if (this._admitted.has(id) && g.main?.state === ST.VALID)
                next.set(id, g.main.rec);
        }
        this._last.pending = pending;
        const changes = [];
        for (const [id, rec] of next) {
            const old = this._view.get(id);
            if (old && old.v === rec.v)
                continue;
            if (old && this._ownWrites.get(id) === rec.v)
                continue;                                   // echo of our own completed write (section 3 (4))
            changes.push({type: old ? 'changed' : 'added', id, record: rec});
        }
        for (const id of this._view.keys()) {
            // `gone`: the note has no entry at all, neither `<id>.json` nor a conflict copy. A note that only left the view (a quarantined, unknown,
            // newer or frozen file, over the limit, or a vanished main file with a conflict copy left) is still on disk; whoever acts on 'removed'
            // (a window closing) must not treat that as a vanished file. `gone === false` keeps the 0.2.5.4 behaviour (a mark, no closing).
            if (!next.has(id)) {
                const g = groups.get(id);
                changes.push({type: 'removed', id, record: null, gone: !g || (!g.main && g.conflicts.length === 0)});
            }
        }
        this._view = next;
        for (const ch of changes)
            this._emit(ch);
        return {changes, pending, stats: this.status()};
    }

    // ---- section 2.2 ------------------------------------------------------------------------------------------

    // State of a `<cid>.json` slot (or any main slot), measured fresh. `expected` is E(L) or null.
    async _slotState(name, expected) {
        const path = this._notePath(name);
        const st = await this.fs.stat(path);           // NOFOLLOW: any entry occupies the slot, a dangling symlink too
        if (st === null)
            return {kind: 'free'};
        const problem = entryProblem(st.type, st.size);
        if (problem !== null)
            return {kind: 'other', why: problem};
        let data;
        try {
            data = await this.fs.readBytes(path);
        } catch (e) {
            return {kind: 'other', why: `read error ${e.code ?? e.message}`};
        }
        const c = this.fmt.classify(data, name.slice(0, UUID_LEN), this.p.now());
        if (c.state === ST.VALID && expected && c.rec.v === expected.v)
            return {kind: 'expected', rec: c.rec};
        return {kind: 'other', why: c.state === ST.VALID ? 'another valid record' : `${c.state}: ${c.reason}`, state: c.state, rec: c.rec};
    }

    // One group, steps 0 to 5 of section 2.2. Returns {work, frozen, unsettled}: `work` counts files written or deleted.
    async _resolveGroup(x, g) {
        const s = g.main;
        // Step 0: FROZEN group.
        if (s && s.state !== ST.VALID) {
            this._logOnce(`frozen|${s.name}|${s.size}|${s.mtime}`, `group ${x} frozen: ${s.name} is ${s.state} (${s.reason})`);
            return {work: 0, frozen: true, unsettled: true};
        }
        const versions = new Map();                       // v -> {rec, conflictEntries}
        const note = (rec, entry) => {
            let item = versions.get(rec.v);
            if (!item) {
                item = {rec, conflicts: []};
                versions.set(rec.v, item);
            }
            if (entry)
                item.conflicts.push(entry);
        };
        if (s)
            note(s.rec, null);
        for (const c of g.conflicts) {
            if (c.state === ST.VALID)
                note(c.rec, c);
        }
        if (versions.size === 0)
            return {work: 0, unsettled: false};
        const all = [...versions.values()];
        const w = all.reduce((a, b) => (this.fmt.compare(b.rec, a.rec) > 0 ? b : a));
        const losers = all.filter(i => i !== w).sort((a, b) => (a.rec.v < b.rec.v ? -1 : 1));
        let work = 0;

        // Step 1 and 2: copies of the non-tombstone losers.
        const preserved = new Set();
        for (const l of losers) {
            if (l.rec.deleted)
                continue;                                 // nothing to preserve
            const copy = this.fmt.expectedCopy(l.rec, x);
            const slot = await this._slotState(mainName(copy.id), copy);
            if (slot.kind === 'expected') {
                preserved.add(l.rec.v);
            } else if (slot.kind === 'free') {
                const r = await this._install(mainName(copy.id), copy, {overwrite: false});
                if (r.ok) {
                    work++;
                    preserved.add(l.rec.v);
                } else {
                    this.p.log.warn(`copy ${copy.id} of ${x} not written (${r.stage} ${r.code}); group stays unsettled`);
                }
            } else {
                this._logOnce(`slot|${copy.id}|${slot.why}`, `copy place ${copy.id}.json of ${x} is taken (${slot.why}); the loser is not preserved`);
            }
        }

        // Step 3 (b): install W in `<X>.json`.
        let sHoldsW = false;
        if (s && s.rec.v === w.rec.v) {
            sHoldsW = true;
        } else {
            const d = s ? s.rec : null;
            if (d !== null && !d.deleted && !preserved.has(d.v)) {
                this._logOnce(`stuck|${x}|${d.v}|${w.rec.v}`, `group ${x}: ${mainName(x)} holds version ${d.v.slice(0, 8)} without a copy; ${w.rec.v.slice(0, 8)} not installed`);
                return {work, unsettled: true};
            }
            const r = await this._install(mainName(x), w.rec, {overwrite: s !== null, expect: s});
            if (!r.ok) {
                this.p.log.warn(`install of ${mainName(x)} failed (${r.stage} ${r.code}); evaluated again at the next event`);
                return {work, unsettled: true};
            }
            work++;
            sHoldsW = true;
        }

        // Step 3 (c): delete conflict files LAST, only the three cases of 4 (d) (i).
        let kept = false;
        for (const c of g.conflicts) {
            if (c.state !== ST.VALID) {
                continue;                                  // UNKNOWN / NEWER / QUARANTINED: never touched
            }
            const c1 = c.rec.v === w.rec.v && sHoldsW;
            const c2 = c.rec.deleted;
            const c3 = preserved.has(c.rec.v);
            if (!(c1 || c2 || c3)) {
                kept = true;
                this._logOnce(`keep|${c.name}|${c.size}|${c.mtime}`, `conflict file ${c.name} kept: its version is neither W, a tombstone nor preserved`);
                continue;
            }
            if (await this._removeIfUnchanged(c))
                work++;
            else
                kept = true;
        }
        return {work, unsettled: kept};
    }

    // ---- section 2.5: local save ------------------------------------------------------------------------------

    _refuse(code, {until = null, watch = null} = {}) {
        const text = CAUSE_TEXT[code](until === null ? '' : isoOf(until));
        return {ok: false, cause: {code, text, ...(until === null ? {} : {until: isoOf(until)}), ...(watch === null ? {} : {watch})}};
    }

    async _saveLocked(request) {
        // A save that found <X>.json changed under its hands starts over on a fresh read (the arrival becomes the copy of
        // 2.5 (ii)); after SAVE_RERUNS tries it is a MOVE_FAILED like any other, and nothing was overwritten.
        let result = await this._doSave(request);
        for (let n = 1; result.changed && n < SAVE_RERUNS; n++)
            result = await this._doSave(request);
        delete result.changed;
        const prior = this._refused.get(request.id);
        if (!result.ok) {
            // The mark carries its CAUSE in text and in the log (2.5).
            const c = result.cause;
            this._logOnce(`refuse|${request.id}|${c.code}|${c.until ?? ''}|${c.watch ?? ''}`, `save of ${request.id} refused: ${c.text}`);
        }
        if (result.ok || result.unchanged) {
            this._refused.delete(request.id);
        } else if (result.cause.watch && RETRY_CAUSES.has(result.cause.code)) {
            // 2.5: the retry watches the file that blocked the save; a failed copy write is the same refusal as "copy place
            // taken" (retry on a change of the copy slot). MOVE_FAILED has no blocking file: no retry, the next key starts
            // a new save.
            const st = await this.fs.stat(this._notePath(result.cause.watch)).catch(() => null);
            this._refused.set(request.id, {request, watchName: result.cause.watch, sig: sigOf(st)});
        } else if (prior) {
            this._refused.delete(request.id);
        }
        return result;
    }

    async _doSave({id, base, text, color, deleted, extra}) {
        if (this.deviceId === null)
            throw new Error('store not started: no device id yet (call start() first)');
        if (typeof id !== 'string' || !UUID_RE.test(id) || typeof text !== 'string' || typeof color !== 'string' ||
            typeof deleted !== 'boolean')
            return this._refuse(CAUSE.BAD_INPUT);
        const changes = extra === undefined ? new Map() : extraChanges(extra);
        if (changes === null)
            return this._refuse(CAUSE.BAD_INPUT);
        const name = mainName(id);
        // Read the current `<X>.json` and every other record of this id, fresh and without the tick budget.
        await this._scan({invalidate: new Set([name]), force: id});
        const g = this._groups().get(id) ?? {main: null, conflicts: [], pending: false};
        const s = g.main;

        // Condition (i): `<X>.json` absent or a valid record of the group.
        if (s && s.state !== ST.VALID) {
            if (s.state === ST.QUARANTINED)
                return this._refuse(CAUSE.QUARANTINE, {until: s.until, watch: name});
            if (s.state === ST.NEWER)
                return this._refuse(CAUSE.NEWER_SCHEMA, {watch: name});
            return this._refuse(CAUSE.NOT_READABLE, {watch: name});
        }
        const d = s ? s.rec : null;
        const text0 = deleted ? '' : text;
        if (utf8Len(text0) > MAX_TEXT_BYTES)
            return this._refuse(CAUSE.TOO_LARGE);

        // The unknown keys of the new record: those of the record the user started from, then the changes of this save
        // (a value sets, null removes). A deleted note keeps no `marks` (formatting contract, rule 6).
        const origin = base ?? d;
        const nextExtra = new Map(origin ? origin.extra : []);
        for (const [k, v] of changes) {
            if (v === null)
                nextExtra.delete(k);
            else
                nextExtra.set(k, v);
        }
        if (deleted)
            nextExtra.delete('marks');

        // Nothing changed: no write (section 3 (3)). The unknown keys count: a save that only changes `extra` is a change.
        if (d && base && base.v === d.v && d.text === text0 && d.color === color && d.deleted === deleted &&
            sameExtra(nextExtra, d.extra))
            return {ok: true, unchanged: true, record: d};

        // The new record: above everything seen (section 1.2), so that local typing wins. Built and checked BEFORE the
        // copy of D is written: a refused save leaves no trace.
        const known = [s, ...g.conflicts].filter(e => e && e.state === ST.VALID).map(e => e.rec);
        const rev = Math.max(0, ...known.map(r => r.rev)) + 1;
        if (rev > MAX_REV)
            return this._refuse(CAUSE.REV_LIMIT);
        const latest = Math.max(0, ...known.map(r => Date.parse(r.updated)));
        const nowMs = this.p.now();
        const updatedMs = Math.max(nowMs, latest + 1);
        // Not in PLAN.md (V6 would call a year above 2100 UNKNOWN): refuse like the rev limit. Easy to remove: this branch.
        if (new Date(updatedMs).getUTCFullYear() > YEAR_MAX)
            return this._refuse(CAUSE.REV_LIMIT);
        const rec = this.fmt.makeRecord({
            id, rev, updated: isoOf(updatedMs), created: origin ? origin.created : isoOf(nowMs), device: this.deviceId,
            color, text: text0, deleted, conflict_of: origin ? origin.conflict_of : null,
        }, nextExtra);
        if (!this.fmt.fitsV11(rec))
            return this._refuse(CAUSE.TOO_LARGE);
        // Never write a file our own reader would reject (clock before year 2000, a malformed `base`): V2 to V11 on the
        // bytes about to be written. Nothing is written, not even the copy of D.
        const check = this.fmt.classify(rec.bytes, id, nowMs);
        if (check.state !== ST.VALID) {
            this.p.log.warn(`save of ${id} would write an unreadable record (${check.reason})`);
            return this._refuse(CAUSE.BAD_INPUT);
        }

        // Condition (ii): if V(D) differs from V(B), D is a tombstone, or its copy slot is free or holds the expected copy.
        let copy = null;
        if (d && (!base || base.v !== d.v) && !d.deleted) {
            copy = this.fmt.expectedCopy(d, id);
            const slot = await this._slotState(mainName(copy.id), copy);
            if (slot.kind === 'other')
                return this._refuse(CAUSE.COPY_PLACE_TAKEN, {watch: mainName(copy.id)});
            if (slot.kind === 'free') {
                const r = await this._install(mainName(copy.id), copy, {overwrite: false, own: true});
                if (!r.ok) {
                    // The version of a write that did not succeed is NOT remembered (done in _install), and the local
                    // record is not written. EEXIST means the slot filled in since the check: same refusal.
                    this.p.log.warn(`copy ${copy.id} of ${id} not written (${r.stage} ${r.code})`);
                    return this._refuse(r.code === FS.EXISTS ? CAUSE.COPY_PLACE_TAKEN : CAUSE.COPY_NOT_WRITTEN, {watch: mainName(copy.id)});
                }
            }
        }

        const r = await this._install(name, rec, {overwrite: d !== null, own: true, expect: d !== null ? s : null});
        if (!r.ok) {
            // CHANGED: <X>.json is no longer the entry this save read (checked move) or vanished (exchange). Nothing was
            // replaced; the save runs again on a fresh read (_saveLocked). Any other failure stays a MOVE_FAILED.
            return {...this._refuse(CAUSE.MOVE_FAILED, {watch: name}), changed: r.code === 'CHANGED'};
        }
        await this._refreshLocked({});
        return {ok: true, record: rec};
    }

    // A refused save is tried again when the entry that blocked it changes (2.5): `<X>.json` for refusal (i), the copy
    // slot of D for refusal (ii).
    async _retryRefused() {
        for (const [id, item] of [...this._refused]) {
            const st = await this.fs.stat(this._notePath(item.watchName)).catch(() => null);
            if (sigOf(st) === item.sig)
                continue;
            this._refused.delete(id);
            const result = await this._saveLocked(item.request);
            this._emit({type: 'save-retried', id, result});
        }
    }
}
