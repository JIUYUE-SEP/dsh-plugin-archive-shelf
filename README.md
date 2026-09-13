# dsh-plugin-archive-shelf

An **Archive Shelf** for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI.

Harness sessions can be archived, but the product ships no way back: the sidebar
menu only hides them, and there is no unarchive control and no way to delete a
session's logs. This plugin adds one settings page that lists **every archived
session** and gives you the two missing actions.

English | [中文](README.zh.md)

## What you get

Settings → **Archive Shelf** (below *Agent presets*):

- every archived session with its **title**, workspace, directory, archive time and size on disk;
- **Restore** — removes the session from the archive set; it reappears in the sidebar
  **at its original position**, because archiving never touched its workspace slot;
- **Delete permanently** — behind a confirmation dialog, removes the session's log
  directory, its projection cache, and its workspace accounting. Irreversible;
- a status badge per row: **running** (an agent is driving a turn) or **loaded**
  (resident in the host process). Neither can be deleted safely — see limitations;
- **Clean up** for stale archive records whose session no longer exists on disk.

## Requirements

- DeepSeek Harness with a `web` profile. Developed and verified against `0.1.5-rc.2`.
- Node `^22.19 || >=24` (whatever the harness itself requires).

## Install

```sh
# 1. install the plugin into your web profile
dsh plugin --profile web add github:JIUYUE-SEP/dsh-plugin-archive-shelf
```

```yaml
# 2. mount it — append to ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: archive-shelf
      name: dsh-plugin-archive-shelf
```

Then **restart** `dsh` and reload the page. A static client plugin is delivered
with the page boot graph, so a plain refresh is not a reliable way to pick up a
new or updated plugin; a restart always is.

### Manual / local install

```sh
git clone https://github.com/JIUYUE-SEP/dsh-plugin-archive-shelf.git
dsh plugin --profile web add ./dsh-plugin-archive-shelf
# same cordis.patch.yml row as above, then restart
```

### Uninstall

```sh
dsh plugin --profile web remove dsh-plugin-archive-shelf
# then delete the `- insert:` row you added to cordis.patch.yml
```

## How it works

No build step: both halves are plain JavaScript and shipped as-is.

- **`lib/index.js` (host)** — a Cordis plugin injecting `workspaceRegistry`,
  `sessionPersistence` and `webServer`. It registers one same-origin JSON route
  (`POST /archive-shelf/api`) and implements four operations: `list`,
  `unarchive`, `delete`, `forget`. Deleting uses `node:fs` directly — the host
  plugin is ordinary Node code, so it needs no sandbox escalation.
- **`lib/client.js` (browser)** — written directly in the client module loader's
  factory form (`window.__ModuleLoader__.load({ id, factory })`), because the
  harness's own client bundler preset lives inside its repository and is not
  published. It registers one `settings.section`, so the page appears in the
  settings card's left tab bar and needs no change to the product.

The route authenticates itself: `POST` + `content-type: application/json` + the
`x-archive-shelf-client: 1` marker header is a *non-simple* cross-origin request,
so a foreign page hits a CORS preflight this server never answers, and an
`Origin`/`Host` match is checked on top. That protects against cross-site
requests, not against other processes on the same machine — those can already
read and delete session files directly.

## Known limitations

- **Restoring uses an internal API.** The harness has no public unarchive
  operation, so the plugin writes the archive set through the workspace
  registry's own `setState`. If a harness upgrade changes that internals shape
  the plugin fails loudly instead of silently doing nothing.
- **Resident or running sessions cannot be deleted.** A session that the host
  process has loaded keeps its log in memory; deleting the files underneath it
  would leave a live session with no durable record (and a later append could
  write the log back). Such rows say so and their delete button stays disabled —
  restart `dsh`, and they are deletable.
- **Attachments are not deleted.** Binary attachments a deleted session
  referenced stay in the harness home.
- **Deletion is irreversible** and there is no trash.
- **Archiving a running session is allowed by the product** (the sidebar's
  archive action has no guard), which hides a session that keeps consuming
  tokens. The shelf's *running* badge is how you see one.

## Development

```sh
npm test        # zero dependencies; drives both shipped artifacts
```

The test imports the host half as an ESM module, evaluates the browser half the
way the client loader does, and renders rows through a minimal React stand-in so
badge, disabled-button and failure-copy behaviour are all asserted.

Two invariants worth knowing before you edit:

1. **The browser bundle's module id must equal the package name**
   (`registration.id === manifest.name`) — the loader looks the factory up by
   that name. The test fails if they drift.
2. **The host resolves nothing by bare specifier.** It imports `node:` builtins
   only; every other capability arrives through injected services. That is what
   lets the package live outside the harness repository and still load.

## License

MIT — see [LICENSE](LICENSE).
