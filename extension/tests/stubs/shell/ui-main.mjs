// SPDX-License-Identifier: GPL-3.0-or-later
import {world} from '../world.mjs';

export const layoutManager = {
    get monitors() {
        return world.monitors;
    },
    get primaryIndex() {
        return world.primaryIndex;
    },
    getWorkAreaForMonitor: i => world.workAreas[i],
};
