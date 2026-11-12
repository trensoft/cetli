// SPDX-License-Identifier: GPL-3.0-or-later
// The scripts of the start gate (tools/start_gate/) run with stand-ins for the commands they call (rpm-gate-helpers.js): build.sh, check.sh,
// start_gate.sh and negative_control.sh here, probe_start.sh in rpm-gate-probe.test.js. They are the part of the gate that makes it hard: a
// gate that passes whatever the commands answer is not a gate, so what each answer does to the exit status and to the lines is pinned.
import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Box, NEVRA, REAL_TOOLS, stub} from './rpm-gate-helpers.js';

const withBox = (fn, tools) => async t => {
    const box = new Box(tools);
    try {
        await fn(box, t);
    } finally {
        box.cleanup();
    }
};

// ---------------------------------------------------------------------------------------------------------------- check.sh

// a box for check.sh: one RPM in /out/rpm, stand-ins for rpm, gjs and probe_start.sh (the gate runs it with bash)
function checkBox(box, {rpms = [`${NEVRA}.rpm`]} = {}) {
    mkdirSync(path.join(box.out, 'rpm'));
    for (const r of rpms)
        writeFileSync(path.join(box.out, 'rpm', r), `payload of ${r}`);
    stub(path.join(box.bin, 'rpm'),
        'echo "rpm $*" >> "$STUB_LOG"\n[ -n "${STUB_RPM_FAIL:-}" ] && exit 1\nprintf "%s" "${STUB_RPM_NAME:-' + NEVRA + '}"\n');
    stub(path.join(box.bin, 'gjs'), 'echo "gjs $*" >> "$STUB_LOG"\nexit "${STUB_GJS_RC:-0}"\n');
    stub(path.join(box.gate, 'probe_start.sh'), 'echo "probe_start" >> "$STUB_LOG"\nexit "${STUB_START_RC:-0}"\n');
    return box.script('check.sh');
}

test('check.sh passes when everything passes, and says which RPM and which digest', withBox((box) => {
    const check = checkBox(box);
    const r = box.run(check);
    assert.equal(r.rc, 0, r.all);
    assert.match(r.out, /^START-GATE rpm PASS rpm -q cetli: cetli-1\.2\.3-1\.fc43\.noarch$/m);
    assert.match(r.out, new RegExp(`^START-GATE RESULT PASS ${NEVRA} sha256 [0-9a-f]{64}$`, 'm'));
}));

test('check.sh installs the RPM and dbus-daemon without weak dependencies, once, through the gate\'s dnf', withBox((box) => {
    const r = box.run(checkBox(box));
    assert.equal(r.rc, 0, r.all);
    assert.deepEqual(box.calls().filter(c => c.startsWith('dnf ')), [`dnf install --setopt=install_weak_deps=false ${box.out}/rpm/${NEVRA}.rpm dbus-daemon`]);
    assert.equal(box.calls()[0], 'gate_repos');
}));

test('check.sh runs both probes from the gate directory, with the version of the RPM', withBox((box) => {
    const r = box.run(checkBox(box));
    assert.equal(r.rc, 0, r.all);
    assert.ok(box.calls().includes(`gjs -m ${box.gate}/probe_installed.mjs 1.2.3`), box.calls().join('\n'));
    assert.ok(box.calls().includes('probe_start'));
}));

for (const [name, env] of [['probe_installed.mjs', {STUB_GJS_RC: '1'}], ['probe_start.sh', {STUB_START_RC: '1'}]]) {
    test(`check.sh fails when ${name} fails, and still runs the other probe`, withBox((box) => {
        const r = box.run(checkBox(box), [], env);
        assert.equal(r.rc, 1, r.all);
        assert.match(r.out, new RegExp(`^START-GATE RESULT FAIL ${NEVRA} sha256 `, 'm'));
        assert.ok(box.calls().includes('probe_start'), 'probe_start did not run');
        assert.ok(box.calls().some(c => c.startsWith('gjs ')), 'probe_installed did not run');
    }));
}

test('check.sh stops, with no RESULT PASS and no probe, when the install fails', withBox((box) => {
    const r = box.run(checkBox(box), [], {STUB_DNF_RC: '1'});
    assert.notEqual(r.rc, 0);
    assert.doesNotMatch(r.out, /RESULT PASS/);
    assert.equal(box.calls().some(c => c.startsWith('gjs ') || c === 'probe_start'), false);
}));

test('check.sh fails when rpm -q names another package than the file', withBox((box) => {
    const r = box.run(checkBox(box), [], {STUB_RPM_NAME: 'cetli-9.9.9-1.fc43.noarch'});
    assert.equal(r.rc, 1, r.all);
    assert.match(r.out, /^START-GATE rpm FAIL rpm -q gives cetli-9\.9\.9-1\.fc43\.noarch, the file is cetli-1\.2\.3-1\.fc43\.noarch$/m);
    assert.match(r.out, /^START-GATE RESULT FAIL /m);
}));

test('check.sh fails when the image has no rpm: the step is not left out', withBox((box) => {
    const check = checkBox(box);
    rmFile(path.join(box.bin, 'rpm'));
    const r = box.run(check);
    assert.equal(r.rc, 1, r.all);
    assert.match(r.out, /^START-GATE rpm FAIL there is no rpm in the image/m);
    assert.match(r.out, /^START-GATE RESULT FAIL /m);
}));

const rmFile = f => spawnSync('rm', ['-f', f]);

for (const rpms of [[], [`${NEVRA}.rpm`, 'cetli-1.2.4-1.fc43.noarch.rpm']]) {
    test(`check.sh wants exactly one RPM in /out/rpm, not ${rpms.length}`, withBox((box) => {
        const r = box.run(checkBox(box, {rpms}));
        assert.equal(r.rc, 1, r.all);
        assert.match(r.out, new RegExp(`^START-GATE RESULT FAIL: expected one RPM in ${box.out.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/rpm, found ${rpms.length}$`, 'm'));
        assert.equal(box.calls().some(c => c.startsWith('dnf ')), false, 'it installed something');
    }));
}

test('check.sh for a tag wants the tag to be v<version of the RPM>', withBox((box) => {
    const r = box.run(checkBox(box), [], {GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.2.3'});
    assert.equal(r.rc, 0, r.all);
    assert.match(r.out, /^START-GATE tag PASS the tag v1\.2\.3 is v1\.2\.3$/m);
}));

for (const name of ['v1.2.4', '1.2.3', 'v1.2.3-1', '']) {
    test(`check.sh fails a run for the tag "${name}", the RPM has version 1.2.3`, withBox((box) => {
        const r = box.run(checkBox(box), [], {GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: name});
        assert.equal(r.rc, 1, r.all);
        assert.match(r.out, /^START-GATE tag FAIL the tag is .*, the RPM has version 1\.2\.3$/m);
        assert.match(r.out, /^START-GATE RESULT FAIL /m);
    }));
}

test('check.sh ignores the ref name when the run is not for a tag', withBox((box) => {
    const r = box.run(checkBox(box), [], {GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main'});
    assert.equal(r.rc, 0, r.all);
    assert.doesNotMatch(r.out, /START-GATE tag/);
}));

// ---------------------------------------------------------------------------------------------------------------- build.sh

// a box for build.sh: stand-ins for make, rpmbuild and the dnf of common.sh; make writes the source RPM, rpmbuild the binary RPM
function buildBox(box, {rpmbuildRcs = [0], make = true} = {}) {
    stub(path.join(box.bin, 'make'),
        `echo "make $*" >> "$STUB_LOG"\n${make ? '' : 'exit 1\n'}mkdir -p "${box.out}/srpm"\ntouch "${box.out}/srpm/cetli-1.2.3-1.src.rpm"\n`);
    stub(path.join(box.bin, 'rpmbuild'),
        'echo "rpmbuild $*" >> "$STUB_LOG"\nn=$(grep -c "^rpmbuild" "$STUB_LOG")\n' +
        `rcs=(${rpmbuildRcs.join(' ')})\nrc=\${rcs[$((n - 1))]:-0}\n` +
        `if [ "$rc" -eq 0 ]; then mkdir -p "${box.out}/build/RPMS/noarch"; touch "${box.out}/build/RPMS/noarch/${NEVRA}.rpm"; chmod 600 "${box.out}/build/RPMS/noarch/${NEVRA}.rpm"; fi\nexit "$rc"\n`);
    return box.script('build.sh');
}

test('build.sh makes the source RPM with .copr/Makefile, installs its build requirements and copies the binary RPM out', withBox((box) => {
    const r = box.run(buildBox(box));
    assert.equal(r.rc, 0, r.all);
    const calls = box.calls();
    assert.ok(calls.includes(`make -f ${box.src}/.copr/Makefile srpm outdir=${box.out}/srpm`), calls.join('\n'));
    assert.ok(calls.includes(`dnf builddep ${box.out}/srpm/cetli-1.2.3-1.src.rpm`), calls.join('\n'));
    assert.ok(calls.includes(`rpmbuild --rebuild --define _topdir ${box.out}/build ${box.out}/srpm/cetli-1.2.3-1.src.rpm`), calls.join('\n'));
    assert.ok(existsSync(path.join(box.out, 'rpm', `${NEVRA}.rpm`)), 'the RPM was not copied to /out/rpm');
    // the order: Makefile, builddep, rpmbuild
    const at = s => calls.findIndex(c => c.startsWith(s));
    assert.ok(at('make ') < at('dnf builddep') && at('dnf builddep') < at('rpmbuild'), calls.join('\n'));
}));

test('build.sh installs the tools it needs, and the plugin of dnf5 or dnf4', withBox((box) => {
    box.run(buildBox(box));
    const dnf = box.calls().filter(c => c.startsWith('dnf install'));
    assert.deepEqual(dnf, ['dnf install rpm-build git-core gzip make', 'dnf install dnf5-plugins']);
    assert.equal(box.calls()[0], 'gate_repos', 'the repositories of the image come first');
}));

test('build.sh falls back to dnf-plugins-core when dnf5-plugins is not there (EL10)', withBox((box) => {
    const build = buildBox(box);
    writeFileSync(path.join(box.gate, 'common.sh'),
        'gate_repos() { :; }\ngate_dnf() { echo "dnf $*" >> "$STUB_LOG"; [ "$*" != "install dnf5-plugins" ]; }\n');
    const r = box.run(build);
    assert.equal(r.rc, 0, r.all);
    assert.ok(box.calls().includes('dnf install dnf-plugins-core'), box.calls().join('\n'));
}));

for (const [codes, expected] of [[[1], 1], [[2], 2], [[11], 11], [[0], 0]]) {
    test(`build.sh ends with exit status ${expected} when rpmbuild ends with ${codes[0]}, and copies nothing on a failure`, withBox((box) => {
        const r = box.run(buildBox(box, {rpmbuildRcs: codes}));
        assert.equal(r.rc, expected, r.all);
        assert.equal(existsSync(path.join(box.out, 'rpm', `${NEVRA}.rpm`)), expected === 0);
        assert.equal(box.calls().filter(c => c.startsWith('rpmbuild')).length, 1, 'rpmbuild must run once: this spec has no generated build requirements');
    }));
}

test('build.sh stops when dnf fails: no rpmbuild', withBox((box) => {
    const r = box.run(buildBox(box), [], {STUB_DNF_RC: '1'});
    assert.notEqual(r.rc, 0);
    assert.equal(box.calls().some(c => c.startsWith('rpmbuild')), false);
}));

test('build.sh stops when the source RPM cannot be made: no builddep, no rpmbuild', withBox((box) => {
    const r = box.run(buildBox(box, {make: false}));
    assert.notEqual(r.rc, 0);
    assert.equal(box.calls().some(c => c.startsWith('rpmbuild') || c.startsWith('dnf builddep')), false);
}));

test('build.sh leaves the files removable for whoever started the container (a+rw)', withBox((box) => {
    const r = box.run(buildBox(box));
    assert.equal(r.rc, 0, r.all);
    const mode = statSync(path.join(box.out, 'rpm', `${NEVRA}.rpm`)).mode & 0o666;
    assert.equal(mode, 0o666);
}));

test('build.sh leaves them removable after a failure too', withBox((box) => {
    const build = buildBox(box, {rpmbuildRcs: [1]});
    stub(path.join(box.bin, 'rpmbuild'), `touch "${box.out}/srpm/leftover"; chmod 600 "${box.out}/srpm/leftover"; exit 1\n`);
    box.run(build);
    assert.equal(statSync(path.join(box.out, 'srpm', 'leftover')).mode & 0o666, 0o666);
}));

// ---------------------------------------------------------------------------------------------------------------- start_gate.sh

// a box for start_gate.sh: a tree with .copr/Makefile, a stand-in for the engine that prints and ends by the script it is told to run
function gateBox(box, {outputs = {}, rcs = {}} = {}) {
    mkdirSync(path.join(box.src, '.copr'));
    writeFileSync(path.join(box.src, '.copr', 'Makefile'), 'srpm:\n');
    for (const f of ['build.sh', 'check.sh', 'common.sh'])
        writeFileSync(path.join(box.gate, f), '');
    let cases = '';
    for (const s of ['build.sh', 'check.sh'])
        cases += `    */${s}) printf '%s\\n' '${outputs[s] ?? ''}'; exit ${rcs[s] ?? 0} ;;\n`;
    const engine = stub(path.join(box.bin, 'fake-engine'),
        'echo "engine $*" >> "$STUB_LOG"\nfor last; do :; done\ncase "$last" in\n' + cases + 'esac\nexit 99\n');
    return engine;
}

function startGate(box, args, env = {}) {
    const script = path.join(box.gate, 'start_gate.sh');
    writeFileSync(script, readFileSync(new URL('../tools/start_gate/start_gate.sh', import.meta.url), 'utf8'));
    chmodSync(script, 0o755);
    return box.run(script, args, env);
}

const gateTools = [...REAL_TOOLS, 'cat'];

test('start_gate.sh runs the two stages in two containers: the tree and the gate read only, the output shared', withBox((box) => {
    const engine = gateBox(box);
    const r = startGate(box, ['quay.io/image:1', box.src], {START_GATE_ENGINE: engine});
    assert.equal(r.rc, 0, r.all);
    const engineCalls = box.calls().filter(c => c.startsWith('engine '));
    assert.equal(engineCalls.length, 2, engineCalls.join('\n'));
    const [one, two] = engineCalls;
    assert.match(one, new RegExp(`-v ${box.src}:/src:ro -v ${box.gate}:/gate:ro -v \\S+:/out quay\\.io/image:1 bash /gate/build\\.sh$`));
    assert.match(two, new RegExp(`-v ${box.gate}:/gate:ro -v \\S+:/out:ro quay\\.io/image:1 bash /gate/check\\.sh$`));
    assert.doesNotMatch(two, /:\/src/, 'stage 2 must not see the tree');
}, gateTools));

test('start_gate.sh passes the tag of the run on to stage 2 and only to stage 2', withBox((box) => {
    const engine = gateBox(box);
    startGate(box, ['img:1', box.src], {START_GATE_ENGINE: engine});
    const [one, two] = box.calls().filter(c => c.startsWith('engine '));
    assert.match(two, /-e GITHUB_REF_TYPE -e GITHUB_REF_NAME/);
    assert.doesNotMatch(one, /GITHUB_REF/);
}, gateTools));

test('start_gate.sh does not start stage 2 after a failed stage 1, and ends with its status', withBox((box) => {
    const engine = gateBox(box, {rcs: {'build.sh': 3}});
    const r = startGate(box, ['img:1', box.src], {START_GATE_ENGINE: engine});
    assert.equal(r.rc, 3, r.all);
    assert.equal(box.calls().filter(c => c.startsWith('engine ')).length, 1);
}, gateTools));

test('start_gate.sh ends with the failure of stage 2', withBox((box) => {
    const engine = gateBox(box, {rcs: {'check.sh': 1}});
    const r = startGate(box, ['img:1', box.src], {START_GATE_ENGINE: engine});
    assert.equal(r.rc, 1, r.all);
    assert.equal(box.calls().filter(c => c.startsWith('engine ')).length, 2);
}, gateTools));

test('start_gate.sh without a container engine is an error (status 2), not a pass', withBox((box) => {
    gateBox(box);
    const r = startGate(box, ['img:1', box.src]);
    assert.equal(r.rc, 2, r.all);
    assert.match(r.err, /no podman or docker/);
}, gateTools));

test('start_gate.sh wants a tree with .copr/Makefile, and an image', withBox((box) => {
    const engine = gateBox(box);
    const empty = mkdtempSync(path.join(tmpdir(), 'sg-empty-'));
    let r = startGate(box, ['img:1', empty], {START_GATE_ENGINE: engine});
    assert.equal(r.rc, 2, r.all);
    assert.match(r.err, /has no \.copr\/Makefile/);
    r = startGate(box, [], {START_GATE_ENGINE: engine});
    assert.notEqual(r.rc, 0);
    assert.equal(box.calls().filter(c => c.startsWith('engine ')).length, 0);
}, gateTools));

// ---------------------------------------------------------------------------------------------------------------- negative_control.sh

// a tree that is a git checkout with the SIGTERM watch in app/application.js; start_gate.sh is a stand-in that prints what it is told to and
// logs what the tree it got looks like
function controlBox(box, {tree = true, output = '', rc = 1, line = '    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, 15, () => {'} = {}) {
    const treeDir = path.join(box.root, 'tree');
    mkdirSync(path.join(treeDir, 'app'), {recursive: true});
    writeFileSync(path.join(treeDir, 'app', 'application.js'), tree ? `${line}\n    stopping = true;\n` : 'nothing here\n');
    const git = (...a) => spawnSync('git', ['-C', treeDir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {encoding: 'utf8'});
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'tree');
    writeFileSync(path.join(box.gate, 'start_gate.sh'),
        '#!/bin/bash\necho "start_gate $1 tree-is-copy=$([ "$2" != "$TREE_UNDER_TEST" ] && echo yes || echo no)" >> "$STUB_LOG"\n' +
        'echo "mutated=$(grep -c "GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, 15," "$2/app/application.js")" >> "$STUB_LOG"\n' +
        `echo "committed=$(git -C "$2" status --porcelain | wc -l)" >> "$STUB_LOG"\nprintf '%s\\n' '${output}'\nexit ${rc}\n`);
    chmodSync(path.join(box.gate, 'start_gate.sh'), 0o755);
    return {treeDir, script: path.join(box.gate, 'negative_control.sh')};
}

const control = (box, opts = {}) => {
    const c = controlBox(box, opts);
    writeFileSync(c.script, readFileSync(new URL('../tools/start_gate/negative_control.sh', import.meta.url), 'utf8'));
    chmodSync(c.script, 0o755);
    return {...c, run: () => box.run(c.script, ['img:1', c.treeDir], {TREE_UNDER_TEST: c.treeDir})};
};
const controlTools = [...REAL_TOOLS, 'git', 'grep', 'sed', 'tee', 'wc', 'cat', 'bash', 'awk'];
// what the gate prints on the copy: the steps before (d), the FAIL line of (d) with the log of the program under it (the ReferenceError of the copy),
// the FAIL of (e), the same error in the log of (e)
const REASON = 'Gjs-CRITICAL **: JS ERROR: ReferenceError: GLibUnix is not defined';
const block = reason => `---- log of cetli ----\n${reason}\n---- end of the log of cetli ----`;
// the two lines start_gate.sh prints before its stages; only the output after the second one counts
const STAGE1 = '== stage 1: build the RPM from /tree in img:1';
const STAGE2 = '== stage 2: install and start it in a clean img:1';
const gateOutput = ({d = `START-GATE d FAIL x\n${block(REASON)}`, e = `START-GATE e FAIL x\n${block(REASON)}`} = {}) =>
    `${STAGE1}\nbuilt\n${STAGE2}\nSTART-GATE rpm PASS x\nSTART-GATE a PASS x\nSTART-GATE b PASS x\nSTART-GATE c PASS x\n${d}\n${e}\nSTART-GATE RESULT FAIL cetli sha256 0`;
const D_FAIL = gateOutput();

test('the control passes when the gate fails in step (d) and (a), (b), (c) pass, on a COPY of the tree with the error in it', withBox((box) => {
    const c = control(box, {output: D_FAIL});
    const r = c.run();
    assert.equal(r.rc, 0, r.all);
    assert.match(r.out, /^NEGATIVE-CONTROL PASS/m);
    const calls = box.calls();
    assert.ok(calls.includes('start_gate img:1 tree-is-copy=yes'), calls.join('\n'));
    assert.ok(calls.includes('mutated=1'), `the error is not in the tree the gate got: ${calls.join('\n')}`);
    assert.ok(calls.includes('committed=0'), 'the copy must be committed: the source RPM is made from HEAD');
    // the tree under test is not changed
    assert.match(readFileSync(path.join(c.treeDir, 'app', 'application.js'), 'utf8'), /GLib\.unix_signal_add\(GLib\.PRIORITY_DEFAULT, 15,/);
}, controlTools));

test('the control fails when the gate PASSES on the bad tree: it is soft', withBox((box) => {
    const r = control(box, {output: 'START-GATE RESULT PASS x', rc: 0}).run();
    assert.equal(r.rc, 1, r.all);
    assert.match(r.out, /^NEGATIVE-CONTROL FAIL: the gate PASSED/m);
}, controlTools));

for (const [why, output] of [
    ['it failed before stage 2 (no result line)', 'a build error'],
    ['(d) failed but (rpm) did not pass', D_FAIL.replace('rpm PASS', 'rpm FAIL')],
    ['(d) failed but (a) did not pass', D_FAIL.replace('a PASS', 'a FAIL')],
    ['(d) failed but (b) did not pass', D_FAIL.replace('b PASS', 'b FAIL')],
    ['(d) failed but (c) did not pass', D_FAIL.replace('c PASS', 'c FAIL')],
    ['(c) failed and (d) did not', D_FAIL.replace('d FAIL', 'd PASS').replace('c PASS', 'c FAIL')],
    ['there is no RESULT FAIL line', D_FAIL.replace('RESULT FAIL', 'RESULT SOMETHING')],
]) {
    test(`the control proves nothing, and fails, when ${why}`, withBox((box) => {
        const r = control(box, {output}).run();
        assert.equal(r.rc, 1, r.all);
        assert.match(r.out, /^NEGATIVE-CONTROL FAIL: the gate failed/m);
    }, controlTools));
}

for (const [why, output] of [
    ['the log of the program under (d) holds another error', gateOutput({d: `START-GATE d FAIL x\n${block('Gjs-CRITICAL **: JS ERROR: ReferenceError: GLib is not defined')}`})],
    ['the log of the program under (d) holds no error at all', gateOutput({d: `START-GATE d FAIL x\n${block('nothing')}`})],
    ['the error is in the log of (e) and not under (d)', gateOutput({d: 'START-GATE d FAIL x'})],
    ['the error is above the line of (d), under no step of its own', gateOutput({d: `${block(REASON)}\nSTART-GATE d FAIL x`, e: 'START-GATE e FAIL x'})],
    ['the error is under (c), whose step passed', D_FAIL.replace('c PASS x', `c PASS x\n${block(REASON)}`).replace(`START-GATE d FAIL x\n${block(REASON)}`, 'START-GATE d FAIL x')],
]) {
    test(`the control fails when (d) failed but ${why}: it failed for another reason`, withBox((box) => {
        const r = control(box, {output}).run();
        assert.equal(r.rc, 1, r.all);
        assert.match(r.out, /^NEGATIVE-CONTROL FAIL: step \(d\) failed, but the log of the program does not show the error that was put in/m);
    }, controlTools));
}

// every line the control reads, as the probe prints it in stage 2
const CONTROL_LINES = ['START-GATE rpm PASS x', 'START-GATE a PASS x', 'START-GATE b PASS x', 'START-GATE c PASS x', 'START-GATE d FAIL x', 'START-GATE RESULT FAIL cetli sha256 0'];
for (const line of CONTROL_LINES) {
    for (const [kind, prefix] of [['a word', 'x '], ['an indent', '  '], ['a diff', '+ ']]) {
        test(`the control wants "${line.split(' ').slice(0, 3).join(' ')}" as a line of its own: after ${kind} in front of it, it does not count`, withBox((box) => {
            const r = control(box, {output: D_FAIL.replace(`\n${line}`, `\n${prefix}${line}`)}).run();
            assert.equal(r.rc, 1, r.all);
            assert.match(r.out, /^NEGATIVE-CONTROL FAIL: the gate failed/m);
        }, controlTools));
    }
    test(`the control reads "${line.split(' ').slice(0, 3).join(' ')}" in its own case: in other letters it does not count`, withBox((box) => {
        const r = control(box, {output: D_FAIL.replace(`\n${line}`, `\n${line.replace(/(PASS|FAIL)/, w => w.toLowerCase())}`)}).run();
        assert.equal(r.rc, 1, r.all);
        assert.match(r.out, /^NEGATIVE-CONTROL FAIL: the gate failed/m);
    }, controlTools));
}

test('the control reads the error that was put in in its own case: in other letters it is another error', withBox((box) => {
    const r = control(box, {output: gateOutput({d: `START-GATE d FAIL x\n${block(REASON.toLowerCase())}`})}).run();
    assert.equal(r.rc, 1, r.all);
    assert.match(r.out, /^NEGATIVE-CONTROL FAIL: step \(d\) failed, but the log of the program does not show the error that was put in/m);
}, controlTools));

test('a line that only quotes the FAIL line of (d) does not open the block of (d): the error under it does not count', withBox((box) => {
    const output = gateOutput({d: `START-GATE d FAIL x\n${block('nothing')}`, e: `START-GATE e FAIL x\nx START-GATE d FAIL x\n${block(REASON)}`});
    const r = control(box, {output}).run();
    assert.equal(r.rc, 1, r.all);
    assert.match(r.out, /^NEGATIVE-CONTROL FAIL: step \(d\) failed, but the log of the program does not show the error that was put in/m);
}, controlTools));

test('only the FAIL line of (d) opens its block: another line of (d) with the error under it does not count', withBox((box) => {
    const output = gateOutput({d: `START-GATE d note x\n${block(REASON)}\nSTART-GATE d FAIL x\n${block('nothing')}`, e: 'START-GATE e FAIL x'});
    const r = control(box, {output}).run();
    assert.equal(r.rc, 1, r.all);
    assert.match(r.out, /^NEGATIVE-CONTROL FAIL: step \(d\) failed, but the log of the program does not show the error that was put in/m);
}, controlTools));

test('only stage 2 counts: the lines of the probe in the output of stage 1 (the build) are not steps of the probe', withBox((box) => {
    const steps = D_FAIL.slice(D_FAIL.indexOf(STAGE2) + STAGE2.length + 1);
    let r = control(box, {output: `${STAGE1}\n${steps}\n${STAGE2}\nSTART-GATE RESULT FAIL cetli sha256 0`}).run();
    assert.equal(r.rc, 1, r.all);
    assert.match(r.out, /^NEGATIVE-CONTROL FAIL: the gate failed/m);
    // stage 2 never started
    r = control(box, {output: `${STAGE1}\n${steps}`}).run();
    assert.equal(r.rc, 1, r.all);
    assert.match(r.out, /^NEGATIVE-CONTROL FAIL: the gate failed/m);
    // a line that names stage 2 but is not the line of start_gate.sh does not start it
    r = control(box, {output: `${STAGE1}\nx ${STAGE2}\n${steps}`}).run();
    assert.equal(r.rc, 1, r.all);
}, controlTools));

test('only stage 2 counts for the reason too: the error in the output of stage 1 is not the error of the start', withBox((box) => {
    const output = gateOutput({d: 'START-GATE d FAIL x', e: 'START-GATE e FAIL x'}).replace('built\n', `built\nSTART-GATE d FAIL x\n${block(REASON)}\n`);
    const r = control(box, {output}).run();
    assert.equal(r.rc, 1, r.all);
    assert.match(r.out, /^NEGATIVE-CONTROL FAIL: step \(d\) failed, but the log of the program does not show the error that was put in/m);
}, controlTools));

test('the control fails, and does not run the gate, when the SIGTERM watch is not in the tree once', withBox((box) => {
    const r = control(box, {tree: false, output: D_FAIL}).run();
    assert.equal(r.rc, 1, r.all);
    assert.match(r.out, /^NEGATIVE-CONTROL FAIL: the SIGTERM watch is not in app\/application\.js once/m);
    assert.equal(box.calls().some(c => c.startsWith('start_gate ')), false);
}, controlTools));

test('the control fails when the SIGTERM watch is there twice', withBox((box) => {
    const two = '    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, 15, () => {\n    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, 15, () => {';
    const r = control(box, {line: two, output: D_FAIL}).run();
    assert.equal(r.rc, 1, r.all);
    assert.equal(box.calls().some(c => c.startsWith('start_gate ')), false);
}, controlTools));
