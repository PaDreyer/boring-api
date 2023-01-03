import {Context} from "../../core/context";

export function handler(ctx: Context, err: Error) {
    console.log("Err: ", err);
    ctx.send(ctx.statusCode);
}