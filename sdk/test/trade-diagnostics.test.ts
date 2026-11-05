import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flushTradeTrace, tradeTrace, tradeTraceAction, tradeTraceState } from '../trade-diagnostics';

const previousPath = process.env.RS_TRADE_TRACE_PATH;
const previousUsers = process.env.RS_TRADE_TRACE_USERS;
afterAll(() => {
    if (previousPath === undefined) delete process.env.RS_TRADE_TRACE_PATH; else process.env.RS_TRADE_TRACE_PATH = previousPath;
    if (previousUsers === undefined) delete process.env.RS_TRADE_TRACE_USERS; else process.env.RS_TRADE_TRACE_USERS = previousUsers;
});
test('disabled diagnostics never evaluate projections', () => {
    delete process.env.RS_TRADE_TRACE_PATH;
    tradeTrace('alice', 'test', 'disabled', () => { throw new Error('must not run'); });
});
test('trace correlates action IDs without credentials or private/public chat and survives projection failure', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'trade-diag-')), 'trace.ndjson');
    process.env.RS_TRADE_TRACE_PATH = path;
    process.env.RS_TRADE_TRACE_USERS = 'alice';
    tradeTrace('bob', 'test', 'filtered', () => { throw new Error('must not run'); });
    tradeTrace('alice', 'sdk', 'action', () => ({ actionId: 'act-1', action: tradeTraceAction({
        type: 'interactPlayer', playerIndex: 7, password: 'secret', token: 'token-secret', message: 'private-chat' }) }));
    tradeTrace('alice', 'test', 'broken', () => { throw new Error('projection failed'); });
    tradeTrace('alice', 'lite', 'state', () => tradeTraceState({ tick: 4, password: 'secret',
        gameMessages: [{ type: 3, text: 'private-chat' }, { type: 2, text: 'public-chat' },
            { type: 0, text: 'Bob is busy at the moment.' }],
        dialog: { isOpen: true, allComponents: [{ id: 1, text: 'You can now craft Body Runes.' }] } }));
    flushTradeTrace();
    const raw = readFileSync(path, 'utf8');
    const records = raw.trim().split('\n').map(line => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[0].data).toEqual({ actionId: 'act-1', action: { type: 'interactPlayer', playerIndex: 7 } });
    expect(records[1].data.dialog.components[0].text).toContain('Body Runes');
    expect(records[1].data.messages[0].text).toContain('busy');
    expect(raw).not.toMatch(/secret|private-chat|public-chat/);
    expect(records[1].seq).toBeGreaterThan(records[0].seq);
    expect(statSync(path).mode & 0o777).toBe(0o600);
});
