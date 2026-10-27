# Windows builds and manual releases

The product version for this change is **0.5.0**. `package.json` is the release source of truth; keep `package-lock.json` root metadata in sync. The product uses Semantic Versioning: `0.5.x` is for compatible fixes and small improvements, `0.6.0` starts the next feature set, and `1.0.0` is reserved for completion of the main product scope.

## Local Windows installer

Requirements: Node.js 24.15.0 (or a compatible supported Node 22.12+), npm, and Windows for a native installer. Run:

```sh
npm ci
npm run build:windows
npm run verify:windows-build
```

The build compiles TypeScript and creates an unsigned Windows x64 NSIS installer in `dist/`, named `Karaoke-Queue-Setup-<version>-x64.exe`. Electron Builder uses the existing Electron packaging setup, ASAR, app id `com.karaoke.queue`, the multi-size ICO in `build-resources/`, and `--publish never`. It does not publish anything. The application data path remains Electron's per-user `userData`; the packaged smoke test uses a disposable profile.

The packaging verifier checks the installer name, app archive, Main, Preload, Renderer, assets, built-in SQLite dependency, icon, and absence of test/docs files and native SQLite add-ons. On Windows CI, `tests/packaged-windows-smoke.cjs` launches the unpacked packaged executable with a temporary profile, verifies trial initialization, writes and reads a test presentation through Renderer → Preload → IPC → SQLite, restarts, and checks persistence. This is a packaged-app smoke test; it does not run the NSIS installer interactively.

Builds are currently unsigned because no Windows signing certificate is configured. Windows SmartScreen may warn users. The workflow reports signature status and does not claim that the installer is signed.

## Pull requests

`.github/workflows/pr-validation.yml` runs for opened, synchronized, and reopened pull requests targeting `main`. It uses read-only repository permissions and runs compile, unit tests, release/packaging configuration tests, and the real-Electron Linux E2E suites under Xvfb. After they pass, a Windows runner builds and verifies the x64 installer and runs the packaged executable smoke test. The installer is uploaded as the Actions artifact `Karaoke-Queue-PR-<number>-Windows-x64` for 30 days. It is a test artifact, not a GitHub Release. A PR workflow cannot create tags or publish Releases.

## Manual prerelease

Only `.github/workflows/release-windows.yml` publishes. Its only trigger is `workflow_dispatch`; there are no push, tag, merge, PR, or release-published triggers. The workflow must be present on the repository's default branch for the Actions UI to show **Run workflow**.

To publish a version:

1. Set `package.json` to the intended version and keep the lockfile synchronized.
2. Commit and merge that version on `main`.
3. Open **GitHub → Actions → Release Karaoke Queue**.
4. Select `main` in the branch selector.
5. Enter the version without `v` (for this release, `0.5.0`) and select **Run workflow**.
6. Wait for preflight, Linux validation/E2E, Windows packaging, package verification, and packaged-app smoke test.
7. After success, open **GitHub → Releases** and download the installer and `SHA256SUMS.txt`.

The first preflight rejects any ref other than `refs/heads/main`, captures the dispatch event SHA, checks out that exact commit, validates strict SemVer and exact equality between the required input and `package.json`, and rejects an existing tag or GitHub Release. A mismatch such as input `0.6.0` against package version `0.5.0` fails before tag or release operations. Version strings are passed as data, never shell-evaluated. Every validation and build checkout uses the captured SHA; publication verifies the artifact checksum, creates `vX.Y.Z` at that SHA, and targets the same SHA in the Release. The workflow summary reports branch, SHA, requested/package version and final tag.

The publish job alone has `contents: write`; validation jobs use read-only permissions. A concurrency group with `cancel-in-progress: false` prevents concurrent active publications from canceling each other. The workflow publishes a GitHub prerelease titled `Karaoke Queue vX.Y.Z`, with the Windows installer and SHA-256 file. It does not configure a signing secret and does not claim code signing. electron-builder is explicitly told not to publish; GitHub Release creation is handled only by the manual workflow using `GITHUB_TOKEN`.

If repository rulesets or organization policy block tag creation or Release writes, an administrator must allow the repository's GitHub Actions `GITHUB_TOKEN` to create contents/releases and permit the `v*` tag pattern. Do not grant write permissions to the PR workflow or use a PAT just to work around a missing repository setting.

### Duplicate and partial publication handling

A tag or Release already present blocks the run; the workflow will not move a tag, overwrite files, or silently update a Release. If a failure occurs after the tag push, the summary warns that publication may be partial. Check that the tag points to the validated SHA and whether the Release exists. If only Release creation failed, recover by completing the Release for that same immutable tag using the validated artifact from that run; do not create or move another tag. If the validated artifact is no longer available, rebuild from the exact tagged SHA and verify the checksum before attaching it. Never delete or move a published tag as automatic recovery.

## Existing installations and downgrade risk

This repository previously recorded product version `1.0.1` in the package and lockfile; local repository history also contains tags `v1.0.0` and `v1.0.1`. The new product version `0.5.0` is numerically lower. There is no `electron-updater` dependency or application auto-update mechanism in the current code, so this workflow does not push an update to existing installations. Users installing 0.5.0 over a newer installation may still encounter Windows installer/version behavior that resembles a downgrade. Back up the existing per-user data before changing versions and verify the chosen install path. Do not delete, reset, or migrate profiles merely to work around version ordering.

The current application stores operational state in SQLite and has a one-way import path for the legacy JSON store. Older 1.0.1 application code predates the current SQLite state and licensing layout and may not read changes made by 0.5.0. Downgrading can therefore show stale or divergent data. Preserve the existing user-data directory and database; do not use an old build against the same profile as a rollback strategy. A safe rollback plan needs a backup and a forward-compatible migration decision.

## Verification boundaries

The CI workflow validates an actual Windows x64 package and launches the packaged executable on a Windows runner using a temporary profile. It does not interactively install the NSIS executable, and no public Release is created while implementing this workflow. The first real publication should be initiated manually only after the intended commit is on `main` and the operator is ready to publish it. No release/tag commands are required from the operator.
