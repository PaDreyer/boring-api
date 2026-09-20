# Project vision

**Status: accepted product direction.** This document is the lasting design brief
for Boring API. Use it when making framework, tooling, example and documentation
decisions. The [roadmap](roadmap.md) records delivery status; the
[application reference](application.md) describes the rules implemented today.
Target behavior in this document is not a claim that every capability already ships.

## The problem we are solving

Coding agents repeatedly lose architectural consistency as an application grows.
They miss existing operations, duplicate behavior, import database code directly,
bypass facades, orchestrate services in entry points, and accumulate unrelated
responsibilities in whichever file is convenient. Written instructions alone
leave the developer repeatedly finding and correcting the same mistakes.

Boring API exists to make backend architecture predictable, discoverable and
mechanically enforced throughout continued work by people and coding agents.
A developer should know where a responsibility belongs before searching the code.
An agent should be able to find the existing implementation and receive an
actionable error when it bypasses the prescribed boundary.

This is the product's central promise and the lead message of its README.
Filesystem routing is one application of that promise. The product direction
covers a complete backend: its entry points, business operations, infrastructure,
execution lifecycle and operational behavior.

## One architecture across the backend

HTTP requests, background jobs, schedules, event consumers, application commands
and server-rendered pages must enter the same business operations through their
public facades. Adding a new way to trigger an operation must preserve its business
rules, authorization and transaction ownership.

The intended execution path is:

```text
HTTP / job / schedule / event / command / server page
                         |
                         v
                     facade
                         |
                         v
                     service
                         |
                         v
                port
                         |
                         v
                     adapter
```

Ports are typed contracts owned by the business module. Setup injects adapters
that implement them; the business module does not import concrete infrastructure.
Transaction coordination uses an explicit transaction contract at the facade
boundary. The diagram describes execution; adapter dependencies point toward the
contracts they implement.

| Responsibility | Its place in the target architecture |
| --- | --- |
| Transport and trigger handling | A named entry point validates its external input, establishes execution identity and delegates to a facade. It does not compose services or access storage. |
| Public application operations | A facade exposes use cases, enforces application access and coordinates services and transaction boundaries. Cross-module workflows use other modules' public facades. |
| Business rules | Services implement the owning module's domain behavior. Entry points, unrelated files and other modules cannot call them directly. Splitting files does not confer additional access. |
| Data and effect contracts | Schemas describe data; repositories describe storage needs; other ports describe effects such as mail, file storage or message publication. These contracts do not initialize clients or perform I/O. |
| Infrastructure | Adapters implement those contracts using database drivers, queues, SDKs and other integrations. They do not call business services or facades. |
| Composition and lifetime | A defined application bootstrap validates configuration, constructs dependencies and owns startup, shutdown and resource disposal. Wiring does not become an alternative place for business workflows. |
| Execution state | Each request, job attempt, event delivery or command invocation has its own context. Identity, tenant, correlation and cancellation data do not live in shared instances or module globals. |

The application model must also assign ownership to authorization, domain errors,
transactions, migrations, retries, idempotency, event delivery and observability.
For example, the adapter implements a database transaction, the application use
case chooses its atomic boundary, and a worker's retry policy must account for the
use case's idempotency requirements. A job's machine identity must not silently
bypass business authorization.

## Conventions are a product contract

1. **Every supported responsibility has a named role.** Define its location,
   exports, allowed dependencies, invocation rules and lifetime. Unknown or
   ambiguous application roles must be diagnosed. A generic `internal`, `utils`
   or `helpers` file must not create unrestricted access between layers.
2. **Prefer predictable decomposition.** Many small files following a known
   convention are preferable to a few files mixing transport, orchestration,
   domain rules and persistence. A small feature follows the same architecture
   as a large one. Define a convention for splitting a role when it grows.
3. **Public facades are the application boundary.** A service cannot be made
   reachable from arbitrary callers by a barrel export, alias, convenience
   wrapper or by injecting raw implementation objects into an entry point.
4. **Reuse is discoverable.** Inspection shows existing use cases, contracts,
   dependencies and supported entry points with source locations. Generators
   inspect and extend that model before creating new source.
5. **Checks are mandatory.** Define mechanically checkable rules and reject
   violations with stable diagnostics. Include unused source, re-exports,
   aliases, supported CommonJS forms and indirect dependencies. Unsupported
   loading patterns must not silently escape analysis. No disable flag or
   alternate unchecked registry may bypass the architecture.
6. **All tools agree.** Discovery, checking, inspection, generation, development
   and production builds use the same convention definitions. Runtime validation
   and static analysis must agree on the contracts each can verify, without
   making production depend on the source compiler.
7. **Integration stays explicit.** Support real infrastructure through defined
   adapter contracts, with a documented reference path. Do not leave each
   application to invent competing wiring or lifecycle patterns.

Static analysis cannot infer arbitrary business meaning from JavaScript. For each
architectural promise, specify the concrete structural, dependency or invocation
rule that enforces it, and the behavioral tests needed beyond that rule. A promise
without that enforcement remains an implementation gap. Documentation and a happy
path example alone do not close it.

## What a complete backend needs

The following capabilities belong to the product scope. Each must fit the same
architecture rather than becoming an independent subsystem with its own rules:

- HTTP and web presentation, including validation, authentication and error mapping.
- Background execution with durable queue adapters, defined delivery guarantees,
  retries, idempotency, failure handling and graceful worker shutdown.
- Scheduled triggers, event consumers and application commands that reuse facades.
- Persistence, transaction coordination and explicit migrations; reliable event
  publication when database state and external delivery must stay consistent.
- Typed configuration, dependency composition, execution context and resource lifetime.
- Consistent authorization for human and machine callers, and explicit tenant
  context where the application requires it.
- Logging, correlation, tracing, metrics and health/readiness at defined boundaries.
- Inspection, scaffolding, tests, development tooling, portable builds and deployment
  for every supported entry point, including workers.

These are delivery requirements, not names of new APIs or reserved filenames.
Introduce their concrete conventions through the roadmap and corresponding
runtime/tooling changes. Existing consumers use the documented current API.

## Definition of progress

A capability is complete when its convention is documented, its runtime behavior
works, forbidden paths fail checks, inspection can find it, generators produce
valid source, and compiled deployments exercise it without development tools.
Lifecycle and failure behavior are part of that capability's acceptance criteria.

The reference application must eventually execute a real use case through HTTP,
a background worker, a scheduled trigger, an event consumer and an application
command using the same facade and business implementation. Negative examples
must prove that callers cannot bypass that path by rearranging imports or files.

Judge work against this complete model. A new folder, a renamed file, a single
import restriction or a successful HTTP example is progress only within the
larger, explicitly tracked contract. See the [delivery roadmap](roadmap.md) for
the remaining work and the next milestone.
