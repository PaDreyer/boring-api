export const authorization = { allOf: ["orders:read", "orders:create"] } as const;
export const handler = () => ({ all: true });
