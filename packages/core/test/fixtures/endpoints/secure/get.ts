export const authentication = true;
export const authorization = "admin";
export async function handler() {
    await Promise.resolve();
    return { ok: true };
}
