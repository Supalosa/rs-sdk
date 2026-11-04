import { afterEach, expect, test } from 'bun:test';
import { createEmbeddedSocket } from './embedded.js';
import type { LiteSession, SessionEnd, SessionOptions } from './session.js';
import type { BotAction, BotWorldState } from '#/bot/types.js';
import type { ActionResult } from '#/bot/ActionExecutor.js';

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const options: SessionOptions = { host: 'local.invalid', username: 'testbot', password: 'test-password' };

async function until(predicate: () => boolean) {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('Embedded protocol fixture did not settle');
        await Bun.sleep(5);
    }
}

async function fixture(execute: (action: BotAction) => ActionResult | Promise<ActionResult> = () => ({ success: true, message: 'dispatched', phase: 'dispatch' }), authorize?:()=>void) {
    let finish!: (end: SessionEnd) => void;
    let onTick = () => {};
    const calls: BotAction[] = [];
    const source = { tick: 0, inGame: true, inventory: [{ id: 995, count: 20 }] } as unknown as BotWorldState;
    const stopped = new Promise<SessionEnd>(resolve => {
        finish = resolve;
    });
    const session = {
        client: {
            setOnGameTickCallback(callback: () => void) {
                onTick = callback;
            },
            collectBotState(tick: number) {
                source.tick = tick;
                return source;
            },
            getMaxMessageLength() {
                return 80;
            },
            executeBotAction(action: BotAction) {
                calls.push(action);
                return execute(action);
            }
        },
        stopped,
        stop() {
            finish({ reason: 'stopped' });
        }
    } as unknown as LiteSession;
    const socket = createEmbeddedSocket({...options,...(authorize?{authorize}:{})}, { startSession: async () => session });
    const messages: Record<string, any>[] = [];
    socket.onmessage = event => messages.push(JSON.parse(String(event.data)));
    cleanups.push(async () => {
        socket.close();
        await socket.stopped;
    });
    await until(() => socket.readyState === 1);
    const authenticate = () => socket.send(JSON.stringify({ type: 'sdk_connect', username: options.username, password: options.password, mode: 'control' }));
    const action = (actionId: string, action: BotAction = { type: 'none', reason: 'fixture' }, timeout?: number) => socket.send(JSON.stringify({ type: 'sdk_action', actionId, action, actionTimeoutMs: timeout }));
    return { socket, source, messages, calls, authenticate, action, end: finish, tick: () => onTick() };
}

test('logout acknowledgement requires the server LOGOUT, not a local close or lost connection', async () => {
    for (const reason of ['logged-out', 'disconnected', 'error', 'idle', 'stopped'] as const) {
        const f = await fixture();
        f.end({ reason });
        expect(await f.socket.logoutAcknowledged).toBe(reason === 'logged-out');
        await f.socket.stopped;
        expect(f.socket.readyState).toBe(3);
    }
    const f = await fixture();
    f.socket.close();
    expect(await f.socket.logoutAcknowledged).toBe(false);
});

test('embedded authentication preserves identity checks and publishes isolated snapshots on game ticks', async () => {
    const f = await fixture();
    f.action('unauthenticated');
    f.socket.send(JSON.stringify({ type: 'sdk_connect', username: options.username, password: 'wrong', mode: 'control' }));
    expect(f.messages.at(-1)).toMatchObject({ type: 'sdk_error' });
    expect(f.calls).toHaveLength(0);
    f.authenticate();
    expect(f.messages.find(message => message.type === 'sdk_connected')).toMatchObject({ maxMessageLength: 80 });
    const initial = f.messages.find(message => message.type === 'sdk_state')!;
    initial.state.inventory[0].count = 999;
    expect(f.source.inventory[0]!.count).toBe(20);
    f.tick();
    expect(f.messages.at(-1)).toMatchObject({ type: 'sdk_state', state: { tick: 1 } });
    f.action('ack');
    await until(() => f.messages.some(message => message.actionId === 'ack'));
    expect(f.messages.find(message => message.actionId === 'ack')).toMatchObject({ type: 'sdk_action_result', result: { success: true, phase: 'dispatch' } });
});

test('generation changes drop queued work and retain the active promise as a dispatch barrier', async () => {
    let finish!: (result: ActionResult) => void;
    const f = await fixture(
        () =>
            new Promise(resolve => {
                finish = resolve;
            })
    );
    f.authenticate();
    f.action('old-active');
    await until(() => f.calls.length === 1);
    f.action('old-pending');
    f.socket.beginGeneration();
    f.action('new');
    await Bun.sleep(60);
    expect(f.calls).toHaveLength(1);
    finish({ success: true, message: 'old action finished' });
    await until(() => f.calls.length === 2);
    expect(f.messages.some(message => message.actionId === 'old-active' || message.actionId === 'old-pending')).toBe(false);
    finish({ success: true, message: 'new action finished', phase: 'completion' });
    await until(() => f.messages.some(message => message.actionId === 'new'));
    expect(f.calls).toHaveLength(2);
});

test('expired queued work is acknowledged as failure and never dispatched', async () => {
    const f = await fixture();
    f.authenticate();
    f.action('expired', { type: 'none', reason: 'expired' }, 1000);
    await until(() => f.messages.some(message => message.actionId === 'expired'));
    expect(f.messages.find(message => message.actionId === 'expired')).toMatchObject({ result: { success: false, reason: 'queue_expired' } });
    expect(f.calls).toHaveLength(0);
});
test('lease authorization is checked at execution even when the expiry timer has not run', async () => {
    let valid=true;
    const f=await fixture(undefined,()=>{if(!valid)throw new Error('Lease expired');});
    f.authenticate();
    f.action('queued-before-expiry');
    valid=false;
    await until(()=>f.messages.some(message=>message.actionId==='queued-before-expiry'));
    expect(f.calls).toHaveLength(0);
    expect(f.messages.find(message=>message.actionId==='queued-before-expiry')).toMatchObject({result:{success:false,reason:'execution_error'}});
    expect(()=>f.action('after-expiry')).toThrow('Lease expired');
});

test('queue saturation is rejected and an action exception does not strand subsequent work', async () => {
    const f = await fixture(() => {
        throw new Error('executor failed');
    });
    f.authenticate();
    for (let i = 0; i < 65; i++) f.action(`action-${i}`);
    expect(f.messages.find(message => message.actionId === 'action-64')).toMatchObject({ result: { success: false, reason: 'busy' } });
    await until(() => f.messages.some(message => message.actionId === 'action-1'));
    expect(f.messages.find(message => message.actionId === 'action-0')).toMatchObject({ result: { success: false, reason: 'execution_error' } });
});

test('closing during session startup waits for session cleanup and publishes no open event', async () => {
    let connected!: (session: LiteSession) => void;
    let stopped!: () => void;
    let stopCalls = 0;
    const sessionStopped = new Promise<void>(resolve => {
        stopped = resolve;
    });
    const socket = createEmbeddedSocket(options, {
        startSession: () =>
            new Promise(resolve => {
                connected = resolve;
            })
    });
    let opens = 0;
    socket.onopen = () => {
        opens++;
    };
    await Bun.sleep(0);
    socket.close();
    let ended = false;
    void socket.stopped.then(() => {
        ended = true;
    });
    connected({
        stop: () => {
            stopCalls++;
        },
        stopped: sessionStopped
    } as unknown as LiteSession);
    await Bun.sleep(0);
    expect(stopCalls).toBe(1);
    expect(ended).toBe(false);
    stopped();
    await socket.stopped;
    expect(opens).toBe(0);
});
