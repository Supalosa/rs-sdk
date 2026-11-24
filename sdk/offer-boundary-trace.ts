/** Opt-in local client observations; none of these events is a server ACK. */
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { BotWorldState } from './types';

type Row = { monoMs: number; actor: string; event: string; data: unknown };
type Sink = { rows: Row[]; count: number; dropped: number; timer?: ReturnType<typeof setTimeout>; writing: boolean; failed: boolean; file?: Awaited<ReturnType<typeof open>> };
const key = Symbol.for('rs-sdk.offer-boundary-trace.v1');
const shared = globalThis as typeof globalThis & { [key]?: Sink };

export function offerBoundaryEnabled(): boolean {
    return typeof process !== 'undefined' && !!process.env.RS_OFFER_BOUNDARY_TRACE_PATH;
}

function schedule(sink: Sink, path: string) {
    if (sink.timer || sink.writing || sink.failed) return;
    // Leave packet processing and +2 polling before encoding or writing JSON.
    sink.timer = setTimeout(async () => {
        sink.timer = undefined;
        sink.writing = true;
        try {
            sink.file ??= await open(path, 'wx', 0o600);
            const rows = sink.rows.splice(0);
            await sink.file.writeFile(rows.map(row => JSON.stringify({ ...row, dropped: sink.dropped }) + '\n').join(''));
        } catch {
            sink.failed = true;
            sink.rows.length = 0;
        } finally {
            sink.writing = false;
            if (sink.rows.length) schedule(sink, path);
        }
    }, 100);
}

export function offerBoundaryTrace(actor: string, event: string, project: () => unknown): void {
    if (!offerBoundaryEnabled()) return;
    const path = process.env.RS_OFFER_BOUNDARY_TRACE_PATH!;
    if (!isAbsolute(path)) return;
    const sink: Sink = shared[key] ??= { rows: [], count: 0, dropped: 0, writing: false, failed: false };
    if (sink.failed) return;
    if (sink.count >= 32_768 || sink.rows.length >= 2_048) { sink.dropped++; return; }
    try {
        const monoMs = performance.now();
        sink.rows.push({ monoMs, actor: actor.slice(0, 64), event, data: project() });
        sink.count++;
        schedule(sink, path);
    } catch { /* Tracing cannot change gameplay. */ }
}

export function offerBoundarySnapshot(state: BotWorldState) {
    const t = state.trade;
    const items = (offer: NonNullable<BotWorldState['trade']>['myOffer']) =>
        offer.slice(0, 28).map(({ id, count }) => ({ id, count }));
    return { clientTick: state.tick, open: !!t?.isOpen, screen: t?.screen,
        peer: t?.partner?.slice(0, 64), own: t ? items(t.myOffer) : [], other: t ? items(t.theirOffer) : [] };
}
