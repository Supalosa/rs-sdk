import type { LiteClient } from './LiteClient.js';
import type { ActionResult } from '#/bot/ActionExecutor.js';
import type { BotWorldState } from '#/bot/types.js';

// Enabled only on isolated test workers. All fences use the game WebSocket.
export function installClientTestClock(client: LiteClient, readState: () => BotWorldState | null) {
    const url = process.env.TEST_CLOCK_URL;
    const token = process.env.TEST_CLOCK_TOKEN;
    if (!url || !token) return undefined;
    const stream = client.conn.stream;
    let sequence = 0;
    let pending: { sequence: number; resolve: (value: ActionResult) => void; reject: (error: Error) => void } | undefined;
    stream.onControlFrame = (message) => {
        if (!message.startsWith("rs-test-tick:")) return;
        const marker = Number(message.slice("rs-test-tick:".length));
        if (!pending || pending.sequence !== marker) return;
        const request = pending;
        void client.pumpPackets().then(() => {
            request.resolve({ success: true, phase: "completion", data: readState() });
        }, request.reject);
    };
    return async () => {
        if (pending) throw new Error("Concurrent lockstep yield");
        sequence++;
        let timer: ReturnType<typeof setTimeout>;
        try {
            const observation = new Promise<ActionResult>((resolve, reject) => {
                pending = { sequence, resolve, reject };
                timer = setTimeout(() => reject(new Error("Lockstep observation watchdog expired")), 10000);
            });
            void observation.catch(() => {});
            // Flush and fence share a WebSocket. Receipt of the fence proves
            // that prior game packets reached the server before it steps.
            client.flush();
            stream.sendControlFrame(`rs-test-fence:${token}:${sequence}`);
            const response = await fetch(url + "/step", {
                method: "POST",
                headers: { authorization: "Bearer " + token, "content-type": "application/json" },
                body: JSON.stringify({ username: process.env.BOT_USERNAME, sequence }),
                signal: AbortSignal.timeout(10000),
            });
            if (!response.ok) {
                throw new Error(`Lockstep step failed: ${response.status} ${await response.text()}`);
            }
            return await observation;
        } finally {
            clearTimeout(timer!);
            pending = undefined;
        }
    };
}
