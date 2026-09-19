import type { ErrorHandler } from "./$types";

export const handler: ErrorHandler = () => {
    return { error: { message: "Internal Server Error" } };
};
