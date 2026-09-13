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
const clientContext = (onRegister) => ({
  effect: (callback) => callback(),
  locale: { register: () => () => {}, bind: (ns) => (key) => `${ns}:${key}` },
  slots: { inject: (name, callback) => callback(), register: onRegister },
  sessions: { refresh: async () => {} },
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
globalThis.fetch = async () => ({ json: async () => payload })

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

// --- styling regressions -----------------------------------------------------
check('primary button uses the theme fill + on-brand label pair',
  clientSource.includes('--dsw-alias-button-primary-fill') && clientSource.includes('--dsw-alias-label-primary-foreground'))
check('primary button carries no hard-coded white text', !clientSource.includes('color:#fff'))

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
