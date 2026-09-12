# Karaoke Queue

Karaoke Queue is a desktop queue manager for karaoke venues. It helps operators register singers, keep the line fair, and manage the current karaoke session from a simple Electron app.

## Features

- Add singers with a table number and up to two songs per turn.
- Add multiple singers at once with batch entry.
- Keep the current singer locked until the turn is marked as sung or cancelled.
- Show the next three recommended singers.
- Reorder upcoming singers with drag and drop.
- Move an upcoming singer into the current turn when needed.
- Prevent the same table from repeating immediately when another table is waiting.
- Balance tables using recent singing history and waiting entries.
- Show long-waiting entries and let the operator manually move them forward.
- Keep a searchable session history, including cancelled entries.
- View table-level singing details from the history.
- Persist queue and session data to disk with `electron-store`.
- Customize the app name and toggle the visual theme.

The app intentionally focuses on queue operation and history rather than statistics or analytics dashboards.

## Requirements

- Node.js 18 or newer
- npm

## Installation

```bash
npm install
```

## Development

Start the application with:

```bash
npm start
```

## Build

Create a distributable application with:

```bash
npm run build
```

The current build configuration targets Windows with an NSIS installer.

## Queue Rules

Each queue entry represents one singer turn and can contain one or two songs. The queue logic:

1. Keeps the current turn stable until the operator finishes or cancels it.
2. Uses arrival order as the base ordering.
3. Spreads multiple entries from the same table across other waiting tables.
4. Uses recent table turns as an internal fairness factor.
5. Avoids consecutive turns from the same table whenever another table is available.
6. Allows repeated turns when only one table remains.
7. Lets the operator override the recommendation manually with drag and drop.

Manual overrides are intentional and take precedence over the automatic recommendation.

## Data Storage

The Electron application stores queue, history, session, and preference data using `electron-store`. Data is persisted in the operating system's application data directory and survives normal application restarts.

When `src/index.html` is opened directly in a browser during development, the app falls back to `localStorage` for storage.

## Trial Activation

New installations include a 30-day local trial. After the trial expires, the application requires the activation code before it can be used:

```text
karaokequeue
```

Successful activation is stored locally and only needs to be entered once on that installation.

## Project Structure

```text
.
├── main.js             Electron main process
├── preload.js          Secure renderer/main-process bridge
├── src/
│   ├── app.js          Queue logic and application behavior
│   ├── index.html      Application markup
│   └── style.css       Application styles
└── package.json        Scripts and Electron configuration
```

## License

No license has been specified for this project yet.
