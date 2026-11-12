// SPDX-License-Identifier: GPL-3.0-or-later
// Helpers of the tests that run the scripts of the start gate (tools/start_gate/). The scripts are made for a container: they read /gate,
// /src and /out and call dnf, rpm, rpmbuild, make, gjs, gdbus, mutter and cetli. Here a script is copied with those paths pointed into a
// temporary directory and run with a PATH that holds only stand-ins and a few real tools, so what is measured is what the script does with
// the answers of the commands: which commands it calls, with which arguments, and which exit status and which lines it ends with.
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {spawn, spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const GATE = path.join(REPO, 'tools', 'start_gate');
export const NEVRA = 'cetli-1.2.3-1.fc43.noarch';
const BASH = spawnSync('sh', ['-c', 'command -v bash'], {encoding: 'utf8'}).stdout.trim();
// the real tools the scripts call besides the stand-ins
export const REAL_TOOLS = ['basename', 'chmod', 'cp', 'cut', 'dirname', 'ls', 'mkdir', 'mktemp', 'rm', 'sha256sum', 'grep', 'touch', 'bash'];

const which = name => spawnSync('sh', ['-c', `command -v ${name}`], {encoding: 'utf8'}).stdout.trim();

// `/gate`, `/src` and `/out` (a whole path word) moved
export function pointPaths(text, mapping) {
    let out = text;
    for (const [from, to] of Object.entries(mapping))
        out = out.replace(new RegExp(`(?<![\\w./-])${from}(?=[/\\s"'])`, 'g'), to);
    return out;
}

export function stub(file, body) {
    rmSync(file, {force: true});                     // a symlink to a real tool must not be written through
    writeFileSync(file, `#!/bin/bash\n${body}`);
    chmodSync(file, 0o755);
    return file;
}

export class Box {
    constructor(tools = REAL_TOOLS) {
        this.root = mkdtempSync(path.join(tmpdir(), 'sg-'));
        for (const d of ['gate', 'src', 'out', 'bin', 'tmp'])
            mkdirSync(path.join(this.root, d));
        this.gate = path.join(this.root, 'gate');
        this.src = path.join(this.root, 'src');
        this.out = path.join(this.root, 'out');
        this.bin = path.join(this.root, 'bin');
        this.tmp = path.join(this.root, 'tmp');
        this.log = path.join(this.root, 'calls.log');
        writeFileSync(this.log, '');
        for (const t of new Set(tools))
            symlinkSync(which(t), path.join(this.bin, t));
        // the shared file of the scripts: no repositories, a dnf that logs and can be made to fail
        writeFileSync(path.join(this.gate, 'common.sh'),
            'gate_repos() { echo "gate_repos" >> "$STUB_LOG"; }\n' +
            'gate_dnf() { echo "dnf $*" >> "$STUB_LOG"; [ "${STUB_DNF_RC:-0}" -eq 0 ]; }\n');
    }

    // tools/start_gate/<name> copied here with the container paths pointed into the box
    script(name) {
        const target = path.join(this.gate, name);
        writeFileSync(target, pointPaths(readFileSync(path.join(GATE, name), 'utf8'), {'/gate': this.gate, '/src': this.src, '/out': this.out}));
        chmodSync(target, 0o755);
        return target;
    }

    run(script, args = [], env = {}) {
        const r = spawnSync(BASH, [script, ...args], {
            env: {PATH: this.bin, HOME: this.root, TMPDIR: this.tmp, STUB_LOG: this.log, ...env},
            encoding: 'utf8', timeout: 60000,
        });
        return {rc: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr};
    }

    // the same without blocking this process: a script that talks to a server of this process needs it
    runAsync(script, args = [], env = {}) {
        return new Promise(resolve => {
            const child = spawn(BASH, [script, ...args], {env: {PATH: this.bin, HOME: this.root, TMPDIR: this.tmp, STUB_LOG: this.log, ...env}});
            let out = '';
            let err = '';
            child.stdout.on('data', d => { out += d; });
            child.stderr.on('data', d => { err += d; });
            child.on('close', rc => resolve({rc, out, err, all: out + err}));
        });
    }

    calls() {
        return readFileSync(this.log, 'utf8').split('\n').filter(Boolean);
    }

    cleanup() {
        rmSync(this.root, {recursive: true, force: true});
    }
}

// a node script as a stand-in that makes a Unix socket (a bash script cannot): `node:net` listens on the path of its argument
export function socketStub(file, body) {
    rmSync(file, {force: true});
    writeFileSync(file, `#!${process.execPath}\nconst net = require('node:net');\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
}
