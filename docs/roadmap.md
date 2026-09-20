# Backend framework roadmap

This is the implementation path for the accepted [project vision](vision.md).
It separates demonstrated behavior from remaining work. Update milestone status
with implementation and test evidence; the presence of a document or example
does not make an enforcement requirement complete.

## Current baseline

| Area | Current implementation | Remaining gap |
| --- | --- | --- |
| HTTP | Filesystem routes, hooks, validation, typed request context, authentication and permissions. | Business execution and context are still centered on HTTP. |
| Module boundaries | Shared roles and a mandatory dependency matrix, including split role files, unused source and same-module service caller restrictions. | Static structure cannot infer business meaning or replace permission tests. |
| Service and repository separation | Business modules use injected ports; concrete infrastructure imports and service forwarding fail checks. Schemas export data/Zod contracts; ports contain types only. | No semantic proof that a use case implements the correct domain rules. |
| Dependency composition | Explicit facade/page factories and data-only operation contracts; setup exposure and imperative writes are checked. | Common configuration, resource disposal and execution lifetime belong to milestone 2. |
| Discovery and tooling | Inspection v2 adds role files and dependency edges. Inspection, generators and portable builds gate on the same checks; the generated health example uses a service. | Jobs, schedules, event consumers and application commands are not yet supported entry points. |
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

**Status: complete, including audit corrections.** The concrete
structural contract and migration are in [Application roles](architecture.md).

- [x] Define one role catalog and an explicit matrix of imports, exports,
  composition and calls. Cover entry points, facades, services, schemas, ports,
  adapters and bootstrap, including the convention for splitting each role.
- [x] Replace the generic permission granted to "private module code" with
  role-specific rules. Only the owning facade may invoke its services; a service
  cannot orchestrate peer services or import another module's implementation.
- [x] Enforce injected ports for infrastructure access. Keep concrete database
  entities, clients and SDK adapters out of business modules and entry points.
- [x] Define and check public facade contracts and setup exposure. Prevent
  re-exports, wrappers or injected raw objects from bypassing a service boundary.
- [x] Classify application source consistently, including unused files. Keep
  aliases, barrels, type-only edges, CommonJS and dynamic loading under the same
  rules; report unsupported forms explicitly.
- [x] Use the role model in inspection, generators and builds. Diagnostics must
  identify the violated role and show the existing operation to reuse when known.
- [x] Align all examples, including small generated modules, with the complete
  pattern and document the migration from today's more permissive boundaries.

**Acceptance:** an entry point, foreign module and same-module helper all fail
when they bypass a facade to reach a service or concrete adapter. Negative tests
cover indirect access as well as direct imports. Valid facade/service/port/adapter
composition is discoverable, generated and compiled through the same model.
No rule is complete solely because a specific filename receives a special error.

Implementation evidence: `packages/core/src/core/roles.ts` owns locations and the
module dependency matrix. `packages/analyzer/src/architecture.ts` resolves the
complete dependency graph; `boundaries.ts` checks public exports, service references,
port/schema shapes, setup provenance, mutation and capability erasure. Inspector v2
uses that model; generators and builds reject its diagnostics before writing output.

Negative cases in `packages/analyzer/test/architecture.test.ts` cover same-module
helpers and peer services, alias/type/re-export/CommonJS paths, raw setup values,
imperative setup writes, returned capabilities and unsupported composition.
`inspect.test.ts`, build alias tests and scaffold tests cover valid split facades,
transaction ports, role discovery, refusal of invalid projects, and generated builds.
Both examples preserve business authorization; the fullstack tests exercise facade
transaction ownership and server-page reuse. Real PostgreSQL remains an opt-in test.

Validation: `pnpm build`, `pnpm example:check`, `pnpm typecheck`, `pnpm test`,
`pnpm example:build` and `pnpm example:fullstack:build` pass. The full suite reports
141 passing tests and one PostgreSQL test skipped without `BORING_TEST_DATABASE_URL`.
The 24 architecture tests include service return-type erasure, callable port
injection and bounded traversal of shared recursive data/dependency graphs.
Audit regressions in `packages/analyzer/test/boundary-regressions.test.ts` additionally
cover destructured and narrowed setup setters, erasure through call parameters,
nested fields, rest tuples, callback arguments/results, Promise results and schemas,
callable service containers, data-only error classes, inline type imports/exports
and retained runtime edges. Build and scaffold regressions verify refusal before
writing output; positive cases preserve typed port composition and Zod schemas.

This is a breaking convention/tooling change requiring a **minor** release on the
0.x line. It does not add a JavaScript sandbox: arbitrary reflection/global side
channels, installed-package behavior, semantic duplication and business correctness
are outside the structural guarantee. Startup remains compiler-free; source checks
must run before deployment. CommonJS dependency edges remain analyzed, while public
operation/setup exports and service references use the documented explicit forms.

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
