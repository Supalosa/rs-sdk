// Headless bot runner: a LiteClient session wired to the SDK gateway.
//
// This is BotOverlay minus the browser - same StateCollector, ActionExecutor
// and BotActionQueue, but the gateway socket is a plain Bun WebSocket instead
// of the in-page GatewayConnection (which needs window.location). Controlling
// SDKs (sdk/runner.ts scripts, sdk/cli.ts, MCP execute_code) pair with it
// exactly as they would with a browser tab.
//
//   bun src/lite/runner.ts <botname>          # reads bots/<botname>/bot.env
//
// Run from server/webclient so the '#/*' import map resolves.

import { fileURLToPath } from 'node:url';

import { LiteGatewayRunner, type LiteGatewayOptions } from './gateway-runner.js';
import { LoginError, OutdatedClientError } from './net/GameConnection.js';
import { startSession, type SessionOptions } from './session.js';
import { FAST_KBD_RUNTIME_MODE } from './fast-kbd.js';

export interface LiteRunnerOptions extends Pick<LiteGatewayOptions, 'onState' | 'testClock'> {
    session?: Pick<SessionOptions, 'bankClientGeneration' | 'secured' | 'cacheDir'>;
    onLogin?: (username: string) => void | Promise<void>;
    onLoginError?: (error: LoginError, username: string) => number | undefined | Promise<number | undefined>;
}

function deriveGatewayUrl(server: string): string {
    if (!server) return 'ws://localhost:7780';
    if (server.startsWith('ws://') || server.startsWith('wss://')) return server;
    if (server.startsWith('localhost') || server.startsWith('127.')) {
        return `ws://${server.includes(':') ? server : server + ':7780'}`;
    }
    return `wss://${server}/gateway`;
}

// The demo server moved off rs-sdk-demo.fly.dev; older bot.env files keep the old name.
const LEGACY_SERVER_HOSTS: Record<string, string> = { 'rs-sdk-demo.fly.dev': 'rs-sdk.maxbittker.com' };

export async function runLiteGateway(botName: string, options: LiteRunnerOptions = {}): Promise<number> {
    const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
    const envPath = `${repoRoot}bots/${botName}/bot.env`;
    const env = process.env.BOT_USERNAME && process.env.PASSWORD ? process.env : Object.fromEntries(
        (await Bun.file(envPath).text())
            .split('\n')
            .filter(line => line.includes('=') && !line.startsWith('#'))
            .map(line => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()])
    );

    const host = LEGACY_SERVER_HOSTS[env.SERVER ?? ''] ?? (env.SERVER || 'localhost');
    const username = env.BOT_USERNAME!;
    // Mirror the server's NODE_PROFANITY_FILTER for locally displayed chat.
    const profanityRaw = (env.PROFANITY_FILTER ?? process.env.PROFANITY_FILTER ?? '').toLowerCase();
    let session;
    try {
        session = await startSession({
            ...options.session,
            host,
            username,
            password: env.PASSWORD!,
            profanityFilter: ['false', '0', 'off', 'no'].includes(profanityRaw) ? false : undefined,
            quiet: true
        });
    } catch (error) {
        if (error instanceof OutdatedClientError) {
            console.error(`[lite-runner] ${error.message}`);
            return 3;
        }
        if (error instanceof LoginError) {
            const exitCode = await options.onLoginError?.(error, username);
            if (exitCode !== undefined) return exitCode;
        }
        throw error;
    }

    let runner: LiteGatewayRunner | undefined;
    const interrupt = () => runner?.stop();
    try {
        await options.onLogin?.(username);
        console.log(`[lite-runner] '${username}' logged into ${host}`);

        const gatewayUrl = env.GATEWAY_URL || process.env.GATEWAY_URL || deriveGatewayUrl(host);
        const runtimeMode = await Bun.file(`${repoRoot}bots/logs/fleet-runtime.mode`).text()
            .then(value => value.trim())
            .catch(() => '');
        const fastKbdAttackEnabled = runtimeMode === FAST_KBD_RUNTIME_MODE;
        if (fastKbdAttackEnabled) {
            console.log('[lite-runner] in-process KBD op2 enabled');
        }
        runner = new LiteGatewayRunner(session, gatewayUrl, {
            fastKbdAttackEnabled,
            onState: options.onState,
            testClock: options.testClock
        });
        runner.connect();
        process.once('SIGINT', interrupt);

        const end = await session.stopped;
        console.log(`[lite-runner] Game session ended (${end.reason})`, end.error ?? '');
        return end.reason === 'stopped' ? 0 : 1;
    } finally {
        process.removeListener('SIGINT', interrupt);
        if (runner) runner.stop();
        else session.stop();
    }
}

if (import.meta.main) {
    const botName = process.argv[2];
    if (!botName) {
        console.error('Usage: bun src/lite/runner.ts <botname>');
        process.exit(1);
    }
    const { TEST_CLOCK_URL: url, TEST_CLOCK_TOKEN: token } = process.env;
    process.exit(await runLiteGateway(botName, { testClock: url && token ? { url, token } : undefined }));
}
