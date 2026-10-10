# opencode-hashline

Hashline plugin for opencode v2 (phase 1: pi-style allocated anchors).

Tools: `read` (native override, serves `anchor│content` rows) + `replace` +
`insert` + `undo_last_change`. Same-message same-file edits commit once with
one undo. Native `edit` inputs get echoed `anchor│` prefixes stripped (with an
`H_ECHO_STRIPPED` notice); native `write` with echoed prefixes fails with
`E_ANCHOR_ECHO`. `@file` attachments arrive annotated and in-project files
are editable by anchor without a prior read.

## Local install

Prerequisites: [opencode v2](https://opencode.ai/v2/docs) (`opencode --version`
≥ 2.0) and [bun](https://bun.sh) 1.x.

Install dependencies **inside the plugin directory** (the host loads the
directory as-is; without its own `node_modules` it fails to resolve
`@opencode/plugin`):

```sh
cd /absolute/path/to/opencode-hashline
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
# or against a running server (Basic auth `opencode:<server-password>`):
# GET /api/plugin?location[directory]=<project-dir>  → id "opencode-hashline", status active
```

After editing `opencode.jsonc`, reload the location
(`POST /api/location/reload` or restart the server/TUI). New sessions pick up
the current tool snapshot; in-flight sessions keep the snapshot from their
first request.

## Config (no UI in phase 1)

File global `<home>/.config/opencode/hashline/config.json`, override per
project `<project>/.opencode/hashline/config.json`, override per plugin
options. Precedence: global < project < options. Unknown keys are rejected.
Defaults: 2000 output lines / 50KB output / 2000 chars per row / 1MiB per file /
4096 anchors. `storeDir` (sidecar directory) may be absolute, or relative —
relative is resolved against the **project** directory.

## Notes and known limitations

- `@file` outside the project is annotated (anchors visible as context) but
  **not editable**: hashline tools reject out-of-project paths with
  `E_PATH_EXCLUDED`. Binary/image/excluded attachments are admitted
  unannotated with a visible `H_ATFILE_SKIPPED` note (explicit code per
  file), never breaking admission.
- Echo-strip is shape-based (`^[a-z]{4}│` per line): a legitimate content line
  starting with 4 lowercase letters + `│` sent through native `edit` would be
  stripped (always with an `H_ECHO_STRIPPED` notice). Native `write` never
  strips — it fails closed with `E_ANCHOR_ECHO`.
- Stale anchors fail with `E_ANCHOR_STALE` plus the current rows in the
  message, so the model retries without a re-read.

## Tests

```sh
bun test          # entry seam: stable id + setup
bun run typecheck # tsc --noEmit
```
