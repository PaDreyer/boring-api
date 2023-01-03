import { SetupContext } from "../../core/setupContext";

export async function setup(setupCtx: SetupContext) {
    console.info("Initializing database");
    setupCtx.set("database", "database");
}