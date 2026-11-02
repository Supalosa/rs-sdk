import { expect, test } from 'bun:test';
import './dom-shim.js';
import Packet from '#/io/Packet.js';
import { ServerProt } from '#/io/ServerProt.js';
import { dispatch } from './protocol/incoming.js';
import type { LiteClient } from './LiteClient.js';

test('bank validity distinguishes a zero-item full packet from stopped transmission', () => {
    const inv = { linkObjType: new Int32Array(400), linkObjNumber: new Int32Array(400) };
    const client = { bankContentsKnown: false, activate() {}, interfaces: { activate() {} }, ifMutable: () => inv } as unknown as LiteClient;
    const full = Packet.alloc(1);
    full.p2(5382); full.p2(1); full.p2(996); full.p1(20);
    const size = full.pos; full.pos = 0;
    dispatch(client, ServerProt.UPDATE_INV_FULL, full, size);
    expect(client.bankContentsKnown).toBe(true);
    expect(inv.linkObjType[0]).toBe(996);
    const stop = Packet.alloc(1);
    stop.p2(5382); stop.pos = 0;
    dispatch(client, ServerProt.UPDATE_INV_STOP_TRANSMIT, stop, 2);
    expect(client.bankContentsKnown).toBe(false);
    expect(inv.linkObjType[0]).toBe(0);
    const empty = Packet.alloc(1);
    empty.p2(5382); empty.p2(0); empty.pos = 0;
    dispatch(client, ServerProt.UPDATE_INV_FULL, empty, 4);
    expect(client.bankContentsKnown).toBe(true);
    expect(inv.linkObjType[0]).toBe(0);
});
