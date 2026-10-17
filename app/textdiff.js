// SPDX-License-Identifier: GPL-3.0-or-later
// PLAN.md section 3: the diff of a remote text is taken on code point arrays, because JavaScript strings count UTF-16
// units and Gtk.TextBuffer counts characters (code points). Only the changed middle part is replaced in the buffer, so
// a cursor before it stays, one after it shifts by the length delta, and one inside it ends at the end of the region
// (the insert mark sits after the inserted text) without any cursor arithmetic here.

// Returns null when the texts are equal, else {start, deleteCount, insert}; start and deleteCount in code points.
export function changedRegion(oldText, newText) {
    if (oldText === newText)
        return null;
    const a = Array.from(oldText);
    const b = Array.from(newText);
    let prefix = 0;
    const max = Math.min(a.length, b.length);
    while (prefix < max && a[prefix] === b[prefix])
        prefix++;
    let suffix = 0;
    while (suffix < max - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix])
        suffix++;
    return {start: prefix, deleteCount: a.length - prefix - suffix, insert: b.slice(prefix, b.length - suffix).join('')};
}
