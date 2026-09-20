import type { ExecutionContext } from "@boringapi/core";
import type { createOrders } from "$modules/orders/facade";
import type { Actor } from "$modules/access/schemas";
import { orderParams } from "$modules/orders/schemas";

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]!));

export function createPages(orders: ReturnType<typeof createOrders>) {
    return {
        async order(execution: ExecutionContext<Actor>, id: string): Promise<string> {
            const params = orderParams.parse({ id });
            const order = await orders.get(execution, params.id);
            return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Order ${escapeHtml(order.id)}</title>
                <main><h1>${escapeHtml(order.item)}</h1><p>Quantity: ${order.quantity}</p><p>Order: ${escapeHtml(order.id)}</p></main></html>`;
        },
    };
}
