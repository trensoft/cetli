// SPDX-License-Identifier: GPL-3.0-or-later
// The packaging lines of the sync window (PLAN-WIZARD 0F.1, 0F.3): the unit is shipped as data, not enabled; its home cannot drift from the
// engine's; the spec and the Makefile carry the small list and nothing more.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {BACKEND_EXE, DEDICATED_HOME_REL, UNIT_NAME} from '../sync/paths.js';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const strip = t => t.replace(/^#.*$/gm, '');
const unit = strip(read('data/cetli-syncthing.service'));
const spec = read('packaging/fedora/cetli.spec');
const specCode = strip(spec);
const make = read('Makefile');

test('the unit: an explicit environment (env -i), the engine\'s home, no UnsetEnvironment, no ST* variable', () => {
    const exec = unit.match(/^ExecStart=(.*)$/m)[1];
    assert.equal(exec, `/usr/bin/env -i HOME=%h PATH=/usr/bin ${BACKEND_EXE} serve --home=%h/${DEDICATED_HOME_REL} --no-browser --no-restart --no-upgrade`);
    assert.equal(/UnsetEnvironment|Environment(File)?=|\bST[A-Z]{3,}/.test(unit), false);
    assert.match(unit, /^WantedBy=default\.target$/m);
    assert.match(unit, /^Restart=on-failure$/m);
    assert.equal(/^WantedBy=.*(graphical|multi-user)/m.test(unit), false, 'a user unit, wanted by default.target');
});

test('the unit file is named like the engine\'s constant and is installed as data into the user unit directory', () => {
    assert.equal(UNIT_NAME, 'cetli-syncthing.service');
    assert.match(make, /data\/\$\(NAME\)-syncthing\.service '\$\(DESTDIR\)\$\(USERUNITDIR\)\/\$\(NAME\)-syncthing\.service'/);
    assert.match(make, /-m 0644 data\/\$\(NAME\)-syncthing\.service/);
    assert.match(make, /USERUNITDIR \?= \$\(PREFIX\)\/lib\/systemd\/user/);
});

test('the spec: systemd-rpm-macros for the macro only, USERUNITDIR passed, the unit and the program in %files, NO systemd scriptlets, no new Requires', () => {
    assert.match(specCode, /^BuildRequires:\s+systemd-rpm-macros$/m);
    assert.match(specCode, /USERUNITDIR=%\{_userunitdir\}/);
    assert.match(specCode, /^%\{_userunitdir\}\/%\{name\}-syncthing\.service$/m);
    assert.match(specCode, /^%\{_bindir\}\/%\{name\}-sync$/m);
    assert.equal(/%systemd_user|%systemd_post|%systemd_preun|%systemd_postun|^%(post|preun|postun|pre)\b/m.test(specCode), false, 'the package enables and restarts nothing');
    assert.equal(/^Requires:.*(syncthing|systemd)/m.test(specCode), false, 'no new dependency');
    assert.match(specCode, /^Recommends:\s+syncthing$/m);
    assert.equal(/^%package|^%exclude/m.test(specCode), false, 'one package, no subpackage, no exclude');
    assert.match(specCode, /^%\{_datadir\}\/%\{name\}\/$/m, 'the whole data directory is owned once');
});

test('the Makefile: the launcher of the engine, the sync tree installed, check-complete names the engine and the unit', () => {
    assert.match(make, /exec gjs -m \$\(DATADIR\)\/\$\(NAME\)\/sync\/main\.js "\$\$@"/);
    assert.match(make, /call install_tree,sync,\$\(DATADIR\)\/\$\(NAME\)\/sync/);
    assert.match(make, /for f in app\/main\.js sync\/main\.js data\/\$\(NAME\)-syncthing\.service /);
    assert.match(make, /\$\(INSTALL\) -D -m 0755 \$\(BUILD\)\/\$\(NAME\)-sync '\$\(DESTDIR\)\$\(BINDIR\)\/\$\(NAME\)-sync'/);
});

test('VERSION, the spec and the changelog agree, and the changelog names what is NOT measured', () => {
    const version = read('VERSION').trim();
    assert.equal(spec.match(/^Version:\s+(.*)$/m)[1], version);
    assert.match(spec, new RegExp(`^\\* .* - ${version.replace(/\./g, '\\.')}-1$`, 'm'));
    const entry = spec.slice(spec.indexOf(`- ${version}-1`), spec.indexOf('* Sun Oct 18 2026 TrenSoft <trensoft@fedoraproject.org> - 0.2.5-1'));
    assert.match(entry, /Supported and measured: up to 4 Syncthing instances on one shared local network/);
    assert.match(entry, /Not measured: 10 computers, another subnet, a VLAN, a guest or client-isolated WiFi, NAT, connections through relays/);
    assert.match(entry, /without it nothing connects/);                                  // M-J7: the direct mesh needs local discovery
    assert.match(entry, /may connect through the first computer only, or not at all/);
    assert.match(entry, /TCP and UDP 22100 and UDP 21127/);
    // Nicole's sentence (PLAN-ADMISSION-0.2.6 0), word for word, in the changelog and in the README
    const sentence = 'A computer you accept can add other computers to your group without asking you again. Remove a lost computer on all your computers.';
    assert.ok(entry.includes(sentence));
    const readme = read('README.md').replace(/\s+/g, ' ');
    assert.ok(readme.includes(sentence));
    assert.match(readme, /Not measured: ten computers, another subnet, a VLAN, a guest or client-isolated WiFi, NAT, relays/);
    assert.match(readme, /without local discovery nothing connects/);
    assert.match(readme, /may connect through the first computer only, or not at all/);
});

test('0H.12: env -i is mandatory in ExecStart with exactly HOME and PATH; no EnvironmentFile, PassEnvironment or UnsetEnvironment', () => {
    const exec = unit.match(/^ExecStart=(.*)$/m)[1];
    assert.equal(exec.startsWith('/usr/bin/env -i HOME=%h PATH=/usr/bin /usr/bin/syncthing serve '), true);
    const env = exec.slice('/usr/bin/env -i '.length, exec.indexOf(' /usr/bin/syncthing'));
    assert.equal(env, 'HOME=%h PATH=/usr/bin');
    assert.equal(/^\s*(EnvironmentFile|PassEnvironment|UnsetEnvironment|Environment)=/m.test(unit), false);
});

test('0H.12: the literal STGUIADDRESS is nowhere in the shipped tree (the allowlist never names it), and a serve address is never given on the command line', async () => {
    const {readdirSync, statSync} = await import('node:fs');
    const root = new URL('../', import.meta.url);
    const walk = dir => readdirSync(new URL(dir, root)).flatMap(n => {
        const rel = `${dir}${n}`;
        return statSync(new URL(rel, root)).isDirectory() ? walk(`${rel}/`) : [rel];
    });
    const shipped = [...walk('sync/'), ...walk('app/'), ...walk('data/'), ...walk('packaging/'), 'Makefile', 'README.md'];
    for (const f of shipped) {
        const text = read(f);
        assert.equal(/STGUIADDRESS|STGUIAPIKEY|STHOMEDIR|STCONFDIR|STDATADIR/.test(text), false, f);
    }
    assert.equal(/--gui-address|--gui-apikey/.test(unit), false);
});
