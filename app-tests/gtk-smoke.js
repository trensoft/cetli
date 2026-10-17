// SPDX-License-Identifier: GPL-3.0-or-later
// Headless smoke test of the GTK app: run it inside a headless Wayland compositor, see app-tests/run.sh.
// It drives the real application.js with the real core and the real Gio layer, in a temporary XDG tree.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';

import {createApp} from '../app/application.js';
import {buildCss} from '../app/data.js';

const base = GLib.dir_make_tmp('cetli-gtk-XXXXXX');
const dirs = {
    notes: `${base}/data/notes`, tmp: `${base}/data/tmp`, state: `${base}/state`,
};
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
const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE; }));
const readText = p => new TextDecoder().decode(GLib.file_get_contents(p)[1]);
const exists = p => GLib.file_test(p, GLib.FileTest.EXISTS);
const noteFiles = () => {
    const d = Gio.File.new_for_path(dirs.notes);
    const out = [];
    const en = d.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    let i;
    while ((i = en.next_file(null)) !== null)
        out.push(i.get_name());
    return out.sort();
};
const fileRec = id => JSON.parse(readText(`${dirs.notes}/${id}.json`));
// What Syncthing does: a hidden tmp file, then a rename.
function remoteWrite(id, patch) {
    const rec = {...fileRec(id), ...patch};
    const tmp = `${dirs.notes}/.syncthing.${id}.json.tmp`;
    GLib.file_set_contents(tmp, `${JSON.stringify(rec)}\n`);
    Gio.File.new_for_path(tmp).move(Gio.File.new_for_path(`${dirs.notes}/${id}.json`), Gio.FileCopyFlags.OVERWRITE, null, null);
}

const ctl = createApp({dirs});
const {gtkApp, windows} = ctl;

async function scenario() {
    await ctl.ready;
    // the stylesheet parses without a single error in this GTK
    const provider = new Gtk.CssProvider();
    let cssErrors = 0;
    provider.connect('parsing-error', (_p, _section, err) => { cssErrors++; print(`css error: ${err.message}`); });
    if (typeof provider.load_from_string === 'function')
        provider.load_from_string(buildCss());
    else
        provider.load_from_data(buildCss());
    check(cssErrors === 0, 'the stylesheet has no parsing error');
    // first run: one new, empty note
    check(windows.size === 1, 'first run: one note window');
    const [id, w] = [...windows][0];
    check(w.win.get_title() === `cetli-${id}`, `window title is cetli-<uuid> (${w.win.get_title()})`);
    check(w.win.get_visible(), 'window is shown');
    check(noteFiles().length === 1, 'the new note is a file');
    check(w.win.has_css_class('cetli-yellow'), 'default colour class');

    // editing and coalesced save
    w.buffer.insert_at_cursor('héllo 🎉', -1);
    w.buffer.insert_at_cursor(' world', -1);
    await sleep(700);
    check(fileRec(id).text === 'héllo 🎉 world', 'typed text saved (UTF-8, coalesced)');
    check(fileRec(id).rev === 2, `one write for the burst (rev ${fileRec(id).rev})`);

    // colour
    w.setColor('green');
    await sleep(500);
    check(fileRec(id).color === 'green' && w.win.has_css_class('cetli-green') && !w.win.has_css_class('cetli-yellow'), 'colour change saved and class swapped');

    // remote version, window clean and quiet: text replaced, cursor after the change shifts
    await sleep(2200);
    const end = w.buffer.get_iter_at_offset(w.buffer.get_char_count());
    w.buffer.place_cursor(end);
    remoteWrite(id, {rev: fileRec(id).rev + 1, updated: new Date(Date.now() + 1000).toISOString(), device: 'b5b5b5b5', text: 'REMOTE héllo 🎉 world'});
    await sleep(1000);
    check(w._bufferText() === 'REMOTE héllo 🎉 world', `clean window takes the remote text (${w._bufferText()})`);
    check(w.buffer.get_iter_at_mark(w.buffer.get_insert()).get_offset() === Array.from('REMOTE héllo 🎉 world').length, 'cursor at the end stays at the end');
    check(w.mark === null, 'no mark after applying');
    w.buffer.insert_at_cursor('+', -1);
    await sleep(600);
    check(noteFiles().length === 1, 'editing after applying a remote version makes no copy (the applied record is the base)');

    // remote version while typing: buffer untouched, mark shown, local wins, the other version kept as a copy
    w.buffer.insert_at_cursor('!', -1);
    remoteWrite(id, {rev: fileRec(id).rev + 1, updated: new Date(Date.now() + 3000).toISOString(), device: 'b5b5b5b5', text: 'second remote'});
    await sleep(450);
    check(w._bufferText().endsWith('!') && w._bufferText() !== 'second remote', 'typing window keeps its text');
    await sleep(900);
    check(fileRec(id).text.endsWith('!'), 'local text won');
    check(noteFiles().length === 2, `the other version was kept as a copy (${noteFiles().length} files)`);

    // a remote tombstone: window stays, mark shown
    const t = fileRec(id);
    remoteWrite(id, {rev: t.rev + 1, updated: new Date(Date.now() + 5000).toISOString(), device: 'b5b5b5b5', text: '', deleted: true});
    await sleep(2300);
    check(windows.has(id) && w.mark?.kind === 'deleted', 'remote tombstone: window stays with a mark');
    w.buffer.insert_at_cursor('x', -1);
    await sleep(700);
    check(fileRec(id).deleted === false, 'typing brings the note back');

    // a conflict file: kept and counted
    const cf = `${dirs.notes}/${id}.sync-conflict-20261017-120000-ABCDEFG.json`;
    GLib.file_set_contents(cf, `${JSON.stringify({...fileRec(id), rev: 99, text: 'conflict'})}\n`);
    await sleep(800);
    check(exists(cf), 'conflict file is kept');
    check(w.unresolved.get_visible() && w.unresolved.get_label() === '1 unresolved', `unresolved mark (${w.unresolved.get_label()})`);

    // new note through the application action
    const sizeBefore = windows.size;
    gtkApp.activate_action('new-note', null);
    await sleep(600);
    check(windows.size === sizeBefore + 1, `New note opens one more window (${sizeBefore} -> ${windows.size})`);

    // layout.json: an entry written by the extension; closing a window writes open=false, nothing else changes
    const [id2, w2] = [...windows].find(([k]) => k !== id);
    await ctl.store.saveLayout({[id2]: {x: 10, y: 20, w: 321, h: 222, monitor: '1920x1080+0+0', open: true}});
    w2.win.close();
    await sleep(500);
    const lay = JSON.parse(readText(`${dirs.state}/layout.json`));
    check(lay[id2].open === false && lay[id2].x === 10 && lay[id2].w === 321 && lay[id2].monitor === '1920x1080+0+0', 'closing writes open=false and keeps the extension members');
    check(!windows.has(id2), 'closed window removed from the app');

    // another launch of the program: the closed note comes back and its flag is true again
    gtkApp.activate();
    await sleep(600);
    check(windows.has(id2), 'a second launch brings the closed note back');
    check(JSON.parse(readText(`${dirs.state}/layout.json`))[id2].open === true, 'and writes open=true');

    // About
    const before = Gtk.Window.list_toplevels().length;
    w.ctl.showAbout(w.win);
    await sleep(300);
    check(Gtk.Window.list_toplevels().length === before + 1, 'About opens as an extra window');

    // delete (menu action win.delete)
    w.win.lookup_action('delete').activate(null);
    await sleep(600);
    check(fileRec(id).deleted === true && fileRec(id).text === '', 'delete writes a tombstone');
    check(!windows.has(id), 'deleted note: window closed');
}

scenario().then(() => {}, e => { failed++; print(`FAIL exception ${e}\n${e.stack}`); }).finally(() => {
    print(`${checks - failed}/${checks} checks passed`);
    print(failed === 0 ? 'RESULT PASS' : 'RESULT FAIL');
    GLib.spawn_command_line_async(`rm -rf ${base}`);
    gtkApp.quit();
});
const status = ctl.run([]);
imports.system.exit(failed === 0 ? status : 1);
