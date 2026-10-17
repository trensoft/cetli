// SPDX-License-Identifier: GPL-3.0-or-later
export class Extension {
    constructor(metadata) {
        this.metadata = metadata;
    }

    get path() {
        return this.metadata.path;
    }
}
