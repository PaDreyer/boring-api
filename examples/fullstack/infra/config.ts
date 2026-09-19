export function databaseUrl(): string {
    const value = process.env.DATABASE_URL;
    if (!value) throw new Error("Set DATABASE_URL and run the explicit migration command before starting the application.");
    return value;
}
