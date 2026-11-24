import { expect, test } from 'bun:test';
import './dom-shim.js';
import ClientStream from '#/io/ClientStream.js';
import Packet from '#/io/Packet.js';
import { ServerProt } from '#/io/ServerProt.js';
import { handlePacket } from './protocol/incoming.js';
import { startSessionLoop } from './session.js';
import type { GameConnection } from './net/GameConnection.js';
import type { LiteClient } from './LiteClient.js';

function peerClosed(finalBytes: number[]) {
    // Real ClientStream buffering + packet framing, without cache archives/login.
    const peer = { url: 'ws://local.invalid', close() {} } as unknown as WebSocket;
    const stream = new ClientStream(peer);
    if (finalBytes.length) peer.onmessage!(new MessageEvent('message', { data: Uint8Array.from(finalBytes).buffer }));
    peer.onclose!(new Event('close') as CloseEvent);
    let loggedOut = false;
    const connection = {
        stream,
        in: Packet.alloc(1),
        randomIn: { nextInt: 0 },
        close: () => stream.close()
    } as unknown as GameConnection;
    const client = {
        conn: connection, ptype: -1, packetsReceived: 0,
        activate() {},
        markLoggedOut() { loggedOut = true; },
        isLoggedOut: () => loggedOut,
        isInGame: () => !loggedOut && !stream.isClosed,
        async pumpPackets() { while (!loggedOut && await handlePacket(client)) {} },
        flush() { throw new Error('Must not write after remote close'); },
        tickCycle() { throw new Error('Must not tick after logout'); }
    } as unknown as LiteClient;
    return startSessionLoop(client, connection, { username: 'logout-fixture' });
}

test('a buffered server LOGOUT is acknowledged even when the peer has already closed', async () => {
    const session = peerClosed([ServerProt.LOGOUT]);
    expect(await session.stopped).toEqual({ reason: 'logged-out' });
    expect(session.client.isLoggedOut()).toBe(true);
});

test('a peer closing without LOGOUT remains an unconfirmed disconnect', async () => {
    const session = peerClosed([]);
    expect(await session.stopped).toEqual({ reason: 'disconnected' });
    expect(session.client.isLoggedOut()).toBe(false);
});
