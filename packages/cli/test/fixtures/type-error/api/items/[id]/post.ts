import z from "zod";
import type { PostHandler } from "./$types";

export const output = z.object({ count: z.number() });

export const handler: PostHandler = () => ({ count: "wrong" });
