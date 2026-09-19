import { join } from "node:path";
import { registerTypeScript } from "@boringapi/core/register";

// Preload before compiling a script whose own imports use Boring aliases.
registerTypeScript(join(__dirname, "api"), join(__dirname, "tsconfig.json"));
