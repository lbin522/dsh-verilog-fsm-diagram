#!/usr/bin/env node
/**
 * Headless CLI for the verilog-fsm-diagram plugin.
 *
 * It loads the plugin's browser client module with DOM stubs and uses the pure
 * internals (`parseVerilog`, `layoutFsm`, `svgDocument`,
 * `buildConditionNumbering`) to render FSM diagrams without a browser.
 *
 * Usage:
 *   node cli.mjs <verilog.v> --list
 *   node cli.mjs <verilog.v> [--fsm <module|stateVar|index>] [--out <dir-or-file>]
 *               [--numbered] [--tree] [--title <text>] [--legend-title <text>] [--all]
 *
 * Notes:
 *   - SVG only (the plugin UI itself also exports SVG);
 *   - text labels by default, `--numbered` renders per-edge numbers + legend;
 *   - `--tree` folds priority-ordered conditional branches into a branch tree;
 *   - `--all` writes one SVG per FSM found in the file.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

const noop = () => {}
const React = {
  useState: (value) => [typeof value === 'function' ? value() : value, noop],
  useMemo: (factory) => factory(),
  useRef: () => ({ current: null }),
  useEffect: noop,
  useCallback: (fn) => fn,
  useId: () => 'id',
  createElement: () => null,
  Fragment: 'fragment',
  memo: (fn) => fn,
  forwardRef: (fn) => fn,
  StrictMode: 'strict',
}

if (globalThis.window === undefined) {
  globalThis.window = {}
}
globalThis.window.__ModuleLoader__ = {
  load(spec) { globalThis.__fsmPluginSpec = spec },
}
globalThis.window.getComputedStyle = () => ({ getPropertyValue: () => '' })
globalThis.window.matchMedia = () => ({
  matches: false, addEventListener: noop, removeEventListener: noop,
})
globalThis.document = {
  createElement: () => ({ style: {}, classList: { add: noop } }),
  documentElement: { style: {} },
  body: { appendChild: noop },
}

await import(pathToFileURL(path.join(here, 'client.js')).href)
const spec = globalThis.__fsmPluginSpec
if (!spec) {
  console.error('error: failed to load plugin client module')
  process.exit(2)
}
const plugin = spec.factory((id) => {
  if (id === 'react') return React
  throw new Error(`unexpected module require: ${id}`)
})
const internals = plugin.__internals
if (!internals || typeof internals.parseVerilog !== 'function') {
  console.error('error: plugin internals are not available')
  process.exit(2)
}

const LIGHT_COLORS = {
  surface: '#ffffff',
  node: '#f7f8fa',
  border: '#d0d5dd',
  borderSoft: '#e4e7ec',
  text: '#101828',
  muted: '#667085',
  accent: '#2563eb',
  labelBg: '#ffffff',
}

function usage() {
  console.error(
    'usage: node cli.mjs <verilog.v> [--list] [--fsm <module|stateVar|index>] ' +
    '[--out <dir-or-file>] [--numbered] [--tree] [--title <text>] [--legend-title <text>] [--all]'
  )
}

function parseArgs(argv) {
  const args = { input: '', list: false, fsm: '', out: '', numbered: false, tree: false, all: false, title: '', legendTitle: '' }
  const rest = []
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]
    if (value === '--list') args.list = true
    else if (value === '--numbered') args.numbered = true
    else if (value === '--tree') args.tree = true
    else if (value === '--all') args.all = true
    else if (value === '--fsm') args.fsm = argv[++i] || ''
    else if (value === '--out') args.out = argv[++i] || ''
    else if (value === '--title') args.title = argv[++i] || ''
    else if (value === '--legend-title') args.legendTitle = argv[++i] || ''
    else if (value === '-h' || value === '--help') { usage(); process.exit(0) }
    else rest.push(value)
  }
  args.input = rest[0] || ''
  return args
}

function fsmKey(fsm) {
  return `${fsm.moduleName || 'module'}${fsm.stateVar ? ':' + fsm.stateVar : ''}`
}

function selectFsms(fsms, selector, all) {
  if (all) return fsms
  if (selector === '') return fsms.slice(0, 1)
  const index = Number(selector)
  if (Number.isInteger(index) && index >= 0 && index < fsms.length) return [fsms[index]]
  const matched = fsms.filter((fsm) => fsmKey(fsm) === selector || fsm.moduleName === selector || fsm.stateVar === selector)
  return matched.slice(0, 1)
}

function svgFor(fsm, args) {
  const view = args.tree ? internals.buildTreeFsm(fsm) : fsm
  const diagram = internals.layoutFsm(view, {})
  const base = {
    colors: LIGHT_COLORS,
    labels: {
      reset: 'RESET',
      diagram: args.title !== '' ? args.title : fsmKey(fsm),
      legend: args.legendTitle !== '' ? args.legendTitle : 'Conditions',
    },
  }
  if (args.numbered) {
    const numbering = internals.buildConditionNumbering(view)
    return internals.svgDocument(diagram, {
      ...base,
      numbered: true,
      numberMap: numbering.numberMap,
      legend: numbering.legend,
    })
  }
  return internals.svgDocument(diagram, base)
}

function outputPath(input, fsm, out) {
  const stem = path.basename(input, path.extname(input))
  const moduleName = fsm.moduleName || 'fsm'
  const suffix = fsm.stateVar ? '_' + fsm.stateVar : ''
  const name = moduleName === stem ? `${stem}${suffix}.svg` : `${stem}_${moduleName}${suffix}.svg`
  if (out === '') return path.join(path.dirname(input), name)
  if (fs.existsSync(out) && fs.statSync(out).isDirectory()) return path.join(out, name)
  if (out.endsWith('/')) return path.join(out, name)
  if (path.extname(out).toLowerCase() === '.svg') return out
  return path.join(out, name)
}

const args = parseArgs(process.argv.slice(2))
if (args.input === '') { usage(); process.exit(2) }
const source = fs.readFileSync(args.input, 'utf8')
const parsed = internals.parseVerilog(source)
const fsms = parsed.fsms || []
if (fsms.length === 0) {
  console.error('error: no FSM found in ' + args.input)
  process.exit(1)
}
if (args.list) {
  for (let i = 0; i < fsms.length; i += 1) {
    const fsm = fsms[i]
    console.log(`${i}\t${fsmKey(fsm)}\tstates=${fsm.states.length}\ttransitions=${fsm.transitions.length}`)
  }
  process.exit(0)
}
const selected = selectFsms(fsms, args.fsm, args.all)
if (selected.length === 0) {
  console.error(`error: no FSM matched '${args.fsm}'; use --list to inspect`)
  process.exit(1)
}
for (const fsm of selected) {
  const target = outputPath(args.input, fsm, args.out)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, svgFor(fsm, args), 'utf8')
  console.log(`wrote ${target}`)
}
