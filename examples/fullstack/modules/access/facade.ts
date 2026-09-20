import { requirePermissions } from "@boringapi/core";
import type { Actor, AuthorizationRule } from "./schemas";

export function requireAccess(actor: Actor, rule: AuthorizationRule): void {
    requirePermissions(actor.permissions, rule);
}

import type { IdentityProvider } from "./ports/identity";
import { authenticate } from "./service";

/** Authentication uses the same public boundary as other application operations. */
export function createAccess(identity: IdentityProvider) {
    return {
        authenticate(header: string | undefined): Actor | undefined {
            return authenticate(header, identity);
        },
    };
}
