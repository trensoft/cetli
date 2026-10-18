// SPDX-License-Identifier: GPL-3.0-or-later
// `cetli-sync <verb> [--stop]`: the engine of the sync window. One JSON object per line on stdout (sync/protocol.js), exactly one terminal line,
// exit code 0 after a `result`, 1 after an `error`, 2 for a usage error. The code is never an argument: `join` reads the ID of the other computer
// from stdin (one line), `host` reads `accept <ID>` lines from stdin and stops at once on EOF. Launcher: `gjs -m <datadir>/cetli/sync/main.js "$@"`.
import System from 'system';

import {defaultDirs} from '../src/gio-layer.js';
import {createEngine} from './engine.js';
import * as real from './gio-ports.js';
import {dedicatedHome} from './paths.js';
import {argvFor, emit} from './protocol.js';
import {createRunPort} from './runport.js';
import GLib from 'gi://GLib';

// How `stable` is decided (PLAN-WIZARD 0G.2). 'evidence' fails closed: with no measured `cli` signal for "the other computer has our folder", host
// and join cannot finish. 'samples' is option (a) of 0G.2 (Attila via Jenna 8447): ten unbroken connected samples, and the window must say
// "Connected", never "Synced". Flip this one word only when Robert's Interface text and Peter say so.
const LINK_RULE = 'evidence';

const out = line => print(line);

function usage() {
    printerr('usage: cetli-sync status|setup|own-id|host|join|forget [--stop]');
    System.exit(2);
}

async function main(args) {
    const verb = args[0];
    const flags = {};
    for (const a of args.slice(1)) {
        if (a === '--stop')
            flags.stop = true;
        else
            usage();
    }
    try {
        argvFor(verb, flags);
    } catch {
        usage();
    }
    const homeDir = GLib.get_home_dir();
    const home = dedicatedHome(homeDir);
    const input = verb === 'host' || verb === 'join' ? real.openInput() : {lines: () => [], eof: () => true};
    const emitEvent = event => {
        try {
            out(emit(event, verb));
        } catch {
            real.log('an event did not fit the contract');
        }
    };
    const engine = createEngine({
        run: createRunPort({spawn: real.spawn, hostEnv: real.hostEnvironment(), home}),
        files: real.files,
        dirs: {homeDir, notes: defaultDirs().notes, home},
        now: real.now, monotonic: real.monotonic, sleep: real.sleep,
        // The positive "the other computer has our folder" signal: there is NO measured way to read it with `syncthing cli` yet (John, M-W6b). Until
        // there is one, the engine can never say `stable`, so host and join end in E_PEER_TIMEOUT instead of claiming a connection.
        evidence: async () => null,
        linkRule: LINK_RULE,
        input, emit: emitEvent, log: real.log,
    });
    const arg = verb === 'forget' ? flags : verb === 'join' ? await input.firstLine() : undefined;
    const outcome = await engine.perform(verb, arg);
    if (outcome.result) {
        emitEvent(outcome.result);
        return 0;
    }
    emitEvent({event: 'error', code: outcome.error.code, ...(outcome.error.step ? {step: outcome.error.step} : {})});
    return 1;
}

const loop = GLib.MainLoop.new(null, false);
let rc = 1;
main(ARGV).then(code => { rc = code; }, () => { real.log('internal error'); rc = 1; }).finally(() => loop.quit());
loop.run();
System.exit(rc);
