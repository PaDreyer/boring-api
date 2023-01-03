import { Logger } from "./logger";

export class SetupContext  extends Map {
    mergeWithDefault() {
        if (!this.has("logger")) {
            this.set("logger", new Logger());
        }
    }
}
