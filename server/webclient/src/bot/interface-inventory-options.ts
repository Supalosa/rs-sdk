import type { InterfaceOption } from '../../../../sdk/types';
import type IfType from '#/config/IfType.js';
import ObjType from '#/config/ObjType.js';

export function visibleInventoryOperation(operation: string | null | undefined): string | undefined {
    const label = operation?.trim();
    return label && !/^hidden$/i.test(label) ? label : undefined;
}

/** Item IDs in interface inventories are encoded as id + 1. */
export function inventoryInterfaceOptions(root: number, list: IfType[], startIndex = 0): InterfaceOption[] {
    const options: InterfaceOption[] = [];
    const seen = new Set<number>();
    function scan(id: number, depth: number) {
        const com = list[id];
        if (depth > 12 || seen.has(id) || !com || (com.type === 0 && com.hide)) return;
        seen.add(id);
        if (com.type === 2 && com.linkObjType && (com.iop || com.objOps)) {
            for (let slot = 0; slot < com.linkObjType.length; slot++) {
                const encoded = com.linkObjType[slot];
                if (encoded <= 0) continue;
                const itemId = encoded - 1;
                const item = ObjType.list(itemId);
                for (let index = 0; index < 5; index++) {
                    const operation = visibleInventoryOperation(com.iop?.[index])
                        ?? (com.objOps ? visibleInventoryOperation(item.iop?.[index]) : undefined);
                    if (!operation) continue;
                    options.push({ index: startIndex + options.length + 1, text: `${operation} ${item.name ?? `item ${itemId}`}`, componentId: id, slot, itemId, operationIndex: index + 1 });
                }
            }
        }
        for (const child of com.children ?? []) scan(child, depth + 1);
    }
    scan(root, 0);
    return options;
}
