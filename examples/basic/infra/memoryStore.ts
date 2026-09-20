import { randomUUID } from "node:crypto";

/** Demo storage only: records disappear on restart and are local to one app instance. */
export function createMemoryStore<T extends { id: string }>() {
    const records = new Map<string, T>();

    return {
        newId: randomUUID,
        async insert(value: T): Promise<void> {
            records.set(value.id, structuredClone(value));
        },
        async find(id: string): Promise<T | undefined> {
            const value = records.get(id);
            return value === undefined ? undefined : structuredClone(value);
        },
    };
}
