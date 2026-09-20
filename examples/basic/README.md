# Basic API example

A small application with in-memory storage, a private orders service, a typed
storage port, a public facade and permission rules.
Run these commands from the repository root:

```bash
pnpm install
pnpm build
pnpm example:dev
```

Set `BORING_API_TOKEN` before starting to exercise protected routes. The token
provider and memory store are demonstration code. See the [contributor guide](../../CONTRIBUTING.md)
for checks/builds and the [application reference](../../docs/application.md) for conventions.

The example server listens on port 4040 by default; set `PORT` to change it.

```bash
curl http://localhost:4040/health
curl http://localhost:4040/items/42
curl -X POST http://localhost:4040/echo \
  -H 'Content-Type: application/json' \
  -d '{"message":"Hello"}'
```

The responses are `{"service":"boring-api","status":"ok"}`, `{"id":"42"}`, and `{"data":{"message":"Hello"}}`. The current scope supports JSON bodies and individual dynamic segments such as `[id]`. Catch-all segments are not defined yet.

To exercise the orders module, set your own `BORING_API_TOKEN` in the shell before
starting `pnpm example:dev`. The example token hook grants the `admin` role and
its explicit `orders:read` and `orders:create` permissions to a matching bearer
token; it is demonstration authentication. Use the same token in
the client shell:

```bash
curl -X POST http://localhost:4040/orders \
  -H "Authorization: Bearer $BORING_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"item":"Notebook","quantity":2}'

# Replace <id> with the ID returned by POST /orders.
curl "http://localhost:4040/orders/<id>" \
  -H "Authorization: Bearer $BORING_API_TOKEN"
```

Creation returns HTTP 201 with `{"data":{"id":"<uuid>","item":"Notebook","quantity":2}}`;
retrieval returns the same envelope with HTTP 200. Both routes require a valid
token (otherwise HTTP 401). Invalid input returns HTTP 400, and a valid but unknown
order UUID returns HTTP 404 with `{"error":{"message":"Order not found"}}`.
To add another order operation, implement its rules in the private service,
expose it through the existing facade and reuse the schemas and storage port.
Then add the method file that calls the facade through `ctx.services`.
