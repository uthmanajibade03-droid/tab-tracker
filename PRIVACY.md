# Tab Tracker — Privacy Policy

_Last updated: May 25, 2026_

Tab Tracker is a Chrome/Edge extension that records how many tabs you open, how many times you visit each site, and how much time you actively spend on each site.

## What data is collected

To do its job, Tab Tracker reads:

- The **URL** of tabs you open and navigate to (used only to extract the hostname, e.g. `github.com`).
- The **active/focused state** of your browser tabs and windows (used to time how long each site is in the foreground).
- The **idle state** of your computer, as reported by the browser (used to pause tracking when you walk away).

## Where the data goes

**Nowhere. The data never leaves your device.**

- All statistics are stored locally in your browser using `chrome.storage.local`.
- The extension does not contain any analytics, telemetry, tracking pixels, or remote servers.
- The extension does not make any network requests of any kind.
- The extension does not share, sell, or transmit your data to any third party.

## Your control

- View all collected data at any time via the extension's dashboard.
- Export everything as a JSON file from the dashboard.
- Permanently delete everything with the "Clear all" button on the dashboard.
- Uninstalling the extension removes all stored data.

## Permissions explained

| Permission | Why it's needed |
|---|---|
| `tabs` | Read tab URLs to group activity by site |
| `host_permissions: <all_urls>` | Inject the floating timer badge on every page |
| `storage` | Save statistics locally on your device |
| `idle` | Pause tracking when you're away from your computer |
| `alarms` | Periodically save in-flight tracking time |

## Contact

If you have questions, open an issue on the project's repository or contact the developer through the Chrome Web Store listing.
