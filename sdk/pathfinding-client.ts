import type { DoorInfo } from './pathfinding';
import { executionContext, throwIfExecutionAborted } from './execution-context';

export type PathWaypoint = { x: number; z: number; level: number };
export type PathResult = { success: boolean; waypoints: PathWaypoint[]; reachedDestination?: boolean; error?: string };
type ServicePath = PathResult & { destinationZoneAllocated?: boolean };
export type DoorRoute = { waypoints: PathWaypoint[]; doors: DoorInfo[] };

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object';
const coordinate = (value: unknown): value is number =>
    Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 16383;
const tile = (value: unknown): value is PathWaypoint =>
    record(value) &&
    coordinate(value.x) &&
    coordinate(value.z) &&
    Number.isInteger(value.level) &&
    Number(value.level) >= 0 &&
    Number(value.level) <= 3;
const door = (value: unknown): value is DoorInfo =>
    record(value) &&
    Number.isInteger(value.shape) &&
    Number.isInteger(value.angle) &&
    typeof value.blockrange === 'boolean' &&
    tile(value);
const waypoints = (value: unknown): value is PathWaypoint[] =>
    Array.isArray(value) && value.length <= 16384 && value.every(tile);

/** Private v1 pathfinding service. Failures never trigger local map loading. */
export class PathfindingClient {
    private endpoint: string;
    constructor(
        server: string,
        private timeoutMs: number,
    ) {
        const url = new URL(server);
        if (
            !['http:', 'https:'].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            (url.pathname !== '/' && url.pathname !== '')
        ) {
            throw new Error('pathfindingServer must be an HTTP(S) origin without credentials');
        }
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
            throw new Error('pathfindingTimeout must be positive and finite');
        this.endpoint = `${url.origin}/v1/query`;
    }

    private async query<T>(request: object, valid: (value: unknown) => value is T): Promise<T> {
        throwIfExecutionAborted();
        const controller = new AbortController();
        const scope = executionContext.getStore()?.signal;
        const abort = () => controller.abort(scope?.reason);
        scope?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => controller.abort(new Error('Pathfinding request timed out')), this.timeoutMs);
        try {
            const response = await fetch(this.endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(request),
                signal: controller.signal,
            });
            if (!response.ok) {
                await response.body?.cancel();
                throw new Error(`Pathfinding service returned HTTP ${response.status}`);
            }
            const value: unknown = await response.json();
            throwIfExecutionAborted();
            if (!valid(value)) throw new Error('Invalid pathfinding service response');
            return value;
        } finally {
            clearTimeout(timer);
            scope?.removeEventListener('abort', abort);
        }
    }

    findPath(
        source: PathWaypoint,
        destination: { x: number; z: number },
        maxWaypoints: number,
        blockedDoors: DoorInfo[],
    ) {
        return this.query<ServicePath>(
            {
                operation: 'findPath',
                source,
                destination,
                maxWaypoints,
                blockedDoors: blockedDoors.map(({ x, z, level }) => ({ x, z, level })),
            },
            (value): value is ServicePath =>
                record(value) &&
                typeof value.success === 'boolean' &&
                waypoints(value.waypoints) &&
                (value.error === undefined || typeof value.error === 'string') &&
                (!value.success ||
                    (typeof value.reachedDestination === 'boolean' &&
                        typeof value.destinationZoneAllocated === 'boolean')),
        );
    }

    async isTileWalkable(level: number, x: number, z: number) {
        const result = await this.query<{ walkable: boolean }>(
            { operation: 'inspectTile', tile: { level, x, z } },
            (value): value is { walkable: boolean } => record(value) && typeof value.walkable === 'boolean',
        );
        return result.walkable;
    }

    async getDoor(level: number, x: number, z: number) {
        const result = await this.query<{ door: DoorInfo | null }>(
            { operation: 'getDoor', tile: { level, x, z } },
            (value): value is { door: DoorInfo | null } => record(value) && (value.door === null || door(value.door)),
        );
        return result.door;
    }

    planDoorRoute(points: PathWaypoint[], start?: { x: number; z: number }) {
        return this.query<DoorRoute>(
            { operation: 'planDoorRoute', waypoints: points, start },
            (value): value is DoorRoute =>
                record(value) && waypoints(value.waypoints) && Array.isArray(value.doors) && value.doors.every(door),
        );
    }
}
