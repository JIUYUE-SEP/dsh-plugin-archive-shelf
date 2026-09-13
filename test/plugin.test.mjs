/**
 * Zero-dependency test for both halves of the plugin.
 *
 * It drives the shipped artifacts exactly as the harness does: the host half is
 * imported as an ESM module, the browser half is evaluated the way the client
 * module loader evaluates it (a factory registered on window.__ModuleLoader__),
 * and rendering runs through a minimal React stand-in whose hooks actually
 * settle, so row state is observable without a browser or a test framework.
 *
 * Run: node test/plugin.test.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFileSync(join(root, relative), 'utf8')

let failures = 0
const check = (label, condition, detail) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!condition) failures += 1
}

// --- host half ---------------------------------------------------------------
const host = await import(join(root, 'lib/index.js'))
const manifest = JSON.parse(read('package.json'))
check('host exports the plugin name', host.name === 'archive-shelf', String(host.name))
check('host declares its injected services',
  Array.isArray(host.inject) && ['workspaceRegistry', 'sessionPersistence', 'webServer'].every(name => host.inject.includes(name)),
  JSON.stringify(host.inject))
check('host exposes apply()', typeof host.apply === 'function')

// --- browser half: the loader contract ---------------------------------------
let registration
const clientSource = read('lib/client.js')
const fakeWindow = { __ModuleLoader__: { load: (value) => { registration = value } } }
new Function('window', 'console', `${clientSource}\nreturn window.__ModuleLoader__;`)(fakeWindow, console)
check('browser half registers one factory', registration !== undefined && typeof registration.factory === 'function')
check('browser module id equals the package name',
  registration.id === manifest.name, `${registration.id} vs ${manifest.name}`)

// --- browser half: rendering --------------------------------------------------
const states = []
let cursor = 0
let effects = []
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => {
    const index = cursor++
    if (states.length <= index) states.push(initial)
    return [states[index], (next) => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
  },
  useEffect: (effect) => { effects.push(effect) },
}

const bundle = registration.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
})
check('browser half exports apply', typeof bundle.apply === 'function')
check('browser half declares its client services',
  JSON.stringify(bundle.inject) === JSON.stringify(['slots', 'locale', 'sessions']), JSON.stringify(bundle.inject))

let captured
const clientContext = (onRegister, sessions, services) => ({
  effect: (callback) => callback(),
  locale: { register: () => () => {}, bind: (ns) => (key) => `${ns}:${key}` },
  slots: { inject: (name, callback) => callback(), register: onRegister },
  sessions: sessions ?? { refresh: async () => {} },
  get: (name) => (services === undefined ? undefined : services[name]),
})
bundle.apply(clientContext((options, component) => { captured = { options, component } }))
check('registers one settings section', captured !== undefined && captured.options.name === 'settings.section')
check('section id and order', captured.options.id === 'archive-shelf' && captured.options.order === 30,
  `${captured.options.id}/${captured.options.order}`)
check('section owns its locale namespace', captured.options.locale === 'archive-shelf')
check('section label follows the bound dictionary', captured.options.label() === 'archive-shelf:tab', captured.options.label())

// rows: running / resident / cold
const rows = [
  { id: 'a', title: 'running', workspace: 'w', cwd: '/tmp', createdAt: 1, live: true, running: true, onDisk: true, sizeBytes: 1 },
  { id: 'b', title: 'resident', workspace: 'w', cwd: '/tmp', createdAt: 2, live: true, running: false, onDisk: true, sizeBytes: 2 },
  { id: 'c', title: 'cold', workspace: 'w', cwd: '/tmp', createdAt: 3, live: false, running: false, onDisk: true, sizeBytes: 3 },
]
let payload = { ok: true, rows, dangling: [] }
const requests = []
/** Payloads consumed in order before `payload` takes over — the host reports a
 * sweep notice exactly once, so a fixed stub would loop the auto-cleanup. */
let payloadSequence = []
globalThis.fetch = async (_url, init) => {
  if (init !== undefined) requests.push(JSON.parse(init.body))
  const next = payloadSequence.length > 0 ? payloadSequence.shift() : payload
  return { json: async () => next }
}

const props = {
  t: (key, params) => (params === undefined ? key : `${key}${JSON.stringify(params)}`),
  useWorkspaces: (select) => select({ archivedSessionIds: [] }),
}
const render = () => { cursor = 0; return captured.component(props) }
render()
for (const effect of effects) effect()
effects = []
await new Promise(resolve => setTimeout(resolve, 0))
const tree = render()

const walk = (node, visit) => {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}
const spans = []
const buttons = []
walk(tree, (node) => {
  if (node.type === 'span') spans.push(node.children?.[0])
  if (node.type === 'button') buttons.push(node)
})
const deleteButtons = buttons.filter(button => String(button.props.className ?? '').includes('asx-btn-danger'))
check('running row carries the running badge', spans.includes('live'))
check('merely resident row carries the resident badge', spans.includes('resident'))
check('one delete button per row', deleteButtons.length === 3, String(deleteButtons.length))
check('running row: delete disabled with a reason',
  deleteButtons.some(button => button.props.disabled === true && button.props.title === 'deleteRunning'))
check('resident row: delete disabled with a reason',
  deleteButtons.some(button => button.props.disabled === true && button.props.title === 'deleteResident'))
check('cold row: delete enabled',
  deleteButtons.some(button => button.props.disabled === false && button.props.title === undefined))

// host refusals map to localized copy through their machine-readable code
let failureComponent
bundle.apply(clientContext((_options, component) => { failureComponent = component }))
for (const [code, expected] of [['running', 'failedRunning'], ['resident', 'failedResident']]) {
  payload = { ok: false, code, error: 'raw-host-text' }
  cursor = 0
  const first = failureComponent(props)
  const cold = []
  walk(first, (node) => { if (node.type === 'button' && String(node.props.className ?? '').includes('asx-btn-danger')) cold.push(node) })
  cold[2].props.onClick()
  cursor = 0
  const dialog = failureComponent(props)
  const confirm = []
  walk(dialog, (node) => { if (node.type === 'button' && String(node.props.className ?? '').includes('asx-btn-primary')) confirm.push(node) })
  await confirm[0].props.onClick()
  await new Promise(resolve => setTimeout(resolve, 0))
  cursor = 0
  const after = failureComponent(props)
  const messages = []
  walk(after, (node) => {
    if (node.type === 'div' && String(node.props.className ?? '').includes('asx-msg-error')) messages.push(node.children?.[0])
  })
  check(`host refusal "${code}" renders localized copy`, messages.includes(expected), messages.join('|'))
}


// --- queueing, cancelling, and releasing -------------------------------------
const findRow = (node, id) => {
  let found = null
  walk(node, (candidate) => {
    if (candidate.type === 'div' && candidate.props.key === id && String(candidate.props.className ?? '').includes('asx-row')) found = candidate
  })
  return found
}
const labelsOf = (row) => {
  const labels = []
  walk(row, (candidate) => { if (candidate.type === 'button') labels.push(candidate.children?.[0]) })
  return labels
}
const buttonOf = (row, label) => {
  let found = null
  walk(row, (candidate) => { if (candidate.type === 'button' && candidate.children?.[0] === label) found = candidate })
  return found
}
const badgesOf = (node) => {
  const badges = []
  walk(node, (candidate) => {
    if (candidate.type === 'span' && String(candidate.props.className ?? '').includes('asx-badge-queued')) badges.push(candidate.children?.[0])
  })
  return badges
}
/** Render, run the pending effects (the initial load), then render the settled tree. */
const cycle = async () => {
  cursor = 0
  captured.component(props)
  const pending = effects
  effects = []
  for (const effect of pending) effect()
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
  cursor = 0
  return captured.component(props)
}

const blockedRow = { id: 'b', title: 'resident', workspace: '', cwd: '/tmp', createdAt: 2, live: true, running: false, pending: false, onDisk: true, sizeBytes: 2 }
const queuedRow = { id: 'd', title: 'queued', workspace: '', cwd: '/tmp', createdAt: 4, live: true, running: false, pending: true, onDisk: true, sizeBytes: 4 }

payload = { ok: true, rows: [blockedRow, queuedRow], dangling: [], canRelease: false, pending: ['d'] }
let shelf = await cycle()
let blockedNode = findRow(shelf, 'b')
let queuedNode = findRow(shelf, 'd')
check('a blocked row offers queueing', labelsOf(blockedNode).includes('queue'), labelsOf(blockedNode).join('|'))
check('a queued row offers cancellation', labelsOf(queuedNode).includes('unqueue'), labelsOf(queuedNode).join('|'))
check('a queued row carries the queued badge', badgesOf(queuedNode).includes('queued'), badgesOf(queuedNode).join('|'))
check('the release button stays hidden without the capability', !labelsOf(blockedNode).includes('release'), labelsOf(blockedNode).join('|'))

requests.length = 0
buttonOf(blockedNode, 'queue').props.onClick()
await new Promise(resolve => setTimeout(resolve, 0))
await new Promise(resolve => setTimeout(resolve, 0))
check('the queue button posts the queue action',
  requests.some(body => body.action === 'queue' && body.sessionId === 'b'), JSON.stringify(requests))

shelf = await cycle()
requests.length = 0
buttonOf(findRow(shelf, 'd'), 'unqueue').props.onClick()
await new Promise(resolve => setTimeout(resolve, 0))
await new Promise(resolve => setTimeout(resolve, 0))
check('the cancel button posts the unqueue action',
  requests.some(body => body.action === 'unqueue' && body.sessionId === 'd'), JSON.stringify(requests))

payload = { ok: true, rows: [blockedRow], dangling: [], canRelease: true, pending: [] }
shelf = await cycle()
blockedNode = findRow(shelf, 'b')
check('the release button appears with the capability', labelsOf(blockedNode).includes('release'), labelsOf(blockedNode).join('|'))

requests.length = 0
buttonOf(blockedNode, 'release').props.onClick()
await new Promise(resolve => setTimeout(resolve, 0))
await new Promise(resolve => setTimeout(resolve, 0))
check('the release button posts the release action',
  requests.some(body => body.action === 'release' && body.sessionId === 'b'), JSON.stringify(requests))

payload = { ok: true, rows: [], dangling: [], canRelease: false, pending: [], swept: { deleted: 2, at: 1 } }
shelf = await cycle()
const notices = []
walk(shelf, (node) => {
  if (node.type === 'div' && String(node.props.className ?? '').includes('asx-msg-ok')) notices.push(node.children?.[0])
})
check('a startup sweep reports what it deleted', notices.some(text => String(text).startsWith('swept')), notices.join('|'))


// --- dropping an archive record is gated on the browser's own session list ----
const coldRow = { id: 'c', title: 'cold', workspace: '', cwd: '/tmp', createdAt: 3, live: false, running: false, pending: false, onDisk: true, sizeBytes: 3 }
const listStub = (byId) => ({ refresh: async () => {}, list: { getSnapshot: () => ({ byId }) } })
const mounted = (sessions, services) => {
  let component
  bundle.apply(clientContext((_options, value) => { component = value }, sessions, services))
  return component
}
/** Render, run the pending effects, and return the settled tree. */
const settle = async (component) => {
  cursor = 0
  component(props)
  const pending = effects
  effects = []
  for (const effect of pending) effect()
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
  cursor = 0
  return component(props)
}

/** Click delete on one row, then confirm it in the dialog. */
const deleteRow = async (component, rowId) => {
  const tree = await settle(component)
  buttonOf(findRow(tree, rowId), 'remove').props.onClick()
  cursor = 0
  const dialog = component(props)
  const confirm = []
  walk(dialog, (node) => {
    if (node.type === 'button' && String(node.props.className ?? '').includes('asx-btn-primary')) confirm.push(node)
  })
  await confirm[0].props.onClick()
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
}

payload = { ok: true, rows: [coldRow], dangling: [], canRelease: false, pending: [] }
requests.length = 0
await deleteRow(mounted(listStub({})), 'c')
check('a deleted session whose row left the list is forgotten',
  requests.some(body => body.action === 'forget' && body.sessionId === 'c'), JSON.stringify(requests))

payload = { ok: true, rows: [coldRow], dangling: [], canRelease: false, pending: [] }
requests.length = 0
await deleteRow(mounted(listStub({ c: { title: 'cold' } })), 'c')
check('a deleted session still carried by the browser list keeps its archive record',
  !requests.some(body => body.action === 'forget'), JSON.stringify(requests))

payload = { ok: true, rows: [coldRow], dangling: [], canRelease: false, pending: [] }
requests.length = 0
const withoutSnapshot = mounted({ refresh: async () => {} })
cursor = 0
withoutSnapshot(props)
await new Promise(resolve => setTimeout(resolve, 0))
cursor = 0
const settled = withoutSnapshot(props)
check('an unreadable session list is never treated as an empty one',
  !requests.some(body => body.action === 'forget'), JSON.stringify(requests))
check('and the row still renders', findRow(settled, 'c') !== null)

payload = { ok: true, rows: [], dangling: [], canRelease: false, pending: [] }
payloadSequence = [{ ok: true, rows: [], dangling: ['z'], canRelease: false, pending: [], swept: { deleted: 1, ids: ['z'], at: 1 } }]
requests.length = 0
const sweptComponent = mounted(listStub({}))
await settle(sweptComponent)
await new Promise(resolve => setTimeout(resolve, 0))
check('the boot sweep report is cleaned up once the row is gone from the list',
  requests.some(body => body.action === 'forget' && body.sessionId === 'z'), JSON.stringify(requests))

// --- mount contract ----------------------------------------------------------
const layerRelative = manifest.dsh?.bundle?.patch
check('the package declares its profile layer', typeof layerRelative === 'string', String(layerRelative))
const layerFile = String(layerRelative).replace(/^\.\//, '')
const layer = read(layerFile)
check('the layer mounts exactly this package',
  layer.includes('id: archive-shelf') && layer.includes(`name: ${manifest.name}`),
  layer.trim().split('\n').at(-1))
check('the layer ships inside the package', Array.isArray(manifest.files) && manifest.files.includes(layerFile),
  JSON.stringify(manifest.files))
check('the client half still declares its platform', manifest.dsh?.client?.platform === 'web',
  JSON.stringify(manifest.dsh?.client))


// --- restoring hands the product's own projection the new archive set ---------
const restorePayload = (archivedSessionIds) => ({
  ok: true, rows: [coldRow], dangling: [], canRelease: false, pending: [], archivedSessionIds,
})
const archiveCalls = []
const workspacesStub = {
  archiveSession: async (id) => { archiveCalls.push(id); },
}
const listRefreshes = { count: 0 }
const countingSessions = { refresh: async () => { listRefreshes.count += 1 }, list: { getSnapshot: () => ({ byId: {} }) } }
const clickRestore = async (component, rowId) => {
  const tree = await settle(component)
  buttonOf(findRow(tree, rowId), 'restore').props.onClick()
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
}

archiveCalls.length = 0
listRefreshes.count = 0
payload = restorePayload(['session-still-archived'])
await clickRestore(mounted(countingSessions, { workspaces: workspacesStub }), 'c')
check('a restore hands the product projection the complete new archive set',
  archiveCalls.length === 1 && archiveCalls[0] === 'session-still-archived', JSON.stringify(archiveCalls))
check('a restore also re-pulls the session list (a released session left it)',
  listRefreshes.count === 1, String(listRefreshes.count))

archiveCalls.length = 0
payload = restorePayload([])
await clickRestore(mounted(countingSessions, { workspaces: workspacesStub }), 'c')
check('restoring the last archived session has no anchor and is reported honestly',
  archiveCalls.length === 0, JSON.stringify(archiveCalls))

requests.length = 0
payload = restorePayload(['session-still-archived'])
await clickRestore(mounted(countingSessions), 'c')
check('a missing workspace service never breaks the restore',
  requests.some(body => body.action === 'unarchive'), JSON.stringify(requests))

// --- host surface for the new actions ---------------------------------------
const hostSource = read('lib/index.js')
check('host implements queue, unqueue, and release actions',
  ["case 'queue'", "case 'unqueue'", "case 'release'"].every(needle => hostSource.includes(needle)))
check('host persists the queue beside the session root',
  hostSource.includes("'.archive-shelf'") && hostSource.includes("'pending.json'"))
check('host feature-detects the agent release capability',
  hostSource.includes("typeof agents.release === 'function'"))
check('host normalizes a trailing separator on the session root',
  hostSource.includes("config.root.replace(/\\/+$/, '')"))

// --- styling regressions -----------------------------------------------------
check('primary button uses the theme fill + on-brand label pair',
  clientSource.includes('--dsw-alias-button-primary-fill') && clientSource.includes('--dsw-alias-label-primary-foreground'))
check('primary button carries no hard-coded white text', !clientSource.includes('color:#fff'))

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
