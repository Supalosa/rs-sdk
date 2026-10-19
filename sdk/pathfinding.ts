// Local pathfinding using bundled collision data
import * as rsmod from '../server/vendor/rsmod-pathfinder';
import { CollisionType, CollisionFlag } from '../server/vendor/rsmod-pathfinder';
import collisionData from './collision-data.json';

let initialized = false;

interface CollisionData {
    tiles: Array<[number, number, number, number]>;
    zones: Array<[number, number, number]>;
    doors?: Array<[number, number, number, number, number, number]>; // [level, x, z, shape, angle, blockrange]
}

export interface DoorInfo {
    level: number;
    x: number;
    z: number;
    shape: number;
    angle: number;
    blockrange: boolean;
}

interface TemporaryDoorBlock {
    door: DoorInfo;
    expiresAt: number;
}

/**
 * Session-owned evidence that a door is temporarily impassable.
 *
 * Entries expire automatically so a transient route failure cannot poison the
 * process-wide collision map for every bot until restart.
 */
export class TemporaryDoorBlocklist {
    private entries = new Map<string, TemporaryDoorBlock>();

    constructor(private readonly now: () => number = Date.now) {}

    block(door: DoorInfo, ttlMs: number = 30_000): void {
        this.entries.set(doorKey(door.level, door.x, door.z), {
            door,
            expiresAt: this.now() + Math.max(0, ttlMs)
        });
    }

    active(): DoorInfo[] {
        const now = this.now();
        for (const [key, entry] of this.entries) {
            if (entry.expiresAt <= now) this.entries.delete(key);
        }
        return [...this.entries.values()].map(entry => entry.door);
    }

    has(level: number, x: number, z: number): boolean {
        this.active();
        return this.entries.has(doorKey(level, x, z));
    }

    clear(): void {
        this.entries.clear();
    }
}

// Spatial index of all known door positions, keyed by "level,x,z"
const doorIndex = new Map<string, DoorInfo>();

// Zones that have at least one collision tile — zones with zero collision data
// are likely open ocean/void and should not be treated as walkable land.
const populatedZones = new Set<string>();

// One-way doors that should NOT be unmasked in the door index.
// These doors can only be opened from one side; routing through them traps the bot.
const ONE_WAY_DOORS = new Set<string>([
    '0,3108,3353', // Draynor Manor front door (west tile) — only opens from outside
    '0,3109,3353', // Draynor Manor front door (east tile) — only opens from outside
    '0,2924,9654', // Melzar's Maze basement 'funexit' door — only opens from the maze side
    '0,2927,9649', // Melzar's Maze basement 'funexit' door — only opens from the maze side
    '0,2931,9640', // Melzar's Maze basement 'funexit' door — only opens from the maze side
]);

function doorKey(level: number, x: number, z: number): string {
    return `${level},${x},${z}`;
}

export function initPathfinding(): void {
    if (initialized) return;

    const data = collisionData as CollisionData;
    const start = Date.now();

    // Allocate all zones first (includes walkable areas with no collision tiles)
    for (const [level, zoneX, zoneZ] of data.zones) {
        rsmod.allocateIfAbsent(zoneX, zoneZ, level);
    }

    // Allocate mainland zones so the 2048x2048 BFS grid can traverse
    // open land between cities. Unallocated zones return NULL (blocked),
    // so without this the pathfinder can't cross gaps in the collision data.
    // Newly-allocated zones default to OPEN (walkable), which is correct
    // for grassland/roads. Zones already allocated above keep their flags.
    let mainlandZones = 0;
    for (let x = 2304; x <= 3392; x += 8) {
        for (let z = 2944; z <= 3584; z += 8) {
            if (!rsmod.isZoneAllocated(x, z, 0)) {
                rsmod.allocateIfAbsent(x, z, 0);
                mainlandZones++;
            }
        }
    }

    // Set collision flags for tiles that have them (includes wall flags)
    for (const [level, x, z, flags] of data.tiles) {
        rsmod.__set(x, z, level, flags);
        // Track which zones have at least one collision tile (likely land, not ocean)
        populatedZones.add(`${level},${x & ~7},${z & ~7}`);
    }

    // Remove wall collision at door/gate positions so the pathfinder
    // routes through doorways while still respecting permanent walls.
    // Uses rsmod.changeWall(add=false) — the same method the server uses
    // when doors are opened at runtime.
    let doorCount = 0;
    let skippedOneWay = 0;
    if (data.doors) {
        for (const [level, x, z, shape, angle, blockrange] of data.doors) {
            const key = doorKey(level, x, z);

            // Skip one-way doors — keep their wall collision so the pathfinder
            // won't route through them (entering traps the bot).
            if (ONE_WAY_DOORS.has(key)) {
                skippedOneWay++;
                continue;
            }

            rsmod.changeWall(x, z, level, angle, shape, !!blockrange, false, false);
            doorIndex.set(key, {
                level, x, z, shape, angle, blockrange: !!blockrange
            });
            doorCount++;
        }
    }

    initialized = true;
    console.log(`Pathfinding initialized in ${Date.now() - start}ms (${data.zones.length} zones + ${mainlandZones} mainland fill, ${data.tiles.length} tiles, ${doorCount} doors masked, ${skippedOneWay} one-way doors blocked)`);
}

// Check if a zone has collision data
export function isZoneAllocated(level: number, x: number, z: number): boolean {
    if (!initialized) {
        initPathfinding();
    }
    return rsmod.isZoneAllocated(x, z, level);
}

// Find long-distance path (2048x2048 search grid, ±1024 tile reach)
export function findLongPath(
    level: number,
    srcX: number,
    srcZ: number,
    destX: number,
    destZ: number,
    maxWaypoints: number = 500,
    blockedDoors: Iterable<DoorInfo> = []
): Array<{ x: number; z: number; level: number }> {
    if (!initialized) {
        initPathfinding();
    }

    // Re-apply only this SDK session's temporary door walls for the duration of
    // this synchronous query. The shared collision snapshot is restored before
    // another bot can pathfind.
    const applied: DoorInfo[] = [];
    try {
        for (const door of blockedDoors) {
            rsmod.changeWall(
                door.x, door.z, door.level,
                door.angle, door.shape, door.blockrange,
                false, true
            );
            applied.push(door);
        }

        const waypointsRaw = rsmod.findLongPath(
            level, srcX, srcZ, destX, destZ,
            1, 1, 1, 0, -1, true, 0, maxWaypoints, CollisionType.NORMAL
        );

        return unpackWaypoints(waypointsRaw);
    } finally {
        for (const door of applied) {
            rsmod.changeWall(
                door.x, door.z, door.level,
                door.angle, door.shape, door.blockrange,
                false, false
            );
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/** Check if a tile is walkable (no blocking flags). */
export function isTileWalkable(level: number, x: number, z: number): boolean {
    if (!initialized) initPathfinding();
    return !rsmod.isFlagged(x, z, level, CollisionFlag.WALK_BLOCKED);
}

/** Check if a tile has specific collision flags set. */
export function isFlagged(x: number, z: number, level: number, masks: number): boolean {
    if (!initialized) initPathfinding();
    return rsmod.isFlagged(x, z, level, masks);
}

/**
 * Check if the zone containing (x, z) has any collision tiles.
 * Zones with zero collision data are likely open ocean/void — real walkable
 * land always has some collision data (objects, walls, floor flags nearby).
 */
export function isZoneLikelyLand(level: number, x: number, z: number): boolean {
    return populatedZones.has(`${level},${x & ~7},${z & ~7}`);
}


// ═══════════════════════════════════════════════════════════════════════════════
//  DOOR PATH ANALYSIS — identify doors a computed path crosses through
// ═══════════════════════════════════════════════════════════════════════════════

type Waypoint = {x:number;z:number;level:number};
function routeTiles(waypoints:Waypoint[],start?:{x:number;z:number}){
    const tiles:Array<Waypoint & {original:boolean}>=[];
    let previous=start?{...start,level:waypoints[0]?.level??0}:undefined;
    if(previous)tiles.push({...previous,original:false});
    for(const wp of waypoints){
        if(!previous){tiles.push({...wp,original:true});previous=wp;continue;}
        const steps=Math.max(Math.abs(wp.x-previous.x),Math.abs(wp.z-previous.z));
        if(!steps){if(tiles.length)tiles[tiles.length-1]!.original=true;}
        for(let n=1;n<=steps;n++)tiles.push({x:previous.x+Math.round((wp.x-previous.x)*n/steps),z:previous.z+Math.round((wp.z-previous.z)*n/steps),level:wp.level,original:n===steps});
        previous=wp;
    }
    return tiles;
}
function crossesDoor(door:DoorInfo,a:Waypoint,b:Waypoint){
    if(door.level!==b.level)return false;
    const crossesEdge=(angle:number)=>{
        const xAxis=angle===0||angle===2;
        const edge=(xAxis?door.x:door.z)+(angle===0||angle===3?-0.5:0.5);
        const from=xAxis?a.x:a.z,to=xAxis?b.x:b.z;
        if((from<edge)===(to<edge))return false;
        const fraction=(edge-from)/(to-from);
        const along=xAxis?a.z+fraction*(b.z-a.z):a.x+fraction*(b.x-a.x);
        return Math.abs(along-(xAxis?door.z:door.x))<=0.5;
    };
    if(door.shape===0)return crossesEdge(door.angle);
    if(door.shape===2)return crossesEdge(door.angle)||crossesEdge((door.angle+1)%4);
    // Diagonal door shapes retain the conservative adjacency handling.
    return Math.abs(b.x-door.x)+Math.abs(b.z-door.z)<=1;
}
/** Inspect every crossed tile edge, including doors between compressed waypoints.
 * Add approach points on the original route so walkTo actually opens each door
 * before trying to traverse it. Scripted door moves must still trigger replan.
 */
export function planDoorRoute(waypoints:Waypoint[],start?:{x:number;z:number}):{waypoints:Waypoint[];doors:DoorInfo[]}{
    if(!initialized)initPathfinding();
    const tiles=routeTiles(waypoints,start),doors:DoorInfo[]=[],result:Waypoint[]=[],seen=new Set<string>();
    const append=(wp:Waypoint)=>{const last=result[result.length-1];if(!last||last.x!==wp.x||last.z!==wp.z||last.level!==wp.level)result.push({x:wp.x,z:wp.z,level:wp.level});};
    for(let i=0;i<tiles.length;i++){
        const tile=tiles[i]!,previous=tiles[i-1];
        for(const [x,z] of [[tile.x,tile.z],[tile.x+1,tile.z],[tile.x-1,tile.z],[tile.x,tile.z+1],[tile.x,tile.z-1]]){
            const key=doorKey(tile.level,x!,z!),door=doorIndex.get(key);
            if(!door||seen.has(key))continue;
            if(previous?!crossesDoor(door,previous,tile):!!start)continue;
            seen.add(key);doors.push(door);if(previous)append(previous);
        }
        if(tile.original)append(tile);
    }
    return {waypoints:result,doors};
}
export function findDoorsAlongPath(waypoints:Waypoint[],start?:{x:number;z:number}):DoorInfo[]{
    return planDoorRoute(waypoints,start).doors;
}

/** Look up a door at an exact position. */
export function getDoorAt(level: number, x: number, z: number): DoorInfo | undefined {
    if (!initialized) initPathfinding();
    return doorIndex.get(doorKey(level, x, z));
}

// Unpack waypoints from rsmod format
function unpackWaypoints(waypointsRaw: Uint32Array): Array<{ x: number; z: number; level: number }> {
    const waypoints: Array<{ x: number; z: number; level: number }> = [];
    for (let i = 0; i < waypointsRaw.length; i++) {
        const packed = waypointsRaw[i]!;
        waypoints.push({
            z: packed & 0x3FFF,
            x: (packed >> 14) & 0x3FFF,
            level: (packed >> 28) & 0x3
        });
    }
    return waypoints;
}
