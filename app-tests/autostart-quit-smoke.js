// SPDX-License-Identifier: GPL-3.0-or-later
// 0.2.8: the program is stopped (gtkApp.quit()) with two notes open and one closed: the `open` marks of layout.json are
// unchanged by the stop (only the user closing a window writes false, and that still does), so the notes come back at the next login.
import {stopTest} from './autostart-support.js';
import {runStartGate} from './start-gate-support.js';

const t = stopTest('quit');
runStartGate({marker: true, seed: t.seed, ownExit: true, atShutdown: t.atShutdown}, t.run);
