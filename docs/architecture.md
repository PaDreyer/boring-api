# Application role contract

This is the structural contract for the shared application model. It applies to
the selected API's sibling directories. The [lifecycle contract](lifecycle.md) defines
configuration, ownership and execution; [durable jobs](jobs.md), [reliable
publication](publications.md) and [operations](operations.md) share that model.

| Role and files | Imports and exports | Calls and lifetime |
| --- | --- | --- |
| HTTP method files | Public schemas, Core, Zod, generated context types | Call injected public operations; one request |
| Pipeline hooks | Public facades/schemas, Core, Zod, Node helpers | Authentication, middleware and response handling; one request |
| Root `+config` | Public schemas, Zod, Core types; exports `schema` and `load(env)` | Data validation before setup; one immutable snapshot per app |
| `jobs/<name>/job.ts` | Public schemas, Core, Zod, generated JobHandler; exports payload/version/policy/handler | One attempt; calls injected facades; setup owns queue binding |
| `schedules/<name>/schedule.ts`, `events/<name>/event.ts`, `commands/<name>/command.ts` | Public schemas, Zod, generated handler and Core types; exact [declaration exports](triggers.md) | One occurrence attempt/event delivery/command; calls injected facades; setup owns identity and ingress |
| `executions/**/*` | Public schemas, Core, Zod, generated types | Controlled callbacks through `application.execute`; one execution |
| Root `+setup` | Public facades, schemas, port types, adapters and pages | Construct dependencies once per app; register `ctx.onClose`; expose approved operations and data |
| `modules/<name>/facade.ts`, `facade/**/*.ts` | Own services, ports, schemas, facade parts; other public facades/schemas; Core and Zod | Public operations coordinate services, access and transactions; dependencies live for the app, execution context is the first argument |
| `service.ts`, `services/**/*.ts` | Schemas, own port types, Zod and Core types | Only operations of the owning facade call exported services; no calls during module loading or factory composition; no peer-service dependencies |
| `schemas.ts`, `schemas/**/*.ts` | Schemas, Zod, Core types | Export data and Zod schemas, not executable helpers; no infrastructure or service behavior |
| `ports/**/*.ts` | Schemas and own port types | Export types only; describe storage, publication, other effects and transaction callbacks |
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
service functions, adapters or objects containing callable capabilities. The exact
Core `ExecutionContext` is allowed only as the first operation parameter; it cannot
be nested, augmented, returned or captured as a factory dependency. Factories
and setup must not retain contexts in their closure variables or collections;
those belong inside an individual invocation. Typed Map/Set containers, including
readonly and weak variants, obey the same lifetime rule as direct context values.
The rule also covers static fields and callbacks retaining a context even when
their return value is data; assignments and collection writes cannot extend its
lifetime beyond the invocation. The bounded static value-flow check follows local
parameters (including defaults and positional rest/spread bindings), return values,
destructuring and mutable aliases, including collection targets. Local overloaded
functions, methods and constructors use their implementation's parameters and body;
the overload signature cannot hide callback storage or returned capabilities.
Callable annotations on mutable local bindings also retain implementation flow,
including later assignments and native `call`/`apply` argument forwarding.
Bound local functions keep their target implementation and the order of bound
arguments when passed as callbacks to native array operations.
Callable lookup uses the same array contents, native return paths and permutations
as lifetime checks. Calls and mutations reach one bounded fixed point, so storing
a function in an array does not hide its argument or return flow.
Array/object assignment patterns, nested targets, defaults, rest elements
and iteration targets obey the same rules as direct assignments. Native `bind`
retains its bound arguments; extracting `signal` or an execution method does not
give it a longer lifetime. Native array methods returning existing elements
(`pop`, `shift`, `at`, `find`) or arrays containing them (`slice`, `splice`,
`filter`, `concat`, `reverse`, `sort`, `flat`, `copyWithin`, `fill`) preserve that provenance.
`reverse`, `sort`, `copyWithin` and `fill` return the original array: writes through
their aliases still affect its shared or local storage. True copies have distinct
outer storage, while copying an array does not detach contexts captured by its
elements or clone nested arrays/objects. Writes through a shallow copy's elements
therefore still affect the original inner storage. Mutations that reorder existing
elements (`reverse`, `sort`, `copyWithin`, `shift`, `unshift`, `splice`) invalidate
precise index selection conservatively, including reads through another alias.
Native `map`, `flatMap` and `Array.from` preserve the provenance of callback results
and bind callback element arguments and native `thisArg` receivers to their source
values. This also applies to native methods invoked through `call`, `apply` (with
literal or constant local tuple arguments) or a locally bound alias. Native array
calls with a dynamic `apply` argument list, spread callback arguments, or an
alias/`bind` chain beyond the supported analysis depth fail `BORING115` at the
call site, even if a particular call only copies data. Write a direct method call
with explicit arguments; `apply` also accepts an inline array or a constant local
tuple without spread. This is a deliberate static syntax boundary, not proof that
the rejected call retains a context, and the checker does not claim to interpret
arbitrary dynamic JavaScript. A user-defined method with the same name is analyzed through
its own implementation, not as a native array operation. Synchronous array
iteration and reduction callbacks also retain their argument flow; reduction
initial values and accumulator results are included. `Array.of` keeps its elements'
provenance. Mapping into a new outer array does not give captured contexts or
shared nested objects a longer lifetime.
Selected data copies (such as `signal.aborted`),
invocation-local callbacks and synchronous callback helpers remain valid.
Factories receive typed ports and other public facades. Setup returns explicit properties:
facade/page factory results, public operations, or data. Arbitrary setup wrappers,
raw services, adapters, spreads and untraceable object construction are rejected.
Imperative `ctx.set` and `ctx.assign` obey the same exposure rules. Const aliases
are traced; capability-erasing annotations/assertions (including service results)
and mutable composition fail. This includes schema declarations and argument
passing to data parameters, including generic constraints and rest parameters.
Jobs, schedules, event consumers and commands also reject `Object`/`Reflect` mutation APIs, extracted methods and destructured
aliases, preventing reflective replacement or deletion of injected facade operations.
Structural helper parameter types do not grant permission to mutate operation
objects, including through destructuring assignment targets. HTTP payload/response data and supported CommonJS route declarations
retain their existing write contracts.
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
execution-state isolation still require application behavior tests. The framework owns resource disposal and isolated execution lifetime; the
[lifecycle tests and contract](lifecycle.md) describe its cooperative cancellation limits.

## Migration and release impact

This changes filesystem conventions, accepted exports and setup composition. Under
the platform's 0.x policy it requires the next **minor** release, not a patch.
Move private helpers into a named role, inject ports instead of importing adapters,
replace service re-exports with facade operations, and expose those operations from
setup. Move adapter-facing types from facade re-exports into port files.
Use `boring inspect`, `boring check` and `boring build` after migration. There is no
compatibility switch. Version changes and publishing remain a separate release step.

Schedules, event consumers and application commands use the complete [trigger contract](triggers.md), including setup grants, PostgreSQL migration, static checks, generation and separate compiled process startup.
