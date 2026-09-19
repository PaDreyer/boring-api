import type { ErrorHandler } from "./$types";

export const handler: ErrorHandler = () => {
    return { error: { message: "Order not found" } };
};
