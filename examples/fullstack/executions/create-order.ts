import type { Application } from "@boringapi/core";
import type { Services } from "../api/$types";
import type { Actor } from "$modules/access/schemas";
import type { CreateOrder } from "$modules/orders/schemas";

/** Bootstrap supplies a trusted human/machine identity, never client permission claims. */
export function createOrder(application: Application<Services>, identity: Actor, input: CreateOrder) {
    return application.execute({ identity }, ({ execution, services }) => services.orders.create(execution, input));
}
