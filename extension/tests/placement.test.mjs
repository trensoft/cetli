// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {chooseArea, clampRect, idFromTitle, monitorKey, roundRect, sameRect} from '../cetli@trensoft.local/placement.js';

const ID = '00000000-0000-4000-8000-000000000001';
const A1 = {key: '1920x1080+0+0', x: 0, y: 32, w: 1920, h: 1048};
const A2 = {key: '1280x1024+1920+0', x: 1920, y: 0, w: 1280, h: 1024};

test('idFromTitle takes exactly cetli-<uuid>', () => {
    assert.equal(idFromTitle(`cetli-${ID}`), ID);
    assert.equal(idFromTitle('cetli-abcdef01-0000-4000-8000-00000000000a'), 'abcdef01-0000-4000-8000-00000000000a');
    for (const bad of ['cetli', `cetli-${ID}\n`, ` cetli-${ID}`, `cetli-${ID} `, `Cetli-${ID}`, 'cetli-ABCDEF01-0000-4000-8000-00000000000A',
        `cetli-${ID}.json`, 'cetli-not-a-uuid', ID, '', null, undefined, 42, `xcetli-${ID}`])
        assert.equal(idFromTitle(bad), null, JSON.stringify(bad));
});

test('monitorKey and roundRect', () => {
    assert.equal(monitorKey({x: 1920, y: 0, width: 1280, height: 1024}), '1280x1024+1920+0');
    assert.deepEqual(roundRect({x: 1.4, y: 2.6, w: 10.5, h: 9.49}), {x: 1, y: 3, w: 11, h: 9});
});

test('sameRect honours the tolerance and null', () => {
    const r = {x: 10, y: 10, w: 100, h: 100};
    assert.ok(sameRect(r, {...r, x: 12}, 2));
    assert.ok(!sameRect(r, {...r, x: 13}, 2));
    assert.ok(!sameRect(r, {...r, h: 98.9}, 1));
    assert.ok(!sameRect(r, null));
    assert.ok(!sameRect(null, r));
});

test('chooseArea: named monitor first, then the largest overlap, then the primary one', () => {
    const areas = [A1, A2];
    assert.equal(chooseArea({x: 0, y: 100, w: 50, h: 50, monitor: A2.key}, areas, 0), A2, 'the named monitor wins');
    assert.equal(chooseArea({x: 0, y: 100, w: 50, h: 50, monitor: 'gone'}, areas, 0), A1, 'unknown name: overlap');
    assert.equal(chooseArea({x: 1800, y: 100, w: 300, h: 50}, areas, 0), A2, 'larger part on the second monitor');
    assert.equal(chooseArea({x: 9000, y: 9000, w: 50, h: 50, monitor: {a: 'b'}}, areas, 1), A2, 'nowhere: primary');
    assert.equal(chooseArea({x: 9000, y: 9000, w: 50, h: 50}, areas, 7), A1, 'bad primary index: the first one');
    assert.equal(chooseArea({x: 0, y: 0, w: 5, h: 5}, [], 0), null);
});

test('clampRect keeps a rectangle in the work area (D3)', () => {
    assert.deepEqual(clampRect({x: 300, y: 200, w: 400, h: 260}, A1), {x: 300, y: 200, w: 400, h: 260}, 'inside: unchanged');
    assert.deepEqual(clampRect({x: 4000, y: 100, w: 300, h: 200}, A1), {x: 1620, y: 100, w: 300, h: 200}, 'right of it');
    assert.deepEqual(clampRect({x: -500, y: -500, w: 300, h: 200}, A1), {x: 0, y: 32, w: 300, h: 200}, 'left/above, under the panel');
    assert.deepEqual(clampRect({x: 1800, y: 1000, w: 300, h: 200}, A1), {x: 1620, y: 880, w: 300, h: 200}, 'sticks out at the corner');
    assert.deepEqual(clampRect({x: 10, y: 10, w: 5000, h: 4000}, A1), {x: 0, y: 32, w: 1920, h: 1048}, 'too big: as big as the area');
    assert.deepEqual(clampRect({x: 2000.4, y: 5.5, w: 100.2, h: 100.7}, A2), {x: 2000, y: 6, w: 100, h: 101}, 'rounded');
});
