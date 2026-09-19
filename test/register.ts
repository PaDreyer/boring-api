import { join } from "path";
import { registerTypeScript } from "../src/register";

registerTypeScript(join(__dirname, "../examples/basic/api"));
