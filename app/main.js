// SPDX-License-Identifier: GPL-3.0-or-later
// Entry point: `gjs -m /usr/share/cetli/app/main.js` (the launcher /usr/bin/cetli). Everything else is in application.js.
import System from 'system';

import {createApp} from './application.js';

const app = createApp();
System.exit(app.run([System.programInvocationName, ...ARGV]));
