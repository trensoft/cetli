// SPDX-License-Identifier: GPL-3.0-or-later
// `cetli-sync <verb> [--all] [--stop] [--enable] [<ID>...]`: the engine of the sync window. One JSON object per line on stdout (sync/protocol.js), exactly one terminal line,
// exit code 0 after a `result`, 1 after an `error`, 2 for a usage error. The code is never an argument: `join` reads the ID of the other computer
// from stdin (one line), `host` reads `accept <ID>` lines from stdin and stops at once on EOF. The IDs of `forget`, `revoke`, `promote` and `ack` are
// canonical positional arguments (sync/protocol.js parseArgs). Launcher: `gjs -m <datadir>/cetli/sync/main.js "$@"`.
import System from 'system';

import {defaultDirs} from '../src/gio-layer.js';
import {createEngine} from './engine.js';
import * as real from './gio-ports.js';
import {dedicatedHome} from './paths.js';
import {emit, parseArgs} from './protocol.js';
import {createRunPort} from './runport.js';
import GLib from 'gi://GLib';

const out = line => print(line);

function usage() {
    printerr('usage: cetli-sync status|setup|own-id|host|join|finish|harden|reset | restart [--enable] | ensure | forget <ID>|--all [--stop] | revoke|promote <ID>... | ack <ID>...|--all');
    System.exit(2);
}

async function main(args) {
    let parsed;
    try {
        parsed = parseArgs(args);
    } catch {
        usage();
    }
    const {verb, flags, ids} = parsed;
    const homeDir = GLib.get_home_dir();
    const home = dedicatedHome(homeDir);
    const input = verb === 'host' || verb === 'join' ? real.openInput() : {lines: () => [], eof: () => true};
    const emitEvent = event => {
        try {
            out(emit(event, verb));
            return true;
        } catch {
            real.log('an event did not fit the contract');
            return false;
        }
    };
    const engine = createEngine({
        run: createRunPort({spawn: real.spawn, hostEnv: real.hostEnvironment(), home}),
        files: real.files,
        dirs: {homeDir, notes: defaultDirs().notes, home},
        now: real.now, monotonic: real.monotonic, sleep: real.sleep,
        input, emit: emitEvent, log: real.log,
    });
    const arg = verb === 'join' ? await input.firstLine() : verb === 'restart' ? {enable: flags.enable === true} : ['forget', 'revoke', 'promote', 'ack'].includes(verb) ? {all: flags.all === true, stop: flags.stop === true, ids} : undefined;
    const outcome = await engine.perform(verb, arg);
    if (outcome.result) {
        if (emitEvent(outcome.result))
            return 0;
        emitEvent({event: 'error', code: 'E_INTERNAL'});                     // never end without a terminal line: the bridge would read E_ENGINE_DIED
        return 1;
    }
    if (!emitEvent({event: 'error', code: outcome.error.code, ...(outcome.error.step ? {step: outcome.error.step} : {})}))
        emitEvent({event: 'error', code: 'E_INTERNAL'});
    return 1;
}

const loop = GLib.MainLoop.new(null, false);
let rc = 1;
main(ARGV).then(code => { rc = code; }, () => { real.log('internal error'); rc = 1; }).finally(() => loop.quit());
loop.run();
System.exit(rc);
