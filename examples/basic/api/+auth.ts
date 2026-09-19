import { timingSafeEqual } from "crypto";
import { Context, HttpError } from "../../../src";

/** Example only: replace this file with the application's identity provider. */
export function authenticate(ctx: Context) {
    const expected = process.env.BORING_API_TOKEN;
    const header = ctx.request.header("authorization");
    if (!expected || !header?.startsWith("Bearer ")) return;

    const actual = Buffer.from(header.slice(7));
    const secret = Buffer.from(expected);
    if (actual.length === secret.length && timingSafeEqual(actual, secret)) {
        return { role: "admin" as const };
    }
}

export function authorize(ctx: Context, role: "admin") {
    const session = ctx.session as { role?: string } | undefined;
    if (session?.role !== role) throw new HttpError(403, "Forbidden");
}
