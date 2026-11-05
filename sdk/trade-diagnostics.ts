/** Temporary opt-in diagnostics. Never serialize credentials or arbitrary action payloads. */
import { appendFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

type Sink = { path: string; lines: string[]; bytes: number; pendingBytes: number; sequence: number; dropped: number; disabled: boolean; timer: ReturnType<typeof setInterval> };
const key = Symbol.for('rs-sdk.temporary-trade-diagnostics.v1');
const shared = globalThis as typeof globalThis & { [key]?: Sink };
const LIMIT = 512 * 1024 * 1024;
let initializationFailed = false;
export function tradeTraceEnabled(username: string): boolean {
    if (initializationFailed || typeof process === 'undefined' || !process.env.RS_TRADE_TRACE_PATH) return false;
    const users = process.env.RS_TRADE_TRACE_USERS?.split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
    return !users?.length || users.includes(username.toLowerCase());
}
export function flushTradeTrace(): void {
    const sink = shared[key];
    if (!sink || sink.disabled || !sink.lines.length) return;
    const lines = sink.lines.splice(0).join('');
    sink.pendingBytes = 0;
    try {
        appendFileSync(sink.path, lines, { mode: 0o600 });
        sink.bytes += Buffer.byteLength(lines);
    } catch {
        sink.disabled = true;
        clearInterval(sink.timer);
        console.warn('[trade-trace] Writing diagnostics failed; tracing disabled');
    }
}
function getSink(): Sink | undefined {
    if (shared[key]) return shared[key];
    const path = process.env.RS_TRADE_TRACE_PATH;
    if (!path || !isAbsolute(path)) { initializationFailed = true; return; }
    try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        // Fresh output only. A mistaken rerun must not overwrite/mix earlier evidence.
        closeSync(openSync(path, 'wx', 0o600));
    } catch {
        initializationFailed = true;
        console.warn('[trade-trace] Output must be a new writable absolute path; tracing disabled');
        return;
    }
    const sink = { path, lines: [], bytes: 0, pendingBytes: 0, sequence: 0, dropped: 0, disabled: false } as unknown as Sink;
    shared[key] = sink;
    sink.timer = setInterval(flushTradeTrace, 100);
    sink.timer.unref?.();
    process.once('exit', flushTradeTrace);
    return sink;
}
/** Lazy projection keeps disabled logging cheap; I/O/serialization failures never fail gameplay. */
export function tradeTrace(username: string, layer: string, event: string, project: () => unknown): void {
    if (!tradeTraceEnabled(username)) return;
    try {
        const sink = getSink();
        if (!sink || sink.disabled) return;
        if (sink.lines.length >= 4096) { sink.dropped++; return; }
        const line = JSON.stringify({ version: 1, seq: ++sink.sequence, at: Date.now(), monoMs: performance.now(),
            pid: process.pid, username, layer, event, dropped: sink.dropped, data: project() }) + '\n';
        if (sink.bytes + sink.pendingBytes + Buffer.byteLength(line) > LIMIT) {
            flushTradeTrace();
            sink.disabled = true;
            clearInterval(sink.timer);
            console.warn('[trade-trace] 512 MiB limit reached; tracing disabled');
            return;
        }
        sink.lines.push(line);
        sink.pendingBytes += Buffer.byteLength(line);
    } catch { /* Diagnostics must not change action or packet handling. */ }
}
/** Allowlist avoids passwords, tokens, chat contents and unrelated action arguments. */
export function tradeTraceAction(action: unknown): Record<string, unknown> {
    const value = action as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of ['type', 'playerIndex', 'optionIndex', 'componentId', 'interfaceId', 'slot', 'amount', 'x', 'z', 'locId'])
        if ((typeof value?.[key] === 'string' && key === 'type') || typeof value?.[key] === 'number') result[key] = value[key];
    return result;
}
export function tradeTraceState(input: unknown): unknown {
    const s = input as any;
    if (!s) return null;
    const items = (list: any[]) => list?.map(i => ({ slot: i.slot, id: i.id, count: i.count ?? i.amount })).slice(0, 28);
    const t = s.trade;
    return { tick: s.tick, observationId: s.observationId, inGame: s.inGame,
        position: s.player && { x: s.player.worldX, z: s.player.worldZ, plane: s.player.level, anim: s.player.animId },
        trade: t && { open: t.isOpen, screen: t.screen, partner: t.partner, myAccepted: t.myAccepted,
            partnerAccepted: t.partnerAccepted, myOffer: items(t.myOffer), theirOffer: items(t.theirOffer) },
        dialog: s.dialog && { open: s.dialog.isOpen, pageId: s.dialog.pageId,
            options: s.dialog.options?.map((o: any) => ({ text: o.text?.slice(0, 256), componentId: o.componentId })).slice(0, 12),
            components: s.dialog.allComponents?.filter((c: any) => c.text).slice(0, 16).map((c: any) => ({ id: c.id, text: c.text?.slice(0, 256) })) },
        interface: s.interface && { open: s.interface.isOpen, id: s.interface.interfaceId },
        inventory: items(s.inventory), rc: s.skills?.find((s: any) => /^runecraft(?:ing)?$/i.test(s.name)),
        messages: s.gameMessages?.filter((m: any) => m.type === 0 || m.type === 4).slice(-12)
            .map((m: any) => ({ type: m.type, tick: m.tick, observationId: m.observationId, sender: m.sender, text: m.text?.slice(0, 400) })) };
}
