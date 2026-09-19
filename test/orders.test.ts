import assert from "node:assert/strict";
import { it } from "node:test";
import { createMemoryStore } from "../examples/basic/infra/memoryStore";
import { createOrders } from "../examples/basic/modules/orders/facade";
import { createOrder, Order } from "../examples/basic/modules/orders/schemas";

it("enforces facade permissions even when called without HTTP", async () => {
    const orders = createOrders(createMemoryStore<Order>());
    const input = createOrder.parse({ item: "Notebook", quantity: 2 });
    const admin = { role: "admin" };
    const viewer = { role: "viewer" };

    await assert.rejects(() => orders.create({ input, actor: viewer }),
        { status: 403, message: "Forbidden" });
    const created = await orders.create({ input, actor: admin });
    await assert.rejects(() => orders.get({ id: created.id, actor: viewer }),
        { status: 403, message: "Forbidden" });
    assert.deepEqual(await orders.get({ id: created.id, actor: admin }), created);
});

it("does not let callers mutate stored orders through input or returned objects", async () => {
    const orders = createOrders(createMemoryStore<Order>());
    const actor = { role: "admin" };
    const input = createOrder.parse({ item: "Notebook", quantity: 2 });
    const created = await orders.create({ input, actor });
    const expected = { ...created };
    input.quantity = 99;
    created.item = "Changed after creation";

    const found = await orders.get({ id: created.id, actor });
    assert.deepEqual(found, expected);
    found.quantity = 42;
    assert.deepEqual(await orders.get({ id: created.id, actor }), expected);
});
