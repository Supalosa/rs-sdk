import './dom-shim.js';
import { startSession, type LiteSession, type SessionOptions } from './session.js';
import { BotActionQueue, type QueuedBotAction } from '#/bot/ActionQueue.js';
import type { BotAction } from '#/bot/types.js';
import type { ActionResult } from '#/bot/ActionExecutor.js';
import { installClientTestClock } from './test-clock.js';
export const leaseAuthorizationVersion = 1;

/** A local socket speaking the existing SDK message contract, with no gateway listener. */
class EmbeddedSocket extends EventTarget {
    readyState = 0;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    readonly stopped: Promise<void>;
    readonly logoutAcknowledged: Promise<boolean>;
    private finishStopped!: () => void;
    private finishLogout!: (acknowledged: boolean) => void;
    private session?: LiteSession;
    private queue = new BotActionQueue();
    private timer?: ReturnType<typeof setInterval>;
    private tick = 0;
    private waiting = 0;
    private authenticated = false;
    private testClock?: ReturnType<typeof installClientTestClock>;
    constructor(
        private options: SessionOptions,
        private connectSession: typeof startSession = startSession
    ) {
        super();
        this.stopped = new Promise(resolve => {
            this.finishStopped = resolve;
        });
        this.logoutAcknowledged = new Promise(resolve => {
            this.finishLogout = resolve;
        });
        queueMicrotask(() => {
            void this.start();
        });
    }
    private event(type: 'open' | 'close' | 'error', detail?: string) {
        const event = new Event(type);
        Object.defineProperty(event, 'message', { value: detail });
        this.dispatchEvent(event);
        this[`on${type}`]?.(event);
    }
    private message(value: unknown) {
        if (this.readyState !== 1) return;
        // Match the gateway boundary: SDK normalization must not mutate the client's state.
        const event = new MessageEvent('message', { data: JSON.stringify(value) });
        this.dispatchEvent(event);
        this.onmessage?.(event);
    }
    private async start() {
        try {
            this.session = await this.connectSession(this.options);
            if (this.readyState === 3) {
                this.session.stop();
                await this.session.stopped;
                return;
            }
            this.testClock = installClientTestClock(this.session.client, () => this.session!.client.collectBotState(this.tick));
            this.session.client.setOnGameTickCallback(() => {
                this.tick++;
                this.publish();
            });
            this.readyState = 1;
            this.timer = setInterval(() => this.pump(), 20);
            this.event('open');
            const end = await this.session.stopped;
            this.finishLogout(end.reason === 'logged-out');
        } catch (error) {
            this.event('error', error instanceof Error ? error.message : 'Embedded session failed');
        } finally {
            this.finishLogout(false);
            this.close();
            this.finishStopped();
        }
    }
    send(data: string) {
        if (this.readyState !== 1) throw new Error('Embedded session is disconnected');
        const message = JSON.parse(data);
        if (message.type === 'sdk_connect') {
            if (message.username !== this.options.username || message.password !== this.options.password || message.mode !== 'control') {
                this.message({ type: 'sdk_error', error: 'Embedded session identity or mode mismatch' });
                return;
            }
            this.authenticated = true;
            this.message({ type: 'sdk_connected', maxMessageLength: this.session!.client.getMaxMessageLength() });
            this.publish();
        } else if (message.type === 'sdk_action' && this.authenticated) {
            this.options.authorize?.();
            const queued = this.queue.enqueue({ action: message.action, actionId: message.actionId }, Math.max(0, (message.actionTimeoutMs ?? 60_000) - 1000));
            if (!queued) this.result(message.actionId, { success: false, message: 'Action queue is full', phase: 'validation', reason: 'busy' });
            if (this.testClock) queueMicrotask(() => this.pump());
        }
    }
    beginGeneration() {
        this.queue.beginGeneration();
        const active = this.queue.active;
        if (active?.action.type === 'wait') {
            this.waiting = 0;
            this.queue.complete(active);
        }
    }
    close() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.beginGeneration();
        clearInterval(this.timer);
        this.session?.stop();
        this.event('close');
    }
    private result(actionId: string | null, result: ActionResult) {
        if (actionId) this.message({ type: 'sdk_action_result', actionId, result });
    }
    private publish() {
        if (!this.authenticated || !this.session) return;
        const state = this.session.client.collectBotState(this.tick);
        if (state) this.message({ type: 'sdk_state', state, stateReceivedAt: Date.now() });
    }
    private complete(entry: QueuedBotAction, result: ActionResult) {
        if (this.queue.active !== entry) return;
        const current = this.queue.isCurrentGeneration(entry);
        this.queue.complete(entry);
        if (current) {
            this.result(entry.actionId, result);
            this.publish();
        }
        if (this.testClock) queueMicrotask(() => this.pump());
    }
    private pump() {
        if (this.readyState !== 1 || !this.session) return;
        for (const entry of this.queue.expirePending())
            this.result(entry.actionId, {
                success: false,
                message: 'Action expired in queue',
                phase: 'validation',
                reason: 'queue_expired'
            });
        const expired = this.queue.expireActive();
        if (expired && this.queue.isCurrentGeneration(expired))
            this.result(expired.actionId, {
                success: false,
                message: 'Active action expired',
                phase: 'completion',
                reason: 'queue_expired'
            });
        if (this.waiting > 0) {
            this.waiting--;
            if (this.waiting === 0 && this.queue.active) this.complete(this.queue.active, { success: true, message: 'Wait complete', phase: 'completion' });
            return;
        }
        if (this.queue.active) return;
        const entry = this.queue.startNext();
        if (!entry) return;
        try {
            this.options.authorize?.();
            const action = entry.action as BotAction;
            const result = action.type === 'testClockYield' ? (this.testClock ? this.testClock() : { success: false, message: 'Test clock unavailable' }) : this.session.client.executeBotAction(action);
            if (result instanceof Promise)
                void result.then(
                    value => this.complete(entry, value as ActionResult),
                    () => this.complete(entry, { success: false, message: 'Action execution failed', phase: 'completion', reason: 'execution_error' })
                );
            else if (action.type === 'wait' && result.success) this.waiting = action.ticks || 1;
            else this.complete(entry, result);
        } catch {
            this.complete(entry, { success: false, message: 'Action execution failed', phase: 'completion', reason: 'execution_error' });
        }
    }
}

/** Session injection allows protocol fixtures to exercise the real queue without a game server. */
export function createEmbeddedSocket(options: SessionOptions, dependencies: { startSession?: typeof startSession } = {}) {
    return new EmbeddedSocket(options, dependencies.startSession);
}
