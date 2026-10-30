
# Karaoke Queue — Codex Agent Instructions

## 1. Project Overview

Karaoke Queue is a desktop application built with Electron,
TypeScript, Node.js, and SQLite.

Its main responsibilities include:

- Managing karaoke sessions, tables, singers, and requests.
- Maintaining a persistent, intelligent performance queue.
- Scheduling turns fairly across tables.
- Supporting manual queue adjustments and protected positions.
- Preserving operational data across application restarts.
- Providing a reliable Windows desktop experience.

### Current and Future Capabilities

Karaoke Queue is an evolving application. Some capabilities,
such as integrated media playback, remote player communication,
and online music catalog integration, may not yet be implemented
or may be partially developed.

Before implementing or modifying any feature:

- Inspect the current codebase to determine whether the
  functionality already exists, is partially implemented,
  or has not been developed.
- Reuse and extend existing implementations whenever appropriate.
- Do not assume a feature is unavailable solely because
  it is not documented here.
- Do not treat unimplemented features as prohibited or
  permanently out of scope.
- New capabilities may be developed when explicitly requested,
  following the project's architecture and engineering standards.
- Preserve existing behavior and avoid unnecessary duplication
  or architectural changes.
- Update relevant documentation when functionality is added
  or its behavior changes.

The repository's actual implementation is the source of truth
for the current development state.

## 2. Communication and Working Style

- Communicate with the user in Brazilian Portuguese.
- Follow established naming and source-code conventions.
- Explain important technical decisions concisely.
- Inspect affected modules before implementing changes.
- Prefer focused changes that address the root cause.
- Avoid unrelated modifications or refactoring.
- Never claim an operation succeeded without verification.
- Distinguish verified facts from assumptions.
- Preserve backward compatibility unless explicitly requested
  otherwise.
- Identify potential regressions before changing critical code.
- Report architectural conflicts instead of silently bypassing
  existing rules.
- Never sacrifice correctness for implementation speed.

## 3. Architecture and Responsibility Boundaries

Preserve the existing Electron architecture:

Renderer -> Preload -> IPC -> Main -> SQLite

### Main Architectural Components

- `main.ts`: Electron lifecycle, windows, IPC, native services.
- `preload.ts`: restricted APIs exposed through contextBridge.
- `types.d.ts`: shared IPC and application contracts.
- `database.ts`: SQLite schema, migrations, and persistence.
- `src/app.ts`: Renderer composition and UI initialization.
- `src/application.ts`: application operations and state.
- `src/state-repository.ts`: persistence coordination and recovery.
- `src/queue-rules.ts`: queue scheduling and ordering.
- `src/round-robin-rules.ts`: incremental Round Robin.
- `src/debut-cadence-rules.ts`: debut scheduling cadence.
- `src/fixed-turn-rules.ts`: manual turn protection.
- `src/frozen-queue-rules.ts`: frozen queue segments.
- `src/history-rules.ts`: session history and table rounds.
- `src/licensing.ts`: pure licensing rules.
- `src/license-service.ts`: licensing validation and persistence.
- `src/ui/`: interface rendering and interactions.

These paths describe the architecture at the time this file
was written. Verify them before relying on them.

### Architecture Rules

- Keep business rules independent from UI rendering.
- Keep persistence within the appropriate data-access layer.
- Never expose raw SQL, SQLite connections, or unrestricted
  Node.js APIs to the Renderer.
- Preserve `contextIsolation: true` and `nodeIntegration: false`.
- Maintain explicit and validated IPC contracts.
- Route operational mutations through the established
  application and persistence layers.
- Do not create alternative state-management paths.
- Avoid circular dependencies.
- Keep modules cohesive and responsibilities clearly defined.
- Do not introduce new architectural layers without necessity.
- Do not reorganize stable modules for cosmetic reasons.

## 4. Engineering Principles

DRY, KISS, and YAGNI MUST be applied together.

These principles complement each other.
None automatically overrides the others.

### DRY — Don't Repeat Yourself

- Avoid duplicating business rules or critical validations.
- Reuse existing utilities, services, and functions.
- Extract shared behavior when the responsibility is genuinely
  the same and abstraction improves maintainability.
- Maintain one authoritative implementation of critical rules.
- Do not introduce abstractions solely because small pieces
  of code look similar.

### KISS — Keep It Simple, Stupid

- Prefer the simplest correct solution.
- Write readable, predictable, and maintainable code.
- Avoid excessive layers, indirection, and clever solutions.
- Follow existing project patterns when appropriate.
- Avoid premature optimization and overengineering.
- Never omit essential error handling or correctness guarantees
  merely to reduce complexity.

### YAGNI — You Aren't Gonna Need It

- Implement only functionality required by the current task.
- Avoid speculative features and unused configuration.
- Do not build generic frameworks without demonstrated need.
- Avoid unnecessary dependencies.
- Support future extensibility through reasonable boundaries,
  without implementing hypothetical functionality prematurely.

### Balancing These Principles

- DRY must not introduce abstractions that violate KISS.
- KISS must not justify duplicating complex business logic.
- YAGNI must not justify skipping validation, safety,
  persistence guarantees, or required automated tests.
- Prefer straightforward code over premature generalization.
- Refactor duplicated logic when its shared responsibility
  is established and the refactoring has clear value.
- Optimize for long-term maintainability, not minimal line count.

### Additional Principles

- Follow Single Responsibility Principle.
- Follow Separation of Concerns.
- Prefer pure functions for business rules when practical.
- Prefer explicit interfaces and clear naming.
- Fix root causes instead of symptoms.
- Avoid unrelated refactoring during focused changes.
- Handle expected failure paths intentionally.

## 5. Critical Business Invariants

The intelligent queue is a critical subsystem.

Never alter its behavior incidentally while implementing
unrelated functionality.

Unless explicitly requested otherwise, preserve:

### Queue Ordering

- Round Robin scheduling operates by TABLE, not singer.
- Established pending positions remain stable.
- Adding requests must not unnecessarily rebuild the queue.
- Preserve the relative request order within each table.
- Avoid consecutive turns from the same table when eligible
  alternatives exist.
- `getPlayOrder()` must remain free of persistence side effects.
- Keep `queueOrderPolicyVersion` independent of application
  SemVer and the SQLite schema version.

### Debut Scheduling

- Debut eligibility depends on table performance history
  within the current session.
- Multiple requests from one table must not generate
  multiple independent debut opportunities.
- Preserve the existing approximate 2:1 regular/debut cadence,
  subject to eligibility and protected positions.
- Preserve persisted `regularsSinceDebut` state.
- Protected/manual completions must not incorrectly consume
  or reset automatic debut cadence.
- Recent-history time windows must not redefine whether
  a table has performed during the session.

### Manual Queue Controls

- Preserve individual pinned turns.
- Preserve frozen queue prefixes and protected positions.
- Automatic scheduling must respect protected positions.
- Canceled drag-and-drop operations must not mutate the queue.
- Invalid or completed references must be handled safely.
- Avoid unintended queue changes during UI-only modifications.

### Presentations and History

- One presentation represents one turn, including
  presentations containing two songs.
- Completed and canceled presentations are distinct states.
- Cancellation must not count as successful performance.
- Completed rounds displayed in the UI are counted by TABLE.
- Singer identification must respect table boundaries.
- Never lose or duplicate presentations during transitions.

### Sessions

- Keep operational data isolated by `sessionId`.
- Never end sessions automatically at midnight.
- Exiting the application does not necessarily end a session.
- Preserve recoverability after unexpected shutdowns.
- Historical data must not contaminate current-session scheduling.
- Do not invent associations for ambiguous legacy records.

Any intentional modification to these invariants must include
explicit requirements, implementation review, and regression tests.

## 6. Persistence and Transaction Safety

Operational persistence is critical.

Preserve the established mutation lifecycle:

1. Read the latest confirmed state.
2. Prepare a candidate state.
3. Apply and validate the requested operation.
4. Persist through the repository.
5. Confirm successful persistence.
6. Publish the confirmed state to the application and UI.

### Mandatory Rules

- Never publish uncommitted operational state as final.
- Serialize operations that mutate shared application state.
- Do not prepare competing mutations from stale snapshots.
- Use SQLite transactions for related changes.
- Preserve commit, rollback, and recovery guarantees.
- Handle partial failures and uncertain IPC outcomes explicitly.
- Reconcile uncertain persistence before retrying mutations.
- Never blindly replay an operation with unknown commit status.
- Do not silently discard sessions, queue positions, history,
  manual pins, or frozen blocks.
- Preserve supported migration and legacy compatibility.
- Keep database schema, queue policy, licensing policy,
  and application versioning independent.

Before modifying persistence, inspect the repository,
database, migration logic, and relevant regression tests.


## Multi-Agent Coordination and Execution Safety

The primary Codex agent is responsible for coordinating
all delegated subagents and integrating their results.

Subagents may work concurrently only when their tasks
are independent and do not introduce conflicting writes.

### Delegation Rules

- Delegate focused tasks to the appropriate specialist.
- Prefer parallel execution for independent read-only analysis.
- Avoid spawning unnecessary agents for trivial changes.
- Give each subagent clear scope, responsibilities, and
  expected deliverables.
- The primary agent remains responsible for final correctness,
  integration, and validation.

### Concurrent Execution Safety

- NEVER allow multiple agents to edit the same files
  simultaneously.
- NEVER allow independent agents to mutate shared application
  state or the same SQLite database concurrently.
- Assign exclusive file ownership for delegated write tasks.
- Do not run conflicting builds, migrations, or E2E suites
  against shared output directories or application profiles.
- Use isolated test environments and unique temporary profiles.
- Do not integrate dependent changes before their prerequisites
  are complete.
- Resolve overlapping responsibilities through the primary agent.
- Never overwrite another agent's uncommitted changes.

### Specialist Responsibilities

- Architecture Explorer: read-only investigation.
- Code Reviewer: read-only code and regression analysis.
- Concurrency Auditor: read-only concurrency and
  idempotency investigation.
- Test Engineer: test implementation and validation within
  explicitly assigned files and scope.
- QA Engineer: independent application testing, reproduction,
  and evidence collection; no production-code modifications.
- Documentation Engineer: documentation updates after the
  implementation and its verified behavior are established.
- Security Auditor: read-only security analysis of Electron,
  IPC, SQLite, licensing, authentication, network communication,
  external integrations, dependencies, and sensitive data.
  Identify vulnerabilities and recommend mitigations without
  modifying production code.

### Recommended Workflow

1. Architecture investigation when necessary.
2. Parallel independent analysis and risk assessment.
3. Coordinated implementation with exclusive file ownership.
4. Unit and integration test implementation.
5. Automated validation and real Electron E2E testing.
6. Independent code review and QA verification.
7. Documentation updates based on verified behavior.
8. Final integration review by the primary agent.

Steps may be combined or omitted when not applicable.
Parallelize only tasks that are genuinely independent.

### Test Integrity

- Subagents MUST follow the project's strict test integrity policy.
- No agent may weaken, skip, or manipulate existing tests
  to make an implementation pass.
- Any failing regression must be reported to the primary agent.
- Production defects must be fixed in production code.
- Changes to existing behavioral expectations require the
  explicit authorization defined in the testing policy.

### Completion

The primary agent MUST collect relevant subagent findings
before declaring the task complete.

It must verify:

- No conflicting edits occurred.
- No unrelated files were overwritten.
- Required tests were executed against the final code.
- Review and QA findings were addressed or reported.
- Documentation reflects the actual implementation.
- Remaining risks and incomplete validations are disclosed.


## 7. Concurrency and Race Condition Policy

Every change involving asynchronous operations, shared state,
IPC, persistence, or external communication MUST include
a concurrency risk assessment.

### Required Analysis

Investigate relevant scenarios including:

- Simultaneous commands.
- Rapid repeated user actions.
- Overlapping asynchronous operations.
- Stale reads and writes.
- Out-of-order responses.
- State changes while operations are pending.
- Duplicate event delivery.
- Timeouts and uncertain results.
- Process restarts and interrupted operations.
- Competing writers or multiple application instances.

### Implementation Rules

- Define explicit operation ordering or conflict policies.
- Prevent stale responses from overwriting confirmed state.
- Avoid check-then-write races when atomicity is required.
- Use appropriate transactions or synchronization.
- Prefer deterministic coordination over arbitrary delays.
- Never use `setTimeout` as a substitute for synchronization.
- Do not introduce complex locks without a demonstrated need.
- Preserve existing operation serialization guarantees.

The current application serializes operations within one
instance, but multi-instance write safety has not been
established.

Do not assume separate Electron processes can safely
mutate the same application state concurrently.

Any new cross-process or networked feature must review:

- State ownership.
- Command ordering.
- Conflict resolution.
- Duplicate delivery.
- Disconnect and reconnect behavior.
- Recovery after uncertain outcomes.

## 8. Idempotency and Retry Safety

Evaluate idempotency whenever operations can be:

- Retried after timeout.
- Triggered by repeated clicks.
- Delivered more than once.
- Replayed after reconnection.
- Recovered after an uncertain IPC or network result.

### Mandatory Requirements

- Repeated delivery of the SAME logical command must not
  produce unintended duplicate effects when idempotency
  is required.
- Distinguish duplicate delivery from intentionally separate
  user actions.
- Use stable operation identifiers when appropriate.
- Persist deduplication state when correctness requires it.
- Prevent duplicate presentation creation or completion.
- Prevent a retried command from accidentally advancing
  multiple queue turns.
- Never blindly retry non-idempotent mutations.
- Do not impose idempotency where separate repeated actions
  are intentionally meaningful.

When idempotency is applicable, test duplicate execution,
retries, uncertain outcomes, and legitimate separate commands.

## 9. Mandatory Automated Testing Policy

Every new feature, bug fix, or behavioral code change MUST
include appropriate automated tests.

Testing is part of implementation, not optional follow-up work.

Existing relevant tests MUST continue passing.

Tests must verify observable behavior and established contracts.

### Test Integrity — Strict No Test Manipulation Policy

Existing automated tests are regression safeguards.

They MUST NOT be modified merely to make an implementation pass.

When a previously passing test fails after a code change,
treat the implementation as the primary regression suspect.

Investigate the failure before considering any test changes.

### Strict Prohibitions

- NEVER change existing assertions or expected results
  merely to accommodate incorrect implementation behavior.
- NEVER delete, disable, skip, weaken, or bypass failing tests.
- NEVER modify fixtures, mocks, or test data to hide regressions.
- NEVER increase timeouts, insert arbitrary delays, or introduce
  retries merely to conceal unstable behavior.
- NEVER reduce coverage thresholds to obtain passing results.
- NEVER modify CI configuration to suppress legitimate failures.
- NEVER remove regression coverage as a shortcut.
- NEVER silently redefine expected business behavior.
- NEVER treat a passing suite obtained through weakened tests
  as a successful implementation.

### Mandatory Failure Investigation

When an existing test fails after an implementation change:

1. Identify the exact failing test and assertion.
2. Reproduce the failure whenever possible.
3. Compare behavior against the last known working state.
4. Review the implementation change that introduced the failure.
5. Check existing business invariants and documented contracts.
6. Determine whether the failure is a code regression,
   environmental issue, or demonstrably incorrect test.
7. Fix production code when implementation behavior is wrong.
8. Rerun the original failing test without weakening it.
9. Execute related regression and integration tests.
10. Document the root cause and final validation results.

Do not assume a test is incorrect simply because it fails.

A test failure is not resolved by changing its expected result
to match an unintended implementation.

### Exceptions — Legitimate Test Updates

Existing test expectations may change only when:

- The user explicitly requests a behavioral contract change.
- The old test conflicts with that newly requested behavior.
- The proposed test change is explained and explicitly authorized.

If an existing test is demonstrably incorrect or outdated:

- Present evidence of the problem.
- Explain the proposed correction.
- Obtain explicit authorization before weakening, replacing,
  or changing existing behavioral expectations.
- Preserve regression protection for all unaffected behavior.

Legitimate test infrastructure repairs must also address
the root cause rather than conceal failures.

Adding NEW tests and strengthening coverage is encouraged.

### Unit Tests

Required for new or modified business logic.

Test:

- Expected behavior.
- Boundary conditions.
- Invalid inputs.
- Relevant failure paths.
- State transitions.
- Affected business invariants.

Prefer deterministic tests using:

- `node:test`
- `node:assert/strict`

Follow existing project testing conventions.

Use controlled clocks and pure functions when appropriate.

### Integration Tests

Required when changes affect interactions between modules,
SQLite, IPC, or shared application state.

Test:

- Communication between affected components.
- Real SQLite operations when persistence is involved.
- Transaction commit and rollback.
- Error propagation across boundaries.
- Recovery after failed operations.
- Persisted state after restart when applicable.
- Consistency after uncertain outcomes.

Do not replace critical integration tests with mocks when
the actual process or persistence boundary matters.

### Race Condition Tests

Required whenever concurrency or asynchronous ordering
can affect application correctness.

Cover relevant scenarios such as:

- Two operations arriving nearly simultaneously.
- Repeated actions before completion.
- Delayed responses.
- Out-of-order asynchronous completion.
- Conflicting mutations.
- Failures between preparation and confirmation.
- Recovery after uncertain persistence.
- Concurrent access to shared resources.

Prefer controlled barriers and deterministic scheduling
over arbitrary sleeps.

### Idempotency Tests

Required for retryable or duplicate-deliverable operations.

Verify:

- Duplicate delivery of the same command.
- Retry after timeout or lost response.
- No unintended duplicate state transitions.
- Correct handling of separate intentional operations.
- Recovery after interruption when applicable.

### Regression Tests

Every bug fix MUST include a regression test that reproduces
the original failure whenever technically feasible.

- Demonstrate the failure before the fix when practical.
- Confirm the regression passes after correcting production code.
- Preserve all unaffected existing assertions.
- Never remove regression coverage to obtain green results.

### End-to-End Tests

Required for critical workflows and relevant UI changes.

Karaoke Queue E2E tests must use REAL Electron and its
actual IPC/persistence stack whenever applicable.

Requirements:

- Use Playwright with Electron.
- Use isolated profiles and test data.
- Use real SQLite for critical persistence scenarios.
- Verify actual operator behavior.
- Exercise restart and recovery where relevant.
- Run headlessly when supported.
- Use the existing Xvfb-compatible runner on Linux.
- Prefer stable event-driven waits over arbitrary delays.
- Preserve native HTML5 drag-and-drop behavior in relevant tests.

Browser-only mocks and localStorage simulations MUST NOT
replace critical real-Electron integration coverage.

The globally configured Playwright MCP may assist inspection
and automation, but it does not replace the project's
Electron E2E suites.

### Scope-Based Testing Requirements

Not every change requires every test category.

The agent MUST evaluate applicability.

- Business logic: unit and relevant regression tests.
- SQLite, IPC, state, and migrations: unit and integration tests,
  plus relevant Electron E2E coverage.
- Concurrency-sensitive changes: race condition tests.
- Retryable commands: idempotency tests.
- Critical UI changes: real Electron E2E tests.
- Licensing: licensing unit and E2E tests.
- Packaging and releases: workflow and packaging validation.
- Documentation-only changes: documentation review
  and applicable static checks.

Do not invent meaningless concurrency tests for changes
that introduce no concurrency risk.

Do not omit required tests merely because their implementation
is inconvenient.

### Test Completion Rules

A task MUST NOT be declared fully validated while relevant
automated tests are failing.

If a failure cannot be resolved:

- Preserve the failing test.
- Do not manipulate assertions or test configuration.
- Report the failure and investigation results.
- Identify which validations remain unsuccessful.
- State clearly that validation is incomplete.

The objective is to fix the implementation,
not artificially produce green test results.

## 10. Test Commands and Execution

Use scripts actually declared in `package.json`.

Verify their current definitions before execution.

### Core Validation

- `npm run compile`
- `npm run test:unit`
- `npm run test:release-workflow`
- `git diff --check`

### Electron E2E

- `npm run test:e2e`
- `npm run test:e2e:headless`
- `npm run test:e2e:linux`

### Targeted E2E Suites

- `npm run test:e2e:drag:headless`
- `npm run test:e2e:persistence:headless`
- `npm run test:e2e:round-robin:headless`
- `npm run test:e2e:cadence:headless`
- `npm run test:e2e:sessions:headless`
- `npm run test:e2e:session-close:headless`
- `npm run test:e2e:licensing:headless`
- `npm run test:e2e:queue-menu:headless`
- `npm run test:e2e:diagnostics:headless`
- `npm run test:e2e:singer-autocomplete:headless`
- `npm run test:e2e:sidebar-name:headless`

### Packaging

- `npm run verify:windows-build`
- `npm run build:windows`

### Execution Policy

- Run compilation for TypeScript implementation changes.
- Run relevant unit tests after behavioral modifications.
- Run broader regressions when shared business logic changes.
- Run relevant Electron E2E suites for operational UI changes.
- Run persistence and session E2E tests for affected flows.
- Run release workflow tests when modifying CI/CD.
- Do not claim Windows packaging was validated unless tested
  in a suitable environment.
- Do not report unexecuted tests as passing.
- If mandatory tests cannot run, explain the limitation
  and report incomplete validation.

## 11. Security and Licensing

- Preserve Electron security boundaries.
- Validate untrusted input at appropriate boundaries.
- Avoid unrestricted IPC handlers.
- Never execute arbitrary user-provided scripts or commands.
- Avoid logging license tokens, credentials, or sensitive data.
- Do not expose licensing secrets in test output or reports.
- Preserve existing trial and activation behavior unless
  explicitly requested otherwise.
- Do not couple licensing policy versions to application SemVer.

### Licensing Documentation

`docs/licensing.md` is currently allowed to remain versioned
according to the project's repository policy.

- Do not automatically untrack this file.
- Do not delete it or add it to `.gitignore` without permission.
- Preserve its existing version-control status.
- Avoid reproducing its sensitive contents in responses or logs.
- Report discovered security risks without exposing secrets.

## 12. Git, CI/CD, and Release Safety

- Inspect the current branch and working tree before changes.
- Preserve unrelated local modifications.
- Review the final diff before completion.
- Do not create commits or push unless explicitly requested.
- Never force-push without specific authorization.
- Avoid accidentally committing unrelated generated files.
- Preserve GitHub Actions release protections.
- Do not create or overwrite release tags without authorization.
- Do not publish releases automatically unless requested.
- Keep package versioning, schema versioning, queue policy,
  and licensing policy independent.
- Validate workflow changes with the existing tests.
- Do not modify release infrastructure as a side effect
  of unrelated features.

## 13. Documentation

Use existing documentation for detailed behavior and
historical design decisions.

Relevant references include:

- `README.md`
- `docs/round-robin-incremental.md`
- `docs/cadence-reset.md`
- `docs/sqlite-persistence-safety.md`
- `docs/legacy-session-compatibility.md`
- `docs/drag-e2e-reliability.md`
- `docs/windows-release-process.md`

Consult relevant documentation before modifying critical
subsystems.

Keep documentation synchronized with behavioral changes.

Do not copy large historical explanations into AGENTS.md.

When documentation conflicts with actual code, investigate
and report the discrepancy.

## 14. Definition of Done

Before declaring a task complete:

1. Confirm the requested behavior was implemented.
2. Verify architectural boundaries were preserved.
3. Review affected business invariants.
4. Assess concurrency and race condition risks.
5. Assess idempotency and retry requirements.
6. Add appropriate unit tests.
7. Add integration tests when applicable.
8. Add real Electron E2E tests when applicable.
9. Run the required validation suites.
10. Verify no existing tests were weakened or manipulated.
11. Check for regressions and unrelated changes.
12. Update relevant documentation when needed.
13. Review the final diff.
14. Confirm no unauthorized Git operations occurred.

### Mandatory Final Report

Every implementation response MUST summarize:

- What changed.
- Which files were affected.
- Which tests were added.
- Which tests were executed.
- Results of each validation.
- Whether concurrency risks were identified.
- Whether idempotency was applicable and verified.
- Any remaining limitations or risks.
- Any mandatory tests that could not be executed.

Never declare full validation while relevant tests remain
failing, skipped without justification, or unexecuted.

Never weaken tests to accommodate an incorrect implementation.

The goal is reliable, maintainable software that preserves
existing behavior while supporting controlled evolution.
