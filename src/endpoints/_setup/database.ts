import {Setup} from "../../core";

export async function setup(ctx: Setup) {
    console.info("Initializing database");
    ctx.set("database", "database");
}