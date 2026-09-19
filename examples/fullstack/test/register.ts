import { join } from "node:path";
import { registerTypeScript } from "@boringapi/compiler/register";

registerTypeScript(join(__dirname, "../api"));
