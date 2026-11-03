import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import './dom-shim.js';
import IfType from '#/config/IfType.js';
import ObjType from '#/config/ObjType.js';
import Packet from '#/io/Packet.js';
import { ClientProt } from '#/io/ClientProt.js';
import { clickInterfaceIop } from './actions.js';
import type { LiteClient } from './LiteClient.js';

const inventory = 3214, tradeSide = 3322;
let original: typeof IfType.list;
let lookup: ReturnType<typeof spyOn<typeof ObjType, 'list'>>;
beforeEach(() => {
    original = IfType.list;
    IfType.list = [];
    lookup = spyOn(ObjType, 'list').mockImplementation((id: number) => ({ id }) as ObjType);
});
afterEach(() => {
    lookup.mockRestore();
    IfType.list = original;
});
function view(component: number, id?: number) {
    IfType.list[component] = { linkObjType: new Int32Array([id === undefined ? 0 : id + 1]) } as IfType;
}
function offer(component = tradeSide, ingame = true) {
    const out = Packet.alloc(1);
    const client = { isInGame: () => ingame, out, writeOpcode: (opcode: number) => out.p1(opcode) } as unknown as LiteClient;
    const success = clickInterfaceIop(client, component, 4, 0);
    return { success, bytes: Array.from(out.data.subarray(0, out.pos)) };
}
test('a trade offer before the side view arrives encodes the known owned essence item, not obj 0', () => {
    view(inventory, 1436);
    view(tradeSide);
    expect(offer()).toEqual({ success: true, bytes: [ClientProt.INV_BUTTON4, 5, 156, 0, 0, 12, 250] });
});
test('the transmitted trade view takes precedence over an older ordinary inventory view', () => {
    view(inventory, 1436);
    view(tradeSide, 1351);
    expect(offer().bytes).toEqual([ClientProt.INV_BUTTON4, 5, 71, 0, 0, 12, 250]);
});
test('a present item with actual id zero is not mistaken for an absent slot', () => {
    view(inventory, 1436);
    view(tradeSide, 0);
    expect(offer().bytes.slice(1, 3)).toEqual([0, 0]);
});
test('missing and empty owned slots remain obj 0, and unrelated components never borrow inventory IDs', () => {
    view(inventory);
    view(tradeSide);
    expect(offer().bytes.slice(1, 3)).toEqual([0, 0]);
    view(inventory, 1436);
    view(2006);
    expect(offer(2006).bytes.slice(1, 3)).toEqual([0, 0]);
});
test('the normal in-game guard still prevents any packet from being written', () => {
    view(inventory, 1436);
    expect(offer(tradeSide, false)).toEqual({ success: false, bytes: [] });
});
