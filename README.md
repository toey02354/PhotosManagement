# Photos Management

A macOS desktop app for renaming photos, organizing Live Photo videos, and restoring metadata from originals.

## Preview and apply

1. Choose a target folder and enable the changes you want. Choose a metadata source folder if you are restoring embedded metadata or Finder dates.
2. Click **Preview changes**. The table shows the current filename, proposed path, date source, actions, and reasons for skipped changes.
3. Review the table and uncheck any files you want to leave untouched. Click **Run selected** to apply the reviewed changes. Changing folders or options requires a new preview.

Files that change after preview are skipped when detected. Existing destination files are preserved. Filename conflicts are reported and left in place. Live Photo videos are moved only when their embedded identifier matches that of a still image in the group.

## Undo last run

**Undo last run** reverses renames and moves from the most recent run that recorded file moves. The undo record survives app restarts. If an original path is occupied or a moved file has changed, Undo leaves the file in place and reports the issue. Unresolved operations remain available for retry.

Undo changes file locations. Embedded metadata edits and Finder date changes stay as applied, so keep a backup before using those options on files you may need to restore.

## Development

Requires Node.js 22.12 or newer. ExifTool is used for embedded metadata and Live Photo verification. The macOS SetFile utility is used to update Finder Created dates.

```bash
nvm use
npm install
npm run dev
```

Run `npm test` for unit tests and `npm run build` for the production build.
