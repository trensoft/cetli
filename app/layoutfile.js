// SPDX-License-Identifier: GPL-3.0-or-later
// layout.json (local, not synced) is written by two parties: the GNOME Shell extension owns x, y, w, h and monitor, this
// app owns `open` (extension/README.md). Every write here reads the file again first and changes only the `open` member of
// ONE entry (read-modify-write). The core's parseLayout/serializeLayout do the validation (through store.loadLayout and
// store.saveLayout). An id without an entry is left alone: x, y, w, h and monitor are required members, and the
// extension creates the entry (open: true) when it first sees the window. KNOWN GAP: another process can still write
// between our read and our write; the window is a few milliseconds.
// "Changes only `open`" is about what THIS file edits. The core's serializeLayout writes the whole file and drops, on
// every write, the invalid entries and every unknown member (measured: an entry with w: -5 and extra/sticky members
// disappear). The contract is x y w h monitor open; the extension does the same, so nothing valid is lost.

// A note is shown at start unless its entry says `open: false`.
export const shouldOpen = (layout, id) => layout[id]?.open !== false;

// The core's loadLayout and saveLayout are two separate steps, so two changes of this process that overlap would lose one
// (both read, both write). The changes of one store are therefore queued here (the core keeps `updateLayout` out).
const queues = new WeakMap();

// Returns true if the file was written.
export function setOpen(store, id, open) {
    const run = (queues.get(store) ?? Promise.resolve()).then(async () => {
        const layout = await store.loadLayout();
        const entry = layout[id];
        if (!entry || entry.open === open)
            return false;
        layout[id] = {...entry, open};
        const r = await store.saveLayout(layout);
        return r.ok === true;
    });
    queues.set(store, run.catch(() => {}));
    return run;
}

// The size a window starts with, from its entry (a Wayland client may choose its size, not its place).
export function sizeOf(layout, id, fallback, min, max) {
    const e = layout[id];
    const clamp = (v, d) => (Number.isFinite(v) && v > 0 ? Math.min(max, Math.max(min, Math.round(v))) : d);
    return e ? {width: clamp(e.w, fallback.width), height: clamp(e.h, fallback.height)} : fallback;
}
