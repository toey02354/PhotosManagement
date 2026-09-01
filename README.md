# Photos Management

Electron + React + TypeScript successor to `rename_createddate_livephoto_gui_v9.py`.

## Development

Requires Node.js 22.12 or newer.

```bash
npm install
npm run dev
```

The desktop shell, sandboxed preload API, v9 option semantics, and processing-engine boundary are initialized. The TypeScript processing engine is currently a safe placeholder: it performs no file mutations until the Python v9 behavior is ported and tested.
