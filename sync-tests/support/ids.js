// SPDX-License-Identifier: GPL-3.0-or-later
// Valid, distinct, deterministic device IDs for the tests of the group (up to 10 computers): `makeId(n)` is a canonical ID whose Luhn
// check characters hold. The four named IDs of world.js stay the ones of the one-peer tests.
import {ID_ALPHABET, groupId, isCanonicalId, luhn32} from '../../sync/ids.js';

export function makeId(n) {
    let seed = (n + 1) * 2654435761 % 2 ** 32;
    let compact = '';
    for (let block = 0; block < 4; block++) {
        let data = '';
        for (let i = 0; i < 13; i++) {
            seed = (seed * 1103515245 + 12345) % 2 ** 31;
            data += ID_ALPHABET[(seed >> 8) % 32];
        }
        compact += data + luhn32(data);
    }
    const id = groupId(compact);
    if (!isCanonicalId(id))
        throw new Error('makeId produced a bad ID');
    return id;
}
