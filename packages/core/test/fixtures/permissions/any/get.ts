export const authorization = { anyOf: ["orders:read", "orders:create"] } as const;
export const handler = () => ({ any: true });
