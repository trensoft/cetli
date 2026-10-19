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

// The program is stopped while two notes are open and one is closed (0.2.8): `mode` is how, 'quit' (gtkApp.quit()) or 'sigterm' (what the session
// sends at logout). Only the user closing a window writes `open: false`; the end of the program must leave the marks as they are, so that the notes
// come back at the next login. The user closes A by hand first: that one must be written (the control of the test).
// The SIGTERM goes to ONE known pid: this process, the program under test (the scenario runs inside it). Its pid is read from /proc/self, never from
// $PPID or a process group or a name, so no other process (the runner, a wrapper) can be reached. Returns {seed, run, atShutdown} for runStartGate.
const ownPid = () => {
    const pid = Number(GLib.file_read_link('/proc/self'));
    const cmd = new TextDecoder().decode(GLib.file_get_contents(`/proc/${pid}/cmdline`)[1]);
    if (!Number.isInteger(pid) || pid <= 1 || !/gjs/.test(cmd))
        throw new Error(`not a usable own pid: ${pid}`);
    return pid;
};

export const stopTest = mode => {
    const openOf = dirs => Object.fromEntries(Object.entries(JSON.parse(layoutText(dirs))).map(([id, e]) => [id, e.open]));
    const calls = [];                                  // every ctl.setOpen of the program: [id, open]
    let afterStop = 0;                                 // how many of them were there when the stop began
    return {
        seed: seedNotes({[ID_A]: true, [ID_B]: true, [ID_C]: false}),
        run: async ({app, windows, check, waitFor, dirs}) => {
            await app.ready;
            const setOpen = app.ctl.setOpen;
            app.ctl.setOpen = (id, open) => {
                calls.push([id, open]);
                return setOpen(id, open);
            };
            check(await waitFor(() => windows.size === 2) && windows.has(ID_A) && windows.has(ID_B), 'the two notes left open are open, the closed one is not');
            windows.get(ID_A).win.close();
            check(await waitFor(() => !windows.has(ID_A) && openOf(dirs)[ID_A] === false), 'closing a window by hand writes open: false');
            check(calls.length === 1 && calls[0][0] === ID_A && calls[0][1] === false, 'the close by hand is the only setOpen call so far');
            // A window that goes away together with the program (the session closing it, the toolkit taking it down) while the stop is under way: its
            // close-request comes after the program knows it is stopping, in the same turn of the main loop.
            const closeB = () => {
                windows.get(ID_B)?.win.close();
                return GLib.SOURCE_REMOVE;
            };
            const pid = mode === 'sigterm' ? ownPid() : 0;
            if (mode === 'sigterm') {
                // The program's own SIGTERM handler marks the stop and then calls gtkApp.quit(): the window goes away at that call, so the order does not
                // depend on how GLib orders two handlers of one signal.
                const quit = app.gtkApp.quit.bind(app.gtkApp);
                app.gtkApp.quit = () => {
                    closeB();
                    quit();
                };
            } else {
                app.gtkApp.connect('shutdown', closeB);                          // the program's own 'shutdown' handler was connected first
            }
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                afterStop = calls.length;
                if (mode === 'quit')
                    app.gtkApp.quit();
                else
                    GLib.spawn_async(null, ['kill', '-TERM', String(pid)], null, GLib.SpawnFlags.SEARCH_PATH, null);
                return GLib.SOURCE_REMOVE;
            });
        },
        atShutdown: ({check, dirs}) => {
            const o = openOf(dirs);
            check(calls.length === afterStop, `after ${mode}: the stop made no setOpen call (${JSON.stringify(calls.slice(afterStop))})`);
            check(o[ID_A] === false, `after ${mode}: the note closed by hand stays marked closed`);
            check(o[ID_B] === true, `after ${mode}: the note left open is still marked open`);
            check(o[ID_C] === false, `after ${mode}: the closed note is still marked closed`);
        },
    };
};
