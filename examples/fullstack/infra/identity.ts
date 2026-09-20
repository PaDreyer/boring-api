import { timingSafeEqual } from "node:crypto";
import type { IdentityProvider } from "$modules/access/ports/identity";

/** Demonstration bearer-token provider; configure the token outside source control. */
export function createIdentity(token: string | undefined): IdentityProvider {
    return {
        authenticate(header) {
            if (!token || !header?.startsWith("Bearer ")) return undefined;
            const candidate = Buffer.from(header.slice(7));
            const expected = Buffer.from(token);
            if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) return undefined;
            return { kind: "user", id: "demo-operator", permissions: ["orders:read", "orders:create"] };
        },
    };
}
