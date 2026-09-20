# Inspecting an application

[Package README](../README.md) · [Agent guide](agent-guide.md)

Use the source-derived catalog to find existing operations and effective hooks before making changes.

## Discover existing functionality

Run `boring inspect` before adding an endpoint or business operation. It lists
routes, callable services exposed through `ctx.services`, and exports from all
public `modules/<name>/facade` and `schemas` files, including unused modules.
Follow the reported source location and extend an existing module when the
operation belongs there. No registry, metadata class or duplicated catalog is needed.

```bash
boring inspect src/api
boring inspect src/api --json > api-catalog.json
```

For example, the orders application exposes `ctx.services.orders.create` and
`ctx.services.orders.get`, with their parameter and return types and implementation
locations. Each route also shows input/output schema types, authentication and
authorization declarations, middleware in execution order, and the selected
envelope and error hooks. Public exports include signatures, inferred types,
source locations and JSDoc descriptions in JSON; re-exports point to their definitions.
Type-only exports remain types, including through import aliases and re-export
chains; they are not offered as runtime operations. Generic operation signatures
use the instantiated constraints and defaults of the returned service.

Inspection uses TypeScript source analysis. It does not import or execute
application setup, hooks, schemas, routes or dependencies. Each run regenerates
`.boring/types` and reads the current source; no inspection cache needs updating.
Invalid structure, contracts, types or architecture produce diagnostics on stderr
and exit status 1, with no catalog on stdout. Fix these errors and run inspection
again. Successful `--json` output is exactly one JSON object on stdout.

### JSON contract, version 2

The root object contains these fields:

| Field | Contents |
| --- | --- |
| `schemaVersion` | `2`. Breaking changes to the catalog structure increment this value; readers should ignore additional fields. |
| `apiDirectory` | Selected API path relative to the consumer project root. |
| `setup`, `auth` | Setup and authentication/authorization hook locations, or `null` when absent. |
| `routes` | Method, URL path, handler location/return types, `input`, `output`, `access`, and effective `hooks`. |
| `services` | Callable services inferred from the return type of `+setup`, with exact `ctx.services` access expressions and operation signatures. |
| `modules` | Public facade/schema exports, including callable exports, schemas, values and types. |
| `roles` | Every classified source file, its role/module/public status, and resolved dependency edges with type-only flags and source offsets. |
| `unmatchedErrors` | Root error hooks used when no route matches. |

Locations have `{ "file": "modules/orders/facade.ts", "line": 17, "column": 9 }`,
with project-relative forward-slash paths and one-based positions. Routes follow
registration order: static segments before parameters and explicit HEAD before
GET at the same path. Modules, services and exports sort by name; the catalog has
no timestamps or absolute project-root field.

Route `input.params`, `input.query`, `input.body` and `output` are `null` when
absent; otherwise each has `source`, `inputType` and `outputType`. These describe
the Zod input and parsed output, including transforms. Types and signatures are
TypeScript descriptions, not JSON Schema. A handler's declared return type can
be `unknown` without an output schema. Response status, early `ctx.send()` calls
and envelope transformations are not inferred as final HTTP response schemas.

`access.authentication` and `access.authorization` contain a declaration or
`null`. Declarations distinguish `kind: "literal"` with a `value`, explicit
`kind: "undefined"`, and `kind: "expression"` with source text and a TypeScript
type. Literal syntax and references to constants can be read statically; calls,
mutable declarations and other computed values remain expressions. This describes
source declarations, not changes caused by runtime side effects. `access.session`
is `required`, `optional`, or `conditional` when a computed declaration prevents
a static decision. Authorization hooks themselves are never evaluated.

`hooks.middleware` is ordered root to leaf. `hooks.envelope` reports the nearest
hook, its route declaration, and whether it is enabled (`true`, `false`, or
`"conditional"`); a missing hook has `source: null`. It still follows the normal
204 and early-response rules. `hooks.errors.generic` and `server` report the
generic and 5xx fallbacks; `statuses` maps explicitly configured statuses to their
effective handlers. Selection checks the nearest scope first: exact status,
then that scope's 500 hook for server errors, then its generic hook, before
walking upward. A `null` location means the framework's default error response.

Service discovery lists checked facade/page operations, including explicit objects,
const aliases and the common operations of conditional factory results. It does not
promote arbitrary callable setup objects to services. Class instances, dynamic
composition, raw adapters/services and unchecked boundary types are errors. Both
the CLI and public `inspectProject` reject projects with check errors. Imperative
Map writes have no inferred signatures; inspect the reported public entries for
their implementations. The role catalog includes unused files and split role parts.
