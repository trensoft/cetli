// SPDX-License-Identifier: GPL-3.0-or-later
// tools/start_gate/probe_start.sh, steps (d) to (f) of the start gate, run with stand-ins for the programs it starts: a node program that
// listens on a Unix socket for dbus-daemon and mutter (the script waits for the sockets), a gdbus that answers from state files, a `cetli` that
// behaves as a scenario says, and a `cetli-sync`. What is measured is what the script makes of the way the programs behave: which of them it
// starts and how, and which lines and exit status it ends with. The real programs run in the gate itself (the negative control shows it fails).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {Box, REAL_TOOLS, socketStub, stub} from './rpm-gate-helpers.js';

const TOOLS = [...REAL_TOOLS, 'sleep', 'head', 'tail', 'wc', 'timeout', 'cat'];
const ENV = {START_GATE_TIMEOUT: '8', START_GATE_SETTLE: '0.3'};
const BENIGN = 'Gjs-WARNING **: GLib.unix_signal_add has been moved\\nlibEGL warning: failed to get driver name for fd -1\\nMESA: error: ZINK: vkCreateInstance failed';

function probeBox(box) {
    const state = path.join(box.root, 'state');
    mkdirSync(state);
    box.state = state;
    socketStub(path.join(box.bin, 'dbus-daemon'), `
const fs = require('node:fs');
const args = process.argv.slice(2);
const conf = args.find(a => a.startsWith('--config-file=')).slice('--config-file='.length);
const text = fs.readFileSync(conf, 'utf8');
fs.appendFileSync(process.env.STUB_LOG, 'dbus-daemon ' + args.join(' ') + '\\n');
fs.writeFileSync(process.env.STUB_STATE + '/bus.conf', text);
net.createServer().listen(text.match(/unix:path=([^<]+)</)[1]);
`);
    socketStub(path.join(box.bin, 'mutter'), `
const fs = require('node:fs');
fs.appendFileSync(process.env.STUB_LOG, 'mutter ' + process.argv.slice(2).join(' ') + ' DBUS=' + process.env.DBUS_SESSION_BUS_ADDRESS + '\\n');
if (process.env.MUTTER_MODE === 'fail') {
    console.error('mutter boom: no way');
    process.exit(1);
}
net.createServer().listen(process.env.XDG_RUNTIME_DIR + '/gate-wl');
`);
    stub(path.join(box.bin, 'gdbus'), `
echo "gdbus $*" >> "$STUB_LOG"
while [ $# -gt 0 ]; do [ "$1" = --object-path ] && path=$2; shift; done
case "$path" in
/io/github/trensoft/cetli) [ -e "$STUB_STATE/app" ] && echo "(['all-notes', 'new-note', 'sync-setup'],)" || { echo "Error: no such name" >&2; exit 1; } ;;
/io/github/trensoft/cetli/window/1) [ -e "$STUB_STATE/window" ] && echo "(['delete', 'color'],)" || echo "(@as [],)" ;;
*) echo "(@as [],)" ;;
esac
`);
    stub(path.join(box.bin, 'cetli'), `
mode=\${STUB_MODE_D:-ok}
[ "$1" = --autostart ] && mode=\${STUB_MODE_E:-ok}
echo "cetli $* HOME=$HOME WAYLAND_DISPLAY=$WAYLAND_DISPLAY GDK_BACKEND=$GDK_BACKEND XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR DBUS=$DBUS_SESSION_BUS_ADDRESS" >> "$STUB_LOG"
rm -f "$STUB_STATE/app" "$STUB_STATE/window"
printf '${BENIGN}\\n' >&2
case "$mode" in
exit1) echo "Gjs-CRITICAL **: JS ERROR: ReferenceError: GLibUnix is not defined" >&2; exit 1 ;;
errlog) echo "cetli: start failed: boom" >&2 ;;
jserror) echo "Gjs-CRITICAL **: JS ERROR: TypeError: x is not a function" >&2 ;;
rejection) echo "Gjs-WARNING **: Unhandled promise rejection" >&2 ;;
esac
mkdir -p "$HOME/.local/share/cetli/notes"
[ "$mode" = nonote ] || echo '{}' > "$HOME/.local/share/cetli/notes/one.json"
[ "$mode" = twonotes ] && echo '{}' > "$HOME/.local/share/cetli/notes/two.json"
[ "$mode" = noapp ] || : > "$STUB_STATE/app"
[ "$mode" = nowindow ] || : > "$STUB_STATE/window"
[ "$mode" = selfexit ] && { sleep 0.6; exit 0; }
[ "$mode" = termfail ] && trap 'exit 1' TERM
[ "$mode" = hang ] && trap '' TERM
[ "$mode" = ok ] || [ "$mode" = errlog ] || [ "$mode" = jserror ] || [ "$mode" = rejection ] || [ "$mode" = twonotes ] || [ "$mode" = nonote ] && trap 'exit 0' TERM
while :; do sleep 0.05; done
`);
    stub(path.join(box.bin, 'cetli-sync'), `
echo "cetli-sync $* HOME=$HOME" >> "$STUB_LOG"
printf '%s' "\${STUB_SYNC_OUT-{\\"v\\":1,\\"event\\":\\"result\\",\\"state\\":\\"no-syncthing\\"\\}
}"
echo "sync stderr text" >&2
exit "\${STUB_SYNC_RC:-0}"
`);
    return box.script('probe_start.sh');
}

const withProbe = fn => async t => {
    const box = new Box(TOOLS);
    try {
        await fn(box, probeBox(box), t);
    } finally {
        box.cleanup();
    }
};
const run = (box, probe, env = {}) => box.run(probe, [], {STUB_STATE: box.state, ...ENV, ...env});
const lines = (r, step) => r.out.split('\n').filter(l => l.startsWith(`START-GATE ${step} `));

test('probe_start.sh passes the three steps when the programs behave', withProbe((box, probe) => {
    const r = run(box, probe);
    assert.equal(r.rc, 0, r.all);
    assert.match(lines(r, 'd')[0], /^START-GATE d PASS the first start registered, opened its first note window, the note is on disk, ran 0\.3 s, ended with exit status 0 on SIGTERM$/);
    assert.match(lines(r, 'e')[0], /^START-GATE e PASS the start at login \(--autostart\) opened the note that was left behind, ran 0\.3 s, ended with exit status 0 on SIGTERM$/);
    assert.match(lines(r, 'f')[0], /^START-GATE f PASS cetli-sync status gave its one closing line: \{"v":1,"event":"result"/);
    assert.equal(r.out.split('\n').filter(l => /^START-GATE \w+ FAIL/.test(l)).length, 0);
}));

test('probe_start.sh starts cetli twice, the second time with --autostart, on one private home, on the headless display and its bus', withProbe((box, probe) => {
    const r = run(box, probe);
    assert.equal(r.rc, 0, r.all);
    const cetli = box.calls().filter(c => c.startsWith('cetli '));
    assert.equal(cetli.length, 2, box.calls().join('\n'));
    const env = c => Object.fromEntries([...c.matchAll(/ (\w+)=(\S+)/g)].map(m => [m[1], m[2]]));
    assert.match(cetli[0], /^cetli {2}HOME=/, 'the first start has no argument');
    assert.match(cetli[1], /^cetli --autostart HOME=/);
    const [one, two] = [env(cetli[0]), env(cetli[1])];
    assert.equal(one.HOME, two.HOME, 'the start at login must see the note of the first start');
    assert.ok(one.HOME.startsWith(box.tmp), `HOME ${one.HOME} is not private`);
    assert.notEqual(one.HOME, box.root);
    assert.equal(one.WAYLAND_DISPLAY, 'gate-wl');
    assert.equal(one.GDK_BACKEND, 'wayland');
    assert.match(one.XDG_RUNTIME_DIR, /\/xdg$/);
    assert.match(one.DBUS, /^unix:path=\S+\/session\.sock$/);
}));

test('probe_start.sh runs mutter headless on the session bus it made, with no X11 and a virtual monitor', withProbe((box, probe) => {
    run(box, probe);
    const m = box.calls().find(c => c.startsWith('mutter '));
    assert.ok(m, box.calls().join('\n'));
    assert.match(m, /^mutter --headless --wayland --no-x11 --virtual-monitor 1280x720 --wayland-display=gate-wl DBUS=unix:path=\S+\/session\.sock$/);
}));

test('probe_start.sh makes a session bus that lists no service directory: it starts no program of the installed packages', withProbe((box, probe) => {
    run(box, probe);
    const conf = readFileSync(path.join(box.state, 'bus.conf'), 'utf8');
    assert.match(conf, /<type>session<\/type>/);
    assert.match(conf, /<listen>unix:path=\S+session\.sock<\/listen>/);
    assert.doesNotMatch(conf, /servicedir|standard_session_servicedirs/);
    assert.match(box.calls().find(c => c.startsWith('dbus-daemon ')), /^dbus-daemon --nofork --config-file=\S+bus\.conf$/);
}));

test('probe_start.sh asks the application and its first window for their actions, on the session bus, with a time limit', withProbe((box, probe) => {
    run(box, probe);
    const g = box.calls().filter(c => c.startsWith('gdbus '));
    assert.ok(g.some(c => c === 'gdbus call --session --timeout 5 --dest io.github.trensoft.cetli --object-path /io/github/trensoft/cetli --method org.gtk.Actions.List'), g.join('\n'));
    assert.ok(g.some(c => c === 'gdbus call --session --timeout 5 --dest io.github.trensoft.cetli --object-path /io/github/trensoft/cetli/window/1 --method org.gtk.Actions.List'), g.join('\n'));
}));

test('probe_start.sh: no display fails (d) and (e) with the log of mutter, and (f) still runs', withProbe((box, probe) => {
    const r = run(box, probe, {MUTTER_MODE: 'fail'});
    assert.equal(r.rc, 1, r.all);
    assert.match(r.out, /mutter did not come up:\nmutter boom: no way/);
    assert.match(lines(r, 'd')[0], /^START-GATE d FAIL no display for the program$/);
    assert.match(lines(r, 'e')[0], /^START-GATE e FAIL no display for the program$/);
    assert.match(lines(r, 'f')[0], /^START-GATE f PASS/);
    assert.equal(box.calls().some(c => c.startsWith('cetli ')), false, 'cetli must not be started with no display');
}));

test('probe_start.sh: a program that ends at once (the 1.0.11 kind of failure) fails (d) with its status and its log', withProbe((box, probe) => {
    const r = run(box, probe, {STUB_MODE_D: 'exit1'});
    assert.equal(r.rc, 1, r.all);
    assert.match(lines(r, 'd')[0], /^START-GATE d FAIL cetli did not come up: the program ended with exit status 1$/);
    assert.match(r.out, /JS ERROR: ReferenceError: GLibUnix is not defined/);
    assert.match(lines(r, 'e')[0], /^START-GATE e PASS/);
}));

test('probe_start.sh: a program that never registers fails with the actions it waited for', withProbe((box, probe) => {
    const r = run(box, probe, {STUB_MODE_D: 'noapp', START_GATE_TIMEOUT: '2'});
    assert.equal(r.rc, 1, r.all);
    assert.match(lines(r, 'd')[0], /^START-GATE d FAIL cetli did not come up: the action new-note not on the bus within 2 s$/);
}));

test('probe_start.sh: no note window fails the step, with its own message', withProbe((box, probe) => {
    const r = run(box, probe, {STUB_MODE_D: 'nowindow', START_GATE_TIMEOUT: '2'});
    assert.equal(r.rc, 1, r.all);
    assert.match(lines(r, 'd')[0], /^START-GATE d FAIL cetli has no note window: the action delete of window 1 not on the bus within 2 s$/);
}));

for (const [mode, count] of [['nonote', 0], ['twonotes', 2]]) {
    test(`probe_start.sh: ${count} note files in the notes folder fail the step`, withProbe((box, probe) => {
        const r = run(box, probe, {STUB_MODE_D: mode});
        assert.equal(r.rc, 1, r.all);
        assert.match(lines(r, 'd')[0], new RegExp(`^START-GATE d FAIL expected one note file in the notes folder, found ${count}$`));
    }));
}

test('probe_start.sh: a program that ends by itself before SIGTERM fails the step', withProbe((box, probe) => {
    const r = run(box, probe, {STUB_MODE_D: 'selfexit', START_GATE_SETTLE: '1'});
    assert.equal(r.rc, 1, r.all);
    assert.match(lines(r, 'd')[0], /^START-GATE d FAIL the program ended by itself with exit status 0 within 1 s$/);
}));

test('probe_start.sh: an exit status other than 0 on SIGTERM fails the step', withProbe((box, probe) => {
    const r = run(box, probe, {STUB_MODE_D: 'termfail'});
    assert.equal(r.rc, 1, r.all);
    assert.match(lines(r, 'd')[0], /^START-GATE d FAIL the program ended with exit status 1 on SIGTERM$/);
}));

test('probe_start.sh: a program that does not end on SIGTERM is killed and fails the step', withProbe((box, probe) => {
    const r = run(box, probe, {STUB_MODE_D: 'hang', START_GATE_TIMEOUT: '2'});
    assert.equal(r.rc, 1, r.all);
    assert.match(lines(r, 'd')[0], /^START-GATE d FAIL the program did not end within 2 s of SIGTERM$/);
}));

for (const mode of ['errlog', 'jserror', 'rejection']) {
    test(`probe_start.sh: exit status 0 is not enough when the log has an error of the start (${mode})`, withProbe((box, probe) => {
        const r = run(box, probe, {STUB_MODE_D: mode});
        assert.equal(r.rc, 1, r.all);
        assert.match(lines(r, 'd')[0], /^START-GATE d FAIL the program ended with exit status 0, but its log has an error of the start$/);
    }));
}

test('probe_start.sh: the warnings of a machine with no GPU and the deprecation of the signal call are not failures', withProbe((box, probe) => {
    const r = run(box, probe);
    assert.equal(r.rc, 0, r.all);
    assert.match(r.out, /libEGL warning/, 'the log of the program is shown');
}));

test('probe_start.sh: the start at login fails on its own, and (d) still passes', withProbe((box, probe) => {
    const r = run(box, probe, {STUB_MODE_E: 'nowindow', START_GATE_TIMEOUT: '2'});
    assert.equal(r.rc, 1, r.all);
    assert.match(lines(r, 'd')[0], /^START-GATE d PASS/);
    assert.match(lines(r, 'e')[0], /^START-GATE e FAIL cetli --autostart has no note window/);
}));

test('probe_start.sh: cetli-sync status runs in a home of its own and its standard error is not part of the line', withProbe((box, probe) => {
    const r = run(box, probe);
    const call = box.calls().find(c => c.startsWith('cetli-sync '));
    assert.match(call, /^cetli-sync status HOME=\S+\/home-sync$/);
    assert.doesNotMatch(lines(r, 'f')[0], /stderr text/);
}));

for (const [why, env, expect] of [
    ['exit status 1', {STUB_SYNC_RC: '1'}, /exit status 1/],
    ['an error line', {STUB_SYNC_OUT: '{"v":1,"event":"error","code":"E_INTERNAL"}\n'}, /standard output: \{"v":1,"event":"error"/],
    ['no output', {STUB_SYNC_OUT: ''}, /standard output: , standard error: sync stderr text/],
    ['two lines', {STUB_SYNC_OUT: '{"v":1,"event":"result","state":"a"}\n{"v":1,"event":"result","state":"b"}\n'}, /FAIL cetli-sync status/],
    ['a result of another version', {STUB_SYNC_OUT: '{"v":2,"event":"result"}\n'}, /FAIL cetli-sync status/],
]) {
    test(`probe_start.sh: cetli-sync status with ${why} fails (f), with its output in the line`, withProbe((box, probe) => {
        const r = run(box, probe, env);
        assert.equal(r.rc, 1, r.all);
        assert.match(lines(r, 'f')[0], expect);
        assert.match(lines(r, 'd')[0], /^START-GATE d PASS/);
    }));
}

test('probe_start.sh has a default time limit of 30 s and settles 2 s: the numbers of the gate', () => {
    const text = readFileSync(new URL('../tools/start_gate/probe_start.sh', import.meta.url), 'utf8');
    assert.match(text, /^limit=\$\{START_GATE_TIMEOUT:-30\}/m);
    assert.match(text, /^settle=\$\{START_GATE_SETTLE:-2\}/m);
});
