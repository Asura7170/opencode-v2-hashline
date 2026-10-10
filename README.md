# opencode-hashline

Hashline plugin for opencode v2 (phase 1: pi-style allocated anchors).
Scaffolding only: plugin entry, stable id, test runner.

## Local install

Prerequisites: [opencode v2](https://opencode.ai/v2/docs) (`opencode --version`
≥ 2.0) and [bun](https://bun.sh) 1.x.

```sh
bun install
```

Register this directory as a local plugin in your project's `opencode.jsonc`
(absolute path; the entry **must be a directory** — opencode resolves it via
`package.json` `main`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-hashline"],
}
```

Then reload the location and confirm the id and source in the active list:

```sh
opencode plugin list
# or against a running server:
# GET /api/plugin?location[directory]=<project-dir>  → id "opencode-hashline", status active
```

After editing `opencode.jsonc`, reload the location
(`POST /api/location/reload` or restart the server/TUI).

## Tests

```sh
bun test          # entry seam: stable id + setup
bun run typecheck # tsc --noEmit
```
