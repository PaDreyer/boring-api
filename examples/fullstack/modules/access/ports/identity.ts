import type { Actor } from "../schemas";

export interface IdentityProvider {
    authenticate(header: string | undefined): Actor | undefined;
}
