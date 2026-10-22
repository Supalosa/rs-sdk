import type { BotWorldState } from './types';
import { throwIfExecutionAborted } from './execution-context';

/** Cooperative test clock. Concurrent waiters share an in-flight tick. */
export class LockstepClock {
    private pending?: Promise<BotWorldState>;
    constructor(private step: () => Promise<BotWorldState>) {}

    yield(): Promise<BotWorldState> {
        throwIfExecutionAborted();
        return this.pending ??= this.step().finally(() => { this.pending = undefined; });
    }

    async wait(predicate: (state: BotWorldState) => boolean, timeoutMs: number, message: string): Promise<BotWorldState> {
        const deadline = Date.now() + 30000;
        // Legacy SDK timeouts are ordinary game time; hardware speed must not
        // determine the number of simulated ticks allowed to satisfy them.
        const ticks = Math.max(1, Math.ceil(timeoutMs / 400));
        for (let tick = 0; tick < ticks; tick++) {
            if (Date.now() >= deadline) throw new Error('Lockstep wait watchdog expired');
            const state = await this.yield();
            if (predicate(state)) return state;
        }
        throw new Error(message);
    }
}
