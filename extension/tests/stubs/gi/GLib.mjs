// SPDX-License-Identifier: GPL-3.0-or-later
import fs from 'node:fs';
import path from 'node:path';
import {world} from '../world.mjs';

class Bytes {
    constructor(data) {
        this.data = data;
    }

    get_size() {
        return this.data.length;
    }

    toArray() {
        return this.data;
    }
}

export default {
    PRIORITY_DEFAULT: 0,
    SOURCE_REMOVE: false,
    Bytes,
    get_user_state_dir: () => world.stateHome,
    build_filenamev: parts => path.join(...parts),
    mkdir_with_parents(dir, mode) {
        fs.mkdirSync(dir, {recursive: true, mode});
        return 0;
    },
    timeout_add(_priority, ms, fn) {
        const id = world.nextTimer++;
        world.timers.set(id, {at: world.now + ms, fn});
        return id;
    },
    source_remove: id => world.timers.delete(id),
};
