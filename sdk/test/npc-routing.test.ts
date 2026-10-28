import { expect, test } from 'bun:test';
import { BotSDK } from '../index';

test('NPC routing opt-out reaches the action command and default remains omitted', async () => {
    const commands: unknown[] = [];
    const sdk = { sendAction: async (command: unknown) => { commands.push(command); return { success: true }; } };
    await BotSDK.prototype.sendInteractNpc.call(sdk as never, 42, 2);
    await BotSDK.prototype.sendInteractNpc.call(sdk as never, 42, 2, { route: false });
    expect(commands).toEqual([
        { type: 'interactNpc', npcIndex: 42, optionIndex: 2, reason: 'SDK' },
        { type: 'interactNpc', npcIndex: 42, optionIndex: 2, route: false, reason: 'SDK' }
    ]);
});
