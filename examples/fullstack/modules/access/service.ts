import type { IdentityProvider } from "./ports/identity";

export function authenticate(header: string | undefined, identity: IdentityProvider) {
    return identity.authenticate(header);
}
