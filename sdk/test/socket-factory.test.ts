import { afterEach, expect, test } from 'bun:test';
import { BotSDK } from '../index';

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function gateway(reply: boolean = true) {
    const actions: Record<string, unknown>[] = [];
    const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch(request, server) {
            if (server.upgrade(request)) return;
            return new Response('WebSocket only', { status: 400 });
        },
        websocket: {
            message(socket, raw) {
                const message = JSON.parse(String(raw));
                if (message.type === 'sdk_connect' && reply) socket.send(JSON.stringify({ type: 'sdk_connected' }));
                if (message.type === 'sdk_action') {
                    actions.push(message);
                    if (reply) socket.send(JSON.stringify({ type: 'sdk_action_result', actionId: message.actionId, result: { success: true, phase: 'dispatch' } }));
                }
            }
        }
    });
    cleanups.push(() => server.stop(true));
    return { url: `ws://127.0.0.1:${server.port}`, actions };
}

test('the injected transport preserves gateway handshake, action acknowledgements and disconnect behavior', async () => {
    const remote = gateway();
    let calls = 0;
    const sdk = new BotSDK({
        botUsername: 'testbot',
        password: 'x',
        gatewayUrl: 'ws://unused.invalid',
        readyTimeout: 0,
        autoReconnect: false,
        autoLaunchBrowser: false,
        socketFactory: url => {
            expect(url).toBe('ws://unused.invalid');
            calls++;
            return new WebSocket(remote.url);
        }
    });
    cleanups.push(() => sdk.disconnect());
    await sdk.connect();
    expect(calls).toBe(1);
    expect(sdk.isConnected()).toBe(true);
    expect(await sdk.sendClickDialog(0)).toMatchObject({ success: true, phase: 'dispatch' });
    expect(remote.actions).toHaveLength(1);
    await sdk.disconnect();
    expect(sdk.isConnected()).toBe(false);
});

test('the injected transport remains subject to the SDK handshake deadline', async () => {
    const remote = gateway(false);
    const sdk = new BotSDK({
        botUsername: 'testbot',
        gatewayUrl: remote.url,
        connectTimeout: 100,
        readyTimeout: 0,
        autoReconnect: false,
        autoLaunchBrowser: false,
        socketFactory: url => new WebSocket(url)
    });
    cleanups.push(() => sdk.disconnect());
    await expect(sdk.connect()).rejects.toThrow('handshake timed out');
    expect(sdk.isConnected()).toBe(false);
});
