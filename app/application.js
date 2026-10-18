// SPDX-License-Identifier: GPL-3.0-or-later
// The application (PLAN.md sections 3, 8, 9): starts the core, opens one window per note, routes the core's events to
// the windows, owns the hamburger menu and the About window. The core is used as it is (src/index.js, src/gio-layer.js);
// conflict resolution is OFF in the first version (the core keeps conflict files and counts them).
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {createStore, createWatcher} from '../src/index.js';
import * as gio from '../src/gio-layer.js';
import {
    APP_ID, APP_NAME, COPYRIGHT, DEFAULT_COLOR, DEFAULT_HEIGHT, DEFAULT_WIDTH, DEVELOPER, ISSUE_URL, MAX_SIZE, MIN_SIZE, NOTE_RHEL_RED, WEBSITE,
    buildCss,
} from './data.js';
import {AllNotesWindow} from './allnotes.js';
import {setOpen, shouldOpen, sizeOf} from './layoutfile.js';
import {NoteWindow} from './window.js';
import * as S from './strings.js';

function readVersion() {
    try {
        const file = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_child('VERSION');
        const [, bytes] = file.load_contents(null);
        return new TextDecoder().decode(bytes).trim();
    } catch (e) {
        console.warn(`cetli: VERSION not read: ${e.message}`);
        return '';
    }
}

function buildMenu() {
    const menu = new Gio.Menu();
    // The colour grid: an item the menu cannot draw itself; each note window puts its grid in under the id 'colors'.
    const colors = new Gio.Menu();
    const grid = Gio.MenuItem.new(null, null);
    grid.set_attribute_value('custom', GLib.Variant.new_string('colors'));
    colors.append_item(grid);
    menu.append_section(null, colors);
    const notes = new Gio.Menu();
    notes.append(S.menuAllNotes(), 'app.all-notes');
    notes.append(S.menuDeleteNote(), 'win.delete');
    menu.append_section(null, notes);
    const more = new Gio.Menu();
    more.append(S.menuAbout(), 'win.about');
    menu.append_section(null, more);
    return menu;
}

function loadCss() {
    const provider = new Gtk.CssProvider();
    const css = buildCss();
    if (typeof provider.load_from_string === 'function')
        provider.load_from_string(css);
    else
        provider.load_from_data(css);
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
}

// `dirs`, `fs` and `platform` can be given by a test; the product uses the defaults of the core's Gio layer.
export function createApp({dirs = gio.defaultDirs(), fs = gio.fs, platform = gio.platform} = {}) {
    const gtkApp = new Adw.Application({application_id: APP_ID, flags: Gio.ApplicationFlags.DEFAULT_FLAGS});
    const store = createStore({fs, platform, dirs});          // resolveConflicts stays at its default: off
    const windows = new Map();
    const version = readVersion();
    let menu = null;
    let watcher = null;
    let allNotes = null;                 // the one "All notes" window, while it is open
    let starting = false;
    let unresolved = 0;
    let resolveReady;
    let rejectReady;

    const ctl = {
        store, gtkApp, windows, version,
        get menu() { return menu; },
        dark: () => Adw.StyleManager.get_default().get_dark(),
        hold: () => gtkApp.hold(),
        release: () => gtkApp.release(),
        log: m => platform.log.warn(m),
        closed: id => {
            windows.delete(id);
            allNotes?.scheduleRefresh();               // the eye of its card
        },
        setOpen: async (id, open) => {
            try {
                await setOpen(store, id, open);
            } catch (e) {
                platform.log.warn(`layout.json not updated: ${e?.message ?? e}`);
            }
        },
        showAbout: parent => showAbout(parent),
        newNote: from => newNote(from),
        notesChanged: () => allNotes?.scheduleRefresh(),
        openNote: id => openNote(id),
        isOpen: id => windows.has(id),
        closeNote: id => windows.get(id)?.win.close(),
        deleteNote: id => deleteNote(id),
        onAllNotesClosed: win => {
            if (allNotes === win)
                allNotes = null;
        },
    };

    function showAbout(parent) {
        const props = {
            application_name: APP_NAME, application_icon: APP_ID, developer_name: DEVELOPER, version, comments: S.aboutComments(),
            copyright: COPYRIGHT, license_type: Gtk.License.GPL_3_0, website: WEBSITE, issue_url: ISSUE_URL, developers: [DEVELOPER],
        };
        if (typeof Adw.AboutDialog === 'function') {
            // libadwaita 1.5 and later. The parent is a plain Gtk.ApplicationWindow, so the dialog is a separate window.
            new Adw.AboutDialog(props).present(parent);
        } else {
            new Adw.AboutWindow({...props, transient_for: parent, destroy_with_parent: true}).present();
        }
    }

    async function openWindow(record, layout) {
        const existing = windows.get(record.id);
        if (existing)
            return existing;                           // e.g. the 'added' event of our own createNote
        const win = new NoteWindow({ctl, record, size: sizeOf(layout, record.id, {width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT}, MIN_SIZE, MAX_SIZE)});
        windows.set(record.id, win);
        win.setUnresolved(unresolved);
        win.present();
        allNotes?.scheduleRefresh();                   // the eye of its card
        return win;
    }

    async function newNote(from) {
        const res = await store.createNote({text: '', color: NOTE_RHEL_RED});   // a new note is red (0.2.4); the core's random pick (src/colors.js) is not used here
        if (!res.ok) {
            from?._setMark('refused', S.markNotSaved(res.cause.code));
            return null;
        }
        allNotes?.scheduleRefresh();
        const existing = windows.get(res.record.id);
        return existing ?? openWindow(res.record, {});
    }

    // A click in the "All notes" list: bring the note's window to the front, or open it again when it was closed.
    async function openNote(id) {
        const rec = store.getNote(id);
        if (!rec || rec.deleted)
            return;
        const w = windows.get(id);
        if (w) {
            w.win.present();
            return;
        }
        await openWindow(rec, await store.loadLayout());
        ctl.setOpen(id, true);
    }

    // The trash of a card in the "All notes" list. An open note is deleted by its window (which knows its base and closes itself);
    // a closed one has no window: it is deleted here from the record the core holds. A refused delete leaves the card and says so.
    async function deleteNote(id) {
        const w = windows.get(id);
        if (w) {
            w.deleteNote();
            return;
        }
        const rec = store.getNote(id);
        if (!rec || rec.deleted)
            return;
        ctl.hold();
        try {
            const res = await store.deleteNote(id, rec);
            if (res.ok) {
                ctl.notesChanged?.();
            } else {
                platform.log.warn(`All notes: delete refused (${res.cause?.code})`);
                allNotes?.showError(S.deleteRefused(res.cause?.code));
            }
        } finally {
            ctl.release();
        }
    }

    function showAllNotes() {
        if (allNotes === null)
            allNotes = new AllNotesWindow({ctl});
        allNotes.present();
    }

    const alive = () => store.listNotes().filter(n => !n.deleted);

    // First activation: the notes that are not marked closed; when none would show, all of them; when there are none, a new one.
    async function showStartWindows() {
        const layout = await store.loadLayout();
        const notes = alive();
        let show = notes.filter(n => shouldOpen(layout, n.id));
        if (show.length === 0)
            show = notes;
        for (const n of show)
            await openWindow(n, layout);
        if (windows.size === 0)
            await newNote(null);
    }

    // Another launch of the program while it runs: bring every note back (closed ones too).
    async function showAll() {
        const layout = await store.loadLayout();
        for (const n of alive()) {
            const w = windows.get(n.id);
            if (w) {
                w.win.present();
            } else {
                await openWindow(n, layout);
                ctl.setOpen(n.id, true);
            }
        }
        if (windows.size === 0)
            await newNote(null);
    }

    function onStoreEvent(ev) {
        if (starting)
            return;
        allNotes?.scheduleRefresh();
        const w = windows.get(ev.id);
        switch (ev.type) {
        case 'added':
        case 'changed':
            if (w) {
                w.onRemote(ev.record);
            } else if (ev.type === 'added' && !ev.record.deleted) {
                store.loadLayout().then(layout => (shouldOpen(layout, ev.id) ? openWindow(ev.record, layout) : null))
                    .catch(e => platform.log.warn(`window not opened: ${e?.message ?? e}`));
            }
            break;
        case 'removed':
            w?.onRemoved();
            break;
        case 'save-retried':
            w?.onSaveRetried(ev.result);
            break;
        default:
            break;
        }
    }

    // The watcher asks the store for a refresh; this wrapper reads the count of kept conflict files after each one.
    const refreshing = {
        refresh: async arg => {
            const r = await store.refresh(arg);
            const n = r?.stats?.unresolved ?? 0;
            if (n !== unresolved) {
                unresolved = n;
                for (const w of windows.values())
                    w.setUnresolved(n);
            }
            return r;
        },
        nextQuarantineRelease: () => store.nextQuarantineRelease(),
    };

    async function start() {
        starting = true;
        await store.start();
        watcher = createWatcher({
            store: refreshing, monitorFactory: gio.monitorFactory, timers: gio.timers, notesDir: dirs.notes, now: platform.now,
            onError: e => platform.log.warn(`refresh failed: ${e?.message ?? e}`),
        });
        store.onEvent(onStoreEvent);
        await watcher.start();
        starting = false;
        await showStartWindows();
    }

    const ready = new Promise((res, rej) => {
        resolveReady = res;
        rejectReady = rej;
    });

    gtkApp.connect('startup', () => {
        loadCss();
        menu = buildMenu();
        const add = new Gio.SimpleAction({name: 'new-note'});
        add.connect('activate', () => newNote(null));
        gtkApp.add_action(add);
        const all = new Gio.SimpleAction({name: 'all-notes'});
        all.connect('activate', () => showAllNotes());
        gtkApp.add_action(all);
        gtkApp.set_accels_for_action('app.new-note', ['<Control>n']);
        gtkApp.set_accels_for_action('app.all-notes', ['<Control>h']);
        Adw.StyleManager.get_default().connect('notify::dark', () => {
            for (const w of windows.values())
                w.setDark(ctl.dark());
            allNotes?.setDark(ctl.dark());
        });
    });

    let startPromise = null;
    gtkApp.connect('activate', () => {
        gtkApp.hold();                                 // the app must live while the core starts
        // A second activation while start() is still running waits for it and then shows all (start() must run once).
        const first = startPromise === null;
        if (first)
            startPromise = start();
        (first ? startPromise : startPromise.then(() => showAll())).then(() => resolveReady(ctl), e => {
            platform.log.warn(`start failed: ${e?.message ?? e}`);
            rejectReady(e);
            gtkApp.quit();
        }).finally(() => gtkApp.release());
    });

    gtkApp.connect('shutdown', () => watcher?.stop());

    return {gtkApp, store, windows, ctl, ready, run: argv => gtkApp.run(argv), showAllNotes, get allNotes() { return allNotes; }};
}
