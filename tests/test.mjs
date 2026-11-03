import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'

/** Load the browser bundle in a VM and extract its internals for testing. */
function loadInternals() {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const marker = source.includes('// __PART_B__') ? '// __PART_B__' : (source.includes('// __PART_C__') ? '// __PART_C__' : null)
  const returnStatement = 'return { __internals: { tokenize, parseVerilog, layoutFsm, svgDocument, wrapLabel } }'
  const instrumented = marker === null ? source : source.replace(marker, returnStatement)
  let captured = null
  const sandbox = { window: { __ModuleLoader__: { load(entry) { captured = entry } } }, console }
  vm.runInNewContext(instrumented, sandbox)
  const fakeReact = {
    useState() {}, useMemo() {}, useRef() {}, useEffect() {}, useCallback() {}, createElement() {},
  }
  const module = captured.factory((spec) => {
    if (spec === 'react') return fakeReact
    throw new Error('unexpected require: ' + spec)
  })
  return module.__internals
}

const internals = loadInternals()
const { parseVerilog, layoutFsm, svgDocument } = internals

const THREE_SEG = `
module fsm_demo (
  input  wire       clk,
  input  wire       rst_n,
  input  wire       start,
  input  wire       done,
  output reg  [1:0] state_out
);
  localparam [1:0] IDLE  = 2'b00;
  localparam [1:0] START = 2'b01;
  localparam [1:0] RUN   = 2'b10;
  localparam [1:0] STOP  = 2'b11;

  reg [1:0] state_current;
  reg [1:0] state_next;

  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      state_current <= IDLE;
    end else begin
      state_current <= state_next;
    end
  end

  always @(*) begin
    state_next = state_current;
    case (state_current)
      IDLE: begin
        if (start) state_next = START;
      end
      START: begin
        if (done) state_next = RUN;
        else state_next = START;
      end
      RUN: begin
        if (done) state_next = STOP;
      end
      STOP: begin
        state_next = IDLE;
      end
      default: state_next = IDLE;
    endcase
  end
endmodule
`

const result = parseVerilog(THREE_SEG)
console.log(JSON.stringify(result, null, 2))
assert.equal(result.fsms.length, 1)
const fsm = result.fsms[0]
assert.equal(fsm.style, 'three')
assert.equal(fsm.clock, 'clk')
assert.equal(fsm.resetSignal, 'rst_n')
assert.equal(fsm.resetState, 'IDLE')
assert.deepEqual(Array.from(fsm.states, (s) => s.name), ['IDLE', 'START', 'RUN', 'STOP'])
assert.equal(fsm.states[0].encoding, "2'b00")
const edges = fsm.transitions.map((e) => `${e.from}->${e.to}:${e.labels.join('|')}`).sort()
console.log('EDGES', edges)
assert.deepEqual(Array.from(edges), [
  'IDLE->START:start',
  'RUN->STOP:done',
  'START->RUN:done',
  'START->START:!done',
  'STOP->IDLE:',
])
console.log('three-segment sample: OK')

// ---------------------------------------------------------------------------
// Two-segment FSM
// ---------------------------------------------------------------------------
const TWO_SEG = `
module fsm_two (input clk, input rst_n, input a, input b, output reg [1:0] state);
  localparam S0 = 2'd0, S1 = 2'd1, S2 = 2'd2;
  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) state <= S0;
    else begin
      case (state)
        S0: if (a) state <= S1;
        S1: begin
              if (b) state <= S2;
              else   state <= S1;
            end
        S2: state <= S0;
        default: state <= S0;
      endcase
    end
  end
endmodule
`
const two = parseVerilog(TWO_SEG)
assert.equal(two.fsms.length, 1)
assert.equal(two.fsms[0].style, 'two')
assert.equal(two.fsms[0].resetState, 'S0')
assert.deepEqual(Array.from(two.fsms[0].transitions, (e) => `${e.from}->${e.to}:${e.labels.join('|')}`).sort(), [
  'S0->S1:a', 'S1->S1:!b', 'S1->S2:b', 'S2->S0:',
])
console.log('two-segment sample: OK')

// ---------------------------------------------------------------------------
// Numeric targets, nested non-state case, sync reset
// ---------------------------------------------------------------------------
const MIXED = `
module fsm_mix (input clk, input rst, input cmd, output reg [2:0] st);
  localparam [2:0] IDLE = 3'b000, RUN = 3'b001, HOLD = 3'b010, DONE = 3'b011;
  reg [2:0] st_next;
  always @(posedge clk) begin
    if (rst) begin
      st <= IDLE;
    end else begin
      st <= st_next;
    end
  end
  always @(*) begin
    st_next = st;
    case (st)
      IDLE: begin
        case (cmd)
          1'b1: st_next = 3'b001;
          default: st_next = IDLE;
        endcase
      end
      RUN: st_next = HOLD;
      HOLD: if (cmd) st_next = DONE;
      DONE: st_next = IDLE;
      default: st_next = IDLE;
    endcase
  end
endmodule
`
const mixed = parseVerilog(MIXED)
assert.equal(mixed.fsms.length, 1)
const mix = mixed.fsms[0]
assert.equal(mix.resetSignal, 'rst')
assert.equal(mix.resetCondition, 'rst')
assert.deepEqual(Array.from(mix.transitions, (e) => `${e.from}->${e.to}:${e.labels.join('|')}`).sort(), [
  'DONE->IDLE:', 'HOLD->DONE:cmd', "IDLE->IDLE:!(cmd == 1'b1)", "IDLE->RUN:cmd == 1'b1", 'RUN->HOLD:',
])
assert.equal(mix.states.length, 4)
console.log('mixed sample: OK')

// ---------------------------------------------------------------------------
// Multiple modules and a bare fragment
// ---------------------------------------------------------------------------
const MULTI = `
module fsm_a (input clk, rst_n, input go, output reg [1:0] s);
  localparam A0 = 2'd0, A1 = 2'd1;
  reg [1:0] s_n;
  always @(posedge clk or negedge rst_n) if (!rst_n) s <= A0; else s <= s_n;
  always @(*) case (s) A0: s_n = go ? A1 : A0; A1: s_n = A0; endcase
endmodule
module fsm_b (input clk, rst_n, input go, output reg [1:0] t);
  localparam B0 = 2'd0, B1 = 2'd1;
  reg [1:0] t_n;
  always @(posedge clk or negedge rst_n) if (!rst_n) t <= B0; else t <= t_n;
  always @(*) case (t) B0: t_n = go ? B1 : B0; B1: t_n = B0; endcase
endmodule
`
const multi = parseVerilog(MULTI)
assert.deepEqual(Array.from(multi.modules), ['fsm_a', 'fsm_b'])
assert.equal(multi.fsms.length, 2)
console.log('multi module: OK')

const fragment = parseVerilog(`
  always @(posedge clk) begin
    if (rst) q <= S0;
    else q <= d;
  end
  always @(*) begin
    case (q)
      S0: d = en ? S1 : S0;
      S1: d = S0;
    endcase
  end
`)
assert.equal(fragment.fsms.length, 1)
assert.equal(fragment.fsms[0].moduleName, 'snippet')
console.log('fragment: OK')

// ---------------------------------------------------------------------------
// Comments must not confuse the tokenizer; no FSM returns an empty list
// ---------------------------------------------------------------------------
assert.equal(parseVerilog('// just a comment\nmodule empty; endmodule').fsms.length, 0)
console.log('empty module: OK')

console.log('ALL TESTS PASSED')


// ---------------------------------------------------------------------------
// Layout and SVG rendering
// ---------------------------------------------------------------------------
const diagram = layoutFsm(fsm)
assert.ok(diagram.nodes.length === 4)
assert.ok(diagram.edges.length === 5)
for (const node of Array.from(diagram.nodes)) {
  assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y), 'node position must be finite')
  assert.ok(node.x >= 0 && node.y >= 0, 'node must stay inside the canvas')
}
for (const edge of Array.from(diagram.edges)) {
  assert.ok(!edge.path.includes('NaN') && !edge.path.includes('undefined'), 'edge path must be finite')
  assert.ok(!edge.arrow.includes('NaN'), 'arrow must be finite')
}
assert.ok(diagram.width > 0 && diagram.height > 0)
const svg = svgDocument(diagram, {
  colors: {
    surface: '#fff', node: '#f7f8fa', border: '#d0d5dd', borderSoft: '#e4e7ec',
    text: '#101828', muted: '#667085', accent: '#2563eb', labelBg: '#fff',
  },
  selected: 'START',
})
assert.ok(svg.startsWith('<svg'))
assert.ok(svg.includes('</svg>'))
assert.ok(svg.includes('data-state="IDLE"'))
assert.ok(svg.includes('is-selected'))
assert.ok(svg.includes('!done'))
assert.ok(!svg.includes('NaN'))
console.log('layout + svg: OK')
console.log('ALL TESTS PASSED (incl. layout)')

// ---------------------------------------------------------------------------
// Ternary right-hand sides become conditional transitions
// ---------------------------------------------------------------------------
const TERNARY = `
module fsm_tern (input clk, rst_n, go, en, sel, output reg [1:0] s);
  localparam A = 2'd0, B = 2'd1, C = 2'd2;
  reg [1:0] n;
  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) s <= A;
    else s <= n;
  end
  always @(*) begin
    n = s;
    case (s)
      A: n = go ? B : C;
      B: n = en ? (sel ? A : B) : C;
      C: n = A;
    endcase
  end
endmodule
`
const ternary = parseVerilog(TERNARY)
assert.equal(ternary.fsms.length, 1)
const ternEdges = Array.from(ternary.fsms[0].transitions, (e) => `${e.from}->${e.to}:${e.labels.join('|')}`).sort()
console.log('TERNARY EDGES', ternEdges)
assert.deepEqual(ternEdges, [
  'A->B:go', 'A->C:!go', 'B->A:en && sel', 'B->B:en && !sel', 'B->C:!en', 'C->A:',
])
console.log('ternary sample: OK')
console.log('ALL TESTS PASSED (incl. ternary)')

// ---------------------------------------------------------------------------
// Nested case over a command signal: default branch and AND/OR precedence
// ---------------------------------------------------------------------------
const NESTED = `
module fsm_nested (input clk, rst, en, input [1:0] cmd, output reg [1:0] s);
  localparam S0 = 2'd0, S1 = 2'd1, S2 = 2'd2;
  reg [1:0] sn;
  always @(posedge clk) if (rst) s <= S0; else s <= sn;
  always @(*) begin
    sn = s;
    case (s)
      S0: begin
        if (en) begin
          case (cmd)
            2'd0, 2'd1: sn = S1;
            2'd2: sn = S2;
            default: sn = S0;
          endcase
        end
      end
      S1: sn = S0;
      S2: sn = S0;
    endcase
  end
endmodule
`
const nested = parseVerilog(NESTED)
assert.equal(nested.fsms.length, 1)
const nestedEdges = Array.from(nested.fsms[0].transitions, (e) => `${e.from}->${e.to}:${e.labels.join('|')}`).sort()
console.log('NESTED EDGES', nestedEdges)
assert.deepEqual(nestedEdges, [
  'S0->S0:en && !(cmd == 2\'d0 || cmd == 2\'d1 || cmd == 2\'d2)',
  'S0->S1:en && (cmd == 2\'d0 || cmd == 2\'d1)',
  'S0->S2:en && cmd == 2\'d2',
  'S1->S0:',
  'S2->S0:',
])
console.log('nested case sample: OK')
console.log('ALL TESTS PASSED (incl. nested case)')

// ---------------------------------------------------------------------------
// Review-driven regressions: generate blocks, wildcards, self loops, hints
// ---------------------------------------------------------------------------
const GENERATE = `
module g (input clk, rst, a, output reg [1:0] s);
  localparam S0 = 2'd0, S1 = 2'd1;
  reg [1:0] sn;
  generate if (1) begin : g_fsm
    always @(posedge clk) if (rst) s <= S0; else s <= sn;
    always @(*) begin case (s) S0: if (a) sn = S1; S1: sn = S0; endcase end
  end endgenerate
endmodule
`
assert.equal(parseVerilog(GENERATE).fsms.length, 1, 'generate-wrapped FSM must be extracted')

const WILDCARD = `
module z (input clk, rst, a, output reg [2:0] s);
  localparam IDLE = 3'b000, A = 3'b100, B = 3'b101;
  reg [2:0] sn;
  always @(posedge clk) if (rst) s <= IDLE; else s <= sn;
  always @(*) begin
    sn = s;
    casez (s)
      3'b000: if (a) sn = 3'b100;
      3'b1??: sn = 3'b000;
      default: sn = 3'b000;
    endcase
  end
endmodule
`
const wildcard = parseVerilog(WILDCARD).fsms[0]
assert.ok(!wildcard.states.some(state => state.name.includes('?')), 'wildcard must map to declared encodings')
assert.ok(Array.from(wildcard.transitions).some(edge => edge.from === 'A' && edge.to === 'IDLE'))
assert.ok(Array.from(wildcard.transitions).some(edge => edge.from === 'B' && edge.to === 'IDLE'))

const SELF = `
module sl (input clk, rst, a, output reg [1:0] s);
  localparam S0 = 2'd0, S1 = 2'd1;
  reg [1:0] sn;
  always @(posedge clk) if (rst) s <= S0; else s <= sn;
  always @(*) begin
    case (s)
      S0: sn = a ? S1 : S0;
      S1: sn = S1;
      default: sn = S0;
    endcase
  end
endmodule
`
const selfLoop = parseVerilog(SELF).fsms[0]
assert.ok(Array.from(selfLoop.transitions).some(edge => edge.from === 'S1' && edge.to === 'S1' && edge.labels.length === 0),
  'explicit unconditional self loop must be preserved')

const IF_CHAIN = `
module io (input clk, rst, a, output reg [1:0] s);
  localparam S0 = 2'd0, S1 = 2'd1;
  always @(posedge clk) begin
    if (rst) s <= S0;
    else if (a) s <= S1;
    else s <= S0;
  end
endmodule
`
const ifChain = parseVerilog(IF_CHAIN)
assert.equal(ifChain.fsms.length, 0)
assert.equal(ifChain.warnings.length, 0)
assert.equal(ifChain.hints.length, 1, 'if-chain FSM gets an explanatory hint, not a warning')
console.log('review regressions: OK')
console.log('ALL TESTS PASSED (incl. review regressions)')

// ---------------------------------------------------------------------------
// Review round 2: bit-select selector and module-header parameters
// ---------------------------------------------------------------------------
const BIT_SELECT = `
module bs (input clk, rst, a, output reg [3:0] s);
  localparam S0 = 4'd0, S1 = 4'd1;
  reg [3:0] sn;
  always @(posedge clk) if (rst) s <= S0; else s <= sn;
  always @(*) begin case (s[1:0]) S0: if (a) sn = S1; S1: sn = S0; endcase end
endmodule
`
const bitSelect = parseVerilog(BIT_SELECT)
assert.equal(bitSelect.fsms.length, 1, 'bit-select case selector must still find the FSM')
assert.deepEqual(Array.from(bitSelect.fsms[0].transitions, e => `${e.from}->${e.to}:${e.labels.join('|')}`).sort(), [
  'S0->S1:a', 'S1->S0:',
])

const HEADER_PARAMS = `
module hp #(parameter W = 2, parameter S0 = 2'd0, parameter S1 = 2'd1)
  (input clk, rst, a, output reg [W-1:0] s);
  reg [W-1:0] sn;
  always @(posedge clk) if (rst) s <= S0; else s <= sn;
  always @(*) begin case (s) S0: if (a) sn = S1; S1: sn = S0; endcase end
endmodule
`
const headerParams = parseVerilog(HEADER_PARAMS)
assert.equal(headerParams.fsms.length, 1)
assert.deepEqual(Array.from(headerParams.fsms[0].states, s => ({ name: s.name, encoding: s.encoding })), [
  { name: 'S0', encoding: "2'd0" }, { name: 'S1', encoding: "2'd1" },
])
console.log('review round 2 regressions: OK')
console.log('ALL TESTS PASSED (incl. round 2)')
