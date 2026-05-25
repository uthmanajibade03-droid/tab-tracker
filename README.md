# Tab Tracker

Minimal Chrome/Edge extension to track sites visited and active time per day.

## Install

1. Open `chrome://extensions` (or `edge://extensions`).
2. Toggle **Developer mode** on.
3. Click **Load unpacked** and pick this folder.
4. Pin the Tab Tracker icon to your toolbar.

## How it works

- Counts a **visit** whenever a tab navigates to a new domain.
- Counts **active time** while a tab is focused, the browser window has focus, and you're not idle (60s threshold).
- Data is stored locally (`chrome.storage.local`); nothing leaves your machine.
- Click the toolbar icon for a quick popup; click "Open dashboard" for the full view, day picker, export, and clear.
