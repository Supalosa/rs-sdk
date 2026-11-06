import type { BankState, BankTickObservation } from './types.js';

/** One immutable bank witness per observed client tick, shared by all publishers. */
export class BankObservationTracker {
    private sampledTick = -1;
    private generation = -1;
    private latest?: BankTickObservation;

    observe(tick: number, generation: number, bank: BankState, publish: boolean): BankTickObservation | undefined {
        if (generation !== this.generation) {
            this.generation = generation;
            this.sampledTick = -1;
            this.latest = undefined;
        }
        if (publish && tick > this.sampledTick) {
            this.sampledTick = tick;
            if (bank.contentsKnown === true) {
                this.latest = {
                    clientGeneration: generation,
                    clientTick: tick,
                    observedAt: new Date().toISOString(),
                    items: bank.items.map(item => ({ ...item }))
                };
            }
        }
        return this.latest ? structuredClone(this.latest) : undefined;
    }
}
