import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'

/** Load client internals. */
function loadInternals() {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let captured = null
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load(entry) { captured = entry } } }, console })
  const fakeReact = { useState() {}, useMemo() {}, useRef() {}, useEffect() {}, useCallback() {}, createElement() {} }
  return captured.factory((spec) => {
    if (spec === 'react') return fakeReact
    throw new Error('unexpected require: ' + spec)
  }).__internals
}

const { parseVerilog, layoutFsm, svgDocument } = loadInternals()
const colors = {
  surface: '#fff', node: '#f7f8fa', border: '#d0d5dd', borderSoft: '#e4e7ec',
  text: '#101828', muted: '#667085', accent: '#2563eb', labelBg: '#fff',
}

// --- graceful failure on non-case FSMs -------------------------------------
const ifChain = `
module if_chain (input clk, input rst_n, input go, output reg [1:0] s);
  localparam A = 2'd0, B = 2'd1;
  reg [1:0] s_n;
  always @(posedge clk or negedge rst_n) if (!rst_n) s <= A; else s <= s_n;
  always @(*) begin
    s_n = s;
    if (s == A) begin
      if (go) s_n = B;
    end else if (s == B) begin
      s_n = A;
    end
  end
endmodule
`
const ifParsed = parseVerilog(ifChain)
assert.equal(ifParsed.fsms.length, 0, 'if-chain FSMs are intentionally unsupported, must return empty')
assert.ok(ifParsed.warnings.length >= 0)
console.log('if-chain graceful: OK (fsms=0)')

// --- malformed input must not throw or hang --------------------------------
const malformedCases = [
  'module m; always @(posedge clk) begin case (s) S0: n = S1;',
  'module m; always @(*) case (s) endcase endmodule',
  'module m; always @(posedge clk) begin if (rst) s <= 0;',
  'module m; always @(*) begin case (s)',
  'always @(posedge clk) case (s) S0: n = S1; endcase',
  '`define X 1\nmodule m; endmodule',
  'module m; function f; input a; f = a; endfunction always @(*) case (s) S0: n = S1; endcase endmodule',
]
for (const source of malformedCases) {
  const started = Date.now()
  const parsed = parseVerilog(source)
  const elapsed = Date.now() - started
  assert.ok(elapsed < 2000, 'malformed input must parse quickly: ' + elapsed + 'ms')
  assert.ok(Array.isArray(parsed.fsms))
}
const strayCloserCases = [
  '\nbegin\n  case (state)\n    S0: state <= S1;\n  endcase\nend\n',
  '\n  case (state)\n    S0: state <= S1;\n  endcase\n',
  '\nmodule m (input clk, input rst, output reg [1:0] s);\n  always @(posedge clk) begin\n    if (rst) begin s <= 0; end\n  end\n  end\n  always @(*) case (s) S0: s <= 1; endcase\nendmodule\n',
  '\nmodule t (input clk, output reg [1:0] s);\n  always @(*) begin\n    case (s)\n      S0: s <= 1;\n',
  '\nmodule u (input clk, output reg [1:0] s);\n  always @(posedge clk) begin\n    case (s)\n      S0: s <= 1;\n    endcase\n',
]
for (const source of strayCloserCases) {
  const started = Date.now()
  const parsed = parseVerilog(source)
  const elapsed = Date.now() - started
  assert.ok(elapsed < 1000, 'stray closer input must not hang: ' + elapsed + 'ms')
  assert.ok(Array.isArray(parsed.fsms))
}
console.log('stray closer inputs: OK (' + strayCloserCases.length + ' cases, no hang)')
console.log('malformed inputs: OK (' + malformedCases.length + ' cases, no throw/hang)')

// --- large FSM performance and layout invariants --------------------------
const STATE_COUNT = 400
const lines = ['module big (input clk, input rst_n, input [7:0] sel, output reg [8:0] state);']
lines.push('  localparam [8:0] ' + Array.from({ length: STATE_COUNT }, (_, i) => 'S' + i + ' = 9\'d' + i).join(', ') + ';')
lines.push('  reg [8:0] state_next;')
lines.push('  always @(posedge clk or negedge rst_n) begin')
lines.push('    if (!rst_n) begin state <= S0; end else begin state <= state_next; end')
lines.push('  end')
lines.push('  always @(*) begin')
lines.push('    state_next = state;')
lines.push('    case (state)')
for (let i = 0; i < STATE_COUNT; i += 1) {
  const targets = [(i + 1) % STATE_COUNT, (i + 7) % STATE_COUNT, (i + 13) % STATE_COUNT, (i + 197) % STATE_COUNT, i]
  lines.push('      S' + i + ': begin')
  for (let k = 0; k < 5; k += 1) {
    lines.push('        if (sel == ' + k + ') state_next = S' + targets[k] + ';')
  }
  lines.push('      end')
}
lines.push('      default: state_next = S0;')
lines.push('    endcase')
lines.push('  end')
lines.push('endmodule')
const bigSource = lines.join('\n')
const parseStarted = Date.now()
const big = parseVerilog(bigSource)
const parseMs = Date.now() - parseStarted
assert.equal(big.fsms.length, 1)
assert.equal(big.fsms[0].states.length, STATE_COUNT)
const layoutStarted = Date.now()
const bigDiagram = layoutFsm(big.fsms[0])
const layoutMs = Date.now() - layoutStarted
const svgStarted = Date.now()
const bigSvg = svgDocument(bigDiagram, { colors, selected: 'S5' })
const svgMs = Date.now() - svgStarted
console.log('large FSM: ' + STATE_COUNT + ' states, ' + big.fsms[0].transitions.length + ' edges, parse=' + parseMs + 'ms layout=' + layoutMs + 'ms svg=' + svgMs + 'ms, size=' + bigSvg.length)
assert.ok(parseMs < 3000, 'parse too slow: ' + parseMs + 'ms')
assert.ok(layoutMs < 3000, 'layout too slow: ' + layoutMs + 'ms')
assert.ok(svgMs < 3000, 'svg too slow: ' + svgMs + 'ms')

// Same-layer nodes must not overlap; all coordinates finite and inside canvas.
const byRank = new Map()
for (const node of Array.from(bigDiagram.nodes)) {
  assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y))
  assert.ok(node.x >= 0 && node.y >= 0)
  assert.ok(node.x + node.width <= bigDiagram.width + 1, 'node escapes canvas width')
  assert.ok(node.y + node.height <= bigDiagram.height + 1, 'node escapes canvas height')
  const list = byRank.get(node.rank) || []
  list.push(node)
  byRank.set(node.rank, list)
}
for (const nodes of byRank.values()) {
  nodes.sort((a, b) => a.x - b.x)
  for (let i = 1; i < nodes.length; i += 1) {
    assert.ok(nodes[i - 1].x + nodes[i - 1].width <= nodes[i].x + 0.01, 'overlapping nodes in one rank')
  }
}
for (const edge of Array.from(bigDiagram.edges)) {
  assert.ok(!edge.path.includes('NaN') && !edge.path.includes('undefined'))
}
assert.ok(bigSvg.startsWith('<svg') && bigSvg.endsWith('</svg>'))
console.log('large FSM layout invariants: OK')

// --- SVG well-formedness through jsdom ------------------------------------
const { createRequire } = await import('node:module')
const nodeRequire = createRequire(import.meta.url)
let JSDOM = null
try { ({ JSDOM } = nodeRequire((process.env.DSH_CHECKOUT || '/root/dsh') + '/node_modules/jsdom')) } catch (error) { JSDOM = null }
if (JSDOM !== null) {
  const dom = new JSDOM('<!doctype html><html><body>' + bigSvg + '</body></html>')
  const svgElement = dom.window.document.querySelector('svg')
  assert.ok(svgElement !== null, 'jsdom must parse the SVG')
  assert.equal(svgElement.querySelectorAll('[data-state]').length, STATE_COUNT)
  console.log('SVG parsed by jsdom: OK, nodes=' + svgElement.querySelectorAll('[data-state]').length)
} else {
  console.log('jsdom unavailable: skipped DOM parse check')
}

console.log('ALL EDGE/PERF TESTS PASSED')
