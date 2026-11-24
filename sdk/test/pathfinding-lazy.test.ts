import { expect, test } from 'bun:test';
import { mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sdkDirectory = fileURLToPath(new URL('..', import.meta.url));

test('pathfinding module and door evidence work without map assets until first map query', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lazy-pathfinding-'));
    try {
        copyFileSync(join(sdkDirectory, 'pathfinding.ts'), join(directory, 'pathfinding.ts'));
        const child = Bun.spawn([process.execPath, '-e', `
            const pf = await import(${JSON.stringify(join(directory, 'pathfinding.ts'))});
            const blocks = new pf.TemporaryDoorBlocklist();
            if (blocks.active().length !== 0) throw new Error('Unexpected door evidence');
            let failed = false;
            try { pf.isZoneAllocated(0, 3248, 3282); }
            catch { failed = true; }
            if (!failed) throw new Error('Map query should require the missing assets');
        `], { stdout: 'pipe', stderr: 'pipe' });
        const stderr = new Response(child.stderr).text();
        expect(await child.exited, await stderr).toBe(0);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('SDK imports defer maps and the first map query initializes them once', async () => {
    // A fresh process prevents earlier pathfinding tests from hiding eager loads.
    const child = Bun.spawn([process.execPath, '-e', `
        await import('./index.ts');
        await import('./actions.ts');
        await import('./runner.ts');
        const pf = await import('./pathfinding.ts');
        const loadedAssets = () => Object.keys(require.cache).filter(p =>
            p.includes('/vendor/rsmod-pathfinder/') || p.endsWith('/collision-data.json'));
        const before = loadedAssets();
        let initializations = 0;
        const write = console.log.bind(console);
        console.log = (...args) => {
            if (String(args[0]).startsWith('Pathfinding initialized')) initializations++;
        };
        const land = pf.isZoneLikelyLand(0, 3248, 3282);
        const path = pf.findLongPath(0, 3248, 3282, 3246, 3284);
        pf.initPathfinding();
        write(JSON.stringify({
            before, land, path, initializations, after: loadedAssets()
        }));
    `], { cwd: sdkDirectory, stdout: 'pipe', stderr: 'pipe' });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    expect(await child.exited, await stderr).toBe(0);
    const result = JSON.parse(await stdout);
    expect(result.before).toEqual([]);
    expect(result.land).toBeTrue();
    expect(result.path.at(-1)).toEqual({ x: 3246, z: 3284, level: 0 });
    expect(result.initializations).toBe(1);
    expect(result.after.some((p: string) => p.includes('/vendor/rsmod-pathfinder/'))).toBeTrue();
    expect(result.after.some((p: string) => p.endsWith('/collision-data.json'))).toBeFalse();
});
