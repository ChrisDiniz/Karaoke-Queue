# Karaoke Queue

**Version 0.5.0 · Pre-1.0 development**

Karaoke Queue is a desktop application for managing karaoke presentation queues. It helps operators organize singers, distribute opportunities across tables, and control the running order while keeping session and presentation data locally persisted.

The project focuses on queue operations and session history. It is not a karaoke player.

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

The current scope is queue and session management. Playback integration, automatic song-end detection, a functional local music library, YouTube playback, and remote licensing are not implemented. The interface includes preparatory or disabled navigation for some playback options; those controls do not indicate a working integration.

## Additional documentation

- [Incremental Round Robin](docs/round-robin-incremental.md)
- [2:1 cadence behavior](docs/cadence-reset.md)
- [SQLite persistence safety](docs/sqlite-persistence-safety.md)
- [Legacy session compatibility](docs/legacy-session-compatibility.md)
- [Drag-and-drop E2E reliability](docs/drag-e2e-reliability.md)
- [Windows build and release process](docs/windows-release-process.md)

The repository does not currently declare a project license.
