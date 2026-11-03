// jsdom interaction tests for the new features: table mode, condition
// numbering and the all-diagrams view.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import vm from 'node:vm'

const nodeRequire = createRequire(import.meta.url)
const { JSDOM, VirtualConsole } = nodeRequire((process.env.DSH_CHECKOUT || '/root/dsh') + '/node_modules/jsdom')
const React = nodeRequire((process.env.DSH_CHECKOUT || '/root/dsh') + '/node_modules/.pnpm/react@18.3.1/node_modules/react')
const ReactDOMClient = nodeRequire((process.env.DSH_CHECKOUT || '/root/dsh') + '/node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/client')
const TestUtils = nodeRequire((process.env.DSH_CHECKOUT || '/root/dsh') + '/node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/test-utils')
const act = React.act ?? TestUtils.act

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
  virtualConsole: new VirtualConsole(),
})
const win = dom.window
globalThis.window = win
globalThis.document = win.document
Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true })
for (const name of ['HTMLElement', 'Element', 'Node', 'SVGElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'PointerEvent', 'Blob', 'File', 'getComputedStyle']) {
  globalThis[name] = win[name]
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
let captured = null
win.__ModuleLoader__ = { load(entry) { captured = entry } }
const sandbox = {
  window: win,
  console,
  document: win.document,
  navigator: win.navigator,
  Blob: win.Blob,
  File: win.File,
  URL: win.URL,
  setTimeout: win.setTimeout,
  clearTimeout: win.clearTimeout,
}
vm.runInNewContext(source, sandbox)
const module = captured.factory((spec) => {
  if (spec === 'react') return React
  throw new Error('unexpected require: ' + spec)
})
const registrations = []
module.apply({
  effect(fn) { fn(); return () => {} },
  locale: { register() { return () => {} }, bind() { return key => key } },
  slots: {
    inject(owner, callback) { callback() },
    register(options, Component) { registrations.push({ options, Component }); return () => {} },
  },
})
const Page = registrations.find((entry) => entry.options.name === 'main').Component
const internals = module.__internals
const SAMPLE = internals.sessionState.code
let hit = null
win.document.elementFromPoint = () => hit
const container = win.document.createElement('div')
win.document.body.appendChild(container)
let root = null
const mount = () => {
  root = ReactDOMClient.createRoot(container)
  act(() => { root.render(React.createElement(Page, { t: (key) => key })) })
}
const q = (selector) => container.querySelector(selector)
const qa = (selector) => [...container.querySelectorAll(selector)]
const byText = (selector, label) => qa(selector).find((element) => element.textContent.trim() === label)
const click = (element) => act(() => { element.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true })) })
// The shipped React build in this jsdom environment does not run the native
// input change plugin; Simulate drives the same onChange handlers.
const setInput = (element, value) => {
  act(() => { TestUtils.Simulate.change(element, { target: { value } }) })
}
const setTextarea = (element, value) => {
  act(() => { TestUtils.Simulate.change(element, { target: { value } }) })
}
const svgMarkup = () => (q('.vfsm-canvas-inner') === null ? '' : q('.vfsm-canvas-inner').innerHTML)
const allSvgMarkup = () => qa('.vfsm-mini-canvas').map((element) => element.innerHTML).join('\n')
const pointer = (type, element) => act(() => {
  element.dispatchEvent(new win.PointerEvent(type, {
    bubbles: true, cancelable: true, clientX: 10, clientY: 10, pointerId: 1, button: 0,
  }))
})

// ---------------------------------------------------------------------------
// Table mode
// ---------------------------------------------------------------------------
mount()
click(byText('.vfsm-seg-btn', 'modeTable'))
assert.ok(q('.vfsm-table-editor') !== null, 'table editor did not open')
assert.ok(svgMarkup().includes('data-state="IDLE"'), 'table diagram missing')
const rows = qa('.vfsm-rows .vfsm-row').filter((row) => !row.classList.contains('vfsm-row-head'))
assert.equal(rows.length, 4, 'default table rows missing')
const inputs = rows[0].querySelectorAll('input')
assert.equal(inputs.length, 3)
setInput(inputs[2], 'DONE')
assert.ok(svgMarkup().includes('data-state="DONE"'), 'editing a row did not regenerate the diagram')
assert.ok(q('.vfsm-gen-code') !== null, 'generated Verilog panel should be open by default')
assert.ok(q('.vfsm-gen-code').textContent.includes('DONE'), 'generated Verilog did not pick up the edit')
assert.ok(q('.vfsm-gen-code').textContent.includes('input  wire start'), 'generated Verilog missing inferred condition port')

// add a row and import text
const before = qa('.vfsm-rows .vfsm-row').length
click(byText('.vfsm-row-actions .vfsm-btn', '+ addTransition'))
assert.equal(qa('.vfsm-rows .vfsm-row').length, before + 1, 'add transition did not append a row')
click(byText('.vfsm-row-actions .vfsm-btn', 'importText'))
setTextarea(q('.vfsm-import-text'), 'A -> B : go\nB -> C\nC,ready,B')
click(byText('.vfsm-import .vfsm-btn', 'importAction'))
assert.ok(svgMarkup().includes('data-state="A"'), 'imported state A missing')
assert.ok(svgMarkup().includes('data-state="C"'), 'imported state C missing')

// copy Verilog
let copiedText = null
Object.defineProperty(win.navigator, 'clipboard', {
  value: { writeText: async (value) => { copiedText = value } },
  configurable: true,
})
click(byText('.vfsm-gen-head .vfsm-btn', 'copyVerilog'))
await new Promise((resolve) => win.setTimeout(resolve, 0))
assert.ok(copiedText !== null && copiedText.includes('module fsm_generated'), 'copy did not write the generated Verilog')

// numbering toggle on the table diagram
click(byText('.vfsm-tools .vfsm-btn', 'labelNumber'))
assert.ok(svgMarkup().includes('class="vfsm-legend"'), 'numbering did not add a legend')
assert.ok(svgMarkup().includes('>1</text>'), 'numbering did not number the edges')
click(byText('.vfsm-tools .vfsm-btn', 'labelNumber'))
assert.ok(!svgMarkup().includes('class="vfsm-legend"'), 'legend must disappear when numbering is off')
console.log('table mode interaction: OK')

// ---------------------------------------------------------------------------
// All-diagrams view
// ---------------------------------------------------------------------------
click(byText('.vfsm-seg-btn', 'modeCode'))
setTextarea(q('.vfsm-code'), `
module fsm_a (input clk, rst, go, output reg [1:0] s);
  localparam A0 = 2'd0, A1 = 2'd1;
  reg [1:0] sn;
  always @(posedge clk) if (rst) s <= A0; else s <= sn;
  always @(*) begin case (s) A0: sn = go ? A1 : A0; A1: sn = A0; endcase end
endmodule
module fsm_b (input clk, rst, go, output reg [1:0] t);
  localparam B0 = 2'd0, B1 = 2'd1;
  reg [1:0] tn;
  always @(posedge clk) if (rst) t <= B0; else t <= tn;
  always @(*) begin case (t) B0: tn = go ? B1 : B0; B1: tn = B0; endcase end
endmodule
`)
assert.equal(qa('.vfsm-tab').length, 2, 'expected one tab per FSM')
const allButton = byText('.vfsm-tools .vfsm-btn', 'viewAll')
assert.ok(allButton !== undefined, 'all-diagrams button missing for multiple FSMs')
click(allButton)
assert.ok(q('.vfsm-all-grid') !== null, 'all-diagrams grid missing')
assert.equal(qa('.vfsm-mini').length, 2, 'expected two mini diagrams')
assert.ok(allSvgMarkup().includes('data-state="A0"') && allSvgMarkup().includes('data-state="B0"'), 'mini diagrams incomplete')
const cardButtons = qa('.vfsm-mini-tools .vfsm-btn')
click(cardButtons.find((button) => button.textContent.trim() === 'fsmView'))
assert.ok(q('.vfsm-canvas-inner') !== null, 'view button did not return to the single diagram')
console.log('all-diagrams interaction: OK')

// ---------------------------------------------------------------------------
// Single-FSM mode hides the all button
// ---------------------------------------------------------------------------
setTextarea(q('.vfsm-code'), `
module only (input clk, rst, go, output reg [1:0] s);
  localparam A0 = 2'd0, A1 = 2'd1;
  reg [1:0] sn;
  always @(posedge clk) if (rst) s <= A0; else s <= sn;
  always @(*) begin case (s) A0: sn = go ? A1 : A0; A1: sn = A0; endcase end
endmodule
`)
assert.equal(byText('.vfsm-tools .vfsm-btn', 'viewAll'), undefined, 'all button must hide for a single FSM')
assert.equal(qa('.vfsm-tab').length, 0, 'no tabs for a single FSM')
console.log('single FSM mode: OK')

// ---------------------------------------------------------------------------
// Clicking one edge switches only that line between text and number
// ---------------------------------------------------------------------------
click(byText('.vfsm-seg-btn', 'modeCode'))
setTextarea(q('.vfsm-code'), SAMPLE)
const toolbarButton = (label) => qa('.vfsm-tools .vfsm-btn').find((button) => button.textContent.trim() === label)
const findStartEdge = () => qa('.vfsm-edge').find((edge) => edge.textContent.includes('start'))
const first = findStartEdge()
assert.ok(first !== undefined, 'sample diagram missing the start edge')
hit = first
const transformBefore = q('.vfsm-canvas-inner').style.transform
pointer('pointerdown', q('.vfsm-canvas'))
pointer('pointerup', q('.vfsm-canvas'))
assert.equal(q('.vfsm-canvas-inner').style.transform, transformBefore,
  'switching one edge must keep the current zoom/pan')
let startEdge = findStartEdge()
assert.ok(startEdge !== undefined)
assert.ok(startEdge.textContent.includes('1'), 'clicking the edge did not switch it to its number')
assert.ok(q('.vfsm-legend') !== null, 'numbered edge should add a legend')
hit = startEdge
pointer('pointerdown', q('.vfsm-canvas'))
pointer('pointerup', q('.vfsm-canvas'))
startEdge = findStartEdge()
assert.ok(startEdge !== undefined && startEdge.textContent.includes('start'), 'second click did not restore the text')
assert.equal(q('.vfsm-legend'), null, 'legend should disappear when no edge is numbered')
// The global switch still works and resets the per-edge override.
const transformBeforeGlobal = q('.vfsm-canvas-inner').style.transform
click(toolbarButton('labelNumber'))
assert.equal(q('.vfsm-canvas-inner').style.transform, transformBeforeGlobal,
  'global label switch must keep the current zoom/pan')
assert.ok(q('.vfsm-legend') !== null, 'global numbering did not switch every edge')
assert.ok(findStartEdge().textContent.includes('1'), 'global numbering did not number the edge')
click(toolbarButton('labelNumber'))
assert.equal(q('.vfsm-legend'), null)
console.log('edge label toggle interaction: OK')

// ---------------------------------------------------------------------------
// Fullscreen toggle keeps the diagram usable and Escape exits the overlay
// ---------------------------------------------------------------------------
click(toolbarButton('fullscreen'))
let viewPane = q('.vfsm-view')
assert.ok(viewPane.classList.contains('is-fullscreen'), 'fullscreen fallback did not activate')
assert.equal(win.document.body.style.overflow, 'hidden')
act(() => {
  win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
})
viewPane = q('.vfsm-view')
assert.ok(!viewPane.classList.contains('is-fullscreen'), 'Escape did not leave fullscreen')
assert.equal(win.document.body.style.overflow, '')
console.log('fullscreen interaction: OK')

// ---------------------------------------------------------------------------
// Generated Verilog round trip from the imported table
// ---------------------------------------------------------------------------
const tableModel = internals.createDefaultTable()
const generated = internals.generateVerilogFromTable(tableModel)
assert.ok(generated.code.includes('input  wire start'))
console.log('ALL DOM FEATURE TESTS PASSED')
