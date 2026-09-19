import { join } from "node:path";
import { registerTypeScript } from "@boringapi/core/register";

registerTypeScript(join(__dirname, "../api"));
