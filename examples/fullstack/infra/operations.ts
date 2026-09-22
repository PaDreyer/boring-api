import type { OperationalAdapter, OperationalRecord } from "@boringapi/core";

interface OperationalStream {
    write(line: string): boolean;
    once(event: "drain", listener: () => void): unknown;
}

/** JSON Lines on stderr keeps command stdout machine-readable and payloads out of telemetry. */
export function createOperations(stream: OperationalStream = process.stderr): OperationalAdapter {
    let drain: Promise<void> | undefined;
    async function write(line: string): Promise<void> {
        while (drain) await drain;
        if (stream.write(line)) return;
        const pending = new Promise<void>(resolve => stream.once("drain", resolve));
        drain = pending;
        try { await pending; }
        finally { if (drain === pending) drain = undefined; }
    }
    return {
        emit: (record: OperationalRecord) => write(`${JSON.stringify(record)}\n`),
        async flush() { while (drain) await drain; },
    };
}
