import { describe, expect, test } from 'bun:test';
import { BotSDK } from '../index';
import { BotActions } from '../actions';
import { findDoorsAlongPath, planDoorRoute, initPathfinding } from '../pathfinding';

initPathfinding();
const door = { x: 3125, z: 3124, level: 0 };
const destination = { x: 3129, z: 3124, level: 0 };

function makeBot() {
    const sdk = new BotSDK({ botUsername: 'test' });
    const pos = { x: 3124, z: 3124 };
    (sdk as any).getState = () => ({
        tick: 1, inGame: true,
        player: { worldX: pos.x, worldZ: pos.z, level: 0, lifeId: 1, isDead: false },
        gameMessages: [], nearbyLocs: [], inventory: [],
        dialog: { isOpen: false }, interface: { isOpen: false },
    });
    (sdk as any).waitForTicks = async () => {};
    const bot = new BotActions(sdk);
    (bot as any).dismissBlockingUI = async () => {};
    const walked: Array<{ x: number; z: number }> = [];
    (bot as any).helpers.walkStepToward = async (x: number, z: number) => {
        walked.push({ x, z });
        Object.assign(pos, { x, z });
        return { status: 'arrived', pos: { ...pos } };
    };
    return { sdk, bot, pos, walked };
}

describe('walkTo door recovery', () => {
    test('recognizes a crossed door edge, but excludes the door behind the route', () => {
        expect(findDoorsAlongPath([door, destination], { x: 3124, z: 3124 })).toContainEqual(expect.objectContaining(door));
        expect(findDoorsAlongPath([door, destination], { x: 3125, z: 3124 })).not.toContainEqual(expect.objectContaining(door));
    });

    test('replans from the new position after a tutorial door moves the player', async () => {
        const { sdk, bot, pos, walked } = makeBot();
        const queries: Array<{ x: number; z: number }> = [];
        (sdk as any).sendFindPath = async () => {
            queries.push({ ...pos });
            // The new route starts at the door tile; proximity alone must
            // not cause us to open the auto-closing door again from inside.
            return { success: true, reachedDestination: true, waypoints: [door, destination] };
        };
        let opens = 0;
        (bot as any).helpers.openDoorAt = async () => {
            opens++;
            pos.x = 3125;
            return 'opened';
        };
        const result = await bot.walkTo(destination.x, destination.z, 0);
        expect(result.success).toBe(true);
        expect(opens).toBe(1);
        expect(queries).toEqual([{ x: 3124, z: 3124 }, { x: 3125, z: 3124 }]);
        expect(walked).toEqual([{ x: 3125, z: 3124 }, { x: 3129, z: 3124 }]);
    });

    test('does not open an unrelated nearby door when a partial route dead-ends', async () => {
        const { sdk, bot, pos } = makeBot();
        const deadEnd = { x: 3122, z: 3119, level: 0 };
        (sdk as any).sendFindPath = async () => ({ success: true, reachedDestination: false, waypoints: [deadEnd] });
        (sdk as any).getNearbyLocs = () => [{ id: 3024, ...door, distance: 5, optionsWithIndex: [{ text: 'Open', opIndex: 1 }] }];
        let opens = 0;
        (bot as any).helpers.openDoorAt = async () => { opens++; return 'opened'; };
        (bot as any).helpers.tryOpenBlockingDoor = async () => { throw Error('Must not open the nearest unrelated door'); };
        const result = await bot.walkTo(3122, 3102, 0);
        expect(result.success).toBe(false);
        expect(result.message).toContain('player actually at');
        expect(opens).toBe(0);
        expect(pos).toEqual({ x: 3122, z: 3119 });
    });

    test('a locked door causes a replan before any old waypoint is walked', async () => {
        const { sdk, bot, walked } = makeBot();
        let blocked = false;
        (sdk as any).isDoorTemporarilyBlocked = () => blocked;
        (sdk as any).blockDoorTemporarily = () => { blocked = true; };
        (sdk as any).sendFindPath = async () => blocked
            ? { success: false, error: 'locked route', waypoints: [] }
            : { success: true, reachedDestination: true, waypoints: [door, destination] };
        (bot as any).helpers.openDoorAt = async () => 'locked';
        const result = await bot.walkTo(destination.x, destination.z, 0);
        expect(result.success).toBe(false);
        expect(walked).toEqual([]);
    });
});

test('compressed routes detect the advisor exit between waypoints and insert an approach tile',()=>{
 const route=planDoorRoute([{x:3133,z:3124,level:0}],{x:3125,z:3124});
 expect(route.doors).toContainEqual(expect.objectContaining({x:3130,z:3124}));
 expect(route.waypoints).toEqual([{x:3129,z:3124,level:0},{x:3133,z:3124,level:0}]);
});
test('door edge detection works in reverse and excludes travel parallel to the wall', () => {
    const exit = { x: 3130, z: 3124 };
    const reverse = planDoorRoute([{ x: 3125, z: 3124, level: 0 }], { x: 3133, z: 3124 });
    expect(reverse.doors).toContainEqual(expect.objectContaining(exit));
    expect(reverse.waypoints).toContainEqual({ x: 3130, z: 3124, level: 0 });
    const parallel = planDoorRoute([{ x: 3130, z: 3128, level: 0 }], { x: 3130, z: 3120 });
    expect(parallel.doors).not.toContainEqual(expect.objectContaining(exit));
});
test('real bank route crosses both auto-closing doors without being trapped in the advisor room',async()=>{
 const {sdk,bot,pos,walked}=makeBot();Object.assign(pos,{x:3122,z:3116});
 const opened:number[]=[];
 (sdk as any).getNearbyLocs=()=>[3125,3130].map(x=>({x,z:3124,id:x===3125?3024:3025,optionsWithIndex:[{text:'Open',opIndex:1}]}));
 // Use actual bundled geometry and the SDK path query, without any NPC collision.
 (bot as any).helpers.openDoorAt=async(x:number,z:number)=>{opened.push(x);Object.assign(pos,{x,z});return 'opened';};
 (bot as any).helpers.walkStepToward=async(x:number,z:number)=>{
  const crossed=findDoorsAlongPath([{x,z,level:0}],pos);
  if(crossed.length)return{status:'stuck',pos:{...pos}};
  walked.push({x,z});Object.assign(pos,{x,z});return{status:'arrived',pos:{...pos}};
 };
 const result=await bot.walkTo(3133,3124,0);
 expect(result.success).toBe(true);expect(pos).toEqual({x:3133,z:3124});expect(opened).toEqual([3125,3130]);
});
