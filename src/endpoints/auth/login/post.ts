import z from "zod";

import { Context } from "../../../core/context";


export const envelope = true;

export const authorization = "admin";
export const permissions = ["customer", "accounts"];

export const body = z.object({});

export async function handler(ctx: Context) {
    ctx.payload = "Test Test";
}

export const output = z.object({});