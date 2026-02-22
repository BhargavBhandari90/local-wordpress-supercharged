# Local WordPress Supercharged

A [Local by Flywheel](https://localwp.com/) addon that gives you instant control over WordPress debug constants directly from the Site Overview page.

## Features

### Toggle Debug Constants from the UI

Three toggle switches are injected into the **Site Info Overview** page, letting you enable or disable WordPress debug constants without ever touching `wp-config.php` by hand:

- **WP_DEBUG** — Enables WordPress debug mode
- **WP_DEBUG_LOG** — Writes debug output to `wp-content/debug.log`
- **WP_DEBUG_DISPLAY** — Shows/hides errors on the front end

Each switch uses WP-CLI under the hood (`wp config get` / `wp config set --raw --add`) to read and write the constants.

### Smart Caching

Constant values are cached on the SiteJSON object, so switching between sites is instant — no WP-CLI calls needed. The cache is:

- **Written** after every fetch and every toggle
- **Invalidated automatically** by comparing the cache timestamp against `wp-config.php`'s file modification time (`mtime`)
- A single `fs.statSync` call (~0.1ms) determines freshness — three WP-CLI spawns are only triggered on cache miss

### Live File Watching

If you edit `wp-config.php` directly (in a text editor, via SSH, or with another tool), the addon detects the change in real time and updates the switches automatically:

- Uses `fs.watch` (OS-level file system events) — not polling
- Watcher lifecycle is tied to the component: starts when you view a site, stops when you navigate away
- A self-writing guard prevents the watcher from firing during addon-initiated writes, eliminating UI flicker

### Optimistic UI with Rollback

When you toggle a switch, the UI updates immediately (optimistic update). If the WP-CLI call fails, the switch reverts to its previous state. Each switch is independently disabled while its write is in flight, so you can toggle multiple constants without waiting.

## Installation

Clone the repository into the Local addons directory for your platform:

- **macOS**: `~/Library/Application Support/Local/addons`
- **Windows**: `C:\Users\username\AppData\Roaming\Local\addons`
- **Linux**: `~/.config/Local/addons`

Then:

```bash
yarn install
yarn build
```

Open Local and enable the addon.

## Development

### Project Structure

```
src/
  main.ts                                      # Main process entry point (thin shell)
  renderer.tsx                                  # Renderer process entry point (thin shell)
  shared/
    types.ts                                    # Shared types, constants, IPC channel names
  features/
    debug-constants/
      debug-constants.service.ts                # WP-CLI fetch/set, cache read/write
      debug-constants.watcher.ts                # fs.watch lifecycle, self-writing guard
      debug-constants.ipc.ts                    # IPC handler registration
      DebugSwitches.tsx                         # React component (factory pattern)
      debug-constants.hooks.tsx                 # Renderer hook registration
```

The codebase is organized by feature. Each feature is self-contained under `src/features/`. Adding a new feature means creating a new directory and adding one import + one call in each entry point.

### Build

```bash
yarn build        # Compile TypeScript to lib/
yarn watch        # Compile in watch mode
```

### External Libraries

- **@getflywheel/local** — Type definitions for Local's addon API
- **@getflywheel/local-components** — React component library (Switch, TableListRow, etc.)

## License

MIT
