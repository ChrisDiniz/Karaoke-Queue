# Windows builds and manual releases

## Phase E1-01 technical contract — 2026-11-08

E0 was explicitly approved by the owner after Windows-native manual validation (PASS). The [E1-01 audit and installation contract](fase-e-e1-01-contrato-instalacao.md) records A1–A7 and remaining gates. S1 remains PARTIAL. The owner authorized development of E1-03 through E5-03, including E1-02 corrections; this does not approve or homologate any stage. On 2026-11-09 the official Windows runner, current x64 NSIS candidate build/verifier and isolated production-addon load passed at source fingerprint `3485486b7bffb7470863c124b792def0cdd5daa1d26c0775c94496cf18771d60`. The packaged-app and NSIS install/uninstall smokes, cross-account ACL, UAC and installed recovery remain NOT RUN; see the current evidence in the [independent review](fase-e-revisao-independente.md) and [Windows runner log record](windows-native-testing.md). No local VM is required. No workflow was dispatched, no artifact uploaded, no app installed on the owner's computer, and no Release created. A1–A7 remain approved; administrative serialization uses the minimal binding and operational exclusivity remains E3.

The product version for this change is **0.5.0**. `package.json` is the release source of truth; keep `package-lock.json` root metadata in sync. The product uses Semantic Versioning: `0.5.x` is for compatible fixes and small improvements, `0.6.0` starts the next feature set, and `1.0.0` is reserved for completion of the main product scope.

## Local Windows installer

Requirements: Node.js 24.15.0 (or a compatible supported Node 22.12+), npm, and Windows for a native installer. Run:

```sh
npm ci
npm run build:windows
npm run verify:windows-build
```

The build compiles TypeScript and creates an unsigned Windows x64 NSIS installer in `dist/`, named `Karaoke-Queue-Setup-<version>-x64.exe`. Its `beforePack` hook builds `build-resources/native/kq-win32.c` with the locked `node-gyp` and Electron headers, then copies the x64 PE to `resources/native/win32-x64/kq_win32.node` outside ASAR. The currently configured installer is fixed per-machine (`perMachine:true`), permits the NSIS elevation flow, fixes the protected Program Files target, and preserves `appId=com.karaoke.queue`, the generic executable name and the existing per-account `userData` paths. Role-specific identity is applied at runtime and to managed shortcuts; it does not rename the executable or move profiles. The current snapshot produced and verified a candidate at `E:\KaraokeQueue\e-independent-windows-final-20261108\checkout\dist\Karaoke-Queue-Setup-0.5.0-x64.exe`, SHA-256 `b8aef4fb40db719e554f849e3a07c72ec34cda59f4a59a22d09d67d709266885`; source fingerprint `3485486b7bffb7470863c124b792def0cdd5daa1d26c0775c94496cf18771d60`, build-input seal `3cb0090a142900f8dcd534bd41b51ef930d1e1e5f15bc6f9f86db97fe4bbfae4`. The package was not installed or uploaded. The build command uses `--publish never`.

The packaging verifier checks installer name, archive, Main, Preload, Renderer, assets, SQLite, icon, absence of tests/docs and `.node` files inside ASAR, and exactly one x64 `kq_win32.node` outside ASAR. The current build and verifier passed and the production addon loaded in Electron 45 Run-As-Node mode. `tests/packaged-windows-smoke.cjs` is restricted to a GitHub-hosted disposable Windows runner; it stages under a unique Program Files fixture and creates a protected synthetic ProgramData manifest, uses an isolated profile, checks that the global role overrides but does not rewrite a conflicting legacy mode file, writes/reads through Renderer → Preload → IPC → SQLite, restarts and checks persistence. It refuses preexisting fixture paths and cleans only its own fixtures. This smoke does not install NSIS, test a second account or control interactive UAC. It remains **NOT RUN** because the workflow was not dispatched.

## E1-02 implementation status

The bootstrap dispatches only fixed administrative argument grammars before loading the Main composition; packaged startup reads the protected global role, acquires the machine-wide runtime gate and retains per-account `userData`. The elevated path supports initial confirmation and the NSIS maintenance role-change command, validates Program Files and the protected manifest, uses the administrative/runtime gates and commits only after shortcut readback. On the current tree, `npm run test:unit`, `npm run test:release-workflow`, official Windows Electron/Playwright/SQLite regressions, x64 N-API build, package verification and isolated addon load passed. The NSIS install/uninstall smoke, UAC, cross-account ACL and two-account cases remain **NOT RUN**; they require hosted disposable Windows or an appropriate interactive lab. S1 remains PARTIAL and E1–E5 homologation/approval and distribution remain pending.

## Implemented function-selection flow — validation pending

The package config and source now implement the approved architecture: one Windows Electron Builder/NSIS installer and one production executable for two functions, Reprodutor (`player`) and Tudo em um (`combined`); `controller` remains compatibility only. NSIS does not select the first function. The first application launch presents the two options, then the video-library setup and optional CSV catalog setup; library setup may be deferred. The selected function is persisted globally while SQLite, sessions, history, libraries and settings remain under each account's `userData`. Later function changes are exposed by the NSIS maintenance page, never normal Settings. Build, screenshot comparison, UAC and native NSIS validation on the current snapshot remain pending.

The implementation maps function-specific display name, title, icon, AppUserModelID and managed shortcut properties while retaining the generic executable/appId/data paths. E3 supplies a Win32 global mutex in a minimal N-API binding; the current x64 production addon was compiled and packaged, while the isolated Electron mutex harness passed. Cross-account and installed-instance behavior remain unverified. Do not silently require elevation during normal operation or let onboarding create a second authority. Preserve SQLite, sessions, history, library, catalog, preferences and recovery. Do not treat unit fakes or prior fingerprints as evidence for the current install smoke.

E1-01 defined conservative legacy handling, preserved paths and recovery constraints. Current NSIS blocks an observed per-user registry install and ambiguous/orphaned global state; it does not move, convert, merge or delete legacy profiles. SQLite migration backup support has been implemented and is covered by isolated real-SQLite unit tests; it is not a multi-database atomic restore or installer rollback. No actual NSIS update/reinstall or old-version artifact test has run for the current snapshot. No automatic database conversion/profile fusion is assumed.

Builds are currently unsigned because no Windows signing certificate is configured. Windows SmartScreen may warn users. The workflow reports signature status and does not claim that the installer is signed.

## Pull requests

`.github/workflows/pr-validation.yml` runs on pull requests to `main` and has a manual `workflow_dispatch` validation trigger. Both paths use read-only repository permissions, run Linux compile/unit/workflow and real-Electron E2E, then build/verify the x64 NSIS installer on `windows-latest`, launch the packaged executable, and run a guarded install/uninstall smoke on the disposable GitHub-hosted runner. After all steps pass, it records event/ref/SHA/run/version/architecture, installer SHA-256 and smoke outcomes, then uploads a validation artifact for 30 days. PR artifacts use `Karaoke-Queue-PR-<number>-Windows-x64`; manual validation artifacts include run ID and source SHA. The workflow cannot create tags or publish Releases. It has not been dispatched by this task.

The current `.github/workflows/release-windows.yml` remains the separate manual publisher. Do not dispatch it during development. Keep the PR/validation artifact path separate from publication and keep packaged executable smoke distinct from NSIS install/maintenance tests.

## Manual prerelease

### Planned controlled venue-test milestone (Phase H7)

The roadmap's H7 milestone is a controlled first release for owner-led remote-operation tests at a karaoke venue, after H5 and H6 approval. It is not automatic authorization for a public/commercial release or for running the publication workflow below. Preparing builds, distributing them, and installing them each require the owner's specific authorization. H7 covers Management controlling a separate Standalone Player; local playback integrated into Combined is deferred to H8 and is not an H7 prerequisite. Build, distribution, publication, and effective installation each require specific owner authorization.

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

The PR/validation workflow is configured to build and verify a Windows x64 package, launch the packaged executable with a temporary profile, and silently install/uninstall NSIS on a disposable GitHub-hosted runner. This local task produced a verified candidate but did not dispatch the workflow or create a GitHub artifact. The automated smoke does not validate interactive maintenance page choices, UAC secure desktop, two-account ACL or two-session behavior. Those cases remain NOT RUN until executed in an appropriate disposable Windows environment. No public Release is created by the validation workflow; publication remains a separate owner-controlled action after review.

## Phase E process coordination candidate — 2026-11-09

The current protocol and its boundaries are documented in [the coordination contract](fase-e-coordenacao-instalacao.md) and [the current review record](fase-e-revisao-independente.md#10-correção-estrutural-da-coordenação-f1f3--2026-11-09). A protected process-tree Job Object spans NSIS/helper handoffs, while admin/runtime mutexes and exact installation/generation/operation fences protect mutations. NSIS releases mutexes on the section thread, including an obligatory final uninstall section. This candidate supersedes previous local artifacts; no installation or publication occurred.

Windows runner snapshot: `3432e5d295cbffc241747061fd8704766b68d52f467a34da60dec28e654053fe`; build input fingerprint: `0b407cead36fb204ca2168f12a69a03bed81ab2e78ef92b0abaee0bfd530a423` (223 inputs). NSIS x64 build, verifier and packaged addon-only load passed. Installer `Karaoke-Queue-Setup-0.5.0-x64.exe` SHA-256: `ae69327a4f5a0940fa8cae263478a04856b0124d4c3549fbcee6ac6d639bfd5f`. The unsigned file remains in the isolated NTFS checkout's dist; it is not a GitHub artifact or approved distribution. Subsequent documentation changes do not change these sealed inputs.

`build-windows-package.cjs` supplies the win32-x64 archive checksum from the locked Electron npm package's official `checksums.json`, as used by Electron's own postinstall. Missing or invalid checksums fail; SHA/TLS validation stays enabled. This avoids another SHASUMS network request for an already verified cached archive. Partial builds and leftover intermediate uninstallers remain rejected and never acquire a completed seal.

The PR workflow now also runs isolated real Win32/NSIS coordination probes before packaged/installed smokes. Installed smoke uses a hash-verified temporary uninstaller copy and the actual default, previously absent profile of the disposable account. It rejects pre-existing state and verifies process completion and all required removals before cleanup. GitHub execution, full packaged Main/SQLite smoke, real install/update/uninstall/reinstall, UAC, production cross-account ACL and two sessions remain NOT RUN locally. GO applies only to final review/validation PR, not homologation or release; no commit/push/dispatch is authorized by this correction task.
