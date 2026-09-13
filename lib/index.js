/**
 * 归档架 (Archive Shelf) — host half.
 *
 * Registers one self-authenticating browser route and implements the four
 * archive operations the settings section needs: list, unarchive, delete and
 * forget. A package outside the harness repository has no generated Remote
 * namespace, so the two halves speak over this same-origin JSON route instead.
 *
 * Imports node builtins only: a bare specifier would resolve from this
 * package's own location, which sits outside the harness dependency closure.
 */
import { readdir, rm, rmdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export const name = 'archive-shelf'
export const inject = ['workspaceRegistry', 'sessionPersistence', 'webServer']

/** Absolute pathname of the browser-facing route. */
const API_PATH = '/archive-shelf/api'
/** Largest accepted request body; every request here is a few short strings. */
const MAX_BODY_BYTES = 64 * 1024

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
    return (typeof config.root === 'string' && config.root !== '') ? config.root : undefined
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
   * Drop one archive-set entry whose session is provably gone. The browser half
   * calls this only after its session list stopped carrying the row, so a
   * removed entry cannot surface as an unopenable sidebar row.
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
            const value = await collect()
            answer(res, 200, {
              ok: true,
              rows: value.rows,
              dangling: value.dangling,
              root: value.root,
              deletable: true,
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
            answer(res, 200, await deleteSession(sessionId))
            return
          }
          case 'forget': {
            if (sessionId === '') { answer(res, 400, { ok: false, error: 'missing sessionId' }); return }
            answer(res, 200, await forgetSession(sessionId))
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
