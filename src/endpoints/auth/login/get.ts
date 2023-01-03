// validation of input

import z from 'zod';
import { Context } from "../../../core/context";

export const params = {};
export const query = {};

// check for authentication
export const authentication = true;

// check permissions
export const authorization = "admin";

export async function setup(ctx: any) {

}

// handle request
export async function handler(ctx: Context) {
    const session = ctx.get("session");
    ctx.send(`Session: ${JSON.stringify(session)}`)
}

// validate output
export const output = {};

