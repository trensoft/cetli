// SPDX-License-Identifier: GPL-3.0-or-later
// Structure rules of the task: the core imports only Gio/GLib (and only in the adapter), no Gtk/Adw/St/Shell, no network,
// no Syncthing call, no secrets, no shell calls; SPDX header everywhere; every P2-T tag has a test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const walk = dir => fs.readdirSync(dir, {withFileTypes: true}).flatMap(e =>
    (e.name === 'node_modules' ? [] : e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const rel = f => path.relative(root, f);
const src = fs.readdirSync(path.join(root, 'src')).filter(f => f.endsWith('.js')).map(f => path.join(root, 'src', f));
const code = f => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

test('every source, test and script file carries the SPDX header (GPL-3.0-or-later)', () => {
    // Only what this package owns: src/ and tests/ (the folder is shared with other work, e.g. extension/, packaging/).
    const files = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'tests'))].filter(f => /\.(js|py|sh)$/.test(f));
    assert.ok(files.length > 10);
    for (const f of files)
        assert.match(fs.readFileSync(f, 'utf8').split('\n').slice(0, 3).join('\n'), /SPDX-License-Identifier: GPL-3\.0-or-later/, rel(f));
});

test('D3: gi:// imports exist only in gio-layer.js and only Gio and GLib; no node: import in src', () => {
    for (const f of src) {
        const imports = [...fs.readFileSync(f, 'utf8').matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map(m => m[1]);
        for (const i of imports) {
            if (i.startsWith('gi://'))
                assert.ok(path.basename(f) === 'gio-layer.js' && ['gi://Gio', 'gi://GLib'].includes(i), `${rel(f)} imports ${i}`);
            else
                assert.match(i, /^\.\/[a-z-]+\.js$/, `${rel(f)} imports ${i}`);
        }
        if (path.basename(f) !== 'gio-layer.js')
            assert.equal(/gi:\/\//.test(code(f)), false, `${rel(f)} has no gi:// at all`);
        assert.equal(/\bimport\s*\(/.test(code(f)), false, `${rel(f)} has no dynamic import`);
    }
    const gio = fs.readFileSync(path.join(root, 'src/gio-layer.js'), 'utf8');
    assert.deepEqual([...gio.matchAll(/from 'gi:\/\/(\w+)'/g)].map(m => m[1]).sort(), ['GLib', 'Gio']);
});

test('D3/D4/7: no Gtk/Adw/St/Clutter/Meta/Shell, no network, no Syncthing call, no shell or process call, no eval, no secrets', () => {
    const forbidden = [
        [/\b(Gtk|Adw|Clutter|Meta|Shell|Pango|Gdk|Soup|Gtk4|St)\./, 'toolkit or shell namespace'],
        [/\b(Subprocess|spawn|exec|execFile|execSync|child_process|launch|DesktopAppInfo)\b/, 'process execution'],
        [/\b(fetch|XMLHttpRequest|WebSocket|http:|https:|net\.|dgram|Soup)\b/, 'network'],
        [/\beval\s*\(|new\s+Function\b|\bFunction\s*\(/, 'dynamic code'],
        [/syncthing|8384|22000|api[_-]?key|password|passwd|secret|credential|bearer|Authorization/i, 'transport or credential'],
        [/\bconsole\.(log|error)\b/, 'console use outside the log object'],
    ];
    for (const f of src) {
        let text = path.basename(f) === 'gio-layer.js' ? code(f).replace(/console\.(warn|log)\(`cetli: \$\{m\}`\)/g, '') : code(f);
        if (path.basename(f) === 'gio-layer.js') {
            // The ONE process of the core: the atomic exchange (0.2.7.1), a fixed argv of /usr/bin/mv, no shell. Exactly this
            // text is let through; any other use of Subprocess in the file (or the exact text in another file) still fails.
            text = text.replace("Gio._promisify(Gio.Subprocess.prototype, 'wait_check_async', 'wait_check_finish');", '')
                .replace(/Gio\.Subprocess\.new\(\[MV, '-T', '--exchange', '--', a, b\],\s*Gio\.SubprocessFlags\.STDOUT_SILENCE \| Gio\.SubprocessFlags\.STDERR_SILENCE\);/, '')
                .replace('await p.wait_check_async(null);', '');
        }
        for (const [re, what] of forbidden)
            assert.equal(re.test(text), false, `${rel(f)}: ${what} (${re})`);
    }
});

test('the P2 tags: every [P2-T1] .. [P2-T14] occurs in a test name', () => {
    const names = walk(path.join(root, 'tests')).filter(f => f.endsWith('.test.js'))
        .flatMap(f => [...fs.readFileSync(f, 'utf8').matchAll(/^test\((['"`])(.*)\1/gm)].map(m => m[2]));
    const tags = new Set(names.flatMap(n => [...n.matchAll(/\[P2-T(\d+)\]/g)].map(m => Number(m[1]))));
    assert.deepEqual([...tags].sort((a, b) => a - b), Array.from({length: 14}, (_, i) => i + 1));
});

test('[P2-T13] 1.5: the adapter\'s file move carries NO_FALLBACK_FOR_MOVE (a copy-and-delete fallback would not be atomic)', () => {
    const gio = code(path.join(root, 'src/gio-layer.js'));
    const moves = [...gio.matchAll(/\.move\(([^;]*)\);/g)];
    assert.ok(moves.length >= 1, 'the adapter moves files');
    for (const m of moves)
        assert.match(m[1], /\bflags\b/, `move call without the flags variable: ${m[0]}`);
    const defs = [...gio.matchAll(/const flags = ([^;]*);/g)];
    assert.ok(defs.length >= 1);
    for (const d of defs)
        assert.match(d[1], /Gio\.FileCopyFlags\.NO_FALLBACK_FOR_MOVE/, `flags without NO_FALLBACK_FOR_MOVE: ${d[0]}`);
});

test('[P2-T13] 1.5: the adapter\'s tmp write is CONSISTENT | DURABLE (CONSISTENT alone does not fsync a new file; every tmp name is new)', () => {
    const gio = code(path.join(root, 'src/gio-layer.js'));
    const calls = [...gio.matchAll(/GLib\.file_set_contents_full\(([^;]*)\);/g)];
    assert.equal(calls.length, 1, 'exactly one durable write in the adapter');
    assert.match(calls[0][1], /GLib\.FileSetContentsFlags\.CONSISTENT\s*\|\s*GLib\.FileSetContentsFlags\.DURABLE|GLib\.FileSetContentsFlags\.DURABLE\s*\|\s*GLib\.FileSetContentsFlags\.CONSISTENT/);
});
