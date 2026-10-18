// SPDX-License-Identifier: GPL-3.0-or-later
// gjs test (no display) of the REAL ports: the process start of the engine (sync/gio-ports.js), the bridge's process layer (app/sync-bridge.js),
// the file port, and a real `main.js` run with piped stdin. No Syncthing is involved: where a program is needed, `env`, `cat`, `yes` and gjs itself
// stand in. Run: . $CETLI_GTKENV/gjsenv.sh; gjs -m sync-tests/gio-ports-smoke.js
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {startProcess} from '../app/sync-bridge.js';
import {scrubEnviron} from '../app/sync-runner.js';
import * as real from '../sync/gio-ports.js';

let failed = 0;
let checks = 0;
const check = (cond, label) => {
    checks++;
    if (cond) {
        print(`ok   ${label}`);
    } else {
        failed++;
        print(`FAIL ${label}`);
    }
};
const here = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_path();
const which = n => GLib.find_program_in_path(n);
const base = GLib.dir_make_tmp('cetli-ports-XXXXXX');

async function scenario() {
    // ---- spawn: environment, stdin, exit status, output cap, timeout
    let r = await real.spawn([which('env')], {PATH: '/usr/bin', HOME: '/h', XDG_X: '1'}, {maxBytes: 65536, timeoutMs: 10000});
    check(r.rc === 0 && r.out.split('\n').filter(Boolean).sort().join() === 'HOME=/h,PATH=/usr/bin,XDG_X=1', 'spawn gives the child exactly the environment it was handed');
    r = await real.spawn([which('cat')], {PATH: '/usr/bin'}, {stdin: 'héllo\n', maxBytes: 65536, timeoutMs: 10000});
    check(r.rc === 0 && r.out === 'héllo\n', 'stdin is written, then closed (UTF-8)');
    r = await real.spawn([which('cat')], {PATH: '/usr/bin'}, {maxBytes: 65536, timeoutMs: 10000});
    check(r.rc === 0 && r.out === '', 'without stdin the child sees EOF at once (the engine\'s own stdin is never inherited)');
    r = await real.spawn(['/bin/sh', '-c', 'exit 7'], {PATH: '/usr/bin'}, {maxBytes: 100, timeoutMs: 10000});
    check(r.rc === 7, 'the exit status comes back');
    r = await real.spawn([which('yes')], {PATH: '/usr/bin'}, {maxBytes: 200000, timeoutMs: 10000});
    check(r.tooLarge === true && r.out === '', 'output over the cap: the child is stopped, tooLarge, no partial text');
    const t0 = GLib.get_monotonic_time();
    r = await real.spawn([which('sleep'), '30'], {PATH: '/usr/bin'}, {maxBytes: 100, timeoutMs: 400});
    check(r.rc === -1 && (GLib.get_monotonic_time() - t0) / 1000 < 5000, 'a child that does not end is killed at the timeout');
    r = await real.spawn(['/no/such/program'], {}, {maxBytes: 100, timeoutMs: 1000});
    check(r.rc === -1, 'a program that cannot be started is rc -1, not an exception');

    // ---- the file port
    const f = real.files;
    const dir = `${base}/a/b`;
    f.mkdirp(dir, 0o700);
    check(f.isDir(dir) && f.modeOf(dir) === 0o700, 'mkdirp makes a 0700 directory');
    f.writeText(`${dir}/x.xml`, 'héllo', 0o600);
    check(f.readText(`${dir}/x.xml`) === 'héllo' && f.modeOf(`${dir}/x.xml`) === 0o600, 'writeText: UTF-8, mode 0600');
    f.writeText(`${dir}/x.xml`, 'second', 0o600);
    check(f.readText(`${dir}/x.xml`) === 'second' && f.listNames(dir).join() === 'x.xml', 'a rewrite replaces the file and leaves no temporary file behind');
    check(f.exists(`${dir}/x.xml`) && !f.exists(`${dir}/nope`), 'exists');
    GLib.file_set_contents(`${base}/target`, 'x');
    Gio.File.new_for_path(`${base}/link`).make_symbolic_link(`${base}/target`, null);
    check(f.isSymlink(`${base}/link`) && !f.isSymlink(`${base}/target`) && !f.isSymlink(`${base}/none`), 'isSymlink does not follow the link');
    check(f.modeOf(`${base}/none`) === null, 'modeOf of a missing path is null');
    // `reset` only: rename within one directory, one file, one EMPTY directory
    f.mkdirp(`${base}/inst/sub`, 0o700);
    f.writeText(`${base}/inst/sub/key`, 'k', 0o600);
    f.rename(`${base}/inst`, `${base}/inst.bak`);
    check(!f.exists(`${base}/inst`) && f.readText(`${base}/inst.bak/sub/key`) === 'k' && f.modeOf(`${base}/inst.bak`) === 0o700, 'rename moves the whole directory with its content and its mode');
    f.mkdirp(`${base}/occupied`, 0o700);
    f.mkdirp(`${base}/mover`, 0o700);
    let threw = false;
    try { f.rename(`${base}/mover`, `${base}/occupied`); } catch { threw = true; }
    check(threw && f.exists(`${base}/mover`), 'a rename onto a path that exists is refused and moves nothing');
    threw = false;
    try { f.rename(`${base}/nowhere`, `${base}/nowhere2`); } catch { threw = true; }
    check(threw, 'a rename of a missing path throws');
    f.mkdirp(`${base}/m/.stfolder`, 0o755);
    GLib.file_set_contents(`${base}/m/.stfolder/hint.txt`, 'h');
    threw = false;
    try { f.removeDir(`${base}/m/.stfolder`); } catch { threw = true; }
    check(threw && f.exists(`${base}/m/.stfolder/hint.txt`), 'removeDir refuses a directory with something in it');
    f.removeFile(`${base}/m/.stfolder/hint.txt`);
    f.removeDir(`${base}/m/.stfolder`);
    check(!f.exists(`${base}/m/.stfolder`) && f.exists(`${base}/m`), 'removeFile and removeDir take exactly the file and the empty directory');
    Gio.File.new_for_path(`${base}/m/lnk`).make_symbolic_link(`${base}/target`, null);
    f.removeFile(`${base}/m/lnk`);
    check(!f.isSymlink(`${base}/m/lnk`) && f.exists(`${base}/target`), 'removing a link removes the link and not what it points to');

    // ---- the bridge's process layer with a real child: lines in order, the exit after the last line, the caps, bad UTF-8, stdin, kill
    const env = ['PATH=/usr/bin:/bin'];
    const collect = (argv, drive = () => {}) => new Promise(resolve => {
        const p = startProcess(argv, {env});
        const got = {lines: [], overflow: 0, rc: null};
        p.onLine(l => got.lines.push(l));
        p.onOverflow(() => { got.overflow++; p.kill(); resolve(got); });
        p.onExit(rc => { got.rc = rc; resolve(got); });
        drive(p, got, resolve);
    });
    let c = await collect(['/bin/sh', '-c', 'echo one; echo two; exit 3']);
    check(c.lines.join() === 'one,two' && c.rc === 3 && c.overflow === 0, 'startProcess: lines in order, then the exit status');
    c = await collect(['/bin/sh', '-c', 'i=0; while [ $i -lt 300 ]; do echo line$i; i=$((i+1)); done']);
    check(c.lines.length === 300 && c.lines[299] === 'line299' && c.rc === 0, 'a burst of lines is all delivered before the exit');
    c = await collect(['/bin/sh', '-c', "head -c 5000 /dev/zero | tr '\\0' x; echo; echo after"]);
    check(c.overflow === 1 && !c.lines.some(l => l.length > 4096), 'a line over 4 KiB is an overflow and is never delivered');
    c = await collect(['/bin/sh', '-c', 'yes abcdefghij | head -c 100000']);
    check(c.overflow === 1 && c.lines.length * 11 <= 65536 + 4096, `more than 64 KiB in total is an overflow (${c.lines.length} lines delivered)`);
    c = await collect(['/bin/sh', '-c', "printf 'ok\\n\\377\\n'"]);
    check(c.lines[0] === 'ok' && c.overflow === 1, 'bytes that are not UTF-8 are a violation');
    c = await collect([which('cat')], p => { p.write('abc\n'); p.write('def\n'); p.closeStdin(); p.closeStdin(); });
    check(c.lines.join() === 'abc,def' && c.rc === 0, 'stdin: written, closed (a second close is harmless); the child sees EOF');
    c = await collect([which('sleep'), '30'], p => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => { p.kill(); return GLib.SOURCE_REMOVE; }));
    check(c.rc !== null && c.rc < 0, `kill: the exit is reported as a signal (${c.rc})`);
    c = await collect(['/bin/sh', '-c', 'printf "no newline at the end"']);
    check(c.lines.join() === 'no newline at the end', 'a last line without a newline is delivered at EOF');
    check(scrubEnviron(['STGUIAPIKEY=k', 'PATH=/usr/bin']).join() === 'PATH=/usr/bin', 'the bridge scrubs the environment too');

    // ---- a real main.js run: usage error, no sync program on this machine, stdin plumbing for join and host
    const gjs = which('gjs');
    const run = (args, stdin) => real.spawn([gjs, '-m', `${here}/sync/main.js`, ...args], {PATH: GLib.getenv('PATH'), HOME: GLib.get_home_dir(), LD_LIBRARY_PATH: GLib.getenv('LD_LIBRARY_PATH') ?? '', GI_TYPELIB_PATH: GLib.getenv('GI_TYPELIB_PATH') ?? '', XDG_RUNTIME_DIR: GLib.getenv('XDG_RUNTIME_DIR') ?? ''}, {stdin, maxBytes: 65536, timeoutMs: 30000});
    r = await run(['status']);
    const line = r.out.trim().split('\n').filter(l => l.startsWith('{'));
    check(r.rc === 0 && line.length === 1 && JSON.parse(line[0]).state === 'no-syncthing' && JSON.parse(line[0]).v === 1, 'main.js status: one result line, rc 0');
    r = await run(['frob']);
    check(r.rc === 2, 'main.js: an unknown verb is a usage error, rc 2');
    r = await run(['reset', '--stop']);
    check(r.rc === 2, 'main.js: reset takes no flag (and a usage error starts nothing)');
    r = await run(['restart', '--stop']);
    check(r.rc === 2, 'main.js: restart takes no flag');
    r = await run(['join'], 'not an id\n');
    const jl = r.out.trim().split('\n').filter(l => l.startsWith('{'));
    check(r.rc === 1 && jl.length === 1 && JSON.parse(jl[0]).event === 'error', 'main.js join with a line on stdin: one error line, rc 1');
    r = await run(['host'], '');
    const hl = r.out.trim().split('\n').filter(l => l.startsWith('{'));
    check(r.rc === 1 && hl.length === 1 && JSON.parse(hl[0]).event === 'error', 'main.js host with EOF on stdin ends at once with an error line');
}

scenario().then(() => {}, e => { failed++; print(`FAIL exception ${e}\n${e.stack}`); }).finally(() => {
    print(`${checks - failed}/${checks} checks passed`);
    print(failed === 0 ? 'RESULT PASS' : 'RESULT FAIL');
    GLib.spawn_command_line_async(`rm -rf ${base}`);
    loop.quit();
});
const loop = GLib.MainLoop.new(null, false);
loop.run();
imports.system.exit(failed === 0 ? 0 : 1);
