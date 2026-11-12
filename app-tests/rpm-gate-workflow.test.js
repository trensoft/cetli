// SPDX-License-Identifier: GPL-3.0-or-later
// The workflows of the start gate (.github/workflows/start-gate.yml and negative-control.yml): the matrix of the first is the chroot list that docs/RELEASING.md names (and, at run time,
// the COPR project: verify_checks.sh reads the project from its API), it runs on the events a tag depends on, and the lines that make it a hard
// gate are there: no continue-on-error, no leg that stops the others, a time limit on every job, no token kept in .git/config, actions pinned by
// a commit, and the negative control (a tree with a start-up error in it must make the gate fail), which is a file of its own, so that a manual run
// leaves no check named like a leg of the gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {GATE, REPO} from './rpm-gate-helpers.js';

const read = f => readFileSync(path.join(REPO, f), 'utf8');
const gate = f => readFileSync(path.join(GATE, f), 'utf8');
const code = text => text.replace(/^\s*#.*$/gm, '');
const WORKFLOW = read('.github/workflows/start-gate.yml');
const CONTROL = read('.github/workflows/negative-control.yml');
const DOC = read('docs/RELEASING.md');

const matrixChroots = () => [...WORKFLOW.matchAll(/^\s+- chroot: (\S+)\s*$/gm)].map(m => m[1]);
const documentedChroots = () => {
    const line = DOC.split('\n').find(l => l.startsWith('Start gate chroots'));
    assert.ok(line, "docs/RELEASING.md has no line that starts with 'Start gate chroots'");
    return [...line.matchAll(/`((?:epel|fedora)-[a-z0-9]+)`/g)].map(m => m[1]);
};

test('the matrix is the chroot list that docs/RELEASING.md names, epel-10 first, no chroot twice', () => {
    const matrix = matrixChroots();
    assert.equal(new Set(matrix).size, matrix.length);
    assert.equal(matrix[0], 'epel-10');
    assert.deepEqual([...matrix].sort(), [...documentedChroots()].sort());
    for (const chroot of matrix)
        assert.ok(DOC.includes(`| \`${chroot}\` |`), `the table of docs/RELEASING.md has no row for ${chroot}`);
});

test('every leg has an image with a tag of its own, and the leg of epel-10 is CentOS Stream 10', () => {
    const pairs = [...WORKFLOW.matchAll(/- chroot: (\S+)\n\s+image: (\S+)/g)];
    assert.deepEqual(pairs.map(m => m[1]), matrixChroots());
    for (const [, chroot, image] of pairs) {
        assert.ok(image.includes(':') && !image.includes('latest'), `${chroot}: ${image}`);
        assert.ok(DOC.includes(image), `docs/RELEASING.md does not name ${image}`);
    }
    assert.equal(pairs[0][2], 'quay.io/centos/centos:stream10');
    assert.deepEqual(pairs.slice(1).map(m => m[2]), matrixChroots().slice(1).map(c => `registry.fedoraproject.org/fedora:${c.replace('fedora-', '')}`));
});

test('the gate runs on pull requests, on main and on tags, and not by hand; the negative control runs by hand only; the tokens only read', () => {
    const w = code(WORKFLOW);
    assert.match(w, /^on:\n  pull_request:\n  push:\n    branches: \[main\]\n    tags: \["v\*"\]$/m);
    assert.doesNotMatch(w, /workflow_dispatch/);
    const c = code(CONTROL);
    assert.match(c, /^on:\n  workflow_dispatch:\n\n/m);
    assert.doesNotMatch(c, /pull_request|push:|schedule|workflow_run/);
    for (const text of [w, c]) {
        assert.match(text, /^permissions:\n  contents: read$/m);
        assert.doesNotMatch(text, /(write|admin)\b/i);
    }
});

test('the gate file has no `if:` anywhere: a skipped job would leave a check named with the raw matrix template, and the negative control is not in it', () => {
    assert.doesNotMatch(code(WORKFLOW), /^\s*(- )?if:/m);
    assert.doesNotMatch(code(WORKFLOW), /negative_control|negative-control/);
});

const jobsOf = text => text.split(/^  (?=[a-z-]+:\n)/m).slice(1).filter(j => /^\w[\w-]*:\n/.test(j) && /runs-on/.test(j));

test('no leg stops the others, every job has a time limit that is a limit, and the check is named like the leg verify_checks.sh reads', () => {
    assert.match(WORKFLOW, /^      fail-fast: false$/m);
    assert.equal(jobsOf(WORKFLOW).length, 1);
    assert.equal(jobsOf(CONTROL).length, 1);
    for (const j of [...jobsOf(WORKFLOW), ...jobsOf(CONTROL)]) {
        const limit = Number(j.match(/timeout-minutes: (\d+)/)?.[1]);
        assert.ok(limit > 0 && limit <= 60, `time limit of ${j.split('\n')[0]}: ${limit}`);
    }
    assert.match(WORKFLOW, /^    name: start gate \(\$\{\{ matrix\.chroot \}\}\)$/m);
    assert.ok(gate('verify_checks.sh').includes('leg = re.compile(r"^start gate \\((.+)\\)$")'));
});

test('the check of the negative control is not named like a leg of the gate, so verify_checks.sh never reads it as one', () => {
    const name = CONTROL.match(/^    name: (.+)$/m)[1];
    assert.equal(name, 'negative control (the gate must fail on a tree that cannot start)');
    assert.doesNotMatch(name, /^start gate \((.+)\)$/);
});

test('every checkout keeps no token, and every action is pinned by a commit', () => {
    const uses = [...WORKFLOW.matchAll(/uses: (\S+)/g), ...CONTROL.matchAll(/uses: (\S+)/g)].map(m => m[1]);
    assert.equal(uses.length, 2);
    for (const u of uses)
        assert.match(u, /^actions\/checkout@[0-9a-f]{40}$/, u);
    assert.equal((WORKFLOW.match(/persist-credentials: false/g) ?? []).length + (CONTROL.match(/persist-credentials: false/g) ?? []).length, uses.length);
    // the same pin as the tests workflow
    assert.deepEqual(uses.map(u => u.split('@')[1]), uses.map(() => read('.github/workflows/tests.yml').match(/actions\/checkout@([0-9a-f]{40})/)[1]));
});

test('the gate job runs the gate on the image of its leg', () => {
    assert.match(WORKFLOW, /run: bash tools\/start_gate\/start_gate\.sh "\$\{\{ matrix\.image \}\}"/);
    assert.equal((WORKFLOW.match(/START_GATE_ENGINE: docker/g) ?? []).length, 1);
});

test('the negative control runs on the image of epel-10, on the checkout of the commit it runs on (by its SHA, no tag or branch that can move)', () => {
    assert.match(CONTROL, /run: bash tools\/start_gate\/negative_control\.sh quay\.io\/centos\/centos:stream10 \.$/m);
    assert.equal((CONTROL.match(/START_GATE_ENGINE: docker/g) ?? []).length, 1);
    assert.match(CONTROL, /^          ref: \$\{\{ github\.sha \}\}$/m);
    assert.deepEqual([...code(CONTROL).matchAll(/^\s+ref: (.+)$/gm)].map(m => m[1]), ['${{ github.sha }}']);
    assert.ok(DOC.includes('quay.io/centos/centos:stream10'));
});

test('no workflow has continue-on-error: a job cannot fail without failing its check', () => {
    assert.doesNotMatch(code(WORKFLOW), /continue-on-error/);
    assert.doesNotMatch(code(CONTROL), /continue-on-error/);
});

test('the workflow files have the SPDX header', () => {
    for (const w of [WORKFLOW, CONTROL])
        assert.match(w.split('\n').slice(0, 3).join('\n'), /SPDX-License-Identifier: GPL-3\.0-or-later/);
});
