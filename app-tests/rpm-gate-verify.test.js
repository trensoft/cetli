// SPDX-License-Identifier: GPL-3.0-or-later
// tools/start_gate/verify_checks.sh, the tag condition of docs/RELEASING.md as a machine check: every chroot of the COPR project has its
// `start gate (<chroot>)` check of GitHub Actions, completed with success, on the commit. The script runs with the real curl and python3
// against a server of this process that plays both APIs (START_GATE_GITHUB_API and START_GATE_COPR_API point at it).
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import path from 'node:path';
import {Box, REAL_TOOLS} from './rpm-gate-helpers.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const CHROOTS = ['epel-10', 'fedora-43', 'fedora-44', 'fedora-rawhide'];
const TOOLS = [...REAL_TOOLS, 'curl', 'python3', 'cat', 'tr', 'sed', 'sort'];

const copr = (chroots = CHROOTS) => ({chroot_repos: Object.fromEntries(chroots.map(c => [`${c}-x86_64`, `https://example.invalid/${c}`]))});
const leg = (chroot, o = {}) => ({name: `start gate (${chroot})`, status: 'completed', conclusion: 'success', app: {slug: 'github-actions'}, ...o});
const checks = (runs, total = runs.length) => ({total_count: total, check_runs: runs});

// the two APIs; `serve` says what each answers: a body, or {status, body}, or null (the connection is closed)
async function api(serve) {
    const requests = [];
    const server = createServer((req, res) => {
        requests.push({url: req.url, auth: req.headers.authorization ?? null});
        const kind = req.url.startsWith('/copr/') ? 'copr' : req.url.startsWith('/github/') ? 'github' : null;
        const a = kind ? serve[kind] : null;
        if (a === null || a === undefined) {
            res.destroy();
            return;
        }
        const {status = 200, body} = a.body === undefined && a.status === undefined ? {body: a} : a;
        res.writeHead(status, {'content-type': 'application/json'});
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    return {requests, base, close: () => server.close()};
}

const withApi = (serve, fn, {env = {}, args = [SHA]} = {}) => async () => {
    const box = new Box(TOOLS);
    const srv = await api(serve);
    try {
        const script = box.script('verify_checks.sh');
        const r = await box.runAsync(script, args, {START_GATE_GITHUB_API: `${srv.base}/github`, START_GATE_COPR_API: `${srv.base}/copr`, ...env});
        await fn(r, srv, box);
    } finally {
        srv.close();
        box.cleanup();
    }
};
const fails = (r, text) => {
    assert.equal(r.rc, 1, r.all);
    assert.match(r.out, new RegExp(`^VERIFY-CHECKS FAIL ${SHA}: `, 'm'));
    if (text)
        assert.match(r.all, text);
    assert.doesNotMatch(r.out, /VERIFY-CHECKS PASS/);
};

test('every chroot of the COPR project with its start gate green: pass', withApi(
    {copr: copr(), github: checks(CHROOTS.map(c => leg(c)))},
    (r, srv) => {
        assert.equal(r.rc, 0, r.all);
        assert.match(r.out, new RegExp(`^VERIFY-CHECKS PASS ${SHA}: every chroot of the COPR project has its start gate green$`, 'm'));
        assert.match(r.out, /COPR chroots: epel-10, fedora-43, fedora-44, fedora-rawhide/);
        assert.equal(srv.requests.length, 2);
    }));

test('it asks for the project trensoft/cetli and the check runs of that repository and that commit, 100 at a time', withApi(
    {copr: copr(), github: checks(CHROOTS.map(c => leg(c)))},
    (r, srv) => {
        const urls = srv.requests.map(q => q.url).sort();
        assert.deepEqual(urls, [`/copr/project/?ownername=trensoft&projectname=cetli`, `/github/repos/trensoft/cetli/commits/${SHA}/check-runs?filter=latest&per_page=100`].sort());
    }));

test('the architectures of a chroot are one chroot', withApi(
    {copr: {chroot_repos: Object.fromEntries(CHROOTS.flatMap(c => [`${c}-x86_64`, `${c}-aarch64`]).map(k => [k, 'x']))}, github: checks(CHROOTS.map(c => leg(c)))},
    r => assert.equal(r.rc, 0, r.all)));

for (const [why, patch] of [
    ['failure', {conclusion: 'failure'}],
    ['cancelled', {conclusion: 'cancelled'}],
    ['skipped', {conclusion: 'skipped'}],
    ['neutral', {conclusion: 'neutral'}],
    ['still running', {status: 'in_progress', conclusion: null}],
    ['queued', {status: 'queued', conclusion: null}],
    ['from another app', {app: {slug: 'some-other-app'}}],
    ['from no app', {app: null}],
]) {
    test(`a leg that is ${why} fails, and the chroot is named`, withApi(
        {copr: copr(), github: checks(CHROOTS.map(c => leg(c, c === 'fedora-44' ? patch : {})))},
        r => fails(r, /fedora-44: /)));
}

test('a missing leg fails', withApi(
    {copr: copr(), github: checks(CHROOTS.filter(c => c !== 'epel-10').map(c => leg(c)))},
    r => fails(r, /epel-10: 0 checks named 'start gate \(epel-10\)', one is needed/)));

test('no check at all fails', withApi({copr: copr(), github: checks([])}, r => fails(r)));

test('a chroot of the COPR project with no leg fails (the matrix and the project are one list)', withApi(
    {copr: copr([...CHROOTS, 'fedora-45']), github: checks(CHROOTS.map(c => leg(c)))},
    r => fails(r, /fedora-45: 0 checks/)));

test('a leg for a chroot that the COPR project has not fails', withApi(
    {copr: copr(), github: checks([...CHROOTS, 'fedora-45'].map(c => leg(c)))},
    r => fails(r, /fedora-45: a leg with no chroot in the COPR project/)));

test('other checks of the commit are ignored', withApi(
    {copr: copr(), github: checks([...CHROOTS.map(c => leg(c)), {name: 'node-tests', status: 'completed', conclusion: 'failure', app: {slug: 'github-actions'}}])},
    r => assert.equal(r.rc, 0, r.all)));

test('two checks of one name fail: one is needed', withApi(
    {copr: copr(), github: checks([...CHROOTS.map(c => leg(c)), leg('epel-10')])},
    r => fails(r, /epel-10: 2 checks named/)));

for (const which of ['copr', 'github']) {
    for (const status of [404, 500]) {
        test(`the ${which} API answering ${status} fails: no answer, no tag`, withApi(
            {copr: copr(), github: checks(CHROOTS.map(c => leg(c))), [which]: {status, body: {message: 'nope'}}},
            r => fails(r, which === 'copr' ? /the COPR project could not be read/ : /the check runs of the commit could not be read/)));
    }
    test(`the ${which} API not answering (the connection is closed) fails`, withApi(
        {copr: copr(), github: checks(CHROOTS.map(c => leg(c))), [which]: null},
        r => fails(r)));
}

for (const [why, body] of [['an empty object', {}], ['an empty list of chroots', {chroot_repos: {}}], ['a list that is not an object', {chroot_repos: ['epel-10-x86_64']}], ['text that is not JSON', 'oops']]) {
    test(`a COPR answer with ${why} fails`, withApi(
        {copr: body, github: checks(CHROOTS.map(c => leg(c)))},
        r => fails(r)));
}

test('a COPR project with no chroots and no checks is not a pass: there is nothing to tag against', withApi(
    {copr: {chroot_repos: {}}, github: checks([])},
    r => fails(r, /the COPR answer has no chroot_repos/)));

test('an incomplete list of checks (total_count over what is listed, more than 100) fails', withApi(
    {copr: copr(), github: checks(CHROOTS.map(c => leg(c)), 101)},
    r => fails(r, /the check runs are not complete \(total_count 101, 4 listed\)/)));

for (const sha of ['', 'abc', SHA.toUpperCase(), `${SHA}0`, 'v1.0.2']) {
    test(`only a full lower-case commit sha is accepted, not "${sha}"`, withApi(
        {copr: copr(), github: checks(CHROOTS.map(c => leg(c)))},
        (r, srv) => {
            assert.equal(r.rc, 2, r.all);
            assert.match(r.err, /usage: verify_checks\.sh SHA/);
            assert.equal(srv.requests.length, 0, 'it must not ask anything with a bad sha');
        }, {args: sha === '' ? [] : [sha]}));
}

test('the token is sent to the GitHub API when there is one, and only then, and not to COPR', async () => {
    for (const token of ['', 'tok-123']) {
        await withApi({copr: copr(), github: checks(CHROOTS.map(c => leg(c)))}, (r, srv) => {
            assert.equal(r.rc, 0, r.all);
            const gh = srv.requests.find(q => q.url.startsWith('/github/'));
            const co = srv.requests.find(q => q.url.startsWith('/copr/'));
            assert.equal(gh.auth, token ? `Bearer ${token}` : null);
            assert.equal(co.auth, null);
        }, {env: token ? {GITHUB_TOKEN: token} : {}})();
    }
});

test('it has the defaults of this repository: trensoft/cetli and the COPR project trensoft/cetli', async () => {
    const {readFileSync} = await import('node:fs');
    const text = readFileSync(new URL('../tools/start_gate/verify_checks.sh', import.meta.url), 'utf8');
    assert.match(text, /^repo=\$\{START_GATE_REPO:-trensoft\/cetli\}$/m);
    assert.match(text, /^copr_owner=\$\{START_GATE_COPR_OWNER:-trensoft\}$/m);
    assert.match(text, /^copr_project=\$\{START_GATE_COPR_PROJECT:-cetli\}$/m);
    assert.match(text, /^github_api=\$\{START_GATE_GITHUB_API:-https:\/\/api\.github\.com\}$/m);
    assert.match(text, /^copr_api=\$\{START_GATE_COPR_API:-https:\/\/copr\.fedorainfracloud\.org\/api_3\}$/m);
});
