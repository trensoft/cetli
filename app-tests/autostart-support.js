// SPDX-License-Identifier: GPL-3.0-or-later
// Shared by the smokes of the start at login (autostart-*.js, 0.2.8): three notes in the notes folder and the local layout.json that says which of them
// were left open.
import GLib from 'gi://GLib';

export const ID_A = '00000000-0000-4000-8000-0000000000a1';
export const ID_B = '00000000-0000-4000-8000-0000000000b2';
export const ID_C = '00000000-0000-4000-8000-0000000000c3';

const ago = min => new Date(Date.now() - min * 60000).toISOString();
const note = (id, text) => ({schema: 1, id, rev: 2, updated: ago(90), created: ago(500), device: 'b5b5b5b5', color: 'yellow', text, deleted: false, conflict_of: null});

// `open`: {id: true | false}; a note that is not named there has no layout entry (a note the extension has not seen yet).
export const seedNotes = open => dirs => {
    for (const [id, text] of [[ID_A, 'note a'], [ID_B, 'note b'], [ID_C, 'note c']])
        GLib.file_set_contents(`${dirs.notes}/${id}.json`, `${JSON.stringify(note(id, text))}\n`);
    GLib.mkdir_with_parents(dirs.state, 0o755);
    const layout = {};
    for (const [id, o] of Object.entries(open))
        layout[id] = {x: 100, y: 100, w: 300, h: 200, monitor: '1920x1080+0+0', open: o};
    GLib.file_set_contents(`${dirs.state}/layout.json`, `${JSON.stringify(layout)}\n`);
};

export const layoutText = dirs => new TextDecoder().decode(GLib.file_get_contents(`${dirs.state}/layout.json`)[1]);
