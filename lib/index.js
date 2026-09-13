/**
 * 归档架 (Archive Shelf) — host half.
 *
 * Registers one self-authenticating browser route and implements the archive
 * operations the settings section needs: list, unarchive, delete, forget, and
 * the deletion queue (queue/unqueue). A package outside the harness repository
 * has no generated Remote namespace, so the two halves speak over this
 * same-origin JSON route instead.
 *
 * The queue exists because a session that is resident in this process cannot be
 * deleted safely under its own live runtime: its log is re-opened by path on
 * every append, so removing the files would either fail the live session or
 * resurrect a partial log. A queued id is retried on every shelf load and after
 * boot, and the request can always be cancelled again.
 *
 * Imports node builtins only: a bare specifier would resolve from this
 * package's own location, which sits outside the harness dependency closure.
 */
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export const name = 'archive-shelf'
export const inject = ['workspaceRegistry', 'sessionPersistence', 'webServer']

/** Absolute pathname of the browser-facing route. */
const API_PATH = '/archive-shelf/api'
/** Largest accepted request body; every request here is a few short strings. */
const MAX_BODY_BYTES = 64 * 1024
/** Queue directory and file beneath the harness home (the parent of the session root). */
const QUEUE_DIR = '.archive-shelf'
const QUEUE_FILE = 'pending.json'
/** Delays after mount for the boot sweep; the registry may not have loaded its state yet. */
const SWEEP_DELAYS_MS = [4_000, 20_000]

const asText = value => (value === undefined || value === null) ? '' : String(value)
const reasonOf = error => (error !== null && error !== undefined && error.message !== undefined)
  ? String(error.message)
  : String(error)

/**
 * Faithful port of the JSONL backend's path-segment escaping, used only to
 * match an on-disk directory back to its session id. A mismatch makes the
 * lookup miss (the caller then reports the session as absent) rather than
 * deleting an unrelated directory.
 * @param raw - session id.
 * @returns the directory name that id owns.
 */
function encodeSegment(raw) {
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < raw.length; index++) {
    const code = raw.charCodeAt(index)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * Install the archive shelf host half.
 * @param ctx - host context carrying the workspace registry, session persistence, and web server.
 */
export function apply(ctx) {
  const registry = ctx.workspaceRegistry
  const persistence = ctx.sessionPersistence
  const archivedIds = () => Array.from(registry.archivedSessionIds, asText)

  const sessionsRoot = () => {
    const config = persistence.config
    if (config === undefined || config === null) return undefined
    if (typeof config.root !== 'string' || config.root === '') return undefined
    // A configured trailing separator would turn the containment checks below
    // into doubled separators and refuse every delete, so it is normalized away.
    const trimmed = config.root.replace(/\/+$/, '')
    return trimmed === '' ? '/' : trimmed
  }

  const sessionDirs = async (root) => {
    const map = new Map()
    if (root === undefined) return map
    let projects
    try {
      projects = await readdir(root, { withFileTypes: true })
    } catch (error) {
      ctx.logger.warn(`archive-shelf: cannot read ${root}: ${reasonOf(error)}`)
      return map
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue
      const dir = join(root, project.name)
      let children
      try {
        children = await readdir(dir, { withFileTypes: true })
      } catch (error) {
        continue
      }
      for (const child of children) {
        if (child.isDirectory()) map.set(child.name, join(dir, child.name))
      }
    }
    return map
  }

  const dirBytes = async (dir) => {
    let total = 0
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      return null
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      try {
        total += (await stat(join(dir, entry.name))).size
      } catch (error) {
        continue
      }
    }
    return total
  }

  const projectionCachePath = (sessionId) => {
    const root = sessionsRoot()
    if (root === undefined) return undefined
    const home = dirname(root)
    if (home === '/' || home === '') return undefined
    return join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  }

  const sessionExists = async (sessionId) => {
    const live = ctx.get('sessions')
    if (live !== undefined && live.get(sessionId) !== undefined) return true
    const query = ctx.get('sessionQuery')
    if (query !== undefined) {
      try {
        for (const record of await query.listSessions()) {
          if (asText(record.header.id) === sessionId) return true
        }
      } catch (error) {
        ctx.logger.warn(`archive-shelf: session listing failed: ${reasonOf(error)}`)
      }
    }
    try {
      for (const snapshot of await persistence.list()) {
        if (asText(snapshot.header.id) === sessionId) return true
      }
    } catch (error) {
      ctx.logger.warn(`archive-shelf: persistence listing failed: ${reasonOf(error)}`)
    }
    const root = sessionsRoot()
    if (root !== undefined) {
      const dirs = await sessionDirs(root)
      if (dirs.has(encodeSegment(sessionId))) return true
    }
    return false
  }

  // ── deletion queue ────────────────────────────────────────────────────────
  // Owned state of this plugin, kept beside the session root it deletes from.
  // A queued id survives restarts, which is the point: the deletion lands on the
  // next boot, when nothing is resident any more.

  const queuePath = () => {
    const root = sessionsRoot()
    if (root === undefined) return undefined
    const home = dirname(root)
    if (home === '/' || home === '') return undefined
    return join(home, QUEUE_DIR, QUEUE_FILE)
  }

  /** Queued ids, or null until the file has been read once. */
  let queued = null
  /** Serializes queue mutations so two requests cannot interleave a read-modify-write. */
  let queueTail = Promise.resolve()

  const loadQueue = async () => {
    if (queued !== null) return queued
    const path = queuePath()
    if (path === undefined) {
      queued = []
      return queued
    }
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8'))
      const list = (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.pending))
        ? parsed.pending
        : []
      queued = list.map(asText).filter(id => id !== '')
    } catch (error) {
      // A missing file is the ordinary state before the first queue request; a
      // corrupt or unreadable one is reported and then treated as empty.
      if (error === null || error === undefined || error.code !== 'ENOENT') {
        ctx.logger.warn(`archive-shelf: cannot read the deletion queue at ${path}: ${reasonOf(error)}`)
      }
      queued = []
    }
    return queued
  }

  const saveQueue = async (ids) => {
    const path = queuePath()
    if (path === undefined) throw new Error('session persistence root is unknown; cannot persist the deletion queue')
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.tmp`
    await writeFile(temporary, `${JSON.stringify({ version: 1, pending: ids }, null, 2)}\n`, 'utf8')
    await rename(temporary, path)
    queued = ids
    return ids
  }

  /** Run one queue mutation with exclusive access to the file. */
  const withQueue = (mutate) => {
    const run = queueTail.then(async () => {
      const current = (await loadQueue()).slice()
      const next = await mutate(current)
      return next === undefined ? current : await saveQueue(next)
    })
    queueTail = run.then(() => {}, () => {})
    return run
  }

  // ── session operations ────────────────────────────────────────────────────

  /**
   * Change the registry-global archive set through the same durable write the
   * registry's own `archiveSession` uses, so its in-memory cache stays coherent
   * and the storage domain emits the `domain/changed` event that restores the
   * session in every connected browser.
   */
  const writeArchived = async (sessionId) => {
    const state = registry.state
    if (state === undefined || state === null || typeof registry.setState !== 'function') {
      throw new Error('workspace registry no longer exposes state/setState; cannot change the archive set')
    }
    const current = Array.from(state.archivedSessionIds, asText)
    if (!current.includes(sessionId)) return current
    const next = current.filter(id => id !== sessionId)
    await registry.setState(Object.assign({}, state, { archivedSessionIds: next }))
    return next
  }

  const changeArchive = async (sessionId) => {
    // Called on the registry, never through an extracted reference: the
    // operation chain is instance state, so a detached method call loses `this`.
    return (typeof registry.enqueueOperation === 'function')
      ? await registry.enqueueOperation(() => writeArchived(sessionId))
      : await writeArchived(sessionId)
  }

  const detachFromWorkspaces = async (sessionId) => {
    const failures = []
    for (const workspace of registry.list()) {
      if (!Array.from(workspace.sessionIds, asText).includes(sessionId)) continue
      try {
        await workspace.detachSession(sessionId)
      } catch (error) {
        failures.push(reasonOf(error))
      }
    }
    return failures
  }

  const collect = async () => {
    const archived = archivedIds()
    const root = sessionsRoot()
    const dirs = await sessionDirs(root)
    const pending = await loadQueue()

    const workspaceTitle = new Map()
    for (const workspace of registry.list()) {
      for (const sessionId of workspace.sessionIds) {
        workspaceTitle.set(asText(sessionId), asText(workspace.title))
      }
    }

    const headers = new Map()
    const live = new Set()
    let listed = false
    const query = ctx.get('sessionQuery')
    if (query !== undefined) {
      try {
        for (const record of await query.listSessions()) {
          const id = asText(record.header.id)
          headers.set(id, record.header)
          if (record.live === true) live.add(id)
        }
        listed = true
      } catch (error) {
        ctx.logger.warn(`archive-shelf: session listing failed: ${reasonOf(error)}`)
      }
    }
    if (!listed) {
      try {
        for (const snapshot of await persistence.list()) {
          headers.set(asText(snapshot.header.id), snapshot.header)
        }
      } catch (error) {
        ctx.logger.warn(`archive-shelf: persistence listing failed: ${reasonOf(error)}`)
      }
    }
    const liveSessions = ctx.get('sessions')
    if (liveSessions !== undefined) {
      for (const session of liveSessions.list()) {
        const id = asText(session.id)
        live.add(id)
        if (!headers.has(id)) headers.set(id, session.header)
      }
    }

    // `live` means resident in this process; `running` means an agent is driving
    // a turn right now. The product derives its own row status from the second,
    // and the two differ for a session that is merely loaded.
    const agents = ctx.get('agents')
    const runningIds = new Set()
    if (agents !== undefined) {
      for (const id of archived) {
        const agent = agents.get(id)
        if (agent !== undefined && agent.status === 'running') runningIds.add(id)
      }
    }

    const titles = new Map()
    const known = archived.filter(id => headers.has(id))
    if (query !== undefined && known.length > 0) {
      try {
        for (const result of await query.readTitleSnapshots(known)) {
          if (result === null || result === undefined || result.status !== 'fulfilled') continue
          const observation = result.value
          if (observation === null || observation === undefined) continue
          const title = observation.title
          if (title === null || title === undefined || typeof title.title !== 'string' || title.title === '') continue
          titles.set(asText(result.sessionId), title.title)
        }
      } catch (error) {
        ctx.logger.warn(`archive-shelf: title read failed: ${reasonOf(error)}`)
      }
    }

    const rows = []
    const dangling = []
    for (const id of archived) {
      const header = headers.get(id)
      if (header === undefined) {
        dangling.push(id)
        continue
      }
      const cwd = typeof header.cwd === 'string' ? header.cwd : ''
      const fallback = cwd === '' ? '' : basename(cwd)
      const dir = dirs.get(encodeSegment(id))
      rows.push({
        id,
        title: titles.has(id) ? titles.get(id) : (fallback === '' ? id : fallback),
        titled: titles.has(id),
        workspace: workspaceTitle.has(id) ? workspaceTitle.get(id) : '',
        cwd,
        createdAt: typeof header.createdAt === 'number' ? header.createdAt : 0,
        subagent: header.origin === 'subagent',
        live: live.has(id),
        running: runningIds.has(id),
        pending: pending.includes(id),
        sizeBytes: dir === undefined ? null : await dirBytes(dir),
        onDisk: dir !== undefined,
      })
    }
    rows.sort((left, right) => (right.createdAt - left.createdAt) || (left.id < right.id ? -1 : 1))
    return { rows, dangling, root: root === undefined ? '' : root }
  }

  const deleteSession = async (sessionId) => {
    if (!archivedIds().includes(sessionId)) {
      return { ok: false, error: 'only archived sessions can be deleted here' }
    }
    const agents = ctx.get('agents')
    const agent = agents === undefined ? undefined : agents.get(sessionId)
    if (agent !== undefined && agent.status === 'running') {
      // Deleting a log an active turn is appending to would race the writer.
      return { ok: false, code: 'running', error: 'the session is running a turn' }
    }
    const live = ctx.get('sessions')
    if (live !== undefined && live.get(sessionId) !== undefined) {
      // A resident session owns its in-memory log; removing the files under it
      // would leave a live session whose durable record is gone.
      return { ok: false, code: 'resident', error: 'the session is resident in this process' }
    }
    const root = sessionsRoot()
    if (root === undefined) return { ok: false, error: 'session persistence root is unknown' }

    const encoded = encodeSegment(sessionId)
    const dirs = await sessionDirs(root)
    let sessionDir = dirs.get(encoded)
    if (sessionDir === undefined && typeof persistence.resolveCurrentLog === 'function') {
      try {
        const logPath = await persistence.resolveCurrentLog(sessionId)
        if (typeof logPath === 'string' && logPath !== '') sessionDir = dirname(logPath)
      } catch (error) {
        ctx.logger.warn(`archive-shelf: log path resolution failed: ${reasonOf(error)}`)
      }
    }

    if (sessionDir === undefined) {
      // Nothing on disk: the session survives only as an archive-set entry, so
      // clean the registry bookkeeping and drop the entry.
      const warnings = await detachFromWorkspaces(sessionId)
      try {
        const remaining = await changeArchive(sessionId)
        return { ok: true, cleanedOnly: true, removedPath: '', freedBytes: 0, warnings, archivedSessionIds: remaining }
      } catch (error) {
        return { ok: false, error: reasonOf(error) }
      }
    }

    if (basename(sessionDir) !== encoded) {
      return { ok: false, error: `resolved directory does not match the session id: ${sessionDir}` }
    }
    if (!sessionDir.startsWith(`${root}/`)) {
      return { ok: false, error: `resolved directory is outside the persistence root: ${sessionDir}` }
    }

    const freedBytes = await dirBytes(sessionDir)
    try {
      await rm(sessionDir, { recursive: true, force: true })
    } catch (error) {
      return { ok: false, error: `delete failed: ${reasonOf(error)}` }
    }
    // The session just left its project directory; drop that directory too when
    // it is now empty. A directory holding other sessions stays as it is.
    await rmdir(dirname(sessionDir)).catch(() => {})
    const cachePath = projectionCachePath(sessionId)
    if (cachePath !== undefined) await rm(cachePath, { force: true }).catch(() => {})

    const warnings = await detachFromWorkspaces(sessionId)
    return { ok: true, cleanedOnly: false, removedPath: sessionDir, freedBytes, warnings, root }
  }

  /**
   * Drop one archive-set entry whose session is provably gone. The interactive
   * path calls this only after the browser's session list stopped carrying the
   * row, so a removed entry cannot surface as an unopenable sidebar row.
   */
  const forgetSession = async (sessionId) => {
    if (!archivedIds().includes(sessionId)) return { ok: true, archivedSessionIds: archivedIds() }
    if (await sessionExists(sessionId)) return { ok: false, error: 'session still exists' }
    try {
      const remaining = await changeArchive(sessionId)
      return { ok: true, archivedSessionIds: remaining }
    } catch (error) {
      return { ok: false, error: reasonOf(error) }
    }
  }

  /** Whether this dsh build exposes the agent release capability the shelf prefers. */
  const canRelease = () => {
    const agents = ctx.get('agents')
    return agents !== undefined && typeof agents.release === 'function'
  }

  /**
   * Unload one session's live agent so its files can be deleted without a
   * restart. Requires the harness-side `agents.release(id)` capability; without
   * it the caller queues the deletion instead.
   */
  const releaseSession = async (sessionId) => {
    if (!archivedIds().includes(sessionId)) {
      // The shelf owns archived sessions only; unloading a live one it does not
      // manage would be a surprise the caller never asked for.
      return { ok: false, error: 'only archived sessions can be released here' }
    }
    const agents = ctx.get('agents')
    if (agents === undefined || typeof agents.release !== 'function') {
      return { ok: false, code: 'unsupported', error: 'this dsh build cannot release a session; queue the deletion instead' }
    }
    const agent = agents.get(sessionId)
    if (agent !== undefined && agent.status === 'running') {
      return { ok: false, code: 'running', error: 'the session is running a turn' }
    }
    let released
    try {
      released = await agents.release(sessionId)
    } catch (error) {
      return { ok: false, error: `release failed: ${reasonOf(error)}` }
    }
    if (released !== true) {
      return { ok: false, code: 'notlive', error: 'the session has no live agent to release' }
    }
    const live = ctx.get('sessions')
    if (live !== undefined && live.get(sessionId) !== undefined) {
      return { ok: false, error: 'the session is still resident after release' }
    }
    return { ok: true }
  }

  // ── the queue sweep ───────────────────────────────────────────────────────
  // Runs after boot and before every list. A queued id whose session is no
  // longer resident is deleted for real; runs and residents stay queued.

  /** Deletions completed by the last sweep, reported to the next list call. */
  let lastSweep = null
  let sweeping = null

  const sweep = async () => {
    const deleted = []
    let deferred = false
    // A queued id whose files went away but whose archive entry could not be
    // dropped yet is retried inside the same drain: the second pass takes the
    // cleaned-only branch and finishes the bookkeeping.
    for (let pass = 0; pass < 3; pass++) {
      const pending = (await loadQueue()).slice()
      if (pending.length === 0) break
      // Without loaded registry state, "not archived any more" cannot be told
      // apart from "not loaded yet"; both the sweep and the queue survive to the
      // next attempt, so nothing is lost by waiting.
      const state = registry.state
      if (state === undefined || state === null) {
        deferred = true
        break
      }
      let progressed = false
      for (const id of pending) {
        if (!archivedIds().includes(id)) {
          // Queued, no longer archived: either an earlier sweep finished the
          // deletion or the user restored the session. Both mean "stop asking".
          await withQueue(ids => ids.filter(queuedId => queuedId !== id))
          progressed = true
          continue
        }
        const result = await deleteSession(id)
        if (result.ok !== true) continue
        const forgotten = await forgetSession(id)
        if (forgotten.ok !== true) continue
        await withQueue(ids => ids.filter(queuedId => queuedId !== id))
        if (result.cleanedOnly !== true) deleted.push(id)
        progressed = true
      }
      if (!progressed) break
    }
    return { attempted: deleted.length, deleted, deferred }
  }

  const drainQueue = () => {
    if (sweeping !== null) return sweeping
    sweeping = sweep()
      .then((result) => {
        if (result.deleted.length > 0) {
          lastSweep = { deleted: result.deleted.length, at: Date.now() }
          ctx.logger.info(`archive-shelf: deleted ${result.deleted.length} queued session(s)`)
        }
        return result
      })
      .catch((error) => {
        ctx.logger.warn(`archive-shelf: queue sweep failed: ${reasonOf(error)}`)
        return { attempted: 0, deleted: [] }
      })
      .finally(() => { sweeping = null })
    return sweeping
  }

  const timer = ctx.get('timer')
  if (timer !== undefined) {
    for (const delay of SWEEP_DELAYS_MS) {
      ctx.effect(() => timer.timeout(() => { void drainQueue() }, delay), `archive-shelf: queue sweep after ${delay}ms`)
    }
  }

  /**
   * Accept only a same-origin JSON POST from the browser half. Absent Origin is
   * allowed: a non-browser caller is outside the browser threat model this check
   * exists for, and it must still present both markers.
   */
  const sameOriginJsonRequest = (req) => {
    if (req.method !== 'POST') return false
    if (req.headers['x-archive-shelf-client'] !== '1') return false
    if (!asText(req.headers['content-type']).startsWith('application/json')) return false
    const origin = req.headers.origin
    if (origin === undefined) return true
    const host = req.headers.host
    try {
      return new URL(origin).host === host
    } catch (error) {
      return false
    }
  }

  const readBody = req => new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', reject)
  })

  const answer = (res, status, value) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(value))
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: API_PATH,
    handler: async (req, res) => {
      // The route is registered ahead of the connection carrier's authenticated
      // fallback, so it authenticates itself. A JSON content type plus the
      // client marker header make this a NON-SIMPLE cross-origin request, so a
      // foreign page reaches the CORS preflight this server never answers
      // instead of the handler; the Origin check closes the same-origin case.
      if (!sameOriginJsonRequest(req)) {
        answer(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      let payload
      try {
        payload = JSON.parse(await readBody(req))
      } catch (error) {
        answer(res, 400, { ok: false, error: `invalid request body: ${reasonOf(error)}` })
        return
      }
      const action = (payload !== null && typeof payload === 'object' && typeof payload.action === 'string')
        ? payload.action
        : ''
      const sessionId = (payload !== null && typeof payload === 'object' && typeof payload.sessionId === 'string')
        ? payload.sessionId
        : ''
      try {
        switch (action) {
          case 'list': {
            const swept = await drainQueue()
            const value = await collect()
            const notice = lastSweep
            lastSweep = null
            answer(res, 200, {
              ok: true,
              rows: value.rows,
              dangling: value.dangling,
              root: value.root,
              deletable: true,
              canRelease: canRelease(),
              pending: (await loadQueue()).slice(),
              swept: notice === null ? null : notice,
              sweepDeferred: swept.deferred === true,
            })
            return
          }
          case 'unarchive': {
            if (sessionId === '') { answer(res, 400, { ok: false, error: 'missing sessionId' }); return }
            if (!archivedIds().includes(sessionId)) { answer(res, 200, { ok: false, error: 'session is not archived' }); return }
            answer(res, 200, { ok: true, archivedSessionIds: await changeArchive(sessionId) })
            return
          }
          case 'delete': {
            if (payload.confirm !== true) { answer(res, 400, { ok: false, error: 'confirmation required' }); return }
            if (sessionId === '') { answer(res, 400, { ok: false, error: 'missing sessionId' }); return }
            const result = await deleteSession(sessionId)
            // A session that actually went away must not stay queued.
            if (result.ok === true) await withQueue(ids => ids.filter(queuedId => queuedId !== sessionId))
            answer(res, 200, result)
            return
          }
          case 'forget': {
            if (sessionId === '') { answer(res, 400, { ok: false, error: 'missing sessionId' }); return }
            answer(res, 200, await forgetSession(sessionId))
            return
          }
          case 'queue': {
            if (sessionId === '') { answer(res, 400, { ok: false, error: 'missing sessionId' }); return }
            if (!archivedIds().includes(sessionId)) { answer(res, 200, { ok: false, error: 'session is not archived' }); return }
            const pending = await withQueue(ids => (ids.includes(sessionId) ? undefined : ids.concat(sessionId)))
            answer(res, 200, { ok: true, pending })
            // Queueing records an intent and deletes nothing by itself: the
            // sweep at boot and on the next list is what acts on it.
            return
          }
          case 'unqueue': {
            if (sessionId === '') { answer(res, 400, { ok: false, error: 'missing sessionId' }); return }
            const pending = await withQueue(ids => ids.filter(queuedId => queuedId !== sessionId))
            answer(res, 200, { ok: true, pending })
            return
          }
          case 'release': {
            if (sessionId === '') { answer(res, 400, { ok: false, error: 'missing sessionId' }); return }
            answer(res, 200, await releaseSession(sessionId))
            return
          }
          default: {
            answer(res, 400, { ok: false, error: 'unknown action' })
          }
        }
      } catch (error) {
        ctx.logger.warn(`archive-shelf: ${action} failed: ${reasonOf(error)}`)
        answer(res, 500, { ok: false, error: reasonOf(error) })
      }
    },
  }), 'archive-shelf: api route')
}
