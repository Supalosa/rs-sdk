import { expect, test } from 'bun:test';
import './dom-shim.js';
import { interactNpc } from './actions.js';
import { ClientProt } from '#/io/ClientProt.js';

test('NPC interaction without routing sends the ordinary packet without movement state', () => {
    const opcodes: number[] = [];
    const payload: number[] = [];
    const client = {
        isInGame: () => true,
        localPlayer: {},
        npc: { 42: { routeX: [14], routeZ: [10], type: { size: 3 } } },
        writeOpcode: (value: number) => opcodes.push(value),
        out: { p2: (value: number) => payload.push(value) }
    };
    expect(interactNpc(client as never, 42, 2, false)).toEqual({ success: true, routed: false });
    expect(opcodes).toEqual([ClientProt.OPNPC2]);
    expect(payload).toEqual([42]);
});
