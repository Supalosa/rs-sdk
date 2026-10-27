import { describe, expect, spyOn, test } from 'bun:test';
import LocType from '#/config/LocType.js';
import CollisionMap from '#/dash3d/CollisionMap.js';
import { LocLayer } from '#/dash3d/LocLayer.js';
import { SceneLite } from './SceneLite.js';
import { buildCollision } from './CollisionBuilder.js';
import type { LocIndex } from './LocIndex.js';

const WX = 3047, WZ = 3205, BASE_X = WX - 20, BASE_Z = WZ - 20;
const pack = (id: number, shape = 10, angle = 0) => (id << 7) | (shape << 2) | angle;
const fakeIndex = {
    mapFlags: (level: number, x: number, z: number) => level === 1 && x === WX && z === WZ ? 2 : 0,
    lookup: (layer: LocLayer, level: number, x: number, z: number) => {
        if (layer !== LocLayer.GROUND || x !== WX || z !== WZ) return 0;
        return [pack(999), pack(2593), pack(2594), pack(2595)][level] ?? 0;
    },
} as unknown as LocIndex;
const id = (typecode: number) => (typecode >>> 14) & 0x7fff;

describe('lite scene bridge placement', () => {
    test('matches pushDown on static tiles and applies dynamic changes on the effective level', () => {
        const scene = new SceneLite(fakeIndex);
        scene.setBase(BASE_X, BASE_Z);
        expect(id(scene.sceneType(0, 20, 20))).toBe(2593);
        expect(id(scene.sceneType(1, 20, 20))).toBe(2594);
        expect(id(scene.sceneType(2, 20, 20))).toBe(2595);
        expect(scene.sceneType(3, 20, 20)).toBe(0);
        expect(scene.staticLocIdAt(LocLayer.GROUND, 0, WX, WZ)).toBe(2593);
        scene.delLoc(0, WX, WZ, 10);
        expect(scene.sceneType(0, 20, 20)).toBe(0);
        scene.addLoc(0, WX, WZ, 3000, 10, 0);
        expect(id(scene.sceneType(0, 20, 20))).toBe(3000);
        expect(id(scene.sceneType(1, 20, 20))).toBe(2594);
        scene.clearZoneOverlay(0, WX, WZ);
        expect(id(scene.sceneType(0, 20, 20))).toBe(2593);
    });

    test('collision applies bridge overlays to the same effective level as the scene', () => {
        const mock = spyOn(LocType, 'list').mockImplementation(() => {
            const loc = new LocType();
            loc.active = true;
            return loc;
        });
        try {
            const scene = new SceneLite(fakeIndex);
            scene.setBase(BASE_X, BASE_Z);
            const maps: (CollisionMap | null)[] = [null, null, null, null];
            buildCollision(fakeIndex, BASE_X, BASE_Z, maps, scene.overlayEntries);
            const before = maps[0]!.flags[CollisionMap.index(20, 20)];
            scene.delLoc(0, WX, WZ, 10);
            buildCollision(fakeIndex, BASE_X, BASE_Z, maps, scene.overlayEntries);
            expect(maps[0]!.flags[CollisionMap.index(20, 20)]).not.toBe(before);
            scene.addLoc(0, WX, WZ, 3000, 10, 0);
            buildCollision(fakeIndex, BASE_X, BASE_Z, maps, scene.overlayEntries);
            expect(maps[0]!.flags[CollisionMap.index(20, 20)]).toBe(before);
            const topBefore = maps[3]!.flags[CollisionMap.index(20, 20)];
            scene.addLoc(3, WX, WZ, 3000, 10, 0);
            buildCollision(fakeIndex, BASE_X, BASE_Z, maps, scene.overlayEntries);
            expect(maps[3]!.flags[CollisionMap.index(20, 20)]).not.toBe(topBefore);
        } finally {
            mock.mockRestore();
        }
    });
});
