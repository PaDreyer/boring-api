export class Logger {
    http(method: string, path: string, code: number, duration: number) {
        console.info(`[${method.toUpperCase()}] ${path} - ${code} ${duration}`);
    }

    info(msg: string) {
        console.info(msg);
    }
}