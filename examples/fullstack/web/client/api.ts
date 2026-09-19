import { createClient } from "@boringapi/core/client";
import type { ApiRoutes } from "$client";

/** Authentication is read at request time; the token remains only in component memory. */
export const createApi = (token: () => string) => createClient<ApiRoutes>("", {
    headers: () => ({ Authorization: `Bearer ${token()}` }),
});
