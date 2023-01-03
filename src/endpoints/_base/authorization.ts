import {Context} from "../../core/context";

export function handler(ctx: Context, authorization: any) {
    const session = ctx.get("session");

    if (!session) throw new Error("401");

    if (session.role !== authorization) {
        throw new Error("403")
    }
}