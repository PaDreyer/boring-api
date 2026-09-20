# Application role contract

This is the structural contract for milestone 1. It applies to the selected API's
sibling directories. Jobs and a common execution lifecycle remain later milestones.

| Role and files | Imports and exports | Calls and lifetime |
| --- | --- | --- |
| HTTP method files | Public schemas, Core, Zod, generated context types | Call injected public operations; one request |
| Pipeline hooks | Public facades/schemas, Core, Zod, Node helpers | Authentication, middleware and response handling; one request |
| Root `+setup` | Public facades, schemas, port types, adapters and pages | Construct dependencies once per app; expose approved operations and data |
| `modules/<name>/facade.ts`, `facade/**/*.ts` | Own services, ports, schemas, facade parts; other public facades/schemas; Core and Zod | Public operations coordinate services, access and transactions; dependencies live for the app, actors are arguments |
| `service.ts`, `services/**/*.ts` | Schemas, own port types, Zod and Core types | Only operations of the owning facade call exported services; no calls during module loading or factory composition; no peer-service dependencies |
| `schemas.ts`, `schemas/**/*.ts` | Schemas, Zod, Core types | Export data and Zod schemas, not executable helpers; no infrastructure or service behavior |
| `repository.ts`, `ports/**/*.ts` | Schemas and own port types | Export types only; describe storage, other effects and transaction callbacks |
| `infra/**/*` | Infrastructure, public schemas, port types, packages and Node | Implement ports, construct resources; never call business operations |
| `web/server/**/*` | Pages, public facade types/operations, schemas, Core, Zod | Presentation with injected facades; data per call |
| `web/client/**/*` | Browser source, public schemas, browser packages and Core client | Browser transport; no server capabilities |

Only root facade and schema files are public module entries. Port types may be
imported directly by setup and adapters, without publishing them through a facade.
Facade parts may re-export other facade parts in the same module; service exports
must never be forwarded. There is no `internal`, `utils` or unclassified module role.
Splitting a service means independent operations in `services/`, coordinated by
the facade; it does not grant service-to-service access.
Export service operations as named functions; objects containing callable methods
and service classes are rejected, including nested objects and literal/computed
property names. Domain error classes may extend `Error` and carry data, without
adding business methods.

Public facades export named functions and types. A factory returns an explicit
object of locally defined operations. Operations accept and return data, not
service functions, adapters or objects containing callable capabilities. Factories
receive typed ports and other public facades. Setup returns explicit properties:
facade/page factory results, public operations, or data. Arbitrary setup wrappers,
raw services, adapters, spreads and untraceable object construction are rejected.
Imperative `ctx.set` and `ctx.assign` obey the same exposure rules. Const aliases
are traced; capability-erasing annotations/assertions (including service results)
and mutable composition fail. This includes schema declarations and argument
passing to data parameters, including generic constraints and rest parameters.
Conversions check individual fields, tuple slots, callback arguments/results and
Promise results;
an allowed port field does not exempt adjacent data fields from this check.
Callable ports are valid injected dependencies. Setup setters must be called
directly; destructuring, renaming, type narrowing and assignment patterns cannot
hide their origin or alias them.
Use explicit ES exports for these checked boundaries; unsupported boundary syntax
must produce a diagnostic, even when JavaScript type checking is disabled.
Data and dependency type traversals visit shared/recursive nodes once; excessively
large contracts are conservatively rejected after a bounded traversal.
Both `import type { Port }` and `import { type Port }` describe erased dependencies,
as do their export equivalents. Mixed, empty and side-effect imports retain runtime
edges and cannot implement a type-only port dependency.

These are structural rules, not inference of business meaning or a JavaScript
sandbox. Permissions, correct transaction boundaries, semantic duplication and
execution-state isolation still require application behavior tests. The framework
does not yet own resource disposal or a transport-independent execution context.

## Migration and release impact

This changes filesystem conventions, accepted exports and setup composition. Under
the platform's 0.x policy it requires the next **minor** release, not a patch.
Move private helpers into a named role, inject ports instead of importing adapters,
replace service re-exports with facade operations, and expose those operations from
setup. Move adapter-facing types from facade re-exports into repository/port files.
Use `boring inspect`, `boring check` and `boring build` after migration. There is no
compatibility switch. Version changes and publishing remain a separate release step.
