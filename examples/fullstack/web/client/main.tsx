import React, { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ApiError } from "@boringapi/core/client";
import { createOrder } from "$modules/orders/schemas";
import type { Order } from "$modules/orders/schemas";
import { createApi } from "./api";

function App() {
    const token = useRef("");
    const api = useMemo(() => createApi(() => token.current), []);
    const [order, setOrder] = useState<Order>();
    const [message, setMessage] = useState("");
    const [busy, setBusy] = useState(false);
    async function create(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setBusy(true); setMessage("");
        try {
            const form = new FormData(event.currentTarget);
            const input = createOrder.parse({ item: form.get("item"), quantity: Number(form.get("quantity")) });
            const created = await api.request("POST /orders", { body: input });
            setOrder(await api.request("GET /orders/:id", { params: { id: created.id } }));
        } catch (error) {
            setMessage(error instanceof ApiError ? `${error.status}: ${error.message}` : error instanceof Error ? error.message : "Request failed");
        } finally { setBusy(false); }
    }
    return <main>
        <p className="eyebrow">Boring API / PostgreSQL + React</p>
        <h1>One order. Shared operations.</h1>
        <p>Create an order through the generated client. Read the same record through the API or server-rendered page.</p>
        <form onSubmit={create}>
            <label>Demo bearer token<input type="password" autoComplete="off" onChange={event => { token.current = event.target.value; }} required /></label>
            <label>Item<input name="item" defaultValue="Notebook" maxLength={200} required /></label>
            <label>Quantity<input name="quantity" type="number" min="1" max="100" defaultValue="2" required /></label>
            <button disabled={busy}>{busy ? "Saving…" : "Create order"}</button>
        </form>
        <p role="status">{message}</p>
        {order && <section><h2>{order.item}</h2><p>Quantity: {order.quantity}</p><code>{order.id}</code>
            <p>The MPA reads this order at <code>/pages/orders/{order.id}</code>, using the same bearer authentication.</p></section>}
    </main>;
}
createRoot(document.getElementById("root")!).render(<App />);
