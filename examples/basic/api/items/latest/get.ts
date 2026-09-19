import type { GetHandler } from "./$types";

export const envelope = false;

export const handler: GetHandler = () => ({ id: "latest", source: "static" });
