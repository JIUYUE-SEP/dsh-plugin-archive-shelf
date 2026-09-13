# dsh-plugin-archive-shelf

An **Archive Shelf** for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI.

Harness sessions can be archived, but the product ships no way back: the sidebar
menu only hides them, and there is no unarchive control and no way to delete a
session's logs. This plugin adds one settings page that lists **every archived
session** and supplies the missing actions: restore, queue a deletion (which you
can cancel again), and — where the host supports it — release a session and
delete it immediately.

English | [中文](README.md)

## What you get

Settings → **Archive Shelf** (below *Agent presets*):

- every archived session with its **title**, workspace, directory, archive time and size on disk;
- **Restore** — removes the session from the archive set; it reappears in the sidebar
  **at its original position**, because archiving never touched its workspace slot.
  Restoring does two things the product does not do by itself: it re-pulls the browser's
  session list (a **released** session was dropped from it when the host announced
  `session/disposed`), and it hands the new archive set to the product's workspace state.
  Both are needed before the sidebar can show the row again. The one exception is
  restoring the **last** archived session, which leaves no anchor to sync with — the
  notice then says to refresh instead of pretending it worked;
- **Delete permanently** — behind a confirmation dialog, removes the session's log
  directory, its projection cache, and its workspace accounting. Irreversible;
- **Queue deletion / Cancel queue** — for a session that cannot be deleted right now
  (running or loaded), record the intent instead: the next `dsh` start deletes it.
  A queued deletion is **always cancellable**, and cancelling does nothing else;
- **Release** — shown only when your DSH exposes `agents.release(id)` (see below):
  unloads the session's live runtime so it can be deleted at once, with no restart;
- a status badge per row: **running** (an agent is driving a turn), **loaded**
  (resident in the host process), or **queued** (deleted on the next start);
- **Clean up** for stale archive records whose session no longer exists on disk.

### What queueing means

Queueing deletes **nothing** right away; it records your intent:

- the queue lives in `.archive-shelf/pending.json` under the harness home (beside the
  session root) and survives restarts;
- it is honoured **only after the next `dsh` start** (a sweep a few seconds in); reading or
  refreshing the shelf never deletes anything, so queueing and deleting stay separate
  acts. An entry that is still resident or running at that moment waits for the start
  after that;
- a queued row shows the **queued** badge and a **Cancel queue** button; cancelling is
  idempotent, so a stray click costs nothing;
- if you **restore** a queued session, its queue entry is dropped — a session you
  brought back is never deleted by a stale request.

### About the Release button

Once a session has been loaded in the host process there is no public way to unload
it — that is the current shape of DSH (the `agents` service has no release-by-id
method, and the one `dispose` handle that could do it is discarded by its creator).
So the plugin **detects the capability**:

- if your DSH provides `agents.release(id)`, the list route reports `canRelease: true`
  and rows grow a **Release** button: release → no longer resident → deletable, no
  restart at any point;
- without that capability the button **does not appear** (rather than failing when
  clicked), and queued deletion remains available.

That host-side capability is **not in upstream DSH today**. To get it you either patch
your own DSH (edit `packages/core/agent` in a source checkout, or `pnpm patch` an npm
install) or wait for it to be accepted upstream.

## Making the Release button appear (optional host patch)

The patch ships with this repository: `patches/host-release.patch` — it touches only
`packages/core/agent` (retain each agent handle's disposal capability and expose
`release(id)`), plus a 161-line spec.

```sh
cd /path/to/deepseek-harness
git apply /path/to/dsh-plugin-archive-shelf/patches/host-release.patch
pnpm exec tsc -b packages/core/agent && pnpm --filter @deepseek-ai/dsh-agent exec tsdown
# restart dsh: loaded rows in the shelf now carry a Release button
```

- **A DSH upgrade can drop the patch, and `git pull` may refuse to merge it.** On a
  conflict, run `git checkout -- packages/core/agent` and apply it again; either way the
  change needs a rebuild and a restart.
- **An npm-installed DSH cannot use this patch as-is**: it holds compiled `lib/` files, so
  the equivalent change goes through `pnpm patch @deepseek-ai/dsh-agent` — same semantics,
  different landing site.
- The way to make it universal is an upstream PR; the patch is written to be one.

## Requirements

- DeepSeek Harness with a `web` profile. Developed and verified against `0.1.5-rc.2`.
- Node `^22.19 || >=24` (whatever the harness itself requires).

## Install

**One command** — the dependency and the mount happen together, and re-running it is safe:

```sh
dsh plugin --profile web add github:JIUYUE-SEP/dsh-plugin-archive-shelf
```

Then **restart** `dsh` (`Ctrl+C`, then `dsh web` again) and reload the page. A static client
plugin ships with the page's boot graph, so a plain refresh does not reliably pick it up
(browser cache and scan timing both interfere); a restart always does.

Why that is enough: this package declares `dsh.bundle.patch` in its own `package.json` and
ships a `cordis.patch.yml` layer. After pnpm finishes, `dsh plugin add` **reconciles that
layer into the profile's `dsh.profile.bundles`**, so you never edit
`~/.dsh/profiles/web/cordis.patch.yml` by hand.

<details>
<summary>If the layer was not registered automatically (a DSH older than that reconciliation)</summary>

```yaml
# Append to ~/.dsh/profiles/web/cordis.patch.yml, then restart
- insert:
    - id: archive-shelf
      name: dsh-plugin-archive-shelf
```
</details>

### Local install

```sh
git clone https://github.com/JIUYUE-SEP/dsh-plugin-archive-shelf.git
dsh plugin --profile web add ./dsh-plugin-archive-shelf   # mounts itself the same way
```

### Uninstall

```sh
dsh plugin --profile web remove dsh-plugin-archive-shelf   # also drops it from dsh.profile.bundles
```

If you added the `- insert:` block from the fold-out above by hand, delete that too.

## Making the Release button appear (optional host patch)

The patch ships with this repository: `patches/host-release.patch` — it touches only
`packages/core/agent` (retain each agent handle's disposal capability and expose
`release(id)`), plus a 161-line spec.

```sh
cd /path/to/deepseek-harness
git apply /path/to/dsh-plugin-archive-shelf/patches/host-release.patch
pnpm exec tsc -b packages/core/agent && pnpm --filter @deepseek-ai/dsh-agent exec tsdown
# restart dsh: loaded rows in the shelf now carry a Release button
```

- **A DSH upgrade can drop the patch, and `git pull` may refuse to merge it.** On a
  conflict, run `git checkout -- packages/core/agent` and apply it again; either way the
  change needs a rebuild and a restart.
- **An npm-installed DSH cannot use this patch as-is**: it holds compiled `lib/` files, so
  the equivalent change goes through `pnpm patch @deepseek-ai/dsh-agent` — same semantics,
  different landing site.
- The way to make it universal is an upstream PR; the patch is written to be one.

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

## After a DSH upgrade

This plugin fills gaps the product explicitly does not offer (archiving is one-way, there is
no session-deletion entry point, and no API unloads a session), so it necessarily touches
things that were **never promised**: the workspace registry's private `setState`, the session
log's on-disk layout, and the `agents.release(id)` capability the optional host patch adds.
After upgrading DSH, spend one minute on this:

```sh
cd /path/to/dsh-plugin-archive-shelf && npm test   # both suites: client contract/rendering + host behaviour
```

1. Restart, then open **Settings → Archive Shelf**: the list renders, the badges (running /
   loaded / queued) are right, and no error banner appears;
2. **Restore** one archived session you do not care about — it must return to its sidebar
   position (this is the `setState` check);
3. **Delete** one session you do not want — its directory goes away and no unopenable row is
   left behind in the sidebar;
4. Check whether loaded rows carry a **Release** button. If they do not, a DSH upgrade
   dropped the host patch: re-apply it as described above, rebuild, and restart (until then
   the feature degrades to queued deletion on its own).

Failures are meant to be **loud**: when a private API is gone, a path no longer matches, or the
session-list snapshot cannot be read, the plugin refuses and says why instead of guessing. If
something does break, open an issue with the message the shelf showed plus your `npm test` output.

## How it works

No build step: both halves are plain JavaScript and shipped as-is.

- **`lib/index.js` (host)** — a Cordis plugin injecting `workspaceRegistry`,
  `sessionPersistence` and `webServer`. It registers one same-origin JSON route
  (`POST /archive-shelf/api`) and implements seven operations: `list`,
  `unarchive`, `delete`, `forget`, `queue`, `unqueue`, `release`. Deleting uses
  `node:fs` directly — the host plugin is ordinary Node code, so it needs no
  sandbox escalation. The queue is this plugin's own state, written to
  `<harness home>/.archive-shelf/pending.json` through a temporary file plus a
  rename, so a half-written queue can never be read back.
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
- **A resident or running session cannot be deleted directly.** A session the host
  process has loaded keeps its log in memory, and the host re-opens that log by path
  on every append, so removing the files underneath it would either fail the live
  session or resurrect a partial log. Such rows have two ways out: **queue the
  deletion** (cancellable, honoured on the next start), or **release** the session
  first on a host that supports it.
- **A queued deletion waits for the next start.** Crossing processes is the point of
  the queue: entries are honoured by the startup sweep and on every shelf load. If the
  session is resident again by then, it stays queued for the next attempt.
- **Release needs host support.** See above; without it the button is absent and the
  feature degrades to queueing.
- **Attachments are not deleted.** Binary attachments a deleted session
  referenced stay in the harness home.
- **Deletion is irreversible** and there is no trash.
- **Archiving a running session is allowed by the product** (the sidebar's
  archive action has no guard), which hides a session that keeps consuming
  tokens. The shelf's *running* badge is how you see one.

## Development

```sh
npm test        # zero dependencies; two suites: contract/rendering + host behaviour
```

- `test/plugin.test.mjs` imports the host half as an ESM module, evaluates the browser
  half the way the client loader does, and renders rows through a minimal React
  stand-in, asserting badges, button visibility and disabled reasons, failure copy, and
  the exact request each button sends;
- `test/host.test.mjs` drives the real `apply()` through fake Cordis contexts and real
  loopback HTTP servers, deleting and writing for real inside temp directories: path
  escape, an oversized body, running/resident refusals, queueing, cancelling, honouring
  the queue across a restart, the three release outcomes, and a service-less
  composition. Every one of them is a runnable regression assertion; `npm test` prints the exact totals.

Two invariants worth knowing before you edit:

1. **The browser bundle's module id must equal the package name**
   (`registration.id === manifest.name`) — the loader looks the factory up by
   that name. The test fails if they drift.
2. **The host resolves nothing by bare specifier.** It imports `node:` builtins
   only; every other capability arrives through injected services. That is what
   lets the package live outside the harness repository and still load.

## License

MIT — see [LICENSE](LICENSE).
