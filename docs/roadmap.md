# Backend framework roadmap

This is the implementation path for the accepted [project vision](vision.md).
It separates demonstrated behavior from remaining work. Update milestone status
with implementation and test evidence; the presence of a document or example
does not make an enforcement requirement complete.

## Current baseline

| Area | Current implementation | Remaining gap |
| --- | --- | --- |
| HTTP | Filesystem routes, hooks, validation, typed request context, authentication and permissions. | Business execution and context are still centered on HTTP. |
| Module boundaries | Public facade/schema entries, private files and mandatory cross-boundary import checks. | Private module files still have broad same-module access; services do not have an exclusive facade caller rule. |
| Service and repository separation | Orders examples have a facade, service and repository port; module scaffolding includes a service file. | Their internal responsibilities and invocation paths are not fully enforced. Existing facade re-exports and direct module-to-infrastructure imports remain possible. |
| Dependency composition | Root setup creates dependencies and exposes inferred `ctx.services`. | The checker does not establish that exposed objects are approved facade operations; raw adapters or services can be passed through setup. |
| Discovery and tooling | Static checks, inspection of routes/public modules/setup services, generators, source watching and portable builds. | The model has no first-class roles or catalogs for jobs, schedules, event consumers and application commands. |
| Database and web | PostgreSQL transaction/migration example, typed browser client and server-page boundaries. | Database lifecycle is application-owned; the framework has no common worker lifecycle, durable job contract or reliable event publication contract. |

Evidence lives in `packages/analyzer/src/architecture.ts`,
`packages/analyzer/src/services.ts`, `packages/core/src/core/context.ts`,
`packages/core/src/core/conventions.ts`, `packages/scaffold/src/templates.ts`
and the consumer examples. These are repository source locations, not additional
consumer entry points. The [current application reference](application.md) is
the authority for what the installed checker actually accepts today.

## Milestone 0 — Preserve the product direction

**Status: complete.**

- [x] Record the whole-backend vision, responsibilities and completion criteria.
- [x] Lead the README with predictable architecture for work with coding agents.
- [x] Make repository agents and contributors read the vision and roadmap.
- [x] Record current gaps without presenting planned capabilities as shipped.

## Milestone 1 — Enforce one application architecture

**Status: next; incomplete.** This is the next implementation milestone. Resolve
the model as a whole before adding isolated exceptions or a second execution runtime.

- [ ] Define one role catalog and an explicit matrix of imports, exports,
  composition and calls. Cover entry points, facades, services, schemas, ports,
  adapters and bootstrap, including the convention for splitting each role.
- [ ] Replace the generic permission granted to "private module code" with
  role-specific rules. Only the owning facade may invoke its services; a service
  cannot orchestrate peer services or import another module's implementation.
- [ ] Enforce injected ports for infrastructure access. Keep concrete database
  entities, clients and SDK adapters out of business modules and entry points.
- [ ] Define and check public facade contracts and setup exposure. Prevent
  re-exports, wrappers or injected raw objects from bypassing a service boundary.
- [ ] Classify application source consistently, including unused files. Keep
  aliases, barrels, type-only edges, CommonJS and dynamic loading under the same
  rules; report unsupported forms explicitly.
- [ ] Use the role model in inspection, generators and builds. Diagnostics must
  identify the violated role and show the existing operation to reuse when known.
- [ ] Align all examples, including small generated modules, with the complete
  pattern and document the migration from today's more permissive boundaries.

**Acceptance:** an entry point, foreign module and same-module helper all fail
when they bypass a facade to reach a service or concrete adapter. Negative tests
cover indirect access as well as direct imports. Valid facade/service/port/adapter
composition is discoverable, generated and compiled through the same model.
No rule is complete solely because a specific filename receives a special error.

## Milestone 2 — Give every execution a common lifecycle

**Status: planned; depends on milestone 1.**

- [ ] Define typed application configuration, dependency construction and explicit
  startup/shutdown contracts, with cleanup after partial startup failure.
- [ ] Define execution context independent of Express: actor or machine identity,
  optional tenant identity, correlation, cancellation and bounded execution lifetime.
- [ ] Define the authorization, domain-error and transaction contracts used by
  public facade operations regardless of their trigger.
- [ ] Make configuration, lifecycle and execution dependencies discoverable and
  check their use; preserve a compiler-free production runtime.

**Acceptance:** the same facade operation runs through HTTP and a controlled
non-HTTP execution with identical business authorization and transaction behavior.
Concurrency tests prove isolation; failure and shutdown tests prove resource cleanup.
Choose the concrete public API with a documented migration and release impact.

## Milestone 3 — Deliver background jobs end to end

**Status: planned; depends on milestones 1 and 2.**

- [ ] Define the job declaration, payload contract, enqueue port, worker entry
  point and adapter contract within the shared role model.
- [ ] Provide a durable reference adapter with explicit delivery guarantees,
  retries, idempotency expectations, failed-job handling and graceful shutdown.
- [ ] Add job discovery, typed contexts, inspection, generators, development
  behavior and compiled worker deployment together.
- [ ] Extend the reference application so HTTP and a queued job invoke the same
  existing facade, with explicit human or machine authorization.

**Acceptance:** execute a persisted job after process restart; demonstrate duplicate
delivery, a failed attempt and shutdown during work. Verify the documented effects
and permissions. Checks must reject a job that imports a service or database adapter
directly. An in-memory callback demo alone does not satisfy this milestone.

## Milestone 4 — Apply the model to schedules, events and commands

**Status: planned; depends on the established execution model.**

- [ ] Add scheduled triggers with defined overlap and missed-run behavior.
- [ ] Add event consumers with validated contracts, acknowledgement/retry rules,
  correlation and idempotency requirements.
- [ ] Add application command entry points with typed input, explicit identity,
  error reporting, cancellation and resource disposal.
- [ ] Extend the common inspector, generators, checks and deployments for each
  entry point rather than introducing parallel service registries or wiring APIs.

**Acceptance:** each entry point invokes the reference use case through its facade.
Duplicate delivery, overlapping schedules, invalid payloads and insufficient
permissions have tested outcomes. Each entry point has the same prohibition on
service and infrastructure bypasses as HTTP and jobs.

## Milestone 5 — Prove a complete operational backend

**Status: planned; integration and production acceptance.** Operational behavior
needed by an earlier milestone must be delivered with that milestone.

- [ ] Define reliable event publication across database commits and message delivery,
  with a reference outbox or another explicitly justified consistency mechanism.
- [ ] Integrate configuration, migrations, structured logs, correlation, tracing,
  metrics and health/readiness with the established lifecycle and adapters.
- [ ] Exercise human/machine authorization and tenant isolation where declared,
  recovery, cancellation and deployment of separate HTTP/worker processes.
- [ ] Verify actual published artifacts and a clean production installation for
  all supported process types without compiler or CLI dependencies.
- [ ] Document one complete reference backend and test every architectural boundary
  against direct and indirect bypass attempts.

**Acceptance:** a developer or agent can discover and extend the existing use case
across all supported triggers, locate each responsibility by convention, receive
actionable errors for forbidden dependencies, and run the resulting backend in
production with the documented failure and lifecycle behavior.

## Working through the roadmap

Implement a coherent slice of the next milestone with its convention, runtime
contract where relevant, checks, tooling, example and documentation. Keep unfinished
items open and record evidence when closing them. If work reveals a missing role
or conflict, resolve it in the shared model before granting a local exception.
Use the repository contributor checks and compatibility policy for each change.
