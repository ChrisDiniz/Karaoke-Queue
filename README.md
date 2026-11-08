# Karaoke Queue

**Version 0.5.0 · Pre-1.0 development**

> **AVISO DE TRANSIÇÃO** — O produto-alvo tem duas funções: **Reprodutor** (`player`/Standalone) e **Tudo em um** (`combined`), que reúne a Gestão. `controller` permanece compatibilidade transitória. Mesas, cantores, fila, sessões, histórico e regras operacionais serão preservados no Tudo em um. Na primeira abertura do aplicativo, os frames Welcome aprovados `rKUlA0rV8m` e `gFR_COs4VP` orientam a escolha da função e a configuração inicial da biblioteca e do catálogo CSV opcional; a escolha não ocorre durante NSIS. A biblioteca pode ser configurada depois. A função será persistida, e mudanças posteriores ocorrerão somente pela manutenção do instalador, não pelas Configurações. A regra aprovada é uma função por computador; a estratégia técnica precisa de auditoria e aprovação em E1, e a garantia pertence a E3. A especificação funcional Standalone está em [docs/standalone-one-screen-player.md](docs/standalone-one-screen-player.md); a direção e as fases atuais estão em [docs/standalone-player-roadmap.md](docs/standalone-player-roadmap.md).

Karaoke Queue is a desktop application for karaoke operators. Its Controller organizes singers, tables, sessions, and presentation queues; its isolated Player mode plays local videos from a manually managed sequence.

## Features

### Smart queue

- A single queue of pending presentations, with a clearly identified current turn.
- Incremental Round Robin distribution across eligible tables to reduce avoidable repetition by one table.
- A moderate debut priority and a 2:1 cadence that balances regular turns and debut opportunities when eligible.
- Round indicators counted per table (not per singer), plus waiting-time information.
- Persisted operational order, so normal updates and restarts do not needlessly reshuffle the queue.

### Presentation management

- Register a table, singer, and one or two songs for a presentation. Two songs still represent one queue turn.
- Add several presentations in one batch.
- Complete a presentation or cancel it with confirmation.
- Edit a presentation, inspect why it has its queue position, and open table details.
- Search singer suggestions scoped to the table.

### Operator controls

- Reorder presentations with drag and drop.
- Pin individual presentations and manually move a presentation into the current turn.
- Freeze a prefix of the queue and release it when ready.
- Keep protected manual positions while the automatic queue continues to organize eligible turns.

Automation assists the operator; it does not remove the ability to intervene.

### Sessions and history

- Continue an open session, start a new session explicitly, and review previous sessions.
- Recover an open session after an unexpected close.
- Search session history by singer, filter by table, and view table-level details.
- Keep completed and cancelled presentations in history.
- Persist data across application restarts. Sessions can cross midnight; the application does not end them automatically based on the calendar date.

### Interface

- Desktop layout with a collapsible sidebar and queue cards with context menus.
- Appearance controls for theme, interface scale, and the name shown in the sidebar.
- Session navigation for the current session and previous sessions.

### Legacy local Player currently in the repository

- Play local videos by numeric code from an indexed folder.
- Add one or more codes to an explicit local sequence; valid natural EOF advances to the next queued item.
- Import an optional CSV catalog for song titles and artists.
- Use playback controls in the embedded view or explicitly move the same video surface to a separate window.
- Recover interrupted playback without automatic resume.

These bullets describe the existing multi-view Player implementation. They are not the functional/UI specification for the new Standalone V1.

### Current implementation and target modes

- **Current code:** still recognizes `controller`, `player`, and `combined`, with transitional first-launch behavior. The old Player control shell was removed in D2; Reprodutor currently uses the Standalone UI. E0 is planned to consolidate Controller into the `combined` product function while preserving its operational domain; E1 then implements the final first-use choice between `player` and `combined`. Combined hosts the operational Management authority and does not yet have the future local-playback integration described for H8.
- **Target:** **Reprodutor** (`player`/Standalone) is the independent one-screen local Player in the V1 specification, with its own media library, optional CSV catalog, and sequence; it can work offline and does not use the operational queue. **Tudo em um** (`combined`) preserves the Controller's operational features and will first control a remote Player for controlled venue testing; local playback integrated into Combined follows later and is not a prerequisite for that first release. “Gestão” names this operational domain, not the user-facing function choice.
- **Function selection:** one Windows installer and production executable serve both final functions. On first application opening, the approved Welcome flow presents Reprodutor (`player`) or Tudo em um (`combined`), then the initial video-library and optional CSV setup. NSIS does not select the function. The selection persists across restarts and updates; later changes use installer maintenance, never normal Settings. E1 audits and obtains approval for the technical strategy; E3 implements computer-wide exclusivity.
- **Controller:** the independent product function will be discontinued; tables, singers, queue, sessions, history, and scheduling rules remain for Combined. Do not remove Controller features or shared services before the authorized cleanup/integration phases.

The existing selector and lifecycle are transitional and remain unchanged until their authorized roadmap phase. The approved sequence is A (architecture preparation) → B (Standalone functional base) → C (Standalone UI) → D (audit, legacy cleanup, and Main modularization) → E0 (Controller-to-Combined consolidation) → E1–E5 (installer and function management) → F (post-install regression and stabilization) → G (secure remote communication) → H (operational Management/Player integration). E0–H remain planned and are not started. LAN/remote playback is not implemented.

## How the smart queue works

**Round Robin** spreads opportunities among eligible tables. A table with several pending presentations should not monopolize turns while other tables are eligible.

**Debut priority** identifies a table that has not completed a presentation in the current session and gives its first eligible request a debut opportunity.

**The 2:1 cadence** balances regular and debut opportunities under the current eligibility rules. It is an operational target, not a guaranteed mathematical ratio in every queue state.

**Manual controls** take precedence where the operator has pinned a turn, moved it manually, or frozen part of the queue. The queue then continues organizing the unprotected turns around those choices.

## Technology and architecture

- Electron 45 and Node.js, with TypeScript 5.9.
- HTML and CSS for the Renderer.
- SQLite through Node's built-in `node:sqlite` API in Electron.
- Playwright 1.64 for tests that launch real Electron windows.
- electron-builder 26 for Windows packaging.
- GitHub Actions for pull request validation and manual release builds.

The persistence path is **Renderer → Preload → IPC → Main → SQLite**. The Preload exposes a restricted bridge; database access stays in the Main process. Operational changes are prepared and persisted before the confirmed state is published back to the interface. SQLite transactions protect schema migration and related writes.

The application stores operational state in `karaoke.sqlite` under Electron's per-user `userData` directory. On first launch with a legacy `karaoke-data.json` in that directory, the app imports it transactionally and leaves the source file in place. Do not commit runtime databases or operator profiles.

## Development

Requirements: Node.js 22.12 or newer and npm.

```sh
npm ci
npm start
```

`npm start` compiles TypeScript and launches Electron. To compile without launching the app:

```sh
npm run compile
```

When opening `build/src/index.html` directly in a browser for UI development, the Renderer has a `localStorage` fallback. This is a development fallback; it does not exercise the normal Electron IPC and SQLite persistence path.

## Tests

Run the unit suite and the release/packaging configuration checks with:

```sh
npm run test:unit
npm run test:release-workflow
```

The focused Electron E2E commands include:

```sh
npm run test:e2e:headless
npm run test:e2e:drag:headless
npm run test:e2e:round-robin:headless
npm run test:e2e:cadence:headless
npm run test:e2e:persistence:headless
npm run test:e2e:sessions:headless
npm run test:e2e:session-close:headless
npm run test:e2e:licensing:headless
npm run test:e2e:queue-menu:headless
npm run test:e2e:player-playback:headless
npm run test:e2e:player-recovery:headless
npm run test:e2e:operating-modes:headless
```

`test:e2e:headless` runs the main Electron smoke suite. The full Linux E2E matrix is available as:

```sh
npm run test:e2e:linux
```

The E2E launchers use real Electron, Playwright, SQLite through IPC, and temporary profiles. Linux headless runs use Xvfb and clear `WAYLAND_DISPLAY` for each suite. They cover queue behavior, drag and drop, persistence, sessions, licensing, menus, and other UI workflows. The application is not replaced by a browser mock in these tests.

## Windows build

The project uses electron-builder to create an unsigned Windows x64 NSIS installer (`.exe`) with ASAR packaging. On Windows, build and verify it with:

```sh
npm ci
npm run build:windows
npm run verify:windows-build
```

The build uses `--publish never`; building locally does not publish a GitHub Release. The pull request and release workflows build on Windows runners. The package verifier checks the installer name, app archive contents, Main/Preload/Renderer files, assets, SQLite runtime, and exclusion of test and documentation files.

The development environment used to prepare version 0.5.0 was WSL2. Its `win-unpacked` application package was generated and inspected, but the local NSIS `.exe` build did not complete because Wine was unavailable. No Windows installation or public Release is claimed from that local build. The Windows-runner build, package validation, and packaged-app smoke test are defined in CI; consult the workflow run for their actual result.

The installer is currently unsigned. Windows may show a SmartScreen warning.

## Pull request validation and releases

### Pull requests

[`.github/workflows/pr-validation.yml`](.github/workflows/pr-validation.yml) runs for pull requests opened, updated, or reopened against `main`. It compiles, runs unit and workflow tests, runs the real-Electron Linux E2E matrix, and then builds and verifies the Windows x64 package on a Windows runner. After the packaged-app smoke test passes, the installer is uploaded as a downloadable Actions Artifact named `Karaoke-Queue-PR-<number>-Windows-x64`.

An Actions Artifact is for testing a pull request. It is not a GitHub Release.

### Manual release

[`.github/workflows/release-windows.yml`](.github/workflows/release-windows.yml), shown as **Release Karaoke Queue** in GitHub Actions, is the only release publisher. It runs only when started manually; merges, pushes, pull requests, and tags do not publish automatically.

To request a release, open **GitHub → Actions → Release Karaoke Queue → Run workflow**, select `main`, and enter the version without the `v` prefix. For example, input `0.5.0` must exactly match `package.json`. The workflow rejects other branches, mismatched versions, and an existing tag or Release. After validation and Windows packaging succeed, it creates `v0.5.0` at the validated commit and publishes a GitHub prerelease with the installer and SHA-256 checksum.

See [the Windows release process](docs/windows-release-process.md) for the full procedure and failure handling. No Release has been published as part of preparing this README.

## Licensing

New installations receive a 15-day trial. The remaining time appears in the header, where the operator can open the activation dialog and enter an activation token. Activation is persisted locally for that installation. After the trial expires, operational changes are blocked while sessions, queue data, and history remain preserved; activation is still available.

This is a lightweight local licensing check, not protection against reverse engineering. The activation token and its validation material are intentionally not included in this README.

## Development status

Karaoke Queue is in active **pre-1.0 development**. Version 0.5.0 is a development release; 1.0.0 is reserved for when the main product scope is complete.

The repository contains Controller operations and the legacy local Player described above. The target product direction is Standalone plus Combined; see the transition notice and roadmap. YouTube playback, LAN pairing, and remote Player control are not implemented. The V1 Standalone behavior is defined only by `docs/standalone-one-screen-player.md`.

## Additional documentation

- [Incremental Round Robin](docs/round-robin-incremental.md)
- [2:1 cadence behavior](docs/cadence-reset.md)
- [SQLite persistence safety](docs/sqlite-persistence-safety.md)
- [Legacy session compatibility](docs/legacy-session-compatibility.md)
- [Drag-and-drop E2E reliability](docs/drag-e2e-reliability.md)
- [Windows build and release process](docs/windows-release-process.md)
- [Local Player playback](docs/player-playback.md)
- [Standalone V1 specification](docs/standalone-one-screen-player.md)
- [Standalone/Combined migration roadmap](docs/standalone-player-roadmap.md)
- [Local video library](docs/video-library.md)
- [Music catalog](docs/music-catalog.md)
- [Remote Player architecture and phase boundaries](docs/remote-player-architecture.md)

The repository does not currently declare a project license.
