// SPDX-License-Identifier: GPL-3.0-or-later
// The lines that make the start gate hard, pinned as text: what the behaviour tests (rpm-gate-run.test.js, rpm-gate-probe.test.js,
// rpm-gate-verify.test.js) cannot reach because the real program is not there (the probe that runs under gjs), and the files that must agree
// with each other (docs/RELEASING.md, application.js, the scripts). The workflow is in rpm-gate-workflow.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, statSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {GATE, REPO} from './rpm-gate-helpers.js';

const read = f => readFileSync(path.join(REPO, f), 'utf8');
const gate = f => readFileSync(path.join(GATE, f), 'utf8');
const code = text => text.replace(/^\s*#.*$/gm, '');
const jsCode = text => text.replace(/^\s*\/\/.*$/gm, '');
const SH = ['build.sh', 'check.sh', 'common.sh', 'negative_control.sh', 'probe_start.sh', 'start_gate.sh', 'verify_checks.sh'];
const ALL = [...SH, 'probe_installed.mjs', 'probe_logic.mjs', 'probe_steps.mjs'];
const DOC = read('docs/RELEASING.md');

test('every shell script of the gate parses', () => {
    for (const f of SH) {
        const r = spawnSync('bash', ['-n', path.join(GATE, f)], {encoding: 'utf8'});
        assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    }
});

test('every executable script is executable, and every file has the SPDX header', () => {
    for (const f of ALL.filter(f => !['common.sh', 'probe_installed.mjs', 'probe_logic.mjs', 'probe_steps.mjs'].includes(f)))
        assert.ok(statSync(path.join(GATE, f)).mode & 0o100, `${f} is not executable`);
    for (const f of ALL.map(f => `tools/start_gate/${f}`))
        assert.match(read(f).split('\n').slice(0, 3).join('\n'), /SPDX-License-Identifier: GPL-3\.0-or-later/, f);
});

test('the scripts that must stop on the first error say so, and never turn it off but once, in check.sh, after the install', () => {
    for (const f of ['build.sh', 'check.sh', 'start_gate.sh', 'verify_checks.sh'])
        assert.match(code(gate(f)), /^set -euo pipefail$/m, f);
    // negative_control.sh reads the status of the gate itself, probe_start.sh collects the failures of its steps
    assert.match(code(gate('negative_control.sh')), /^set -uo pipefail$/m);
    assert.match(code(gate('probe_start.sh')), /^set -u$/m);
    for (const f of SH.filter(f => f !== 'check.sh'))
        assert.doesNotMatch(code(gate(f)), /set \+e|set \+o errexit/, f);
    const check = code(gate('check.sh'));
    assert.equal((check.match(/set \+e/g) ?? []).length, 1);
    assert.ok(check.indexOf('set +e') > check.indexOf('gate_dnf install'), 'set +e comes after the install');
});

test('no failure is passed over with "|| true" or ":" in any script', () => {
    for (const f of SH)    // the one that stays: the engine lookup of start_gate.sh, which is checked on the next line of the script
        assert.doesNotMatch(code(gate(f)).replace('engine=${START_GATE_ENGINE:-$(command -v podman || command -v docker || true)}', ''), /\|\|\s*(true|:)\b/, f);
    assert.match(code(gate('start_gate.sh')), /^\[ -n "\$engine" \] \|\| \{ echo "start_gate\.sh: no podman or docker" >&2; exit 2; \}$/m);
});

test('check.sh installs without weak dependencies, runs both probes with "|| status=1", and ends with the status', () => {
    const check = code(gate('check.sh'));
    assert.match(check, /gate_dnf install --setopt=install_weak_deps=false "\$rpm_file" dbus-daemon/);
    assert.match(check, /^gjs -m \/gate\/probe_installed\.mjs "\$version" \|\| status=1$/m);
    assert.match(check, /^bash \/gate\/probe_start\.sh \|\| status=1$/m);
    assert.match(check, /^exit "\$status"$/m);
    assert.match(check, /START-GATE RESULT FAIL/);
});

test('build.sh makes the source RPM with the file COPR runs and rebuilds it, once, from the source RPM', () => {
    const build = code(gate('build.sh'));
    assert.match(build, /^make -f \/src\/\.copr\/Makefile srpm outdir=\/out\/srpm$/m);
    assert.match(build, /^gate_dnf builddep "\$srpm"$/m);
    assert.match(build, /^rpmbuild --rebuild --define "_topdir \/out\/build" "\$srpm"$/m);
    assert.equal((build.match(/rpmbuild/g) ?? []).length, 1);
    assert.match(build, /^trap 'chmod -R a\+rwX \/out' EXIT$/m);
});

test('probe_start.sh: the failures that make a log a failure, both starts, the headless display, and the fail function sets the status', () => {
    const p = code(gate('probe_start.sh'));
    assert.match(p, /grep -Eq 'start failed\|JS ERROR\|Unhandled promise rejection' "\$log"/);
    assert.match(p, /^\s+run_cetli d "/m);
    assert.match(p, /^\s+run_cetli e "[^"]*" --autostart$/m);
    assert.match(p, /cetli-sync status/);
    assert.match(p, /mutter --headless --wayland --no-x11 --virtual-monitor 1280x720 --wayland-display=gate-wl/);
    assert.match(p, /^fail\(\) \{ echo "START-GATE \$1 FAIL \$2"; status=1; \}$/m);
    assert.match(p, /^exit "\$status"$/m);
    assert.match(p, /kill -TERM "\$pid"/);
    assert.match(p, /kill -KILL "\$pid"/);
    assert.match(p, /trap cleanup EXIT/);
});

// what the steps do is in rpm-gate-steps.test.js (probe_steps.mjs run against stand-ins); here is what only the real file shows: that the probe the
// container runs wires the three steps in, with the real GLib, and ends with the status of runSteps
test('probe_installed.mjs: wires the three steps a, b, c to the real GLib and Gio, prints through runSteps, and uses no tree path', () => {
    const p = jsCode(gate('probe_installed.mjs'));
    assert.match(p, /import \{runSteps, stepImport, stepInstalled, stepSignal\} from '\.\/probe_steps\.mjs';/);
    assert.match(p, /\['a', \(\) => stepInstalled\(ARGV\[0\], \{read, isFile: path => GLib\.file_test\(path, GLib\.FileTest\.IS_REGULAR\)\}\)\],/);
    assert.match(p, /\['b', \(\) => stepImport\(\{read, importModule: specifier => import\(specifier\), gjsVersion: System\.version\}\)\],/);
    assert.match(p, /\['c', \(\) => stepSignal\(\{GLib, Gio, read\}\)\],/);
    assert.match(p, /\], print\);/);
    assert.match(p, /return runSteps\(/);
    assert.match(p, /System\.exit\(rc\);/);
    assert.doesNotMatch(p, /\/src\b|import\.meta/, 'the probe looks at the installed copy, not at a checkout');
    assert.doesNotMatch(p, /START-GATE/, 'the lines are printed by runSteps, in one place');
});

test('probe_steps.mjs imports no gi module (node runs it) and prints START-GATE lines in one place', () => {
    const p = jsCode(gate('probe_steps.mjs'));
    assert.doesNotMatch(p, /from 'gi:|from 'system'|from "gi:/);
    assert.match(p, /print\(`START-GATE \$\{name\} PASS /);
    assert.match(p, /print\(`START-GATE \$\{name\} FAIL /);
    assert.match(p, /return failed \? 1 : 0;/);
});

test('the SIGTERM watch of step (c) is the call application.js makes, and the negative control can find it once', () => {
    const call = 'GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, 15,';
    assert.equal(read('app/application.js').split(call).length - 1, 1, 'application.js must have the call once (negative_control.sh puts its error there)');
    assert.equal(jsCode(gate('probe_steps.mjs')).split(call).length - 1, 1);
    assert.ok(gate('negative_control.sh').includes('GLib\\.unix_signal_add(GLib\\.PRIORITY_DEFAULT, 15,'), 'negative_control.sh looks for the call');
});

test('the program still names the application id and the object path the probe asks the bus for', () => {
    const app = read('app/data.js');
    assert.match(app, /APP_ID = 'io\.github\.trensoft\.cetli'/);
    const p = code(gate('probe_start.sh'));
    assert.match(p, /^app_id=io\.github\.trensoft\.cetli$/m);
    assert.match(p, /^app_path=\/io\/github\/trensoft\/cetli$/m);
    assert.match(read('app/window.js'), /'delete'/, 'the note window offers the action the probe waits for');
    assert.match(read('app/application.js'), /name: 'new-note'/, 'the application offers the action the probe waits for');
});

test('docs/RELEASING.md makes verify_checks.sh the step before the tag, names every step of the gate, and the negative control', () => {
    assert.match(DOC, /`tools\/start_gate\/verify_checks\.sh <sha>` \(`VERIFY-CHECKS PASS`\)/);
    assert.match(DOC, /with no output of it there is no\s+tag/);
    assert.match(DOC, /If one chroot did not run, there is no tag|if one chroot did not run, there is no tag/);
    for (const step of ['(rpm)', '(a)', '(b)', '(c)', '(d)', '(e)', '(f)'])
        assert.ok(DOC.includes(step), `the doc does not name step ${step}`);
    assert.match(DOC, /`tools\/start_gate\/negative_control\.sh IMAGE TREE`/);
    assert.match(DOC, /\(`workflow_dispatch`\)/);
});
