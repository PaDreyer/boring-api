// validation of input
import {Context} from "../../../core";
import z from 'zod';

export const body = z.object({});
export const params = {};
export const query = {};

// check permissions
export const permissions = [];

export async function setup(ctx: any) {

}

// handle request
export async function handler(ctx: Context) {
    console.log("ctx: ", ctx.entries());
}

// validate output
export const output = {};

