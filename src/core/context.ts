import {Request, Response} from "express";

export class Context extends Map {
    private request: Request;
    private response: Response;

    constructor(req: Request, res: Response) {
        super();
        this.request = req;
        this.response = res;
    }

    send(...args: unknown[]) {
        return this.response.send(...args);
    }

    set payload(payload: unknown) {
        this.set("response_payload", payload);
    }

    get payload() {
        return this.get("response_payload");
    }

    get statusCode() {
        return this.response.statusCode;
    }
}


