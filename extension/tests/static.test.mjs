// SPDX-License-Identifier: GPL-3.0-or-later
// What the extension may and may not contain: the Shell runs it with the full rights of the user.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const dir = fileURLToPath(new URL('../cetli@trensoft.local/', import.meta.url));
const read = f => fs.readFileSync(path.join(dir, f), 'utf8');
const own = ['extension.js', 'placement.js'];

test('the directory holds exactly the expected files, the core ones as links to src/', () => {
    assert.deepEqual(fs.readdirSync(dir).sort(), ['constants.js', 'extension.js', 'layout.js', 'metadata.json', 'placement.js']);
    for (const f of ['constants.js', 'layout.js']) {
        assert.ok(fs.lstatSync(path.join(dir, f)).isSymbolicLink(), `${f} is a link to the core`);
        assert.equal(fs.realpathSync(path.join(dir, f)), fs.realpathSync(path.join(dir, '../../src', f)));
    }
});

test('metadata.json', () => {
    const m = JSON.parse(read('metadata.json'));
    assert.equal(m.uuid, 'cetli@trensoft.local');
    assert.equal(path.basename(dir), m.uuid, 'the directory is named after the uuid');
    assert.deepEqual(m['shell-version'], ['47', '48', '49']);
    assert.equal(m.name, 'cetli');
    assert.equal(m['settings-schema'], undefined, 'no GSettings');
    assert.equal(m['session-modes'], undefined, 'nothing runs on the lock screen');
});

test('imports: only Gio, GLib, the Shell base class and layout manager, and our own modules', () => {
    for (const f of own) {
        const specs = [...read(f).matchAll(/^import\b[^'"]*from\s+['"]([^'"]+)['"]/gm)].map(m => m[1]);
        for (const s of specs) {
            assert.ok(['gi://Gio', 'gi://GLib', 'resource:///org/gnome/shell/extensions/extension.js',
                'resource:///org/gnome/shell/ui/main.js'].includes(s) || /^\.\/[a-z-]+\.js$/.test(s), `${f}: ${s}`);
        }
    }
});

test('no process, no network, no dynamic code, no other file than layout.json', () => {
    const banned = [/Subprocess/, /\bspawn/i, /\bSoup\b/, /gi:\/\/(Soup|GSettings|Gtk|Gdk|St|Clutter)/, /\beval\s*\(/,
        /new Function/, /\bimport\s*\(/, /\bfetch\s*\(/, /XMLHttpRequest/, /get_home_dir|getenv|GLib\.get_user_(config|cache|data)_dir/];
    for (const f of own) {
        const code = read(f).replace(/\/\/.*$/gm, '');
        for (const re of banned)
            assert.ok(!re.test(code), `${f} must not contain ${re}`);
    }
    const paths = [...read('extension.js').matchAll(/'([^']*\.json)'/g)].map(m => m[1]);
    assert.deepEqual(paths, ['layout.json']);
});

test('every file has the SPDX header; the extension has no user-visible text of its own', () => {
    for (const f of own)
        assert.match(read(f), /^\/\/ SPDX-License-Identifier: GPL-3\.0-or-later\n/, f);
    // Messages go to the journal only (console.warn/error); nothing is shown (no St, no Main.notify, no dialog).
    for (const f of own)
        assert.ok(!/\bnotify\b|\bSt\./.test(read(f).replace(/\/\/.*$/gm, '')), f);
});
