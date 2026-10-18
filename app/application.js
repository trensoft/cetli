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
import {SyncBridge} from './sync-bridge.js';
import {notesSynced, wantsFirstStart, writeDismissed} from './sync-hook.js';
import {SyncWizard} from './sync-wizard.js';
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
    more.append(S.menuSync(), 'app.sync-setup');
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

// `dirs`, `fs` and `platform` can be given by a test; the product uses the defaults of the core's Gio layer. `bridge` and `homeDir` are given
// by a test too (a fake bridge replays the engine; the home is where the first-start hook looks for `.stfolder` markers).
// `firstStartSync`: the product (main.js) turns the first-start sync window on; the tests of the notes leave it off.
export function createApp({dirs = gio.defaultDirs(), fs = gio.fs, platform = gio.platform, bridge = null, homeDir = undefined, firstStartSync = false} = {}) {
    const gtkApp = new Adw.Application({application_id: APP_ID, flags: Gio.ApplicationFlags.DEFAULT_FLAGS});
    const store = createStore({fs, platform, dirs, resolveConflicts: true});   // the copies of Syncthing conflicts are resolved by the product; the store default stays off
    const windows = new Map();
    const version = readVersion();
    const syncBridge = bridge ?? new SyncBridge({log: m => platform.log.warn(m)});
    let syncWin = null;                  // the one sync window, while it is open
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
        onSyncClosed: win => {
            if (syncWin === win)
                syncWin = null;
        },
        // "Later" on the consent page of the first-start window: the answer is written (no ID, no label), so it does not come back.
        dismissSync: () => {
            try {
                writeDismissed(dirs.state);
            } catch (e) {
                platform.log.warn(`sync-wizard.json not written: ${e?.message ?? e}`);
            }
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

    // Only the very first note is red (0.2.4): when no live note exists yet. Every later new note gets the base colour the core picks
    // (src/colors.js, as before 0.2.4). The check and the create are one step in a chain, so two quick "new" clicks on an empty store
    // do not both see "no note" and make two red ones.
    let newNoteChain = Promise.resolve();
    function createNoteRed1st() {
        const step = newNoteChain.then(() => store.createNote(store.listNotes().some(n => !n.deleted) ? {text: ''} : {text: '', color: NOTE_RHEL_RED}));
        newNoteChain = step.catch(() => {});
        return step;
    }

    async function newNote(from) {
        const res = await createNoteRed1st();
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

    // The menu item and the first start. A window that is already open is brought to the front.
    function showSync({firstStart = false} = {}) {
        if (syncWin === null)
            syncWin = new SyncWizard({ctl, bridge: syncBridge, firstStart});
        syncWin.present();
        return syncWin;
    }

    // The first start (PLAN-WIZARD 0H.11): no state file and no `.stfolder` anywhere from notes/ up to $HOME. Nothing runs before the
    // user presses the button in the window; a failure here must never block the notes.
    function maybeShowFirstStartSync() {
        try {
            if (firstStartSync && wantsFirstStart({dirs, homeDir}))
                showSync({firstStart: true});
        } catch (e) {
            platform.log.warn(`sync window not opened: ${e?.message ?? e}`);
        }
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
        if (windows.size === 0) {
            if (synced())
                showAllNotes();                        // 0.2.5.1: a window must open (GTK quits without one), but not a new note
            else
                await newNote(null);
        }
    }

    // 0.2.5.1: a synchronised notes folder gets no note of its own at the start (it may fill a moment later, and the new note would reach
    // every computer). A failure of the query counts as synchronised. Both starts open the list instead (without a window GTK quits).
    function synced() {
        try {
            return notesSynced({dirs, homeDir});
        } catch {
            return true;
        }
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
        if (windows.size === 0) {
            if (synced())
                showAllNotes();                        // 0.2.5.1: no note of its own on a synchronised folder; the list shows that it runs
            else
                await newNote(null);
        }
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
        maybeShowFirstStartSync();
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
        const sync = new Gio.SimpleAction({name: 'sync-setup'});
        sync.connect('activate', () => showSync());
        gtkApp.add_action(sync);
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

    gtkApp.connect('shutdown', () => {
        watcher?.stop();
        syncBridge.stop();
    });

    return {gtkApp, store, windows, ctl, ready, run: argv => gtkApp.run(argv), showAllNotes, showSync, get allNotes() { return allNotes; }, get syncWindow() { return syncWin; }};
}
