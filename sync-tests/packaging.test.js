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
    assert.match(entry, /Supported and measured: 10 computers in one group on one shared local network \(a virtual LAN on one machine; 2 of them ran the real application, 8 only the sync engine\)/);
    assert.match(entry, /the 11th computer was refused \(E_GROUP_FULL\)/);
    assert.match(entry, /did not reach the others within 85 s; after it was given on 6 of the 9 remaining computers, none of them listed it any more \(on the other 3 the call answered E_BAD_ID\)\. A note from one computer then reached the other 8\./);
    assert.doesNotMatch(entry, /so it has to be given on every computer|kept syncing/);   // a conclusion, not a measurement
    assert.match(entry, /Not measured: 10 real computers, another subnet, a VLAN, a guest or client-isolated WiFi, NAT, connections through relays/);
    assert.match(entry, /without it nothing connects/);                                  // M-J7: the direct mesh needs local discovery
    assert.match(entry, /may connect through the first computer only, or not at all/);
    assert.match(entry, /TCP and UDP 22100 and UDP 21127/);
    // Nicole's sentence (PLAN-ADMISSION-0.2.6 0), word for word, in the changelog and in the README
    const sentence = 'A computer you accept can add other computers to your group without asking you again. Remove a lost computer on all your computers.';
    assert.ok(entry.includes(sentence));
    const readme = read('README.md').replace(/\s+/g, ' ');
    assert.ok(readme.includes(sentence));
    assert.match(readme, /measured with 10 computers in one group on one shared local network \(a virtual LAN on one machine; 2 of them ran the real application, 8 only the sync engine\)/);
    assert.match(readme, /the 11th computer was refused/);
    assert.match(readme, /did not reach the others within 85 s; after it was given on 6 of the 9 remaining computers, none of them listed it any more \(on the other 3 the call answered E_BAD_ID\)\. A note from one computer then reached the other 8\./);
    assert.doesNotMatch(readme, /so it has to be given on every computer|kept syncing/);
    assert.match(readme, /Not measured: 10 real computers, another subnet, a VLAN, a guest or client-isolated WiFi, NAT, relays/);
    assert.match(readme, /without local discovery nothing connects/);
    assert.match(readme, /may connect through the first computer only, or not at all/);
});

test('the changelog of this version carries the Fix point of the atomic swap: the requirement, the fall-back, what is measured and what is not covered', () => {
    const version = read('VERSION').trim();
    assert.equal(version, '0.2.7');
    assert.equal(/0\.2\.7\.1/.test(specCode), false, 'there is no 0.2.7.1 entry or version: the fix is part of 0.2.7');
    const entry = spec.slice(spec.indexOf(`- ${version}-1`), spec.indexOf('* Sun Oct 18 2026 TrenSoft <trensoft@fedoraproject.org> - 0.2.5-1'));
    assert.match(entry, /^- Fix: a note could lose its newest text\. /m, 'the Fix point is in the 0.2.7-1 entry');
    assert.equal(entry.indexOf('- Fix: a note could lose its newest text.') < entry.indexOf('- New: cetli syncs up to 10 computers.'), true, 'and it comes first');
    assert.match(specCode, /^Requires:\s+coreutils >= 9\.5$/m);
    assert.match(entry, /so the package requires coreutils 9\.5 or later/);
    assert.match(entry, /on such a file system a conflict file is deleted after a check only \(that window stays, and it is not logged\), so "put back" above holds only where the file system can do the swap\./);
    assert.match(entry, /Measured under gjs by the smoke app-tests\/exchange-smoke\.js: `mv --exchange` started by the real src\/gio-layer\.js, with the mv of the Fedora 43 and CentOS Stream 10 roots \(each started with its own loader\), under Debian bookworm gjs 1\.74\.2, with a positive control .* and a negative control /);
    assert.match(entry, /Not measured: a real Fedora or EL10 session; a real sync program delivering at that moment\./);
    assert.match(entry, /Not covered by this fix: the write of a note into a place where none is, and the local save of the user over a note that changed at that moment \(both work as in 0\.2\.6\); also, a conflict file that is put back can, in a very short window, overwrite a file that has appeared under the same name meanwhile \(the newer version stays on the computer that sent it\)/);
    assert.doesNotMatch(entry, /not yet run by the gate|both work as in 0\.2\.7\)/);
    assert.doesNotMatch(entry, /no version (of a note )?is lost|nothing is ever lost/i, 'the changelog does not claim that no version is ever lost');
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
