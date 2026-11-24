import { describe, expect, test } from 'bun:test';
import { BotSDK } from '../index';
import { BotActions } from '../actions';

function harness() {
    const sdk = new BotSDK({ botUsername: 'test', password: 'test', autoLaunchBrowser: false });
    const internal = sdk as any;
    internal.state = {
        tick: 1, player: { animId: 625 }, inventory: [],
        skills: [{ name: 'Mining', experience: 0 }],
        nearbyLocs: [{ id: 2090, name: 'Rocks copper ore', x: 3282, z: 3367, distance: 1, reachable: true, optionsWithIndex: [{ text: 'Mine', opIndex: 1 }] }],
        gameMessages: [], dialog: { isOpen: false }, interface: { isOpen: false },
    };
    const bot = new BotActions(sdk);
    sdk.sendInteractLoc = async () => ({ success: true, message: 'dispatched' });
    return { sdk, bot, internal };
}

describe('mineRock completion evidence', () => {
    test('does not complete on animation, XP alone, or an unrelated ore', async () => {
        const h = harness();
        let settled = false;
        const work = h.bot.mineRock(/copper ore/i, { timeout: 1000 }).then(result => { settled = true; return result; });
        await new Promise(resolve => setTimeout(resolve, 0));
        const publish = () => { for (const listener of h.internal.stateListeners) listener(h.internal.state); };
        publish();
        await Promise.resolve();
        expect(settled).toBeFalse();
        h.internal.state.skills[0].experience = 437;
        h.internal.state.inventory = [{ id: 438, name: 'Tin ore', count: 1, slot: 0 }];
        publish();
        await Promise.resolve();
        expect(settled).toBeFalse();
        h.internal.state.inventory.push({ id: 436, name: 'Copper ore', count: 1, slot: 1 });
        publish();
        const result = await work;
        expect(result).toMatchObject({ success: true, oresMined: 1, xpGained: 437, ore: { name: 'Copper ore' } });
        expect(h.internal.stateListeners.size).toBe(0);
    });

    test('times out when a mining animation never produces ore', async () => {
        const result = await harness().bot.mineRock(/copper ore/i, { timeout: 10 });
        expect(result).toMatchObject({ success: false, reason: 'timeout', oresMined: 0 });
    });

    test('gives a clear failure for an inventory-only selector', async () => {
        expect(await harness().bot.mineRock(/^copper ore$/i)).toMatchObject({ success: false, reason: 'loc_not_found' });
    });

    test('refuses a full inventory before clicking the rock', async () => {
        const h = harness();
        h.internal.state.inventory = Array.from({ length: 28 }, (_, slot) => ({ id: 436, name: 'Copper ore', count: 1, slot }));
        h.sdk.sendInteractLoc = async () => { throw new Error('must not click'); };
        expect(await h.bot.mineRock(/copper ore/i)).toMatchObject({ success: false, reason: 'inventory_full' });
    });

    test('observes a fast ore completion even when no animation is published', async () => {
        const h = harness();
        h.sdk.sendInteractLoc = async () => {
            h.internal.state.player.animId = -1;
            h.internal.state.skills[0].experience = 437;
            h.internal.state.inventory = [{ id: 436, name: 'Copper ore', count: 1, slot: 0 }];
            return { success: true, message: 'dispatched' };
        };
        expect(await h.bot.mineRock(/copper ore/i)).toMatchObject({ success: true, oresMined: 1, xpGained: 437 });
    });
});


describe('mineRock rejection recovery', () => {
    function frames(h: ReturnType<typeof harness>, batches: ((state: any) => void)[][]) {
        let waits = 0;
        h.sdk.waitForCondition = async (predicate: any) => {
            for (const frame of batches[waits++] ?? []) {
                frame(h.internal.state);
                if (predicate(h.internal.state)) return h.internal.state;
            }
            throw new Error('No completion in supplied frames');
        };
    }
    const idle = (tick: number, rejected = 1) => (s: any) => {
        s.tick = tick;
        s.player.animId = -1;
        s.opFeedback = { opRejectedCount: rejected };
    };
    const completed = (s: any) => {
        s.skills[0].experience = 437;
        s.inventory = [{ id: 436, name: 'Copper ore', count: 1, slot: 0 }];
    };

    test('waits through false rejection and delayed mining completion without re-clicking', async () => {
        const h = harness();
        h.internal.state.opFeedback = { opRejectedCount: 0 };
        let clicks = 0;
        h.sdk.sendInteractLoc = async () => { clicks++; return { success: true, message: 'dispatched' }; };
        frames(h, [[idle(2), idle(3), s => { s.tick = 4; s.player.animId = 625; },
            idle(8, 4), s => { s.tick = 12; completed(s); }]]);
        expect(await h.bot.mineRock(/copper ore/i)).toMatchObject({ success: true, oresMined: 1 });
        expect(clicks).toBe(1);
    });

    test('retries an idle rejection with a fresh cursor, then observes completion', async () => {
        const h = harness();
        h.internal.state.opFeedback = { opRejectedCount: 0 };
        let clicks = 0;
        h.sdk.sendInteractLoc = async () => { clicks++; return { success: true, message: 'dispatched' }; };
        frames(h, [[idle(2), idle(6)], [idle(7), completed]]);
        expect(await h.bot.mineRock(/copper ore/i)).toMatchObject({ success: true, oresMined: 1 });
        expect(clicks).toBe(2);
    });

    test('bounds repeated idle rejections to three clicks', async () => {
        const h = harness();
        h.internal.state.opFeedback = { opRejectedCount: 0 };
        let clicks = 0;
        h.sdk.sendInteractLoc = async () => { clicks++; return { success: true, message: 'dispatched' }; };
        frames(h, [[idle(2), idle(6)], [idle(7, 2), idle(11, 2)], [idle(12, 3), idle(16, 3)]]);
        expect(await h.bot.mineRock(/copper ore/i)).toMatchObject({ success: false, reason: 'rejected' });
        expect(clicks).toBe(3);
    });

    test('does not retry explicit mining refusals', async () => {
        const h = harness();
        let clicks = 0;
        h.sdk.sendInteractLoc = async () => { clicks++; return { success: true, message: 'dispatched' }; };
        frames(h, [[s => { s.gameMessages = [{ tick: 2, type: 0, text: 'You need a pickaxe.' }]; }]]);
        expect(await h.bot.mineRock(/copper ore/i)).toMatchObject({ success: false, reason: 'rejected' });
        expect(clicks).toBe(1);
    });
});
