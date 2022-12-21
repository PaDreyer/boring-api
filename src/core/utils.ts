import {Setup} from "./index";
import {Logger} from "./logger";

export function getLogger(setup: Setup): Logger {
    if (!setup.has("logger")) throw new Error("Missing Logger");

    return setup.get("logger");
}