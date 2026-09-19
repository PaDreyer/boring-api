export class Logger {
    http(method: string, path: string, code: number, duration: number) {
        console.info(`[${method.toUpperCase()}] ${path} - ${code} ${duration.toFixed(1)}ms`);
    }

    info(msg: string) {
        console.info(msg);
    }

    error(error: unknown) {
        console.error(error);
    }
}
