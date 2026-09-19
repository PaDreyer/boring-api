import { SetupContext } from "../../../src";

export function setup(ctx: SetupContext) {
    ctx.logger.info("Preparing example services");
    return { serviceName: "boring-api" };
}
