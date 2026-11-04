import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)
const React = nodeRequire((process.env.DSH_CHECKOUT || '/root/dsh') + '/node_modules/.pnpm/react@18.3.1/node_modules/react')
const ReactDOMServer = nodeRequire((process.env.DSH_CHECKOUT || '/root/dsh') + '/node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/server')

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
let captured = null
vm.runInNewContext(source, { window: { __ModuleLoader__: { load(entry) { captured = entry } } }, console })
const module = captured.factory((spec) => {
  if (spec === 'react') return React
  throw new Error('unexpected require: ' + spec)
})
const internals = module.__internals
const {
  parseVerilog, generateVerilogFromTable, parseTransitionTableText, buildConditionNumbering,
  buildTreeFsm, svgDocument, layoutFsm, sessionState, sanitizeIdentifier,
} = internals

// The panel component comes from the registrations, like the browser does.
const registrations = []
const fakeContext = {
  effect(fn) { return fn() },
  locale: { register() { return () => {} }, bind() { return (key) => key } },
  slots: {
    inject(name, callback) { callback() },
    register(options, Component) { registrations.push({ options, Component }); return () => {} },
  },
}
module.apply(fakeContext)
const Page = registrations.find((entry) => entry.options.name === 'main').Component
const render = () => ReactDOMServer.renderToStaticMarkup(React.createElement(Page, { t: (key) => key }))

// ---------------------------------------------------------------------------
// Table -> Verilog generator round trip
// ---------------------------------------------------------------------------
const defaultTable = internals.createDefaultTable()
const generated = generateVerilogFromTable(defaultTable)
assert.equal(generated.empty, false)
assert.ok(generated.code.includes('module fsm_generated'), 'module header missing')
assert.ok(generated.code.includes('always @(posedge clk or negedge rst_n)'), 'clocked block missing')
assert.ok(generated.code.includes("localparam [1:0] IDLE = 2'd0;"), 'localparam encoding missing')
assert.ok(generated.code.includes('input  wire start'), 'condition signal start must become a port')
assert.ok(generated.code.includes('input  wire done'), 'condition signal done must become a port')
assert.ok(generated.code.includes('output wire [1:0] state_out'), 'state output port missing')
const parsed = parseVerilog(generated.code)
assert.equal(parsed.fsms.length, 1)
const fsm = parsed.fsms[0]
assert.equal(fsm.style, 'three')
assert.equal(fsm.clock, 'clk')
assert.equal(fsm.resetSignal, 'rst_n')
assert.equal(fsm.resetState, 'IDLE')
assert.deepEqual(Array.from(fsm.states, (state) => state.name), ['IDLE', 'START', 'RUN', 'STOP'])
const edgeList = Array.from(fsm.transitions, (edge) => edge.from + '->' + edge.to + ':' + edge.labels.join('|')).sort()
assert.deepEqual(edgeList, ['IDLE->START:start', 'RUN->STOP:done', 'START->RUN:done', 'STOP->IDLE:'])
console.log('table generator round trip: OK')

const empty = generateVerilogFromTable({ rows: [], moduleName: 'x', stateVar: 's', clock: 'clk', reset: 'rst_n' })
assert.equal(empty.empty, true)
assert.equal(empty.code, '')
const sanitized = generateVerilogFromTable({
  moduleName: 'my-fsm', stateVar: '2state', clock: 'clk', reset: 'rst_n',
  rows: [{ from: 'A-B', cond: '', to: 'C D' }],
})
assert.ok(sanitized.code.includes('module my_fsm'), 'module name not sanitized: ' + sanitized.code.split('\n')[0])
assert.ok(sanitized.code.includes('state_current_2state'), 'state register must be a legal identifier: ' + sanitized.code.split('\n')[9])
assert.ok(/reg \[0:0\]/.test(sanitized.code), 'single state must still get a one-bit range')
console.log('generator edge cases: OK')

// ---------------------------------------------------------------------------
// Pasted transition text
// ---------------------------------------------------------------------------
const arrowRows = parseTransitionTableText(`
// arrow form
IDLE -> START : start
START -> RUN if done
RUN -> STOP
`)
assert.deepEqual(Array.from(arrowRows, (row) => ({ from: row.from, cond: row.cond, to: row.to })), [
  { from: 'IDLE', cond: 'start', to: 'START' },
  { from: 'START', cond: 'done', to: 'RUN' },
  { from: 'RUN', cond: '', to: 'STOP' },
])
const csvRows = parseTransitionTableText('IDLE,start,START\nSTART,,\nRUN\tdone\tSTOP')
assert.deepEqual(Array.from(csvRows, (row) => ({ from: row.from, cond: row.cond, to: row.to })), [
  { from: 'IDLE', cond: 'start', to: 'START' },
  { from: 'RUN', cond: 'done', to: 'STOP' },
])
assert.deepEqual(Array.from(parseTransitionTableText('')), [])
const markdownRows = parseTransitionTableText('| From | Condition | To |\n|---|---|---|\n| A | go | B |')
assert.deepEqual(Array.from(markdownRows, (row) => ({ from: row.from, cond: row.cond, to: row.to })), [
  { from: 'A', cond: 'go', to: 'B' },
])
console.log('transition text import: OK')

// ---------------------------------------------------------------------------
// Condition numbering + legend inside the SVG
// ---------------------------------------------------------------------------
const info = buildConditionNumbering(fsm)
assert.deepEqual(Array.from(info.legend, (item) => ({ number: item.number, label: item.label })), [
  { number: 1, label: 'start' }, { number: 2, label: 'done' },
])
const diagram = layoutFsm(fsm)
const colors = {
  surface: '#ffffff', node: '#f7f8fa', border: '#d0d5dd', borderSoft: '#e4e7ec',
  text: '#101828', muted: '#667085', accent: '#2563eb', labelBg: '#ffffff',
}
const plainSvg = svgDocument(diagram, { colors, selected: '', labels: { reset: 'reset', diagram: 'diagram', legend: 'Conditions' } })
const numberedSvg = svgDocument(diagram, {
  colors, selected: '', labels: { reset: 'reset', diagram: 'diagram', legend: 'Conditions' },
  numbered: true, numberMap: info.numberMap, legend: info.legend,
})
assert.ok(plainSvg.includes('>start</text>'), 'plain SVG must keep condition text')
assert.ok(!plainSvg.includes('class="vfsm-legend"'), 'plain SVG must have no legend')
assert.ok(numberedSvg.includes('>1</text>'), 'numbered SVG must label the edge with its number')
assert.ok(numberedSvg.includes('class="vfsm-legend"'), 'numbered SVG must contain the legend')
assert.ok(numberedSvg.includes('Conditions'), 'legend title missing')
assert.ok(numberedSvg.includes('>start</text>'), 'legend must spell conditions out')
assert.ok(numberedSvg.includes('>done</text>'), 'legend must include every condition')
assert.ok(numberedSvg.includes('>2</text>'), 'legend must number the conditions')
assert.ok(numberedSvg.startsWith('<svg') && numberedSvg.endsWith('</svg>'))
assert.ok(!numberedSvg.includes('NaN'))
// The legend grows the viewBox and background rectangle.
const numberedHeight = /viewBox="0 0 \d+ (\d+)"/.exec(numberedSvg)
assert.ok(Number(numberedHeight[1]) > diagram.height, 'legend must extend the document height')
console.log('condition numbering + legend: OK')

// ---------------------------------------------------------------------------
// Rendered panel in table mode, all-diagrams mode, numbered mode
// ---------------------------------------------------------------------------
sessionState.mode = 'table'
sessionState.viewAll = false
sessionState.numbering = false
sessionState.code = ''
let markup = render()
assert.ok(markup.includes('vfsm-table-editor'), 'table editor missing')
assert.ok(markup.includes('vfsm-gen-head'), 'generated Verilog controls missing')
assert.ok(markup.includes('<svg'), 'table mode must render a diagram')
assert.ok(markup.includes('data-state="IDLE"'), 'table diagram states missing')
console.log('table mode SSR: OK')

sessionState.mode = 'code'
sessionState.code = `
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
`
sessionState.fsmIndex = 0
sessionState.viewAll = true
markup = render()
assert.ok(markup.includes('vfsm-all-grid'), 'all-diagrams grid missing')
assert.ok(markup.includes('vfsm-mini'), 'mini diagram cards missing')
assert.ok(markup.includes('data-state="A0"') && markup.includes('data-state="B0"'),
  'all-diagrams view must render every FSM')
const miniCount = (markup.match(/class="vfsm-mini"/g) || []).length
assert.equal(miniCount, 2, 'expected two mini diagrams, got ' + miniCount)
console.log('all diagrams SSR: OK')

sessionState.viewAll = false
sessionState.numbering = true
markup = render()
assert.ok(markup.includes('vfsm-legend'), 'numbered mode must render a legend in the SVG')
assert.ok(/aria-pressed="true"/.test(markup), 'numbering toggle must expose its pressed state')
console.log('numbered mode SSR: OK')

// ---------------------------------------------------------------------------
// Multi-FSM recognition regressions
// ---------------------------------------------------------------------------
const multiTwo = parseVerilog(`
module m (input clk, rst, a, output reg [1:0] p, output reg [1:0] q, output reg [1:0] r);
  always @(posedge clk) begin
    if (rst) begin p <= 0; q <= 0; r <= 0; end
    else begin
      case (p) 2'd0: p <= a ? 2'd1 : 2'd0; 2'd1: p <= 2'd0; endcase
      case (q) 2'd0: q <= a ? 2'd1 : 2'd0; 2'd1: q <= 2'd0; endcase
      case (r) 2'd0: r <= a ? 2'd1 : 2'd0; 2'd1: r <= 2'd0; endcase
    end
  end
endmodule
`)
assert.equal(multiTwo.fsms.length, 3, 'three 2-seg FSMs in one always block must all be found')
const literalReset = parseVerilog(`
module m (input clk, rst, a, output reg [1:0] s);
  reg [1:0] sn;
  always @(posedge clk) if (rst) s <= 0; else s <= sn;
  always @(*) case (s) 2'd0: sn = a ? 2'd1 : 2'd0; 2'd1: sn = 2'd0; endcase
endmodule
`)
assert.equal(literalReset.fsms[0].states.length, 2, '0 and 2\'d0 must collapse to one state')
console.log('multi-FSM regressions: OK')


// ---------------------------------------------------------------------------
// Per-edge colours: incident edges differ and the label matches its line
// ---------------------------------------------------------------------------
const colouredDiagram = layoutFsm(fsm)
const incident = new Map()
for (const edge of Array.from(colouredDiagram.edges)) {
  if (edge.colorIndex === undefined) throw new Error('edge has no colour slot')
  for (const node of [edge.from, edge.to]) {
    if (!incident.has(node)) incident.set(node, [])
    incident.get(node).push(edge.colorIndex)
  }
}
for (const [node, slots] of incident) {
  const unique = new Set(slots)
  assert.equal(unique.size, slots.length,
    'incident edges at ' + node + ' reuse a colour slot: ' + JSON.stringify(slots))
}
const customPalette = ['#010101', '#020202', '#030303', '#040404', '#050505', '#060606',
  '#070707', '#080808', '#090909', '#0a0a0a', '#0b0b0b', '#0c0c0c']
const colourSvg = svgDocument(colouredDiagram, {
  colors, selected: '', labels: {}, palette: customPalette,
})
const groups = [...colourSvg.matchAll(/<g class="vfsm-edge[^>]*data-edge="(\d+)"[^>]*>([\s\S]*?)<\/g>/g)]
assert.ok(groups.length >= 3, 'edge groups missing from coloured SVG')
for (const group of groups) {
  const body = group[2]
  const stroke = /stroke:(#[0-9a-f]{6})/.exec(body)
  const fill = /<text class="vfsm-label-text" style="fill:(#[0-9a-f]{6})"/.exec(body)
  if (stroke === null || fill === null) continue
  assert.equal(fill[1], stroke[1], 'edge ' + group[1] + ' label colour differs from its line')
}
assert.ok(!colourSvg.includes('var(--'), 'standalone SVG must not keep palette var() references')
// Numbered labels sit on the edge with a surface-coloured chip (embedded).
const numberedModes = {}
for (const transition of fsm.transitions) numberedModes[transition.from + '\u0000' + transition.to] = 'number'
const embeddedDiagram = layoutFsm(fsm, { labelModes: numberedModes, numberMap: info.numberMap })
const embeddedSvg = svgDocument(embeddedDiagram, {
  colors, selected: '', labels: {}, palette: customPalette, numbered: true,
  numberMap: info.numberMap, edgeModes: numberedModes,
})
assert.ok(embeddedSvg.includes('class="vfsm-label-rect is-number"'), 'numbered chips are not marked as embedded')
assert.ok(!plainSvg.includes('vfsm-label-rect is-number'), 'text chips must keep the bordered style')
console.log('embedded numbering: OK')
// Branch-tree generation style: keep priorities, drop inherited negations,
// give each conditional branch segment its own number, and draw junctions.
const branchCode = `
module branch_fsm(input clk, input rst_n, input a, input b, input c, output reg [1:0] state);
localparam IDLE = 2'd0, S1 = 2'd1, S2 = 2'd2, S3 = 2'd3;
always @(posedge clk or negedge rst_n) begin
  if (!rst_n) state <= IDLE;
  else begin
    case (state)
      IDLE: begin
        if (a) state <= S1;
        else if (b) state <= S2;
        else if (c) state <= S3;
        else state <= IDLE;
      end
      S1: state <= IDLE;
      default: state <= IDLE;
    endcase
  end
end
endmodule`
const branchFsm = parseVerilog(branchCode).fsms[0]
const treeFsm = buildTreeFsm(branchFsm)
const junctions = treeFsm.states.filter(state => state.synthetic === true)
assert.equal(junctions.length, 4, 'each priority branch needs a junction')
const branchLabels = treeFsm.transitions.filter(t => t.from.startsWith('__branch__')).map(t => t.labels.join(' / '))
assert.ok(branchLabels.includes('a') && branchLabels.includes('b') && branchLabels.includes('c') && branchLabels.includes('else'),
  'tree branch labels: ' + JSON.stringify(branchLabels))
assert.ok(branchLabels.every(label => !label.includes('!a') && !label.includes('!b')),
  'lower branches must not repeat higher conditions: ' + JSON.stringify(branchLabels))
const treeInfo = buildConditionNumbering(treeFsm)
assert.equal(JSON.stringify(treeInfo.legend.map(row => row.label)), JSON.stringify(['a', 'b', 'c', 'else']))
const treeDiagram = layoutFsm(treeFsm)
assert.equal(treeDiagram.nodes.filter(node => node.synthetic).length, 4)
assert.ok(treeDiagram.nodes.filter(node => node.synthetic).every(node => node.width <= 22 && node.height <= 22))
assert.ok(treeDiagram.edges.length >= 9, 'tree needs trunk, branch and continuation segments')
console.log('branch tree style: OK')
console.log('edge colours: OK')
console.log('ALL FEATURE TESTS PASSED (incl. edge colours)')

// ---------------------------------------------------------------------------
// Review round 2 defect regressions
// ---------------------------------------------------------------------------
// A. bit-select on the next-state left-hand side must not lose transitions.
const bitLhs = parseVerilog(`
module bl (input clk, rst, a, output reg [3:0] s);
  reg [3:0] sn;
  always @(posedge clk) if (rst) s <= 0; else s <= sn;
  always @(*) begin case (s[1:0])
    2'd0: sn[1:0] = a ? 2'd1 : 2'd0;
    2'd1: sn[1:0] = 2'd0;
  endcase end
endmodule
`)
assert.equal(bitLhs.fsms.length, 1, 'bit-select LHS must still find the FSM')
assert.equal(bitLhs.fsms[0].transitions.length, 3, 'bit-select LHS must not lose transitions')

// B. Keyword / leading-$ names are escaped.
assert.ok(sanitizeIdentifier('default', 'S') !== 'default', 'keyword must be escaped')
assert.ok(!sanitizeIdentifier('$foo', 'S').startsWith('$'), 'leading $ must not survive')
const keywordStates = generateVerilogFromTable({
  moduleName: 'kw', stateVar: 's', clock: 'clk', reset: 'rst_n',
  rows: [{ from: 'default', cond: 'a', to: 'casez' }, { from: 'casez', cond: '', to: 'default' }],
})
assert.ok(keywordStates.code.includes('default_'), 'keyword state must be escaped in generated code')
assert.ok(keywordStates.code.includes('casez_'), 'keyword state must be escaped in generated code')

// C. Name collisions are resolved with a warning.
const collided = generateVerilogFromTable({
  moduleName: 'm', stateVar: 'clk', clock: 'clk', reset: 'rst_n',
  rows: [{ from: 'A', cond: '', to: 'B' }, { from: 'B', cond: '', to: 'A' }],
})
assert.ok(collided.warnings.some((warning) => warning.code === 'warnRenamed'), 'collision must be reported')

// D. Inline comments are stripped by the importer and the generator.
const commentedRows = parseTransitionTableText('A -> B : go // start now\nB -> A : done # note')
assert.deepEqual(Array.from(commentedRows, (row) => ({ from: row.from, cond: row.cond, to: row.to })), [
  { from: 'A', cond: 'go', to: 'B' }, { from: 'B', cond: 'done', to: 'A' },
])

// E. Condition widths are inferred and undeclared calls become input ports.
const inferred = generateVerilogFromTable({
  moduleName: 'inf', stateVar: 's', clock: 'clk', reset: 'rst_n',
  rows: [{ from: 'A', cond: "x[1] && count == 4'd3", to: 'B' }, { from: 'B', cond: '', to: 'A' }],
})
assert.ok(inferred.code.includes('input  wire [1:0] x'), 'bit-select width not inferred')
assert.ok(inferred.code.includes('input  wire [3:0] count'), 'comparison width not inferred')
const call = generateVerilogFromTable({
  moduleName: 'fn', stateVar: 's', clock: 'clk', reset: 'rst_n',
  rows: [{ from: 'A', cond: 'is_go(x)', to: 'B' }, { from: 'B', cond: '', to: 'A' }],
})
assert.ok(!call.code.includes('is_go(x)'), 'undeclared function call survived in generated RTL')
assert.ok(call.code.includes('input  wire is_go'), 'function call was not replaced by an input')
assert.ok(call.warnings.some((warning) => warning.code === 'warnConditionFunction'))
console.log('review round 2 regressions: OK')
console.log('ALL FEATURE TESTS PASSED (incl. review round 2)')
