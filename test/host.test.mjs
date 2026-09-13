/**
 * Behavioural test for the archive-shelf HOST half.
 *
 * Drives the real `apply()` against fake Cordis contexts and real loopback
 * HTTP servers in throwaway temp directories, so the destructive and
 * crash-prone paths (oversized body, socket teardown, recursive delete, the
 * deletion queue, the boot sweep) are covered without touching a real harness.
 *
 * Run: node test/host.test.mjs
 *
 * Phases: 1 full services, 2 no optional services, 3 a trailing-slash session
 * root, 4 the deletion queue and the agent-release capability.
 */
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { apply } from '../lib/index.js'

const results = []
const gaps = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
}
/** Behaviour that is wrong but fail-closed, recorded so it is reported not hidden. */
const gap = (label, detail = '') => {
  gaps.push({ label, detail })
  console.log(`GAP   ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

/** Same segment escaping the JSONL backend uses. */
const enc = id => (id === '.' ? '~002E' : id === '..' ? '~002E~002E' : [...id].map(c =>
  c !== '~' && /^[A-Za-z0-9._-]$/.test(c) ? c : '~' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')).join(''))

/** Fire the scheduled boot sweep and let its async work settle. */
const fireBootSweep = async (instance) => {
  for (const timer of instance.timers) timer.callback()
  for (let tick = 0; tick < 4; tick++) await new Promise(resolve => setTimeout(resolve, 0))
}

const sandbox = await mkdtemp(join(tmpdir(), 'asx-host-'))
const root = join(sandbox, 'sessions')
const project = join(root, '--home-jiuyue--')
const lonelyProject = join(root, '--lonely--')
const queueProject = join(root, '--queue--')

const unarchiveId = 'session-1111-aaaa'
const deleteId = 'session-5555-eeee'
const orphanId = 'session-2222-bbbb'
const runningId = 'session-3333-cccc'
const residentId = 'session-4444-dddd'
const forgetOnDiskId = 'session-6666-ffff'
const queuedId = 'session-7777-gggg'
const traversalId = '../escape-attempt'

/** Ids whose listing follows the filesystem; every other id stands for a stale index entry. */
const dirBacked = new Set([unarchiveId, deleteId, forgetOnDiskId, queuedId])

const headers = new Map([
  [unarchiveId, { id: unarchiveId, cwd: '/home/jiuyue/work/alpha', createdAt: 300 }],
  [deleteId, { id: deleteId, cwd: '/home/jiuyue/work/zeta', createdAt: 250 }],
  [orphanId, { id: orphanId, cwd: '/home/jiuyue/work/beta', createdAt: 200 }],
  [runningId, { id: runningId, cwd: '/home/jiuyue/work/gamma', createdAt: 100 }],
  [residentId, { id: residentId, cwd: '/home/jiuyue/work/delta', createdAt: 50 }],
  [forgetOnDiskId, { id: forgetOnDiskId, cwd: '/home/jiuyue/work/epsilon', createdAt: 40 }],
  [traversalId, { id: traversalId, cwd: '', createdAt: 10 }],
])
const defaultArchived = [unarchiveId, deleteId, orphanId, runningId, residentId, forgetOnDiskId, traversalId]

/** Does this id still own a session directory? Models the product listing from disk. */
const hasDirectory = (id) => {
  if (!dirBacked.has(id)) return true
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(root, entry.name, enc(id)))) return true
    }
  } catch (error) {
    return false
  }
  return false
}

/**
 * Boot the plugin over a real loopback server.
 * @param mode - 'full' wires every optional service; 'degraded' wires none of them.
 * @param options - sessionsRoot, archived list, an optional fake agent release, timer service.
 */
async function boot(mode, options = {}) {
  const {
    sessionsRoot = root,
    archived = defaultArchived,
    release = null,
    withTimer = false,
    residents = [residentId],
  } = options
  const state = { archivedSessionIds: [...archived] }
  const detachCalls = []
  const warnings = []
  const releasedIds = []
  const timers = []
  const resident = new Set(residents)
  const workspaceRegistry = {
    get archivedSessionIds() { return state.archivedSessionIds },
    get state() { return state },
    async setState(next) { state.archivedSessionIds = next.archivedSessionIds },
    async enqueueOperation(fn) { return await fn() },
    list: () => [{ title: 'AGENT', sessionIds: [unarchiveId, residentId, deleteId], async detachSession(id) { detachCalls.push(id) } }],
  }
  const listed = () => [...headers.values()].filter(header => hasDirectory(header.id)).map(header => ({ header }))
  const sessionPersistence = {
    config: { root: sessionsRoot },
    async list() { return listed() },
    async resolveCurrentLog() { throw new Error('no log') },
  }
  const agents = { get: id => (id === runningId ? { status: 'running' } : undefined) }
  if (release !== null) {
    agents.release = async (id) => {
      releasedIds.push(id)
      return release(id, resident)
    }
  }
  const services = mode === 'full' ? {
    sessionQuery: {
      async listSessions() { return listed().map(record => ({ header: record.header, live: false })) },
      async readTitleSnapshots(ids) {
        return ids.map(sessionId => sessionId === unarchiveId
          ? { status: 'fulfilled', sessionId, value: { title: { title: '从1数到1000' } } }
          : { status: 'rejected', sessionId })
      },
    },
    sessions: { get: id => (resident.has(id) ? { id, header: headers.get(id) } : undefined), list: () => [] },
    agents,
    ...(withTimer ? { timer: { timeout: (callback, delay) => { timers.push({ callback, delay }); return () => {} } } } : {}),
  } : {}
  const disposers = []
  const ctx = {
    workspaceRegistry,
    sessionPersistence,
    webServer: { register(route) { ctx.route = route; return () => { ctx.disposed = true } } },
    effect(fn, label) { ctx.effectLabel = label; disposers.push(fn()) },
    logger: { warn: m => warnings.push(String(m)), info() {}, error() {} },
    get: name => services[name],
  }
  apply(ctx)
  const server = createServer((req, res) => {
    Promise.resolve(ctx.route.handler(req, res)).catch(error => {
      check(false, `${mode}: handler rejected`, String(error && error.message))
      if (!res.headersSent) res.writeHead(500).end('{}')
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const call = async (body, extra = {}, requestOrigin = origin) => {
    const res = await fetch(`${origin}/archive-shelf/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-archive-shelf-client': '1', origin: requestOrigin, ...extra },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
    const text = await res.text()
    let json
    try { json = JSON.parse(text) } catch { json = undefined }
    return { status: res.status, json, text }
  }
  return {
    ctx, state, detachCalls, warnings, call, origin, disposers, releasedIds, timers, resident,
    queueFile: join(dirname(sessionsRoot), '.archive-shelf', 'pending.json'),
    close: () => new Promise(r => server.close(r)),
  }
}

// ══ phase 1: every service wired ════════════════════════════════════════════
await mkdir(join(project, enc(unarchiveId)), { recursive: true })
await writeFile(join(project, enc(unarchiveId), 'log.jsonl'), 'x'.repeat(1234))
await mkdir(join(lonelyProject, enc(deleteId)), { recursive: true })
await writeFile(join(lonelyProject, enc(deleteId), 'log.jsonl'), 'y'.repeat(4321))
await writeFile(join(project, 'decoy.txt'), 'do not delete')
await mkdir(join(project, enc(forgetOnDiskId)), { recursive: true })

const full = await boot('full')
check(full.ctx.route.kind === 'exact' && full.ctx.route.path === '/archive-shelf/api', 'registers one exact route', full.ctx.route.path)
check(full.ctx.effectLabel === 'archive-shelf: api route', 'route is a labelled effect', String(full.ctx.effectLabel))
full.disposers.forEach(d => d())
check(full.ctx.disposed === true, 'disposing the effect removes the route')

check((await fetch(`${full.origin}/archive-shelf/api`)).status === 403, 'GET is refused')
check((await full.call('{}', { 'x-archive-shelf-client': '' })).status === 403, 'missing client marker is refused')
check((await full.call('{}', {}, 'http://evil.example')).status === 403, 'cross-origin Origin is refused')
check((await full.call('{}', { 'content-type': 'text/plain' })).status === 403, 'non-JSON content type is refused')
check((await full.call({ action: 'list' })).status === 200, 'same-origin JSON POST is accepted')
const noOrigin = await fetch(`${full.origin}/archive-shelf/api`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-archive-shelf-client': '1' }, body: '{"action":"list"}',
})
check(noOrigin.status === 200 && (await noOrigin.json()).ok === true, 'absent Origin still needs both markers')

check((await full.call('{not json')).status === 400, 'malformed JSON is a 400')
check((await full.call({ action: 'bogus' })).status === 400, 'unknown action is a 400')
check((await full.call({ action: 'unarchive' })).status === 400, 'unarchive without sessionId is a 400')
check((await full.call({ action: 'delete', sessionId: unarchiveId })).json.error === 'confirmation required', 'delete without confirm is refused')

let oversizeOutcome
try {
  const over = await full.call({ action: 'list', pad: 'x'.repeat(200 * 1024) })
  oversizeOutcome = `answered status=${over.status}`
} catch (error) {
  oversizeOutcome = `socket reset: ${error.message}`
}
check((await full.call({ action: 'list' })).status === 200, 'server survives an oversized body', oversizeOutcome)

const list = (await full.call({ action: 'list' })).json
check(list.ok === true && list.rows.length === 7, 'list returns every archived session', `rows=${list.rows.length}`)
check(list.dangling.length === 0, 'no dangling entries')
check(list.canRelease === false, 'a build without the release capability says so', `canRelease=${list.canRelease}`)
check(list.rows[0].id === unarchiveId, 'rows are newest-first by createdAt', `first=${list.rows[0].id}`)
const unarchiveRow = list.rows.find(r => r.id === unarchiveId)
check(unarchiveRow.title === '从1数到1000' && unarchiveRow.titled === true, 'title snapshot wins over the cwd basename')
check(unarchiveRow.workspace === 'AGENT', 'workspace title is carried')
check(unarchiveRow.sizeBytes === 1234 && unarchiveRow.onDisk === true, 'on-disk size is reported', `size=${unarchiveRow.sizeBytes}`)
check(list.rows.find(r => r.id === orphanId).title === 'beta', 'untitled row falls back to the cwd basename')
check(list.rows.find(r => r.id === traversalId).title === traversalId, 'no cwd falls back to the id')
check(list.rows.find(r => r.id === runningId).running === true, 'running row is flagged')
check(list.rows.find(r => r.id === runningId).live === false, 'running alone does not imply resident')

const un = await full.call({ action: 'unarchive', sessionId: unarchiveId })
check(un.json.ok === true && !un.json.archivedSessionIds.includes(unarchiveId), 'unarchive drops the archive entry')
check(full.state.archivedSessionIds.length === 6, 'registry state was written through setState', `left=${full.state.archivedSessionIds.length}`)
check((await full.call({ action: 'unarchive', sessionId: unarchiveId })).json.error === 'session is not archived', 'unarchiving twice is a clean refusal')

check(/only archived/.test((await full.call({ action: 'delete', sessionId: 'session-nope', confirm: true })).json.error), 'deleting a non-archived session is refused')
check((await full.call({ action: 'delete', sessionId: runningId, confirm: true })).json.code === 'running', 'deleting a running session is refused as running')
check((await full.call({ action: 'delete', sessionId: residentId, confirm: true })).json.code === 'resident', 'deleting a resident session is refused as resident')
check(existsSync(join(project, 'decoy.txt')), 'refusals leave the project directory untouched')

const del = await full.call({ action: 'delete', sessionId: deleteId, confirm: true })
check(del.json.ok === true && del.json.cleanedOnly === false, 'archived on-disk session is deleted', JSON.stringify(del.json).slice(0, 140))
check(!existsSync(join(lonelyProject, enc(deleteId))), 'session directory is gone')
check(!existsSync(lonelyProject), 'now-empty project directory is removed too')
check(del.json.freedBytes === 4321, 'freed bytes reported', `freed=${del.json.freedBytes}`)
check(full.detachCalls.includes(deleteId), 'deleted session was detached from its workspace')
// Deliberate two-step: the archive flag stays until the product's own session
// list stops carrying the row, so a deleted session cannot flash back into the
// sidebar as an unopenable entry. The row leaves the shelf immediately.
check(full.state.archivedSessionIds.includes(deleteId), 'archive flag is kept until the record is forgotten')
const afterDelete = (await full.call({ action: 'list' })).json
check(!afterDelete.rows.some(r => r.id === deleteId), 'deleted session is gone from the rows')
check(afterDelete.dangling.includes(deleteId), 'deleted session is reported as a dangling record')
const forgotten = await full.call({ action: 'forget', sessionId: deleteId })
check(forgotten.json.ok === true && !forgotten.json.archivedSessionIds.includes(deleteId), 'forget then drops the dangling record')

const orphan = await full.call({ action: 'delete', sessionId: orphanId, confirm: true })
check(orphan.json.ok === true && orphan.json.cleanedOnly === true, 'header-only session is cleaned without a filesystem delete', JSON.stringify(orphan.json).slice(0, 120))
check(!full.state.archivedSessionIds.includes(orphanId), 'cleaned-only session left the archive set')

const traversal = await full.call({ action: 'delete', sessionId: traversalId, confirm: true })
check(traversal.json.ok === true && traversal.json.cleanedOnly === true, 'a traversal-shaped id only cleans bookkeeping', JSON.stringify(traversal.json).slice(0, 100))
check(!existsSync(join(sandbox, 'escape-attempt')) && existsSync(root), 'nothing outside the persistence root was touched')

check((await full.call({ action: 'forget', sessionId: residentId })).json.error === 'session still exists', 'forget refuses a session that still exists')
check((await full.call({ action: 'forget', sessionId: forgetOnDiskId })).json.ok === false, 'forget refuses while the directory is on disk')
check((await full.call({ action: 'forget', sessionId: 'session-not-archived' })).json.ok === true, 'forget of an unarchived id is an idempotent no-op')
check(full.warnings.every(w => w.includes('archive-shelf:')), 'diagnostics are namespaced', `${full.warnings.length} warnings`)
await full.close()

// ══ phase 2: no optional services at all ════════════════════════════════════
const degraded = await boot('degraded')
const degradedList = await degraded.call({ action: 'list' })
check(degradedList.status === 200 && degradedList.json.ok === true, 'list works without sessionQuery/sessions/agents')
check(degradedList.json.rows.length === 6 && degradedList.json.dangling.length === 1,
  'degraded list accounts for every archive entry',
  `rows=${degradedList.json.rows.length} dangling=${degradedList.json.dangling.length} (deleted/orphan dirs are no longer listed)`)
check(degradedList.json.rows.every(r => r.running === false && r.live === false), 'absent agents/residency means no badges')
check(degradedList.json.rows.find(r => r.id === orphanId).title === 'beta', 'degraded titles fall back to the cwd basename')
const degradedDelete = await degraded.call({ action: 'delete', sessionId: orphanId, confirm: true })
check(degradedDelete.json.ok === true && degradedDelete.json.cleanedOnly === true, 'delete works without agents/residency services')
await degraded.close()

// ══ phase 3: persistence root written with a trailing slash ═════════════════
const slashed = await boot('full', { sessionsRoot: `${root}/` })
const slashedList = await slashed.call({ action: 'list' })
check(slashedList.json.rows.find(r => r.id === unarchiveId).onDisk === true, 'trailing-slash root still reports sessions as on disk')
const slashedDelete = await slashed.call({ action: 'delete', sessionId: unarchiveId, confirm: true })
check(slashedDelete.json.ok === true, 'trailing-slash root still deletes', JSON.stringify(slashedDelete.json).slice(0, 120))
await slashed.close()

// ══ phase 4: the deletion queue and the release capability ══════════════════
const queueArchived = [...defaultArchived, queuedId]
headers.set(queuedId, { id: queuedId, cwd: '/home/jiuyue/work/eta', createdAt: 5 })
await mkdir(join(queueProject, enc(queuedId)), { recursive: true })
await writeFile(join(queueProject, enc(queuedId), 'log.jsonl'), 'z'.repeat(999))

// A queued session that is still resident must stay queued: the queue exists
// precisely for the sessions that cannot be deleted under their own runtime.
const queued = await boot('full', { archived: queueArchived, withTimer: true, residents: [residentId, queuedId] })
check(queued.timers.length === 2, 'boot schedules the queue sweep', `delays=${queued.timers.map(t => t.delay).join(",")}ms`)
check(typeof queued.timers[0].callback === 'function', 'the scheduled sweep is callable')

const queueResult = await queued.call({ action: 'queue', sessionId: queuedId })
check(queueResult.json.ok === true && queueResult.json.pending.includes(queuedId), 'queue accepts an archived session')
check(JSON.parse(await readFile(queued.queueFile, 'utf8')).pending.includes(queuedId), 'the queue is persisted beside the session root', queued.queueFile)
check(existsSync(join(queueProject, enc(queuedId))), 'a queued but still resident session keeps its files')
const queuedList = (await queued.call({ action: 'list' })).json
const queuedRow = queuedList.rows.find(r => r.id === queuedId)
check(queuedRow !== undefined && queuedRow.pending === true, 'the row reports its queued state', `rows=${queuedList.rows.map(r => r.id).join("|")}`)
check(queuedList.pending.includes(queuedId), 'the response carries the queue')
check(queuedList.swept === null, 'a refused sweep reports nothing')

const unqueued = await queued.call({ action: 'unqueue', sessionId: queuedId })
check(unqueued.json.ok === true && !unqueued.json.pending.includes(queuedId), 'unqueue cancels the request')
check(JSON.parse(await readFile(queued.queueFile, 'utf8')).pending.length === 0, 'the cancellation is persisted')
check((await queued.call({ action: 'unqueue', sessionId: queuedId })).json.ok === true, 'unqueue is idempotent')
check((await queued.call({ action: 'list' })).json.rows.find(r => r.id === queuedId).pending === false, 'the row drops the queued badge again')
check((await queued.call({ action: 'queue', sessionId: 'session-not-archived' })).json.ok === false, 'queue refuses a session that is not archived')
check((await queued.call({ action: 'queue' })).status === 400, 'queue without sessionId is a 400')

// The incident guard: reading the shelf must never act on the queue. A sweep on
// list would turn "queue this" into "delete this" for any row that happened to
// be deletable by the next read, without the delete confirmation the delete
// action owns.
await queued.call({ action: 'queue', sessionId: forgetOnDiskId })
await queued.call({ action: 'list' })
await queued.call({ action: 'list' })
const afterLists = (await queued.call({ action: 'list' })).json
check(existsSync(join(project, enc(forgetOnDiskId))), 'a queued session survives list calls')
check(afterLists.pending.includes(forgetOnDiskId), 'and it is still queued')
check(afterLists.rows.find(r => r.id === forgetOnDiskId).pending === true, 'and still shows the queued badge')
check(afterLists.swept === null, 'and no sweep notice was invented')
await queued.call({ action: 'unqueue', sessionId: forgetOnDiskId })

// A blocked session stays queued through the boot sweep that refuses it.
await queued.call({ action: 'queue', sessionId: residentId })
await fireBootSweep(queued)
const afterRefusal = (await queued.call({ action: 'list' })).json
check(afterRefusal.pending.includes(residentId), 'a resident session stays queued through the boot sweep')
check((await queued.call({ action: 'release', sessionId: residentId })).json.code === 'unsupported', 'release reports the missing capability')

// The user cancels one and keeps the other; the queue must survive a restart.
await queued.call({ action: 'unqueue', sessionId: residentId })
await queued.call({ action: 'queue', sessionId: queuedId })
check(JSON.parse(await readFile(queued.queueFile, 'utf8')).pending.includes(queuedId), 'the queue survives a restart')
await queued.close()

const restarted = await boot('full', { archived: queueArchived, withTimer: true })
await fireBootSweep(restarted)
const swept = (await restarted.call({ action: 'list' })).json
check(swept.swept !== null && swept.swept.deleted === 1, 'the boot sweep deletes the queued session', JSON.stringify(swept.swept))
check(!existsSync(join(queueProject, enc(queuedId))), 'the queued session directory is gone')
check(!existsSync(queueProject), 'its now-empty project directory is gone too')
check(swept.rows.every(r => r.id !== queuedId), 'the swept session left the archive rows')
check(swept.pending.length === 0, 'the queue is empty after the sweep')
check(JSON.parse(await readFile(restarted.queueFile, 'utf8')).pending.length === 0, 'the swept entry is persisted as removed')
check((await restarted.call({ action: 'list' })).json.swept === null, 'the sweep notice is reported only once')
// A queued id the user restored is dropped, not deleted.
await restarted.call({ action: 'queue', sessionId: runningId })
await restarted.call({ action: 'unarchive', sessionId: runningId })
await fireBootSweep(restarted)
const restoredWhileQueued = (await restarted.call({ action: 'list' })).json
check(!restoredWhileQueued.pending.includes(runningId), 'restoring a queued session drops the queue entry')
check((await restarted.call({ action: 'delete', sessionId: runningId, confirm: true })).json.ok === false, 'the restored session was not deleted')
await restarted.close()

// ══ phase 5: with the harness-side release capability ═══════════════════════
const releasable = await boot('full', {
  archived: [...defaultArchived, queuedId],
  release: async (id, resident) => {
    // Honours the harness contract: false when nothing is retained for that id.
    if (!resident.has(id)) return false
    resident.delete(id)
    return true
  },
})
const releasableList = (await releasable.call({ action: 'list' })).json
check(releasableList.canRelease === true, 'the release capability is reported to the client')
check((await releasable.call({ action: 'release', sessionId: runningId })).json.code === 'running', 'release refuses a running session')
check((await releasable.call({ action: 'release', sessionId: 'session-not-archived' })).json.error === 'only archived sessions can be released here',
  'release refuses a session this shelf does not own')
check((await releasable.call({ action: 'release', sessionId: orphanId })).json.code === 'notlive', 'release reports an archived id with no live agent')
const released = await releasable.call({ action: 'release', sessionId: residentId })
check(released.json.ok === true && releasable.releasedIds.includes(residentId), 'release unloads the resident session', JSON.stringify(released.json))
const releasedDelete = await releasable.call({ action: 'delete', sessionId: residentId, confirm: true })
check(releasedDelete.json.ok === true, 'the released session is deletable without a restart', JSON.stringify(releasedDelete.json).slice(0, 120))
await releasable.close()

// A release that leaves the session resident must be reported, not papered over.
const stuck = await boot('full', { release: async (id, resident) => resident.has(id) })
const stuckResult = await stuck.call({ action: 'release', sessionId: residentId })
check(stuckResult.json.ok === false && /still resident/.test(stuckResult.json.error), 'a release that does not unload is reported', JSON.stringify(stuckResult.json))
await stuck.close()

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length} checks, ${failed.length} failed, ${gaps.length} known gap(s)`)
for (const f of failed) console.log(`  FAILED: ${f.label} — ${f.detail}`)
for (const g of gaps) console.log(`  GAP: ${g.label} — ${g.detail}`)
process.exit(failed.length === 0 ? 0 : 1)
