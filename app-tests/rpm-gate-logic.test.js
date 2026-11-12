// SPDX-License-Identifier: GPL-3.0-or-later
// The decisions of the probe of the installed package (tools/start_gate/probe_logic.mjs): the part of step (a) and (b) that needs no GLib.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {checkLibadwaita, checkVersion, datadirOfLauncher} from '../tools/start_gate/probe_logic.mjs';

const makefile = readFileSync(new URL('../Makefile', import.meta.url), 'utf8');

test('the launcher that the Makefile writes is read as /usr/share/cetli', () => {
    const written = makefile.match(/printf '%s\\n' '#!\/bin\/sh' '(exec gjs -m \$\(DATADIR\)\/\$\(NAME\)\/app\/main\.js "\$\$@")'/)[1];
    const launcher = `#!/usr/bin/sh\n${written.replace('$(DATADIR)', '/usr/share').replace('$(NAME)', 'cetli').replace('$$@', '$@')}\n`;
    assert.equal(datadirOfLauncher(launcher), '/usr/share/cetli');
});

test('a launcher of a checkout, or of no program, is refused', () => {
    assert.throws(() => datadirOfLauncher('#!/bin/sh\nexec gjs -m /home/u/cetli/app/main.js "$@"\n'), /not an installed copy under \/usr/);
    assert.throws(() => datadirOfLauncher('#!/bin/sh\nexec gjs -m /usr/share/cetli/app/other.js "$@"\n'), /does not start gjs -m <datadir>\/app\/main\.js/);
    assert.throws(() => datadirOfLauncher('#!/bin/sh\nexec python3 /usr/share/cetli/app/main.js "$@"\n'), /does not start gjs/);
    assert.throws(() => datadirOfLauncher(''), /does not start gjs/);
    assert.throws(() => datadirOfLauncher('exec gjs -m //app/main.js "$@"'), /does not start gjs/, 'a data directory needs a name');
    assert.throws(() => datadirOfLauncher('#!/bin/sh\nexec gjs -m /usr/share/cetli/app/main.js\n'), /does not start gjs/);
});

test('/usr/local and /usr/lib are installed copies too, /opt and /usr itself are not a place for the data directory', () => {
    assert.equal(datadirOfLauncher('exec gjs -m /usr/local/share/cetli/app/main.js "$@"'), '/usr/local/share/cetli');
    assert.throws(() => datadirOfLauncher('exec gjs -m /opt/cetli/app/main.js "$@"'), /not an installed copy/);
    assert.throws(() => datadirOfLauncher('exec gjs -m /usrx/cetli/app/main.js "$@"'), /not an installed copy/);
});

test('the version of the installed copy is the version of the RPM, a newline does not matter, a different one does', () => {
    assert.equal(checkVersion('1.0.1\n', '1.0.1'), '1.0.1');
    assert.throws(() => checkVersion('1.0.0\n', '1.0.1'), /installed version 1\.0\.0, the RPM has 1\.0\.1/);
    assert.throws(() => checkVersion('', '1.0.1'), /installed version , the RPM has 1\.0\.1/);
    assert.throws(() => checkVersion('1.0.1.1\n', '1.0.1'), /installed version/);
});

test('libadwaita 1.5 and later is enough, 1.4 and another major version are not', () => {
    assert.doesNotThrow(() => checkLibadwaita(1, 5));
    assert.doesNotThrow(() => checkLibadwaita(1, 8));
    assert.throws(() => checkLibadwaita(1, 4), /libadwaita 1\.4, the program needs 1\.5 or later/);
    assert.throws(() => checkLibadwaita(0, 9), /libadwaita 0\.9/);
    assert.throws(() => checkLibadwaita(2, 0), /libadwaita 2\.0/);
});
