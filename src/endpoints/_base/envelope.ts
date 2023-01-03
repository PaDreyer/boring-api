import {Context} from "../../core/context";

export function handler(ctx: Context) {
    ctx.payload = JSON.stringify(ctx.payload);
}