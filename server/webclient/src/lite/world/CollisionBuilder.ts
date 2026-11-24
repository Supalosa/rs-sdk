// Rebuild the build-area CollisionMaps from the static index.
//
// This is the collision half of ClientBuild - the part that matters for routing -
// with all the model construction stripped out. It calls the SAME CollisionMap
// class the browser client uses, so testWall/testWDecor/testLoc reach rules and
// the tryMove BFS behave identically.
//
// Called once per REBUILD_NORMAL. 104x104x4 tiles over ~5 mapsquares is a few
// milliseconds, versus the browser client's full scene rebuild.

import LocType from '#/config/LocType.js';
import CollisionMap, { BuildArea } from '#/dash3d/CollisionMap.js';
import { LocLayer } from '#/dash3d/LocLayer.js';
import { LocShape } from '#/dash3d/LocShape.js';
import { MapFlag } from '#/dash3d/MapFlag.js';

import { LocIndex, valueAngle, valueLocId, valueShape } from './LocIndex.js';

export function buildCollision(index: LocIndex, baseX: number, baseZ: number, maps: (CollisionMap | null)[], overlay?: ReadonlyMap<number, number>): void {
    for (let level = 0; level < BuildArea.LEVELS; level++) {
        if (!maps[level]) {
            maps[level] = new CollisionMap();
        }
        maps[level]!.reset();
    }

    // Terrain first (ClientBuild.finishBuild), so loc flags layer on top.
    for (let level = 0; level < BuildArea.LEVELS; level++) {
        for (let x = 0; x < BuildArea.SIZE; x++) {
            for (let z = 0; z < BuildArea.SIZE; z++) {
                const flags = index.mapFlags(level, baseX + x, baseZ + z);
                if ((flags & MapFlag.Block) === 0) {
                    continue;
                }

                let trueLevel = level;
                if ((index.mapFlags(1, baseX + x, baseZ + z) & MapFlag.LinkBelow) !== 0) {
                    trueLevel--;
                }
                if (trueLevel >= 0) {
                    maps[trueLevel]?.blockGround(x, z);
                }
            }
        }
    }

    // Note the 1..SIZE-2 bounds: ClientBuild.loadLocations clips locs on the
    // outer ring of the build area (`stx > 0 && stx < SIZE - 1`), and
    // CollisionMap.reset already marks that ring _BOUNDS. Matching the clip
    // keeps this byte-identical to the browser's map.
    for (let level = 0; level < BuildArea.LEVELS; level++) {
        for (let x = 1; x < BuildArea.SIZE - 1; x++) {
            for (let z = 1; z < BuildArea.SIZE - 1; z++) {
                const worldX = baseX + x;
                const worldZ = baseZ + z;
                const bridged = (index.mapFlags(1, worldX, worldZ) & MapFlag.LinkBelow) !== 0;
                const trueLevel = bridged ? level - 1 : level;
                if (trueLevel < 0) continue;

                for (const layer of [LocLayer.WALL, LocLayer.WALL_DECOR, LocLayer.GROUND, LocLayer.GROUND_DECOR]) {
                    // Zone changes are indexed by the effective player level;
                    // static map locations retain their raw file level.
                    const value = readLoc(index, overlay, layer, level, trueLevel, worldX, worldZ);
                    if (!value) {
                        continue;
                    }

                    const map = maps[trueLevel];
                    if (map) {
                        applyLoc(map, x, z, valueLocId(value), valueShape(value), valueAngle(value));
                    }
                }
            }
        }
    }
    // A bridge pushes raw levels 1..3 to effective levels 0..2, leaving no
    // static counterpart for a server-added loc on effective level 3.
    if (overlay) for (const [key, value] of overlay) {
        const level = Math.floor(key / 0x10000000) & 3;
        const worldX = Math.floor(key / 0x4000) & 0x3fff;
        const worldZ = key & 0x3fff;
        const x = worldX - baseX, z = worldZ - baseZ;
        if (level === 3 && value > 0 && x > 0 && x < BuildArea.SIZE - 1 && z > 0 && z < BuildArea.SIZE - 1 &&
            (index.mapFlags(1, worldX, worldZ) & MapFlag.LinkBelow) !== 0) {
            applyLoc(maps[3]!, x, z, valueLocId(value), valueShape(value), valueAngle(value));
        }
    }
}

function readLoc(index: LocIndex, overlay: ReadonlyMap<number, number> | undefined, layer: LocLayer, level: number, effectiveLevel: number, worldX: number, worldZ: number): number {
    if (overlay) {
        const key = ((layer & 0x3) * 0x40000000) + ((effectiveLevel & 0x3) * 0x10000000) + ((worldX & 0x3fff) * 0x4000) + (worldZ & 0x3fff);
        const override = overlay.get(key);
        if (override !== undefined) {
            return override === -1 ? 0 : override;
        }
    }
    return index.lookup(layer, level, worldX, worldZ);
}

/** The collision calls ClientBuild.addLoc makes, keyed the same way by shape. */
function applyLoc(map: CollisionMap, x: number, z: number, locId: number, shape: number, angle: number): void {
    let loc: LocType;
    try {
        loc = LocType.list(locId);
    } catch {
        return;
    }

    if (!loc.blockwalk) {
        return;
    }

    if (shape === LocShape.GROUND_DECOR) {
        // ClientBuild.addLoc requires `loc.active` here, not just blockwalk.
        // blockwalk defaults TRUE and active defaults FALSE, so dropping the
        // active check blocks every flower, path tile and floor decoration in
        // the world - which walls the player into their own tile.
        if (loc.active) {
            map.blockGround(x, z);
        }
        return;
    }

    if (shape === LocShape.CENTREPIECE_STRAIGHT || shape === LocShape.CENTREPIECE_DIAGONAL || shape >= LocShape.ROOF_STRAIGHT || shape === LocShape.WALL_DIAGONAL) {
        map.addLoc(x, z, loc.width, loc.length, angle, loc.blockrange);
        return;
    }

    if (shape <= LocShape.WALL_SQUARE_CORNER) {
        map.addWall(x, z, shape, angle, loc.blockrange);
    }

    // Wall decorations (shapes 4-8) never block.
}
