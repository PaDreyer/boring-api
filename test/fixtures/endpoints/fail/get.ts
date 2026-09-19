export async function handler() {
    await Promise.resolve();
    throw new Error("private failure detail");
}
