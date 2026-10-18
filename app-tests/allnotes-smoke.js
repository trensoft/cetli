// SPDX-License-Identifier: GPL-3.0-or-later
// Headless smoke test of the "All notes" window (0.2.1): run it inside a headless Wayland compositor, see app-tests/run.sh.
// Same setup as gtk-smoke.js (real application.js, real core, real Gio layer, temporary XDG tree). Every wait is a POLL on a
// condition with a generous limit, never a fixed sleep, so that a loaded machine only makes it slower, not red.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';

import {createApp} from '../app/application.js';
import {COLORS, NOTE_RHEL_RED, cssClassOf} from '../app/data.js';
import {AllNotesWindow, CARD_CSS} from '../app/allnotes.js';
import {PREVIEW_LINES, PREVIEW_LINE_CHARS} from '../app/preview.js';
import * as S from '../app/strings.js';

const base = GLib.dir_make_tmp('cetli-all-XXXXXX');
const dirs = {notes: `${base}/data/notes`, tmp: `${base}/data/tmp`, state: `${base}/state`};
let failed = 0;
let checks = 0;
const check = (cond, label) => {
    checks++;
    if (cond) {
        print(`ok   ${label}`);
    } else {
        failed++;
        print(`FAIL ${label}`);
    }
};
// gjs 1.74 (SpiderMonkey 102) has no String.prototype.isWellFormed
const wellFormed = t => !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(t);
const info = text => print(`info ${text}`);
const readText = p => new TextDecoder().decode(GLib.file_get_contents(p)[1]);
const fileRec = id => JSON.parse(readText(`${dirs.notes}/${id}.json`));
const tick = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE; }));
// Polls `cond` every 40 ms until it holds or `limit` ms have passed; true when it held.
async function waitFor(cond, limit = 8000) {
    const t0 = GLib.get_monotonic_time();
    for (;;) {
        if (cond())
            return true;
        if ((GLib.get_monotonic_time() - t0) / 1000 > limit)
            return false;
        await tick(40);
    }
}
// What Syncthing does: a hidden tmp file, then a rename (also for a new file).
function remotePut(id, rec) {
    const tmp = `${dirs.notes}/.syncthing.${id}.json.tmp`;
    GLib.file_set_contents(tmp, `${JSON.stringify(rec)}\n`);
    Gio.File.new_for_path(tmp).move(Gio.File.new_for_path(`${dirs.notes}/${id}.json`), Gio.FileCopyFlags.OVERWRITE, null, null);
}
let seq = 0;
const stamp = () => new Date(Date.now() + 60000 + (seq++)).toISOString();
const remoteRecord = (over = {}) => {
    const id = over.id ?? GLib.uuid_string_random();
    const t = stamp();
    return {schema: 1, id, rev: 1, updated: t, created: t, device: 'b5b5b5b5', color: 'pink', text: 'remote', deleted: false, conflict_of: null, ...over};
};

const ctl = createApp({dirs});
const {gtkApp, windows} = ctl;

async function scenario() {
    await ctl.ready;
    const tops = () => Gtk.Window.list_toplevels().length;
    const aliveIds = () => ctl.store.listNotes().filter(n => !n.deleted).map(n => n.id);
    const newNote = async () => {
        const known = new Set(windows.keys());
        gtkApp.activate_action('new-note', null);
        await waitFor(() => windows.size === known.size + 1);
        const nid = [...windows.keys()].find(k => !known.has(k));
        return [nid, windows.get(nid)];
    };
    const [idA, wA] = [...windows][0];

    // ---- the menu and the single instance
    const items = [];
    const walk = m => {
        for (let i = 0; i < m.get_n_items(); i++) {
            items.push({label: m.get_item_attribute_value(i, 'label', null)?.get_string()[0], action: m.get_item_attribute_value(i, 'action', null)?.get_string()[0]});
            for (const kind of ['section', 'submenu']) {
                const sub = m.get_item_link(i, kind);
                if (sub)
                    walk(sub);
            }
        }
    };
    walk(ctl.ctl.menu);
    check(items.some(i => i.action === 'app.all-notes' && i.label === S.menuAllNotes()), 'the hamburger menu has "All notes"');
    const topsBefore = tops();
    gtkApp.activate_action('all-notes', null);
    check(await waitFor(() => ctl.allNotes !== null && tops() === topsBefore + 1), '"All notes" opens one window');
    const list = ctl.allNotes;
    check(list.win.get_title() === S.allNotesTitle() && !list.win.get_title().startsWith('cetli-'), `with a title of its own, not cetli-<uuid> (${list.win.get_title()})`);
    gtkApp.activate_action('all-notes', null);
    ctl.showAllNotes();
    await tick(300);
    check(tops() === topsBefore + 1 && ctl.allNotes === list, 'a second request opens no second window (menu action and method)');
    check(!windows.has(list.win.get_title()), 'the list is not among the note windows');

    // ---- rows: one per live note; empty placeholder; live update from a local edit
    const rowLabel = id => list.rows.get(id)?.label.get_label();
    const order = () => { const out = []; for (let i = 0; list.list.get_row_at_index(i); i++) out.push(list.list.get_row_at_index(i)._cetli.id); return out; };
    check(list.rows.size === aliveIds().length && list.list.get_row_at_index(list.rows.size) === null, `one row per live note (${list.rows.size})`);
    check(rowLabel(idA) === S.emptyNotePreview(), `an empty note shows the placeholder (${rowLabel(idA)})`);
    wA.buffer.set_text('first line\n\n  second line  \nthird\nfourth', -1);
    check(await waitFor(() => rowLabel(idA) === 'first line\nsecond line\nthird'), `the row follows the typing: ${JSON.stringify(rowLabel(idA))}`);
    const cls = c => list.rows.get(idA).row.has_css_class(cssClassOf(c));
    const colorOfA = [...COLORS, NOTE_RHEL_RED].find(c => cls(c));
    check(colorOfA === wA.color && colorOfA === NOTE_RHEL_RED && [...COLORS, NOTE_RHEL_RED].filter(c => cls(c)).length === 1, `the row carries the colour class of its note (a new note is red), one only (${colorOfA})`);
    const other = COLORS.find(c => c !== wA.color);
    wA.setColor(other);
    check(await waitFor(() => cls(other) && !cls(colorOfA)), 'a colour change moves the class of the row');
    const [idB, wB] = await newNote();
    check(await waitFor(() => list.rows.has(idB)), 'a new note gets a row');
    const [idC, wC] = await newNote();
    check(await waitFor(() => list.rows.has(idC)), 'and a third');
    check(await waitFor(() => order().join() === [...aliveIds()].map(i => list.rows.get(i)).sort((a, b) => (a.updated < b.updated ? 1 : (a.updated === b.updated ? (a.id < b.id ? 1 : -1) : -1))).map(i => i.id).join()),
        'the rows are ordered the most recently changed first, the id on a tie');
    check(order()[0] === idC, 'the note just made is the first row');

    // ---- delete: the row goes
    wC.deleteNote();
    check(await waitFor(() => !list.rows.has(idC) && fileRec(idC).deleted === true), 'a deleted note loses its row');

    // ---- the other computer: new note, change, custom and odd colours, tombstone
    const r1 = remoteRecord({text: 'from the other computer', color: 'green'});
    remotePut(r1.id, r1);
    check(await waitFor(() => rowLabel(r1.id) === 'from the other computer', 10000), 'a note from the other computer gets a row');
    check(order()[0] === r1.id, 'and, being the newest, is the first row');
    remotePut(r1.id, {...r1, rev: 2, updated: stamp(), text: 'changed over there', color: 'purple'});
    check(await waitFor(() => rowLabel(r1.id) === 'changed over there' && list.rows.get(r1.id).row.has_css_class('cetli-purple') && !list.rows.get(r1.id).row.has_css_class('cetli-green'), 10000),
        'a remote change reaches the row (text and colour)');
    const custom = remoteRecord({text: 'custom', color: '#123456'});
    const upper = remoteRecord({text: 'upper', color: '#ABCDEF'});
    const evil = remoteRecord({text: 'evil', color: 'red; } window { display: none } /*'});
    const gray = remoteRecord({text: 'old gray', color: 'gray'});
    for (const r of [custom, upper, evil, gray])
        remotePut(r.id, r);
    check(await waitFor(() => [custom, upper, evil, gray].every(r => list.rows.has(r.id)), 10000), 'notes with a custom, upper-case, hostile and old gray colour get rows');
    const has = (r, c) => list.rows.get(r.id).row.has_css_class(c);
    check(has(custom, 'cetli-x-123456') && !has(custom, 'cetli-yellow'), 'a valid #rrggbb gets its own class');
    check(has(upper, 'cetli-yellow') && has(evil, 'cetli-yellow'), 'an upper-case hex and a hostile string are shown as yellow');
    check(has(gray, 'cetli-gray'), 'an old gray note keeps the gray class');
    // the style of the custom colour is really in force: white text on #123456, dark text on the yellow of an unknown colour
    const fg = r => list.rows.get(r.id).row.get_style_context().get_color();
    check(await waitFor(() => fg(custom).red > 0.9 && fg(custom).green > 0.9 && fg(custom).blue > 0.9), `the row of #123456 has white text (${fg(custom).red.toFixed(2)})`);
    check(await waitFor(() => fg(upper).red < 0.3), `and the yellow row (upper-case hex) has dark text (${fg(upper).red.toFixed(2)})`);
    check(fileRec(evil.id).color === evil.color && fileRec(upper.id).color === '#ABCDEF', 'and the files are not changed');
    remotePut(r1.id, {...r1, rev: 3, updated: stamp(), text: '', deleted: true});
    check(await waitFor(() => !list.rows.has(r1.id), 10000), 'a tombstone from the other computer removes the row');

    // ---- long and odd texts
    const huge = remoteRecord({text: `${'\u{1F389}'.repeat(PREVIEW_LINE_CHARS * 3)}\n${'y'.repeat(200)}\nl3\nl4\nl5\n${'z'.repeat(30000)}`, color: 'blue'});
    remotePut(huge.id, huge);
    const blank = remoteRecord({text: ' \n\t\n  \n', color: 'mint'});
    remotePut(blank.id, blank);
    check(await waitFor(() => list.rows.has(huge.id) && list.rows.has(blank.id), 10000), 'a 50 KB note and a note of blanks only get rows');
    const hl = rowLabel(huge.id);
    check(hl.split('\n').length === PREVIEW_LINES && hl.split('\n').every(l => Array.from(l).length <= PREVIEW_LINE_CHARS + 1) && wellFormed(hl),
        `the long note shows ${PREVIEW_LINES} cut lines of well-formed text (${hl.length} chars)`);
    check(rowLabel(blank.id) === S.emptyNotePreview(), 'a note of blanks only shows the placeholder');

    // ---- a click: an open note is presented (no second window); a closed note comes back
    // the windows of the notes that came from the other computer open on their own; wait until every live note has one
    check(await waitFor(() => aliveIds().every(id => windows.has(id)), 20000), `every live note has its window (${windows.size} windows; a remotely deleted note keeps its window, by design)`);
    const wcount = windows.size;
    wB.win.close();
    check(await waitFor(() => !windows.has(idB)), 'a note window can be closed');
    check(list.rows.has(idB) && ctl.allNotes === list && list.win.get_visible(), 'a closed note stays in the list, the list stays open');
    list.list.emit('row-activated', list.rows.get(idB).row);
    check(await waitFor(() => windows.has(idB) && windows.size === wcount), 'a click on the row of a closed note opens its window again');
    check(await waitFor(() => {
        const f = `${dirs.state}/layout.json`;
        if (!GLib.file_test(f, GLib.FileTest.EXISTS))
            return true;
        const l = JSON.parse(readText(f));
        return l[idB] === undefined || l[idB].open !== false;
    }), 'and does not leave open=false behind');
    const again = windows.get(idB);
    let presented = 0;
    const realPresent = again.win.present.bind(again.win);
    again.win.present = () => { presented++; realPresent(); };
    list.list.emit('row-activated', list.rows.get(idB).row);
    check(await waitFor(() => presented >= 1), 'a click on the row of an open note brings its window to the front');
    check(windows.get(idB) === again && windows.size === wcount, 'and opens no second window');

    // ---- the eye: it shows whether the window is open, and hides or shows it
    const eyeOf = id => list.rows.get(id).eye;
    check(await waitFor(() => eyeOf(idB).get_icon_name() === 'view-reveal-symbolic' && eyeOf(idB).get_tooltip_text() === S.hideNoteTooltip()), 'the eye of an open note is open, with the "Hide note" tooltip');
    eyeOf(idB).emit('clicked');
    check(await waitFor(() => !windows.has(idB)), 'a click on the eye of an open note closes its window');
    check(await waitFor(() => eyeOf(idB).get_icon_name() === 'view-conceal-symbolic' && eyeOf(idB).get_tooltip_text() === S.showNoteTooltip()), 'and the eye turns to closed, with the "Show note" tooltip');
    check(list.rows.has(idB), 'the card stays');
    eyeOf(idB).emit('clicked');
    check(await waitFor(() => windows.has(idB) && eyeOf(idB).get_icon_name() === 'view-reveal-symbolic'), 'a click on the eye of a closed note opens its window and the eye turns to open');

    // ---- time of the last change on the card: HH:MM today, else YYYY-MM-DD (local time; GLib is the oracle)
    const gl = id => GLib.DateTime.new_from_iso8601(ctl.store.getNote(id).updated, null).to_local();
    const timeOf = id => list.rows.get(id).time.get_label();
    check(timeOf(idA) === gl(idA).format('%R') && /^\d\d:\d\d$/.test(timeOf(idA)), `a note changed today shows the time (${timeOf(idA)})`);
    const old = remoteRecord({text: 'old note', color: 'blue', updated: new Date(Date.now() - 40 * 86400000).toISOString(), created: new Date(Date.now() - 41 * 86400000).toISOString()});
    remotePut(old.id, old);
    check(await waitFor(() => list.rows.has(old.id), 10000), 'a note changed 40 days ago gets a card');
    check(timeOf(old.id) === gl(old.id).format('%F') && /^\d{4}-\d\d-\d\d$/.test(timeOf(old.id)), `and shows the date (${timeOf(old.id)})`);
    check(order()[order().length - 1] === old.id, 'and, being the oldest change, is the last card');

    // ---- the look of the card (UX review): a 1 px outline on every card, nothing see-through on it
    const anyRow = list.rows.get(idA).row;
    const bd = anyRow.get_style_context().get_border();
    check(bd.top === 1 && bd.bottom === 1 && bd.left === 1 && bd.right === 1, `every card has a 1 px outline (${bd.top}/${bd.right}/${bd.bottom}/${bd.left})`);
    check(!/opacity/.test(CARD_CSS), 'the card style has no opacity (icons and time stay opaque)');
    check(/cetli-dark row\.cetli-row \{ border-color: rgba\(255, 255, 255/.test(CARD_CSS), 'and the outline has a light version for the dark theme');

    // ---- search: the text of the note, any case; white space only is no search; no hit: "no results"
    const visibleIds = () => order().filter(id => list.rows.get(id).row.get_child_visible());
    const searchFor = async (q, cond) => { list.search.set_text(q); return waitFor(cond, 5000); };
    check(list.search.get_visible() && list.stack.get_visible_child_name() === 'list', 'the search field is above the cards');
    check(await searchFor('OLD NOTE', () => visibleIds().join() === old.id), 'a search is case-insensitive and shows only the notes that hold the text');
    check(list.stack.get_visible_child_name() === 'list', 'and the cards stay on the page');
    check(await searchFor('   ', () => visibleIds().length === list.rows.size), 'a query of white space only shows every note');
    check(await searchFor('zzzz no such text', () => list.stack.get_visible_child_name() === 'nores') && list.search.get_visible() && visibleIds().length === 0,
        'a search with no hit shows "no results" and keeps the search field');
    check(await searchFor('', () => list.stack.get_visible_child_name() === 'list' && visibleIds().length === list.rows.size), 'clearing the search brings every card back');
    const empty = new AllNotesWindow({ctl: {...ctl.ctl, store: {listNotes: () => []}}});
    check(empty.stack.get_visible_child_name() === 'none' && !empty.search.get_visible(), 'no notes at all: the "no notes" page, without the search field');
    empty.win.close();

    // ---- the trash: a confirmation first; a closed note and an open note
    const [idD, wD] = await newNote();
    check(await waitFor(() => list.rows.has(idD)), 'a note to delete gets a card');
    wD.buffer.set_text('delete me closed', -1);
    check(await waitFor(() => fileRec(idD).text === 'delete me closed'), 'its text is saved');
    wD.win.close();
    check(await waitFor(() => !windows.has(idD)), 'its window is closed');
    list.rows.get(idD).trash.emit('clicked');
    check(list.dialog !== undefined && list.dialog.get_heading() === S.deleteConfirmTitle(), 'the trash of a closed note asks first');
    list.dialog.response('cancel');
    await tick(400);
    check(fileRec(idD).deleted === false && list.rows.has(idD), 'Cancel leaves the note');
    list.rows.get(idD).trash.emit('clicked');
    list.dialog.response('delete');
    check(await waitFor(() => !list.rows.has(idD) && fileRec(idD).deleted === true), 'Delete removes the card and marks the note deleted in its file');
    check(!windows.has(idD), 'and no window opens for it');
    check(windows.has(blank.id), 'the note of blanks has its window open');
    list.rows.get(blank.id).trash.emit('clicked');
    list.dialog.response('delete');
    check(await waitFor(() => !list.rows.has(blank.id) && !windows.has(blank.id) && fileRec(blank.id).deleted === true), 'the trash of an open note deletes it and closes its window');

    // the trash of a closed note whose delete the core refuses: the card stays, the file stays, a message is shown
    const [idR, wR] = await newNote();
    wR.buffer.set_text('refused delete', -1);
    check(await waitFor(() => fileRec(idR).text === 'refused delete' && list.rows.has(idR)), 'a note whose delete will be refused is saved and has a card');
    wR.win.close();
    check(await waitFor(() => !windows.has(idR)), 'its window is closed');
    const shown = [];
    const realToast = list.toasts.add_toast.bind(list.toasts);
    list.toasts.add_toast = t => { shown.push(t.get_title()); realToast(t); };
    const realDelete = ctl.store.deleteNote;
    ctl.store.deleteNote = async () => ({ok: false, cause: {code: 'MOVE_FAILED'}});
    list.rows.get(idR).trash.emit('clicked');
    list.dialog.response('delete');
    check(await waitFor(() => shown.length === 1), 'a refused delete shows a message');
    check(shown[0] === S.deleteRefused('MOVE_FAILED') && shown[0].includes('MOVE_FAILED'), `and it names the cause (${shown[0]})`);
    check(list.rows.has(idR) && fileRec(idR).deleted === false && !windows.has(idR), 'the card and the file stay, and no window opens');
    ctl.store.deleteNote = realDelete;
    // a record that is gone or already deleted: nothing happens, no message
    await ctl.ctl.deleteNote(idR + '-no-such-note');
    await ctl.ctl.deleteNote(idD);
    check(shown.length === 1, 'a note that is gone or already deleted raises no message');
    // the same note, now accepted: the card goes
    list.rows.get(idR).trash.emit('clicked');
    list.dialog.response('delete');
    check(await waitFor(() => !list.rows.has(idR) && fileRec(idR).deleted === true), 'and once the core accepts, the same trash deletes it');
    list.toasts.add_toast = realToast;
    list.list.emit('row-activated', list.rows.get(huge.id).row);
    check(await waitFor(() => windows.has(huge.id)), 'a click on a note from the other computer opens it');

    // ---- the list is a window of its own
    const notesOpen = [...windows.values()];
    list.scheduleRefresh();                      // a refresh is pending at the moment of closing
    check(list._timer !== null, 'a refresh timer is armed');
    list.win.close();
    check(list._timer === null, 'closing the list cancels its pending refresh timer');
    check(await waitFor(() => ctl.allNotes === null), 'closing the list forgets it');
    await tick(300);
    check(notesOpen.every(w => windows.get(w.id) === w && w.win.get_visible()), 'closing the list closes no note window');
    remotePut(r1.id, {...r1, rev: 4, updated: stamp(), text: 'back again', deleted: false});
    check(await waitFor(() => ctl.store.getNote(r1.id)?.text === 'back again', 10000), 'the core took the change');
    check(ctl.allNotes === null, 'a change while the list is closed does not reopen it');
    gtkApp.activate_action('all-notes', null);
    check(await waitFor(() => ctl.allNotes !== null && ctl.allNotes !== list), 'a new request opens a fresh list');
    const list2 = ctl.allNotes;
    check(list2.rows.size === aliveIds().length && list2.rows.get(r1.id)?.label.get_label() === 'back again', `with the same rows (${list2.rows.size}) and the note that came back`);
    list2.setDark(true);
    check(list2.win.has_css_class('cetli-dark'), 'dark theme adds the cetli-dark class to the list');
    list2.setDark(false);
    check(!list2.win.has_css_class('cetli-dark'), 'and removes it');

    // ---- many notes arriving while the list is open (the 1000-note case is allnotes-bulk-smoke.js)
    const have = aliveIds().length;
    const t0 = GLib.get_monotonic_time();
    // The ids are marked closed in layout.json first, so that the notes arrive without 150 note windows (opening a window
    // per note costs the compositor more than the list does; that is not what this step measures).
    const recs = Array.from({length: 150}, (_, i) => remoteRecord({text: `bulk ${i}\n${'x'.repeat(i % 200)}`, color: COLORS[i % COLORS.length]}));
    const layout = await ctl.store.loadLayout();
    for (const r of recs)
        layout[r.id] = {x: 0, y: 0, w: 300, h: 260, monitor: 'test', open: false};
    await ctl.store.saveLayout(layout);
    for (const r of recs)
        GLib.file_set_contents(`${dirs.notes}/${r.id}.json`, `${JSON.stringify(r)}\n`);
    const settled = await waitFor(() => aliveIds().length >= have + 150 && list2.rows.size === aliveIds().length, 90000);
    info(`150 files at once: the core holds ${aliveIds().length}, the list ${list2.rows.size} rows, ${((GLib.get_monotonic_time() - t0) / 1000).toFixed(0)} ms`);
    check(settled && recs.every(r => !windows.has(r.id)), `150 files at once: the list shows exactly the notes of the core (${list2.rows.size}) and they opened no window`);
    const t2 = GLib.get_monotonic_time();
    list2.refresh();
    const idle = (GLib.get_monotonic_time() - t2) / 1000;
    check(idle < 500, `a refresh over ${list2.rows.size} unchanged rows is cheap (${idle.toFixed(1)} ms, limit 500)`);
    const sorted = [...list2.rows.values()].sort((a, b) => (a.updated < b.updated ? 1 : (a.updated === b.updated ? (a.id < b.id ? 1 : -1) : -1))).map(i => i.id).join();
    const orderNow = []; for (let i = 0; list2.list.get_row_at_index(i); i++) orderNow.push(list2.list.get_row_at_index(i)._cetli.id);
    check(orderNow.join() === sorted, 'the rows of all those notes are in order');
    // a burst of 100 local-style changes is one refresh: edit one note many times, the list ends consistent
    for (let i = 0; i < 100; i++)
        wA.buffer.set_text(`typing ${i}`, -1);
    check(await waitFor(() => list2.rows.get(idA)?.label.get_label() === 'typing 99', 30000), 'a burst of edits ends with the last text in the row');
}

scenario().then(() => {}, e => { failed++; print(`FAIL exception ${e}\n${e.stack}`); }).finally(() => {
    print(`${checks - failed}/${checks} checks passed`);
    print(failed === 0 ? 'RESULT PASS' : 'RESULT FAIL');
    GLib.spawn_command_line_async(`rm -rf ${base}`);
    gtkApp.quit();
});
const status = ctl.run([]);
imports.system.exit(failed === 0 ? status : 1);
