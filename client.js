window.__ModuleLoader__.load({
  id: '@local/verilog-fsm-diagram',
  factory(require) {
    const React = require('react')
    const { useState, useMemo, useRef, useEffect, useCallback } = React
    const h = React.createElement

    /** Locale namespace and the id shared by the sidebar entry and the main panel. */
    const NS = 'verilogFsm'
    const PANEL_ID = 'verilog-fsm'

    /** Words starting a declaration group that the parser can skip as a unit. */
    const DECL_WORDS = ['reg', 'wire', 'logic', 'integer', 'bit', 'byte', 'shortint', 'int', 'longint', 'real', 'time', 'genvar']
    /** Words starting an always process. */
    const ALWAYS_WORDS = ['always', 'always_ff', 'always_comb', 'always_latch']
    /** Two-character operators recognized by the tokenizer. */
    const OPERATORS2 = ['<=', '>=', '==', '!=', '&&', '||', '<<', '>>', '**', '++', '--', '->', '::']

    // =====================================================================
    // Verilog tokenizer: just enough fidelity for FSM extraction.
    // =====================================================================

    /**
     * Split Verilog source into identifiers, literals, and operators, dropping
     * comments. Every token keeps its source line for diagnostics.
     * @param {string} source - Verilog text.
     * @returns {Array<{type: string, value: string, line: number}>} token list.
     */
    function tokenize(source) {
      const text = String(source === undefined || source === null ? '' : source)
      const n = text.length
      const tokens = []
      let i = 0
      let line = 1
      while (i < n) {
        const c = text[i]
        if (c === '\n') { line += 1; i += 1; continue }
        if (c === ' ' || c === '\t' || c === '\r' || c === '\f') { i += 1; continue }
        if (c === '/' && text[i + 1] === '/') {
          while (i < n && text[i] !== '\n') i += 1
          continue
        }
        if (c === '/' && text[i + 1] === '*') {
          i += 2
          while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
            if (text[i] === '\n') line += 1
            i += 1
          }
          i = Math.min(n, i + 2)
          continue
        }
        if (c === '"') {
          const start = i
          i += 1
          while (i < n && text[i] !== '"') {
            if (text[i] === '\n') line += 1
            i += 1
          }
          i = Math.min(n, i + 1)
          tokens.push({ type: 'str', value: text.slice(start, i), line })
          continue
        }
        if (/[A-Za-z_$]/.test(c)) {
          const start = i
          while (i < n && /[A-Za-z0-9_$]/.test(text[i])) i += 1
          tokens.push({ type: 'id', value: text.slice(start, i), line })
          continue
        }
        if (/[0-9]/.test(c)) {
          const start = i
          while (i < n && /[0-9_]/.test(text[i])) i += 1
          if (text[i] === "'") {
            i += 1
            if (text[i] === 's' || text[i] === 'S') i += 1
            if (/[bBoOdDhH]/.test(text[i] || '')) {
              i += 1
              while (i < n && /[0-9a-fA-FxXzZ_?]/.test(text[i])) i += 1
            }
          } else if (text[i] === '.' && /[0-9]/.test(text[i + 1] || '')) {
            i += 1
            while (i < n && /[0-9_]/.test(text[i])) i += 1
          }
          tokens.push({ type: 'num', value: text.slice(start, i), line })
          continue
        }
        const three = text.slice(i, i + 3)
        if (three === '===' || three === '!==') {
          tokens.push({ type: 'op', value: three, line })
          i += 3
          continue
        }
        const two = text.slice(i, i + 2)
        if (OPERATORS2.indexOf(two) >= 0) {
          tokens.push({ type: 'op', value: two, line })
          i += 2
          continue
        }
        tokens.push({ type: 'op', value: c, line })
        i += 1
      }
      return tokens
    }

    /**
     * Render a token slice back to compact source text, keeping expressions
     * readable as transition labels.
     * @param {Array<{type: string, value: string}>} tokens - token slice.
     * @returns {string} normalized expression text.
     */
    function tokensToText(tokens) {
      if (tokens === undefined || tokens === null || tokens.length === 0) return ''
      let out = ''
      for (let k = 0; k < tokens.length; k += 1) {
        const value = tokens[k].value
        if (out === '') { out = value; continue }
        const previous = tokens[k - 1].value
        const tightBefore = value === ')' || value === ']' || value === '}' || value === ','
          || value === ';' || value === ':' || value === '?'
        const tightAfter = previous === '(' || previous === '[' || previous === '{'
          || previous === '!' || previous === '~' || previous === '#' || previous === '?' || previous === ':'
        if (tightBefore || tightAfter) out += value
        else out += ' ' + value
      }
      return out.trim()
    }

    /** Normalize a constant spelling for index comparison. */
    function normalizeConst(text) {
      return String(text).replace(/\s+/g, '').replace(/_/g, '').toLowerCase()
    }

    /**
     * Convert a Verilog numeric literal to BigInt when it has a known value.
     * Returns null for `x`/`z` digits, expressions, and identifiers.
     */
    function numericValue(text) {
      const raw = String(text).replace(/\s+/g, '').replace(/_/g, '')
      if (raw === '') return null
      const based = /^(\d*)'([sS]?)([bBoOdDhH])([0-9a-fA-FxXzZ?]+)$/.exec(raw)
      if (based !== null) {
        const radix = { b: 2, o: 8, d: 10, h: 16 }[based[3].toLowerCase()]
        const digits = based[4]
        if (/[xXzZ?]/.test(digits)) return null
        try { return BigInt(parseInt(digits, radix)) } catch (error) { return null }
      }
      if (/^\d+$/.test(raw)) return BigInt(raw)
      if (/^0x[0-9a-f]+$/.test(raw)) return BigInt(raw)
      return null
    }

    /** Split a comma-separated label token slice into one token slice per label. */
    function splitLabels(tokens) {
      const groups = []
      let current = []
      let depth = 0
      for (const token of tokens) {
        const value = token.value
        if (value === '(' || value === '[' || value === '{') depth += 1
        else if (value === ')' || value === ']' || value === '}') depth = Math.max(0, depth - 1)
        if (depth === 0 && value === ',') {
          if (current.length > 0) groups.push(current)
          current = []
          continue
        }
        current.push(token)
      }
      if (current.length > 0) groups.push(current)
      return groups
    }

    /** Find the first top-level assignment operator in a flat statement. */
    function findAssignOp(tokens) {
      let depth = 0
      for (let k = 0; k < tokens.length; k += 1) {
        const value = tokens[k].value
        if (value === '(' || value === '[' || value === '{') depth += 1
        else if (value === ')' || value === ']' || value === '}') depth -= 1
        else if (depth === 0 && (value === '=' || value === '<=')) return k
      }
      return -1
    }

    /**
     * Build a small recursive-descent parser over a token list. The parser
     * understands module items, always events, begin/end, if/else, and case
     * statements; everything else is skipped as an opaque statement.
     */
    function createParser(tokens) {
      const parser = { tokens, i: 0 }

      parser.eof = () => parser.i >= tokens.length
      parser.peek = (offset = 0) => tokens[parser.i + offset]
      parser.isWord = (word, offset = 0) => {
        const token = parser.peek(offset)
        return token !== undefined && token.type === 'id' && token.value === word
      }
      parser.isOp = (op, offset = 0) => {
        const token = parser.peek(offset)
        return token !== undefined && token.type === 'op' && token.value === op
      }
      parser.group = () => {
        const start = parser.i
        let depth = 0
        while (parser.i < tokens.length) {
          const value = tokens[parser.i].value
          if (value === '(') depth += 1
          else if (value === ')') {
            depth -= 1
            if (depth === 0) {
              parser.i += 1
              return tokens.slice(start + 1, parser.i - 1)
            }
          }
          parser.i += 1
        }
        return tokens.slice(start + 1)
      }
      parser.bracketGroup = () => {
        const start = parser.i
        let depth = 0
        while (parser.i < tokens.length) {
          const value = tokens[parser.i].value
          if (value === '[') depth += 1
          else if (value === ']') {
            depth -= 1
            if (depth === 0) {
              parser.i += 1
              return tokens.slice(start + 1, parser.i - 1)
            }
          }
          parser.i += 1
        }
        return tokens.slice(start + 1)
      }
      parser.collectUntil = (stops) => {
        const out = []
        let depth = 0
        while (!parser.eof()) {
          const token = parser.peek()
          const value = token.value
          if (depth === 0 && stops.indexOf(value) >= 0) break
          if (value === '(' || value === '[' || value === '{') depth += 1
          else if (value === ')' || value === ']' || value === '}') depth = Math.max(0, depth - 1)
          out.push(token)
          parser.i += 1
        }
        return out
      }
      parser.skipToWord = (word) => {
        while (!parser.eof()) {
          const matched = parser.isWord(word)
          parser.i += 1
          if (matched) return
        }
      }
      parser.skipToSemicolon = () => {
        let depth = 0
        while (!parser.eof()) {
          const value = parser.peek().value
          if (value === '(') depth += 1
          else if (value === ')') depth = Math.max(0, depth - 1)
          if (depth === 0 && value === ';') { parser.i += 1; return }
          if (depth === 0 && parser.peek().type === 'id'
            && (value === 'endmodule' || value === 'end' || value === 'endcase'
              || value === 'endfunction' || value === 'endtask' || value === 'join'
              || value === 'join_any' || value === 'join_none')) {
            parser.i += 1
            return
          }
          parser.i += 1
        }
      }
      parser.parseParamDecl = (params) => {
        if (parser.isOp('[')) parser.bracketGroup()
        while (!parser.eof()) {
          if (parser.isOp(';')) { parser.i += 1; return }
          const token = parser.peek()
          if (token !== undefined && token.type === 'id' && DECL_WORDS.indexOf(token.value) < 0) {
            const name = token.value
            parser.i += 1
            if (parser.isOp('=')) {
              parser.i += 1
              const expression = parser.collectUntil([',', ';'])
              params.set(name, tokensToText(expression))
            } else if (parser.isOp(',')) parser.i += 1
            else if (parser.isOp(';')) { parser.i += 1; return }
            else parser.i += 1
          } else {
            parser.i += 1
          }
        }
      }
      parser.parseDecl = (decls) => {
        const range = parser.isOp('[') ? tokensToText(parser.bracketGroup()) : ''
        while (!parser.eof()) {
          if (parser.isOp(';')) { parser.i += 1; return }
          if (parser.isOp(',')) { parser.i += 1; continue }
          if (parser.isOp('=')) { parser.i += 1; parser.collectUntil([',', ';']); continue }
          const token = parser.peek()
          if (token !== undefined && token.type === 'id') {
            decls.set(token.value, range)
            parser.i += 1
            continue
          }
          parser.i += 1
        }
      }
      parser.parseAlways = () => {
        const startToken = parser.peek()
        const line = startToken.line
        parser.i += 1
        const event = []
        if (parser.isOp('@')) {
          parser.i += 1
          if (parser.isOp('(')) event.push.apply(event, parser.group())
          else if (parser.peek() !== undefined) { event.push(parser.peek()); parser.i += 1 }
        }
        const body = parser.parseStatement()
        const clocked = event.some(token => token.value === 'posedge' || token.value === 'negedge')
        return { kind: 'always', event, clocked, body, line }
      }
      parser.parseStatementBody = () => {
        if (parser.eof()) return { kind: 'empty' }
        const token = parser.peek()
        if (token.type === 'id') {
          const word = token.value
          if (word === 'begin' || word === 'fork') {
            const line = token.line
            parser.i += 1
            const ends = word === 'begin' ? ['end'] : ['join', 'join_any', 'join_none']
            const body = []
            while (!parser.eof()) {
              const current = parser.peek()
              if (current.type === 'id' && ends.indexOf(current.value) >= 0) break
              body.push(parser.parseStatement())
            }
            const closer = parser.peek()
            if (closer !== undefined && closer.type === 'id' && ends.indexOf(closer.value) >= 0) parser.i += 1
            return { kind: 'block', body, line }
          }
          if (word === 'if') {
            const line = token.line
            parser.i += 1
            const cond = parser.isOp('(') ? parser.group() : []
            const thenNode = parser.parseStatement()
            let elseNode = null
            if (parser.isWord('else')) {
              parser.i += 1
              elseNode = parser.parseStatement()
            }
            return { kind: 'if', cond, then: thenNode, else: elseNode, line }
          }
          if (word === 'case' || word === 'casez' || word === 'casex') {
            const line = token.line
            parser.i += 1
            const sel = parser.isOp('(') ? parser.group() : []
            const items = []
            while (!parser.eof() && !parser.isWord('endcase')) {
              if (parser.isWord('default')) {
                parser.i += 1
                if (parser.isOp(':')) parser.i += 1
                items.push({ labels: [], isDefault: true, body: parser.parseStatement() })
                continue
              }
              const labelTokens = []
              let guard = 0
              while (!parser.eof() && !parser.isOp(':') && !parser.isWord('endcase') && guard < 512) {
                labelTokens.push(parser.peek())
                parser.i += 1
                guard += 1
              }
              if (parser.isOp(':')) parser.i += 1
              items.push({ labels: splitLabels(labelTokens), isDefault: false, body: parser.parseStatement() })
            }
            if (parser.isWord('endcase')) parser.i += 1
            return { kind: 'case', sel, items, line }
          }
          if (word === 'unique' || word === 'unique0' || word === 'priority') {
            parser.i += 1
            return parser.parseStatement()
          }
          if (word === 'for' || word === 'while' || word === 'repeat') {
            const line = token.line
            parser.i += 1
            const cond = parser.isOp('(') ? parser.group() : []
            return { kind: 'loop', word, cond, body: parser.parseStatement(), line }
          }
          if (word === 'forever') {
            parser.i += 1
            return { kind: 'loop', word, cond: [], body: parser.parseStatement(), line: token.line }
          }
          if (word === 'assign') {
            parser.i += 1
            parser.skipToSemicolon()
            return { kind: 'skip', line: token.line }
          }
        }
        const line = token.line
        const flat = []
        let depth = 0
        while (!parser.eof()) {
          const current = parser.peek()
          const value = current.value
          if (value === '(' || value === '[' || value === '{') depth += 1
          else if (value === ')' || value === ']' || value === '}') depth = Math.max(0, depth - 1)
          if (depth === 0 && value === ';') { parser.i += 1; break }
          if (depth === 0 && current.type === 'id'
            && (value === 'end' || value === 'endcase' || value === 'endmodule')) break
          flat.push(current)
          parser.i += 1
        }
        if (flat.length === 0) return { kind: 'empty' }
        const opIndex = findAssignOp(flat)
        if (opIndex < 0) return { kind: 'other', tokens: flat, line }
        return { kind: 'assign', lhs: flat.slice(0, opIndex), op: flat[opIndex].value, rhs: flat.slice(opIndex + 1), line }
      }
      parser.parseStatement = () => {
        const before = parser.i
        const node = parser.parseStatementBody()
        // Malformed input may leave the cursor on a closer the surrounding
        // construct does not own; always consume one token so no loop spins.
        if (parser.i === before && !parser.eof()) parser.i += 1
        return node
      }
      parser.parseItems = (terminators) => {
        const items = []
        const params = new Map()
        const decls = new Map()
        const isTerminator = () => {
          if (parser.eof()) return true
          const token = parser.peek()
          return token.type === 'id' && terminators.indexOf(token.value) >= 0
        }
        const mergeInto = (inner) => {
          for (const item of inner.items) items.push(item)
          for (const [name, value] of inner.params) params.set(name, value)
          for (const [name, value] of inner.decls) decls.set(name, value)
        }
        const parseGenerateBody = () => {
          if (!parser.isWord('begin')) { parser.skipToSemicolon(); return }
          parser.i += 1
          if (parser.isOp(':')) {
            parser.i += 1
            if (parser.peek() !== undefined && parser.peek().type === 'id') parser.i += 1
          }
          const inner = parser.parseItems(['end'])
          if (parser.isWord('end')) parser.i += 1
          mergeInto(inner)
        }
        while (!isTerminator()) {
          const token = parser.peek()
          if (token === undefined) break
          if (token.type === 'id') {
            const word = token.value
            if (word === 'generate') {
              parser.i += 1
              const inner = parser.parseItems(['endgenerate'])
              if (parser.isWord('endgenerate')) parser.i += 1
              mergeInto(inner)
              continue
            }
            // Generate constructs (`if`/`for`) wrap module items; treat their
            // blocks transparently so a parameterized FSM is still extracted.
            if (word === 'if' || word === 'for') {
              parser.i += 1
              if (parser.isOp('(')) parser.group()
              if (word === 'for' && parser.isOp(':')) {
                parser.i += 1
                if (parser.peek() !== undefined && parser.peek().type === 'id') parser.i += 1
              }
              parseGenerateBody()
              continue
            }
            if (word === 'parameter' || word === 'localparam') { parser.i += 1; parser.parseParamDecl(params); continue }
            if (DECL_WORDS.indexOf(word) >= 0) { parser.i += 1; parser.parseDecl(decls); continue }
            if (ALWAYS_WORDS.indexOf(word) >= 0) { items.push(parser.parseAlways()); continue }
            if (word === 'initial' || word === 'final') { parser.i += 1; parser.parseStatement(); continue }
            if (word === 'function') { parser.skipToWord('endfunction'); continue }
            if (word === 'task') { parser.skipToWord('endtask'); continue }
            if (word === 'generate') { parser.skipToWord('endgenerate'); continue }
            if (word === 'specify') { parser.skipToWord('endspecify'); continue }
          }
          parser.skipToSemicolon()
        }
        return { items, params, decls }
      }
      return parser
    }

    // =====================================================================
    // FSM extraction
    // =====================================================================

    /** True when the name looks like a reset signal. */
    function isResetName(name) {
      return /rst|reset/i.test(name)
    }

    /** True when an expression reads any reset-looking signal. */
    function isResetCondition(tokens) {
      return tokens.some(token => token.type === 'id' && isResetName(token.value))
    }

    /** Return the single identifier a token slice represents, or null. */
    function simpleId(tokens) {
      if (tokens === undefined || tokens === null || tokens.length !== 1) return null
      return tokens[0].type === 'id' ? tokens[0].value : null
    }

    /**
     * Identifier an expression addresses for state-register matching: a bare
     * signal or a bit-select of one (`s` and `s[1:0]` both name `s`).
     */
    function selectorId(tokens) {
      if (tokens === undefined || tokens === null || tokens.length === 0) return null
      if (tokens.length === 1) return tokens[0].type === 'id' ? tokens[0].value : null
      if (tokens[0].type === 'id' && tokens[1].value === '[') return tokens[0].value
      return null
    }

    /** Visit every statement node; skipReset drops reset branches at the top. */
    function walkStatements(node, visit, skipReset) {
      if (node === undefined || node === null) return
      if (skipReset && node.kind === 'if' && isResetCondition(node.cond)) {
        walkStatements(node.else, visit, skipReset)
        return
      }
      visit(node)
      if (node.kind === 'block') {
        for (const child of node.body) walkStatements(child, visit, skipReset)
      } else if (node.kind === 'if') {
        walkStatements(node.then, visit, skipReset)
        walkStatements(node.else, visit, skipReset)
      } else if (node.kind === 'case') {
        for (const item of node.items) walkStatements(item.body, visit, skipReset)
      } else if (node.kind === 'loop') {
        walkStatements(node.body, visit, skipReset)
      }
    }

    /** Find the first case statement accepted by the predicate, depth first. */
    function findCaseNode(node, predicate) {
      let found = null
      walkStatements(node, (current) => {
        if (found === null && current.kind === 'case' && predicate(current)) found = current
      }, false)
      return found
    }

    /** Find every case statement accepted by the predicate, in walk order. */
    function collectCases(node, predicate) {
      const found = []
      walkStatements(node, (current) => {
        if (current.kind === 'case' && predicate(current)) found.push(current)
      }, false)
      return found
    }

    /** Assignments whose right side names a signal: state <= next candidates. */
    function findBareStateAssigns(block) {
      const found = []
      walkStatements(block.body, (node) => {
        if (node.kind !== 'assign') return
        const lhs = selectorId(node.lhs)
        const rhs = simpleId(node.rhs)
        if (lhs === null || rhs === null || lhs === rhs) return
        found.push({ stateVar: lhs, nextVar: rhs, line: node.line })
      }, true)
      return found
    }

    /** Clock and async reset signals named in an always event control. */
    function clockEventInfo(event) {
      const signals = []
      for (let k = 0; k < event.length; k += 1) {
        const token = event[k]
        if (token.value !== 'posedge' && token.value !== 'negedge') continue
        const signal = event[k + 1]
        if (signal === undefined || signal.type !== 'id') continue
        if (signals.indexOf(signal.value) < 0) signals.push(signal.value)
      }
      // `always @(negedge rst_n or posedge clk)` names the reset first: the
      // clock is the edge signal that does not look like a reset.
      let clock = null
      for (const name of signals) {
        if (!isResetName(name)) { clock = name; break }
      }
      if (clock === null && signals.length > 0) clock = signals[0]
      return { clock, resets: signals.filter(name => name !== clock) }
    }

    /** Locate the reset branch of a clocked block and its state assignment. */
    function findReset(block, stateVar) {
      const statements = block.body !== undefined && block.body.kind === 'block' ? block.body.body : [block.body]
      for (const node of statements) {
        if (node === undefined || node === null || node.kind !== 'if') continue
        if (!isResetCondition(node.cond)) continue
        const assigns = []
        walkStatements(node.then, (child) => {
          if (child.kind === 'assign' && selectorId(child.lhs) === stateVar) assigns.push(child)
        }, false)
        if (assigns.length > 0) return { assign: assigns[0], cond: node.cond }
      }
      return null
    }

    /** Index localparam values so numeric literals resolve back to state names. */
    function buildValueIndex(params) {
      const index = new Map()
      for (const [name, value] of params) {
        const numeric = numericValue(value)
        if (numeric !== null) index.set(numeric.toString(), name)
        else index.set(normalizeConst(value), name)
      }
      return index
    }

    /**
     * Expand one case label into the state names it addresses. Binary literals
     * with wildcard digits (`3'b1??`) match the declared encodings instead of
     * inventing a state whose name contains question marks.
     */
    function expandStateLabel(tokens, params, valueIndex, registry) {
      const text = tokensToText(tokens)
      if (text === '') return []
      const wildcard = /^(\d*)'[sS]?[bB]([01?xXzZ]+)$/.exec(text)
      if (wildcard !== null && /[?xXzZ]/.test(wildcard[2])) {
        const declaredWidth = wildcard[1] === '' ? null : parseInt(wildcard[1], 10)
        const pattern = wildcard[2].toLowerCase()
        const names = []
        for (const [name, value] of params) {
          const numeric = numericValue(value)
          if (numeric === null) continue
          let bits = numeric.toString(2)
          if (declaredWidth === null) {
            if (bits.length !== pattern.length) continue
          } else if (bits.length > declaredWidth) {
            bits = bits.slice(bits.length - declaredWidth)
          } else {
            bits = '0'.repeat(declaredWidth - bits.length) + bits
          }
          if (bits.length !== pattern.length) continue
          let matches = true
          for (let k = 0; k < pattern.length; k += 1) {
            const digit = pattern[k]
            if (digit === '?' || digit === 'x' || digit === 'z') continue
            if (bits[k] !== digit) { matches = false; break }
          }
          if (matches) names.push(name)
        }
        return names
      }
      const resolved = resolveStateLabel(tokens, params, valueIndex, registry)
      return resolved === null ? [] : [resolved.name]
    }

    /**
     * Resolve a case label (identifier or constant) to a state name. A shared
     * registry makes different spellings of one encoding (`0`, `2'd0`, a
     * localparam) collapse onto the same state.
     */
    function resolveStateLabel(tokens, params, valueIndex, registry) {
      const text = tokensToText(tokens)
      if (text === '') return null
      if (tokens.length === 1 && tokens[0].type === 'id') {
        const name = tokens[0].value
        const declared = params.get(name)
        if (declared !== undefined) {
          const numeric = numericValue(declared)
          if (numeric !== null) {
            const key = 'num:' + numeric.toString()
            if (registry !== undefined) {
              if (!registry.has(key)) registry.set(key, name)
              return { name: registry.get(key), raw: text }
            }
          }
        }
        return { name, raw: text }
      }
      const numeric = numericValue(text)
      if (numeric !== null) {
        const key = 'num:' + numeric.toString()
        if (registry !== undefined) {
          if (!registry.has(key)) {
            const known = valueIndex.get(numeric.toString())
            registry.set(key, known === undefined ? text : known)
          }
          return { name: registry.get(key), raw: text }
        }
        const known = valueIndex.get(numeric.toString())
        return { name: known === undefined ? text : known, raw: text }
      }
      const known = valueIndex.get(normalizeConst(text))
      if (known !== undefined) return { name: known, raw: text }
      if (registry !== undefined) {
        const key = 'text:' + normalizeConst(text)
        if (!registry.has(key)) registry.set(key, text)
        return { name: registry.get(key), raw: text }
      }
      return { name: text, raw: text }
    }

    /** Resolve an assignment right side to a target state ("current" maps to null). */
    function resolveTarget(tokens, params, valueIndex, stateNames, stateVar, registry) {
      const text = tokensToText(tokens)
      if (text === '') return null
      if (tokens.length === 1 && tokens[0].type === 'id') {
        const name = tokens[0].value
        if (name === stateVar) return { name: null, raw: text }
        if (stateNames.has(name)) return { name, raw: text }
        if (params.has(name)) {
          const declared = params.get(name)
          const numeric = numericValue(declared)
          if (numeric !== null && registry !== undefined) {
            const key = 'num:' + numeric.toString()
            if (registry.has(key)) return { name: registry.get(key), raw: text }
            registry.set(key, name)
          }
          return { name, raw: text }
        }
        return null
      }
      const numeric = numericValue(text)
      if (numeric !== null) {
        const key = 'num:' + numeric.toString()
        if (registry !== undefined) {
          if (registry.has(key)) return { name: registry.get(key), raw: text }
          const known = valueIndex.get(numeric.toString())
          const display = known === undefined ? text : known
          registry.set(key, display)
          return { name: display, raw: text }
        }
        const known = valueIndex.get(numeric.toString())
        return { name: known === undefined ? text : known, raw: text }
      }
      const known = valueIndex.get(normalizeConst(text))
      if (known !== undefined) return { name: known, raw: text }
      if (stateNames.has(text)) return { name: text, raw: text }
      return null
    }

    /** Join accumulated branch conditions into one label. */
    function conditionsToText(conditions) {
      const parts = []
      for (const condition of conditions) {
        const text = condition.negated ? negateCondition(condition.text) : condition.text
        if (text !== '') parts.push(text)
      }
      if (parts.length <= 1) return parts.length === 0 ? '' : parts[0]
      // Keep the original precedence readable now that the parts are ANDed.
      return parts.map((part) => {
        const grouped = part.charAt(0) === '(' || (part.charAt(0) === '!' && part.charAt(1) === '(')
        return part.indexOf(' || ') >= 0 && !grouped ? '(' + part + ')' : part
      }).join(' && ')
    }

    /** Negate a condition expression with minimal parentheses. */
    function negateCondition(text) {
      if (text === '') return ''
      if (text.charAt(0) === '!' && !/\s/.test(text)) return text.slice(1)
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text)) return '!' + text
      return '!(' + text + ')'
    }

    /** Strip redundant wrapping parentheses from an expression token slice. */
    function unwrapParens(tokens) {
      let out = tokens
      while (out.length >= 2 && out[0].value === '(') {
        let depth = 0
        let match = -1
        for (let k = 0; k < out.length; k += 1) {
          const value = out[k].value
          if (value === '(') depth += 1
          else if (value === ')') {
            depth -= 1
            if (depth === 0) { match = k; break }
          }
        }
        if (match !== out.length - 1) break
        out = out.slice(1, out.length - 1)
      }
      return out
    }

    /** Split a ternary expression into condition, then-branch, and else-branch. */
    function splitTernary(tokens) {
      let depth = 0
      let question = -1
      let colon = -1
      for (let k = 0; k < tokens.length; k += 1) {
        const value = tokens[k].value
        if (value === '(' || value === '[' || value === '{') depth += 1
        else if (value === ')' || value === ']' || value === '}') depth = Math.max(0, depth - 1)
        else if (depth === 0 && value === '?' && question < 0) question = k
        else if (depth === 0 && value === ':' && question >= 0) { colon = k; break }
      }
      if (question < 0 || colon < 0) return null
      return {
        condition: tokens.slice(0, question),
        thenBranch: tokens.slice(question + 1, colon),
        elseBranch: tokens.slice(colon + 1),
      }
    }

    /** Deduplicate warnings preserving order. */
    function uniqueWarnings(list) {
      const seen = new Set()
      const out = []
      for (const item of list) {
        const key = typeof item === 'string' ? item : JSON.stringify(item)
        if (seen.has(key)) continue
        seen.add(key)
        out.push(item)
      }
      return out
    }

    /** Find a combinational case over `stateVar` that assigns `nextVar`. */
    function findStateCase(blocks, stateVar, nextVar) {
      for (const block of blocks) {
        const caseNode = findCaseNode(block.body, (node) => {
          if (selectorId(node.sel) !== stateVar) return false
          let assignsNext = false
          for (const item of node.items) {
            walkStatements(item.body, (child) => {
              if (child.kind === 'assign' && selectorId(child.lhs) === nextVar) assignsNext = true
            }, false)
          }
          return assignsNext
        })
        if (caseNode !== null) return caseNode
      }
      return null
    }

    /** Turn one state register (or self-assigning case) into an FSM model. */
    function buildFsm(module, clockBlock, reg, caseNode, style, params, valueIndex) {
      const warnings = []
      const eventInfo = clockEventInfo(clockBlock.event)
      const resetInfo = findReset(clockBlock, reg.stateVar)
      let resetState = null
      let resetCondition = null
      let resetSignal = eventInfo.resets.length > 0 ? eventInfo.resets[0] : null
      if (resetInfo !== null && resetSignal === null) {
        const named = resetInfo.cond.find(token => token.type === 'id' && isResetName(token.value))
        if (named !== undefined) resetSignal = named.value
      }

      const stateOrder = []
      const stateSeen = new Set()
      const addState = (name) => {
        if (name === null || name === undefined || name === '') return
        if (stateSeen.has(name)) return
        stateSeen.add(name)
        stateOrder.push(name)
      }

      // One registry per FSM collapses `0`, `2'd0`, and a localparam naming the
      // same encoding onto one state. The reset spelling seeds the registry so
      // the start state keeps the name the author used in the reset branch.
      const stateRegistry = new Map()
      const labelNames = new Set()
      if (resetInfo !== null) {
        resetCondition = tokensToText(resetInfo.cond)
        const resolved = resolveStateLabel(resetInfo.assign.rhs, params, valueIndex, stateRegistry)
        if (resolved !== null) {
          resetState = resolved.name
          labelNames.add(resetState)
        }
      }
      for (const item of caseNode.items) {
        if (item.isDefault) continue
        for (const label of item.labels) {
          for (const name of expandStateLabel(label, params, valueIndex, stateRegistry)) labelNames.add(name)
        }
      }

      const rawTransitions = []
      const nextVars = new Set([reg.nextVar])

      const handleTarget = (rhsTokens, branchConditions, line, fromStates) => {
        rhsTokens = unwrapParens(rhsTokens)
        const ternary = splitTernary(rhsTokens)
        if (ternary !== null) {
          const conditionText = tokensToText(ternary.condition)
          handleTarget(ternary.thenBranch, branchConditions.concat([{ text: conditionText, negated: false }]), line, fromStates)
          handleTarget(ternary.elseBranch, branchConditions.concat([{ text: conditionText, negated: true }]), line, fromStates)
          return
        }
        const target = resolveTarget(rhsTokens, params, valueIndex, labelNames, reg.stateVar, stateRegistry)
        if (target === null) {
          warnings.push({ code: 'warnUnresolvedTarget', params: { line, expr: tokensToText(rhsTokens) } })
          return
        }
        if (target.name !== null) addState(target.name)
        rawTransitions.push({ fromStates, to: target.name, conditions: branchConditions })
      }

      const walkBody = (node, fromStates, conditions) => {
        if (node === undefined || node === null) return
        if (node.kind === 'block') {
          for (const child of node.body) walkBody(child, fromStates, conditions)
          return
        }
        if (node.kind === 'if') {
          const condText = tokensToText(node.cond)
          walkBody(node.then, fromStates, conditions.concat([{ text: condText, negated: false }]))
          if (node.else !== null && node.else !== undefined) {
            walkBody(node.else, fromStates, conditions.concat([{ text: condText, negated: true }]))
          }
          return
        }
        if (node.kind === 'case') {
          const selector = selectorId(node.sel)
          if (selector !== null && selector === reg.stateVar) {
            warnings.push({ code: 'warnNestedCase', params: { line: node.line } })
            return
          }
          const selText = tokensToText(node.sel)
          const labelTexts = []
          for (const item of node.items) {
            if (item.isDefault) continue
            for (const label of item.labels) labelTexts.push(tokensToText(label))
          }
          const knownCondition = labelTexts.map(label => selText + ' == ' + label).join(' || ')
          for (const item of node.items) {
            if (item.isDefault) {
              const fallback = knownCondition === '' ? '' : negateCondition(knownCondition)
              walkBody(item.body, fromStates, conditions.concat([{ text: fallback, negated: false }]))
              continue
            }
            const labels = item.labels.map(label => tokensToText(label))
            const condText = labels.map(label => selText + ' == ' + label).join(' || ')
            if (condText === '') continue
            walkBody(item.body, fromStates, conditions.concat([{ text: condText, negated: false }]))
          }
          return
        }
        if (node.kind === 'assign') {
          const lhs = selectorId(node.lhs)
          if (lhs === null || !nextVars.has(lhs)) return
          handleTarget(node.rhs, conditions, node.line, fromStates)
          return
        }
        if (node.kind === 'loop') {
          warnings.push({ code: 'warnLoop', params: { line: node.line } })
          walkBody(node.body, fromStates, conditions)
        }
      }

      for (const item of caseNode.items) {
        if (item.isDefault) continue
        const fromStates = []
        for (const label of item.labels) {
          const names = expandStateLabel(label, params, valueIndex, stateRegistry)
          if (names.length === 0) {
            warnings.push({ code: 'warnLabel', params: { label: tokensToText(label) } })
            continue
          }
          for (const name of names) {
            fromStates.push(name)
            addState(name)
          }
        }
        if (fromStates.length === 0) continue
        walkBody(item.body, fromStates, [])
      }

      if (stateOrder.length === 0) return null

      if (resetState !== null && !stateSeen.has(resetState)) {
        stateSeen.add(resetState)
        stateOrder.unshift(resetState)
      }

      const edgeMap = new Map()
      const quietSelfLoops = new Set()
      for (const transition of rawTransitions) {
        const label = conditionsToText(transition.conditions)
        for (const from of transition.fromStates) {
          const to = transition.to === null ? from : transition.to
          if (from === to && label === '') {
            // An unconditional self assignment is usually the `next = current`
            // baseline before the real conditions; keep it only when the state
            // has no other way out, where it is the whole behaviour.
            quietSelfLoops.add(from)
            continue
          }
          const key = from + '\u0000' + to
          let edge = edgeMap.get(key)
          if (edge === undefined) {
            edge = { from, to, labels: [], unconditional: false }
            edgeMap.set(key, edge)
          }
          if (label === '') edge.unconditional = true
          else if (edge.labels.indexOf(label) < 0) edge.labels.push(label)
        }
      }

      const transitions = []
      for (const edge of edgeMap.values()) {
        transitions.push({ from: edge.from, to: edge.to, labels: edge.unconditional ? [] : edge.labels })
      }
      for (const from of quietSelfLoops) {
        const hasOther = transitions.some(edge => edge.from === from)
        if (!hasOther) transitions.push({ from, to: from, labels: [] })
      }

      return {
        id: module.name + ':' + reg.stateVar,
        moduleName: module.name,
        stateVar: reg.stateVar,
        nextVar: reg.nextVar,
        style,
        clock: eventInfo.clock,
        resetSignal,
        resetCondition,
        resetState,
        states: stateOrder.map(name => ({ name, encoding: params.has(name) ? params.get(name) : '' })),
        transitions,
        warnings: uniqueWarnings(warnings),
        line: caseNode.line,
      }
    }

    /** Extract every FSM a module contains. */
    function analyzeModule(module) {
      const blocks = module.items.filter(item => item.kind === 'always')
      const clocked = blocks.filter(block => block.clocked)
      const combinational = blocks.filter(block => !block.clocked)
      if (clocked.length === 0) return []
      const params = module.params
      const valueIndex = buildValueIndex(params)
      const fsms = []
      const covered = new Set()

      for (const block of clocked) {
        for (const reg of findBareStateAssigns(block)) {
          if (covered.has(reg.stateVar)) continue
          const caseNode = findStateCase(combinational, reg.stateVar, reg.nextVar)
          if (caseNode === null) continue
          covered.add(reg.stateVar)
          const fsm = buildFsm(module, block, reg, caseNode, 'three', params, valueIndex)
          if (fsm !== null) fsms.push(fsm)
        }
      }

      for (const block of clocked) {
        const caseNodes = collectCases(block.body, (node) => {
          const selector = selectorId(node.sel)
          if (selector === null) return false
          let assignsSelf = false
          for (const item of node.items) {
            walkStatements(item.body, (child) => {
              if (child.kind === 'assign' && selectorId(child.lhs) === selector) assignsSelf = true
            }, true)
          }
          return assignsSelf
        })
        for (const caseNode of caseNodes) {
          const selector = selectorId(caseNode.sel)
          if (selector === null || covered.has(selector)) continue
          covered.add(selector)
          const fsm = buildFsm(module, block, { stateVar: selector, nextVar: selector }, caseNode, 'two', params, valueIndex)
          if (fsm !== null) fsms.push(fsm)
        }
      }

      return fsms
    }

    /** Collect parameter declarations found in an ANSI module-header `#(...)`. */
    function parseHeaderParameters(tokens, params) {
      const sub = createParser(tokens)
      while (!sub.eof()) {
        const token = sub.peek()
        if (token.type === 'id' && (token.value === 'parameter' || token.value === 'localparam')) {
          sub.i += 1
          continue
        }
        if (token.type === 'id' && DECL_WORDS.indexOf(token.value) < 0) {
          const name = token.value
          sub.i += 1
          if (sub.isOp('=')) {
            sub.i += 1
            const expression = sub.collectUntil([',', ';'])
            params.set(name, tokensToText(expression))
          }
          continue
        }
        sub.i += 1
      }
    }

    /**
     * Parse Verilog source and extract every case-based state machine.
     * @param {string} source - Verilog source text (a full file or a fragment).
     * @returns {{modules: string[], fsms: object[], warnings: string[]}}
     */
    function parseVerilog(source) {
      const tokens = tokenize(source)
      const parser = createParser(tokens)
      const modules = []
      while (!parser.eof()) {
        if (parser.isWord('module') || parser.isWord('macromodule')) {
          const line = parser.peek().line
          parser.i += 1
          let name = 'module'
          if (parser.peek() !== undefined && parser.peek().type === 'id') {
            name = parser.peek().value
            parser.i += 1
          }
          const headerParams = new Map()
          while (!parser.eof() && !parser.isOp(';')) {
            if (parser.isOp('#')) {
              parser.i += 1
              if (parser.isOp('(')) parseHeaderParameters(parser.group(), headerParams)
              continue
            }
            if (parser.isOp('(')) parser.group()
            else parser.i += 1
          }
          if (parser.isOp(';')) parser.i += 1
          const parsed = parser.parseItems(['endmodule'])
          for (const [name, value] of headerParams) parsed.params.set(name, value)
          if (parser.isWord('endmodule')) parser.i += 1
          modules.push({ name, line, items: parsed.items, params: parsed.params })
        } else {
          parser.i += 1
        }
      }
      if (modules.length === 0) {
        const snippetParser = createParser(tokens)
        const parsed = snippetParser.parseItems([])
        modules.push({ name: 'snippet', line: 1, items: parsed.items, params: parsed.params })
      }
      const warnings = []
      const fsms = []
      for (const module of modules) {
        try {
          const found = analyzeModule(module)
          for (const fsm of found) fsms.push(fsm)
        } catch (error) {
          warnings.push({
            code: 'warnModuleError',
            params: { module: module.name, message: error instanceof Error ? error.message : String(error) },
          })
        }
      }
      const hints = []
      if (fsms.length === 0) {
        for (const module of modules) {
          const blocks = module.items.filter(item => item.kind === 'always' && item.clocked)
          let explained = false
          for (const block of blocks) {
            const registers = findBareStateAssigns(block)
            if (registers.length === 0) continue
            hints.push({ code: 'hintNoCase', params: { module: module.name, state: registers[0].stateVar } })
            explained = true
            break
          }
          if (explained) break
        }
      }
      return { modules: modules.map(module => module.name), fsms, warnings, hints }
    }

    // =====================================================================
    // Layered layout for a state-transition graph
    // =====================================================================

    /** Approximate text width in px for the SVG font. */
    function estimateTextWidth(text, fontSize) {
      let width = 0
      for (const character of String(text)) {
        width += character.codePointAt(0) > 0x2e80 ? fontSize : fontSize * 0.6
      }
      return width
    }

    /** Intersection of the vector center->toward with the node's padded box. */
    function boxAnchor(node, toward) {
      const cx = node.x + node.width / 2
      const cy = node.y + node.height / 2
      const dx = toward.x - cx
      const dy = toward.y - cy
      if (dx === 0 && dy === 0) return { x: cx, y: cy }
      const halfWidth = node.width / 2 + 5
      const halfHeight = node.height / 2 + 5
      const scale = Math.min(
        dx === 0 ? Number.POSITIVE_INFINITY : halfWidth / Math.abs(dx),
        dy === 0 ? Number.POSITIVE_INFINITY : halfHeight / Math.abs(dy),
      )
      return { x: cx + dx * scale, y: cy + dy * scale }
    }

    /** Quadratic bezier point at t. */
    function bezierPoint(start, control, end, t) {
      const u = 1 - t
      return {
        x: u * u * start.x + 2 * u * t * control.x + t * t * end.x,
        y: u * u * start.y + 2 * u * t * control.y + t * t * end.y,
      }
    }

    /** Arrowhead polygon at `tip` pointing along direction (dx, dy). */
    function arrowHead(tip, dx, dy) {
      const length = Math.sqrt(dx * dx + dy * dy) || 1
      const ux = dx / length
      const uy = dy / length
      const size = 9
      const half = 4.2
      const baseX = tip.x - ux * size
      const baseY = tip.y - uy * size
      const left = { x: baseX - uy * half, y: baseY + ux * half }
      const right = { x: baseX + uy * half, y: baseY - ux * half }
      return 'M' + tip.x.toFixed(1) + ',' + tip.y.toFixed(1)
        + ' L' + left.x.toFixed(1) + ',' + left.y.toFixed(1)
        + ' L' + right.x.toFixed(1) + ',' + right.y.toFixed(1) + ' Z'
    }

    /** Wrap one transition label into short lines for the SVG chip. */
    function wrapLabel(text, maxLength) {
      if (text === '') return []
      const parts = []
      const pieces = String(text).split(' && ')
      let current = ''
      for (const piece of pieces) {
        const candidate = current === '' ? piece : current + ' && ' + piece
        if (candidate.length <= maxLength) { current = candidate; continue }
        if (current !== '') parts.push(current)
        current = piece
        while (current.length > maxLength) {
          parts.push(current.slice(0, maxLength - 1) + '…')
          current = current.slice(maxLength - 1)
        }
      }
      if (current !== '') parts.push(current)
      return parts.length === 0 ? [String(text)] : parts
    }

    /** Keep edge chips readable: extra condition text stays in the state table
     * and the tooltip instead of growing the chip without bound. */
    function capLabelLines(lines, maxLines) {
      if (lines.length <= maxLines) return lines
      return lines.slice(0, maxLines - 1).concat(['…'])
    }

    /** Median of a numeric list. */
    function median(values) {
      if (values.length === 0) return 0
      const sorted = values.slice().sort((left, right) => left - right)
      const middle = Math.floor(sorted.length / 2)
      return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
    }

    /** Smooth the polyline through `points` with a Catmull-Rom spline. */
    function smoothPolylinePath(points) {
      if (points.length < 2) return ''
      if (points.length === 2) {
        return 'M' + points[0].x.toFixed(1) + ',' + points[0].y.toFixed(1)
          + ' L' + points[1].x.toFixed(1) + ',' + points[1].y.toFixed(1)
      }
      let path = 'M' + points[0].x.toFixed(1) + ',' + points[0].y.toFixed(1)
      for (let index = 0; index < points.length - 1; index += 1) {
        const before = points[index - 1] === undefined ? points[index] : points[index - 1]
        const current = points[index]
        const next = points[index + 1]
        const after = points[index + 2] === undefined ? next : points[index + 2]
        const control1 = { x: current.x + (next.x - before.x) / 6, y: current.y + (next.y - before.y) / 6 }
        const control2 = { x: next.x - (after.x - current.x) / 6, y: next.y - (after.y - current.y) / 6 }
        path += ' C' + control1.x.toFixed(1) + ',' + control1.y.toFixed(1)
          + ' ' + control2.x.toFixed(1) + ',' + control2.y.toFixed(1)
          + ' ' + next.x.toFixed(1) + ',' + next.y.toFixed(1)
      }
      return path
    }

    /** Rounded polyline for edges routed around the outside of the graph. */
    function roundedPolylinePath(points, radius) {
      if (points.length < 2) return ''
      let path = 'M' + points[0].x.toFixed(1) + ',' + points[0].y.toFixed(1)
      for (let index = 1; index < points.length - 1; index += 1) {
        const previous = points[index - 1]
        const current = points[index]
        const next = points[index + 1]
        const lengthIn = Math.hypot(current.x - previous.x, current.y - previous.y) || 1
        const lengthOut = Math.hypot(next.x - current.x, next.y - current.y) || 1
        const corner = Math.min(radius, lengthIn / 2, lengthOut / 2)
        const enter = {
          x: current.x - (current.x - previous.x) / lengthIn * corner,
          y: current.y - (current.y - previous.y) / lengthIn * corner,
        }
        const leave = {
          x: current.x + (next.x - current.x) / lengthOut * corner,
          y: current.y + (next.y - current.y) / lengthOut * corner,
        }
        path += ' L' + enter.x.toFixed(1) + ',' + enter.y.toFixed(1)
          + ' Q' + current.x.toFixed(1) + ',' + current.y.toFixed(1)
          + ' ' + leave.x.toFixed(1) + ',' + leave.y.toFixed(1)
      }
      const last = points[points.length - 1]
      path += ' L' + last.x.toFixed(1) + ',' + last.y.toFixed(1)
      return path
    }

    /** True when two axis-aligned rectangles overlap (with a margin). */
    function rectanglesOverlap(left, right, margin) {
      const gap = margin === undefined ? 0 : margin
      return left.x < right.x + right.width + gap
        && right.x < left.x + left.width + gap
        && left.y < right.y + right.height + gap
        && right.y < left.y + left.height + gap
    }

    /**
     * Lay out an FSM with a layered Sugiyama-style approach: long edges get
     * dummy waypoints (so they do not cut through node columns), back edges are
     * routed around the outside, connected nodes are aligned by median
     * relaxation, and every transition label is placed in a free slot instead
     * of piling up at the middle of the edge.
     * @param {object} fsm - extracted FSM model.
     * @returns {object} diagram with positioned nodes and routed edges.
     */
    function layoutFsm(fsm, options) {
      const labelModes = options === undefined || options === null || options.labelModes === undefined
        ? {}
        : options.labelModes
      const numberMap = options === undefined || options === null || options.numberMap === undefined
        ? {}
        : options.numberMap
      const names = fsm.states.map(state => state.name)
      if (names.length === 0) {
        return { width: 240, height: 120, nodes: [], edges: [], resetNode: null }
      }
      const indexOf = new Map()
      names.forEach((name, position) => indexOf.set(name, position))
      const rawEdges = []
      for (const transition of fsm.transitions) {
        if (!indexOf.has(transition.from) || !indexOf.has(transition.to)) continue
        rawEdges.push({ from: transition.from, to: transition.to, labels: transition.labels })
      }
      const selfEdges = rawEdges.filter(edge => edge.from === edge.to)
      const edges = rawEdges.filter(edge => edge.from !== edge.to)

      // --- entry roots and back edges -------------------------------------
      const outgoing = new Map(names.map(name => [name, []]))
      edges.forEach((edge, edgeIndex) => outgoing.get(edge.from).push(edgeIndex))
      const roots = []
      if (fsm.resetState !== null && indexOf.has(fsm.resetState)) roots.push(fsm.resetState)
      else {
        for (const name of names) {
          if (!edges.some(edge => edge.to === name)) roots.push(name)
        }
      }
      if (roots.length === 0 && names.length > 0) roots.push(names[0])
      const color = new Map()
      const backEdges = new Set()
      const visit = (entry) => {
        const stack = [{ node: entry, next: 0 }]
        color.set(entry, 1)
        while (stack.length > 0) {
          const frame = stack[stack.length - 1]
          const list = outgoing.get(frame.node)
          if (frame.next >= list.length) {
            color.set(frame.node, 2)
            stack.pop()
            continue
          }
          const edgeIndex = list[frame.next]
          frame.next += 1
          const target = edges[edgeIndex].to
          const state = color.get(target) || 0
          if (state === 1) { backEdges.add(edgeIndex); continue }
          if (state === 0) { color.set(target, 1); stack.push({ node: target, next: 0 }) }
        }
      }
      for (const root of roots) if (!color.has(root)) visit(root)
      for (const name of names) if (!color.has(name)) visit(name)

      // --- ranks ----------------------------------------------------------
      const rank = new Map(names.map(name => [name, 0]))
      for (let iteration = 0; iteration < names.length * 2 + 4; iteration += 1) {
        let changed = false
        edges.forEach((edge, edgeIndex) => {
          if (backEdges.has(edgeIndex)) return
          const candidate = rank.get(edge.from) + 1
          if (rank.get(edge.to) < candidate) { rank.set(edge.to, candidate); changed = true }
        })
        if (!changed) break
      }
      let maxRank = 0
      for (const name of names) maxRank = Math.max(maxRank, rank.get(name))

      // --- nodes and dummy waypoints for long forward edges ----------------
      const nodeHeight = 46
      const nodeGap = 66
      const dummyGap = 30
      const verticalGap = 122
      const padding = 30
      const topMargin = 74
      const nodes = new Map()
      const layers = []
      for (let layerIndex = 0; layerIndex <= maxRank; layerIndex += 1) layers.push([])
      names.forEach((name, order) => {
        const state = fsm.states[order]
        const nameText = state === undefined ? name : state.name
        const encoding = state === undefined || state.encoding === undefined ? '' : state.encoding
        const width = Math.max(108, Math.min(260, Math.round(estimateTextWidth(nameText, 13) + 38)))
        let displayName = nameText
        if (estimateTextWidth(nameText, 13) > width - 30) {
          while (displayName.length > 1 && estimateTextWidth(displayName + '…', 13) > width - 30) {
            displayName = displayName.slice(0, -1)
          }
          displayName += '…'
        }
        const node = {
          id: name, kind: 'state', name: nameText, displayName, encoding,
          width, height: nodeHeight, halfWidth: width / 2, rank: rank.get(name),
          order, cx: 0, cy: 0, reset: fsm.resetState === name,
        }
        nodes.set(name, node)
        layers[node.rank].push(node)
      })
      const dummyChains = new Map()
      edges.forEach((edge, edgeIndex) => {
        if (backEdges.has(edgeIndex)) return
        const delta = rank.get(edge.to) - rank.get(edge.from)
        if (delta <= 1 || delta > 4) return
        const chain = []
        for (let layerIndex = rank.get(edge.from) + 1; layerIndex < rank.get(edge.to); layerIndex += 1) {
          const id = '__d' + edgeIndex + '_' + layerIndex
          const dummy = {
            id, kind: 'dummy', name: '', displayName: '', encoding: '',
            width: 2, height: 2, halfWidth: 1, rank: layerIndex, order: layers[layerIndex].length, cx: 0, cy: 0,
          }
          nodes.set(id, dummy)
          layers[layerIndex].push(dummy)
          chain.push(id)
        }
        dummyChains.set(edgeIndex, chain)
      })

      // --- ordering: barycenter sweeps over chain segments -----------------
      const chainSegments = []
      edges.forEach((edge, edgeIndex) => {
        if (backEdges.has(edgeIndex)) return
        if (rank.get(edge.to) - rank.get(edge.from) > 4) return
        const chain = [edge.from].concat(dummyChains.get(edgeIndex) || []).concat([edge.to])
        for (let position = 0; position < chain.length - 1; position += 1) {
          chainSegments.push([chain[position], chain[position + 1]])
        }
      })
      const neighbors = new Map()
      const addNeighbor = (left, right) => {
        if (!neighbors.has(left)) neighbors.set(left, [])
        neighbors.get(left).push(right)
      }
      for (const [left, right] of chainSegments) { addNeighbor(left, right); addNeighbor(right, left) }
      const normalizedPosition = new Map()
      const reindexLayers = () => {
        for (const layer of layers) {
          const last = Math.max(1, layer.length - 1)
          layer.forEach((node, position) => {
            node.order = position
            normalizedPosition.set(node.id, position / last)
          })
        }
      }
      reindexLayers()
      for (let pass = 0; pass < 8; pass += 1) {
        const indices = []
        for (let layerIndex = 0; layerIndex <= maxRank; layerIndex += 1) indices.push(layerIndex)
        if (pass % 2 === 1) indices.reverse()
        for (const layerIndex of indices) {
          const layer = layers[layerIndex]
          if (layer.length < 2) continue
          const scored = layer.map(node => {
            const refs = (neighbors.get(node.id) || [])
              .map(id => normalizedPosition.get(id))
              .filter(value => value !== undefined)
            return {
              node,
              score: refs.length === 0 ? normalizedPosition.get(node.id) : median(refs),
            }
          })
          scored.sort((left, right) => left.score - right.score || left.node.order - right.node.order)
          layers[layerIndex] = scored.map(entry => entry.node)
          reindexLayers()
        }
      }

      // --- x coordinates: median alignment with per-layer separation -------
      const gapBetween = (left, right) => (left.kind === 'dummy' || right.kind === 'dummy' ? dummyGap : nodeGap)
        + left.halfWidth + right.halfWidth
      for (const layer of layers) {
        let cursor = 0
        layer.forEach((node, position) => {
          if (position === 0) node.cx = node.halfWidth
          else node.cx = cursor + node.halfWidth
          cursor = node.cx + node.halfWidth
        })
      }
      for (let iteration = 0; iteration < 20; iteration += 1) {
        const indices = []
        for (let layerIndex = 0; layerIndex <= maxRank; layerIndex += 1) indices.push(layerIndex)
        if (iteration % 2 === 1) indices.reverse()
        for (const layerIndex of indices) {
          const layer = layers[layerIndex]
          if (layer.length === 0) continue
          const targets = layer.map(node => {
            const refs = (neighbors.get(node.id) || [])
              .map(id => nodes.get(id))
              .filter(other => other !== undefined)
              .map(other => other.cx)
            return refs.length === 0 ? node.cx : median(refs)
          })
          for (let position = 0; position < layer.length; position += 1) {
            const node = layer[position]
            const minimum = position === 0 ? -Infinity : layer[position - 1].cx + gapBetween(layer[position - 1], node)
            node.cx = Math.max(targets[position], minimum)
          }
          for (let position = layer.length - 1; position >= 0; position -= 1) {
            const node = layer[position]
            const maximum = position === layer.length - 1
              ? Infinity
              : layer[position + 1].cx - gapBetween(node, layer[position + 1])
            node.cx = Math.min(node.cx, maximum)
          }
        }
      }
      for (const node of nodes.values()) {
        node.cy = topMargin + node.rank * (nodeHeight + verticalGap) + nodeHeight / 2
      }
      for (const node of nodes.values()) {
        if (node.kind === 'state') {
          node.x = node.cx - node.width / 2
          node.y = node.cy - node.height / 2
        }
      }

      // --- edge geometry --------------------------------------------------
      const realNodes = names.map(name => nodes.get(name))
      const minNodeLeft = Math.min(...realNodes.map(node => node.x))
      const maxNodeRight = Math.max(...realNodes.map(node => node.x + node.width))
      const graphCenter = (minNodeLeft + maxNodeRight) / 2
      const nodeRects = realNodes.map(node => ({ x: node.x, y: node.y, width: node.width, height: node.height }))
      const labelRects = []
      const annotated = []
      const GRID = 140
      const occupancy = new Map()
      const cellsFor = (rect) => {
        const keys = []
        const left = Math.floor(rect.x / GRID)
        const right = Math.floor((rect.x + rect.width) / GRID)
        const top = Math.floor(rect.y / GRID)
        const bottom = Math.floor((rect.y + rect.height) / GRID)
        for (let column = left; column <= right; column += 1) {
          for (let row = top; row <= bottom; row += 1) keys.push(column + ':' + row)
        }
        return keys
      }
      const insertOccupied = (rect) => {
        for (const key of cellsFor(rect)) {
          if (!occupancy.has(key)) occupancy.set(key, [])
          occupancy.get(key).push(rect)
        }
      }
      const collisionCount = (rect) => {
        let count = 0
        const seen = new Set()
        for (const key of cellsFor(rect)) {
          const bucket = occupancy.get(key)
          if (bucket === undefined) continue
          for (const other of bucket) {
            if (seen.has(other)) continue
            seen.add(other)
            if (rectanglesOverlap(rect, other, 5)) count += 1
          }
        }
        return count
      }
      for (const rect of nodeRects) insertOccupied({ x: rect.x - 6, y: rect.y - 6, width: rect.width + 12, height: rect.height + 12 })
      let backSequence = 0

      const numberedEdge = (edge) => labelModes[transitionKey(edge.from, edge.to)] === 'number'
      const labelBox = (edge) => {
        const text = edge.labels.length === 0 ? '' : edge.labels.join(' / ')
        if (text === '') return null
        if (numberedEdge(edge)) {
          const display = edge.labels
            .map(label => (numberMap[label] === undefined ? label : String(numberMap[label])))
            .join(' / ')
          return { text, lines: [display], width: estimateTextWidth(display, 11) + 12, height: 20, numbered: true }
        }
        const lines = capLabelLines(wrapLabel(text, 26), 5)
        const width = Math.max(...lines.map(line => estimateTextWidth(line, 11))) + 12
        return { text, lines, width, height: lines.length * 14 + 6 }
      }
      const perpendicular = (from, to) => {
        const dx = to.x - from.x
        const dy = to.y - from.y
        const length = Math.hypot(dx, dy) || 1
        return { x: -dy / length, y: dx / length }
      }
      const candidatesAlong = (points, box, onLine) => {
        const candidates = []
        if (box === null) return candidates
        // A numbered label sits directly on the edge (the chip masks the line
        // behind it); text labels are pushed beside the edge.
        const fractions = onLine ? [0.5, 0.4, 0.6, 0.3, 0.7] : [0.5, 0.36, 0.64, 0.24, 0.76]
        const offsets = onLine ? [0, 13, -13] : [18, -18, 34, -34, 52, -52]
        if (points.length === 2) {
          const normal = perpendicular(points[0], points[1])
          const basePoints = fractions.map((fraction) => ({
            x: points[0].x + (points[1].x - points[0].x) * fraction,
            y: points[0].y + (points[1].y - points[0].y) * fraction,
          }))
          // Embedded numbers go on the line first; side offsets are only a fallback.
          for (const base of basePoints) candidates.push(base)
          for (const offset of offsets) {
            if (offset === 0) continue
            for (const base of basePoints) {
              candidates.push({ x: base.x + normal.x * offset, y: base.y + normal.y * offset })
            }
          }
          return candidates
        }
        const basePoints = []
        for (let position = 0; position < points.length - 1; position += 1) {
          const from = points[position]
          const to = points[position + 1]
          for (const fraction of [0.5, 0.28, 0.72]) {
            basePoints.push({
              x: from.x + (to.x - from.x) * fraction,
              y: from.y + (to.y - from.y) * fraction,
              normal: perpendicular(from, to),
            })
          }
        }
        if (onLine) for (const base of basePoints) candidates.push({ x: base.x, y: base.y })
        for (const offset of offsets) {
          if (offset === 0) continue
          for (const base of basePoints) {
            candidates.push({ x: base.x + base.normal.x * offset, y: base.y + base.normal.y * offset })
          }
        }
        return candidates
      }
      const placeLabel = (candidates, box) => {
        if (box === null || candidates.length === 0) return null
        let best = candidates[0]
        let bestOverlap = Infinity
        for (const candidate of candidates) {
          const rect = { x: candidate.x - box.width / 2, y: candidate.y - box.height / 2, width: box.width, height: box.height }
          const overlap = collisionCount(rect)
          if (overlap === 0) return { candidate, rect }
          if (overlap < bestOverlap) { bestOverlap = overlap; best = candidate }
        }
        return {
          candidate: best,
          rect: { x: best.x - box.width / 2, y: best.y - box.height / 2, width: box.width, height: box.height },
        }
      }

      // Self loops draw above their state.
      for (const edge of selfEdges) {
        const node = nodes.get(edge.from)
        const start = { x: node.cx - node.width * 0.24, y: node.y }
        const end = { x: node.cx + node.width * 0.24, y: node.y }
        const apex = { x: node.cx, y: node.y - 52 }
        const arcMid = {
          x: 0.25 * start.x + 0.5 * apex.x + 0.25 * end.x,
          y: 0.25 * start.y + 0.5 * apex.y + 0.25 * end.y,
        }
        const box = labelBox(edge)
        const candidates = []
        if (box !== null) {
          if (box.numbered) candidates.push(arcMid)
          for (const offset of [34, 50, 68]) candidates.push({ x: node.cx, y: node.y - 52 - offset - box.height / 2 + 12 })
        }
        const placed = placeLabel(candidates, box)
        if (placed !== null) { labelRects.push(placed.rect); insertOccupied(placed.rect) }
        annotated.push({
          edge, kind: 'self', points: [start, apex, end],
          arrowDirection: { x: end.x - apex.x, y: end.y - apex.y },
          box, labelCenter: placed === null ? null : placed.candidate,
        })
      }

      // Forward edges (with dummy waypoints) and back edges.
      edges.forEach((edge, edgeIndex) => {
        const source = nodes.get(edge.from)
        const target = nodes.get(edge.to)
        const box = labelBox(edge)
        const rankDelta = rank.get(edge.to) - rank.get(edge.from)
        if (!backEdges.has(edgeIndex) && rankDelta > 4) {
          // Long forward edges are routed through a side channel instead of
          // hundreds of waypoints, so dense state machines stay fast to lay out.
          const sideRight = (source.cx + target.cx) / 2 >= graphCenter
          backSequence += 1
          const sideX = sideRight
            ? maxNodeRight + 40 + backSequence * 15
            : minNodeLeft - 40 - backSequence * 15
          const start = { x: sideRight ? source.x + source.width : source.x, y: source.cy }
          const end = { x: sideRight ? target.x + target.width : target.x, y: target.cy }
          const points = [start, { x: sideX, y: source.cy }, { x: sideX, y: target.cy }, end]
          const candidates = []
          if (box !== null) {
            for (const fraction of [0.5, 0.32, 0.68, 0.2, 0.8]) {
              const y = source.cy + (target.cy - source.cy) * fraction
              if (box.numbered) candidates.push({ x: sideX, y })
              for (const outward of [18, 36, 56]) {
                candidates.push({ x: sideX + (sideRight ? box.width / 2 + outward : -box.width / 2 - outward), y })
              }
            }
          }
          const placed = placeLabel(candidates, box)
          if (placed !== null) { labelRects.push(placed.rect); insertOccupied(placed.rect) }
          annotated.push({
            edge, kind: 'long', points,
            arrowDirection: { x: end.x - points[points.length - 2].x, y: 0 },
            box, labelCenter: placed === null ? null : placed.candidate,
          })
          return
        }
        if (backEdges.has(edgeIndex)) {
          const sideRight = (source.cx + target.cx) / 2 >= graphCenter
          backSequence += 1
          const sideX = sideRight
            ? maxNodeRight + 44 + backSequence * 16
            : minNodeLeft - 44 - backSequence * 16
          const start = { x: sideRight ? source.x + source.width : source.x, y: source.cy }
          const end = { x: sideRight ? target.x + target.width : target.x, y: target.cy }
          const points = [start, { x: sideX, y: source.cy }, { x: sideX, y: target.cy }, end]
          const candidates = []
          if (box !== null && Math.abs(target.cy - source.cy) > 30) {
            for (const fraction of [0.5, 0.34, 0.66, 0.22, 0.78]) {
              const y = source.cy + (target.cy - source.cy) * fraction
              if (box.numbered) candidates.push({ x: sideX, y })
              for (const outward of [20, 38, 58]) {
                candidates.push({ x: sideX + (sideRight ? box.width / 2 + outward : -box.width / 2 - outward), y })
              }
            }
          }
          const placed = placeLabel(candidates, box)
          if (placed !== null) { labelRects.push(placed.rect); insertOccupied(placed.rect) }
          annotated.push({
            edge, kind: 'back', points,
            arrowDirection: { x: end.x - points[points.length - 2].x, y: 0 },
            box, labelCenter: placed === null ? null : placed.candidate,
          })
          return
        }
        const chain = [edge.from].concat(dummyChains.get(edgeIndex) || []).concat([edge.to])
        const route = chain.map(id => ({ x: nodes.get(id).cx, y: nodes.get(id).cy }))
        const start = boxAnchor(source, route[1])
        const end = boxAnchor(target, route[route.length - 2])
        const points = [start].concat(route.slice(1, -1)).concat([end])
        const candidates = candidatesAlong(points, box, box !== null && box.numbered)
        const placed = placeLabel(candidates, box)
        if (placed !== null) { labelRects.push(placed.rect); insertOccupied(placed.rect) }
        annotated.push({
          edge, kind: 'forward', points,
          arrowDirection: {
            x: end.x - points[points.length - 2].x,
            y: end.y - points[points.length - 2].y,
          },
          box, labelCenter: placed === null ? null : placed.candidate,
        })
      })

      // --- edge colours: incident edges get different palette slots ---------
      annotated.forEach((item, index) => {
        const used = new Set()
        for (let otherIndex = 0; otherIndex < index; otherIndex += 1) {
          const other = annotated[otherIndex]
          const shares = other.edge.from === item.edge.from
            || other.edge.from === item.edge.to
            || other.edge.to === item.edge.from
            || other.edge.to === item.edge.to
          if (shares) used.add(other.colorIndex)
        }
        let colorIndex = 0
        while (colorIndex < EDGE_PALETTE_SIZE && used.has(colorIndex)) colorIndex += 1
        item.colorIndex = colorIndex >= EDGE_PALETTE_SIZE ? 0 : colorIndex
      })

      // --- bounds, shift and path strings ---------------------------------
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity
      for (const node of realNodes) {
        minX = Math.min(minX, node.x)
        maxX = Math.max(maxX, node.x + node.width)
        minY = Math.min(minY, node.y - 44)
        maxY = Math.max(maxY, node.y + node.height)
      }
      for (const item of annotated) {
        for (const point of item.points) {
          minX = Math.min(minX, point.x)
          maxX = Math.max(maxX, point.x)
          minY = Math.min(minY, point.y)
          maxY = Math.max(maxY, point.y)
        }
        if (item.labelCenter !== null) {
          minX = Math.min(minX, item.labelCenter.x - item.box.width / 2)
          maxX = Math.max(maxX, item.labelCenter.x + item.box.width / 2)
          minY = Math.min(minY, item.labelCenter.y - item.box.height / 2)
          maxY = Math.max(maxY, item.labelCenter.y + item.box.height / 2)
        }
      }
      const shiftX = padding - minX
      const shiftY = padding - minY
      for (const node of realNodes) {
        node.x += shiftX
        node.y += shiftY
        node.cx += shiftX
        node.cy += shiftY
      }
      const outputNodes = realNodes.map(node => ({
        name: node.name,
        displayName: node.displayName,
        encoding: node.encoding,
        width: node.width,
        height: node.height,
        x: node.x,
        y: node.y,
        rank: node.rank,
        reset: fsm.resetState === node.name,
      }))
      const outputEdges = annotated.map(item => {
        const points = item.points.map(point => ({ x: point.x + shiftX, y: point.y + shiftY }))
        let path
        if (item.kind === 'forward') path = smoothPolylinePath(points)
        else if (item.kind === 'back' || item.kind === 'long') path = roundedPolylinePath(points, 22)
        else path = 'M' + points[0].x.toFixed(1) + ',' + points[0].y.toFixed(1)
          + ' Q' + points[1].x.toFixed(1) + ',' + points[1].y.toFixed(1)
          + ' ' + points[2].x.toFixed(1) + ',' + points[2].y.toFixed(1)
        const tip = points[points.length - 1]
        return {
          from: item.edge.from,
          to: item.edge.to,
          self: item.kind === 'self',
          colorIndex: item.colorIndex,
          labels: item.edge.labels,
          path,
          arrow: arrowHead(tip, item.arrowDirection.x, item.arrowDirection.y),
          label: item.box === null ? '' : item.box.text,
          labelX: item.labelCenter === null ? tip.x : item.labelCenter.x + shiftX,
          labelY: item.labelCenter === null ? tip.y : item.labelCenter.y + shiftY,
          title: item.edge.from + ' → ' + item.edge.to
            + (item.box === null || item.box.text === '' ? '' : ' · ' + item.box.text),
        }
      })
      const resetNode = fsm.resetState !== null && nodes.has(fsm.resetState) ? nodes.get(fsm.resetState) : null
      return {
        width: Math.round(maxX - minX + padding * 2),
        height: Math.round(maxY - minY + padding * 2),
        nodes: outputNodes,
        edges: outputEdges,
        resetNode: resetNode === null ? null : nodes.get(fsm.resetState),
      }
    }

    /** Resolve the theme tokens used by the diagram into literal colors. */
    function readThemeColors() {
      const fallback = {
        surface: '#ffffff', node: '#f7f8fa', border: '#d0d5dd', borderSoft: '#e4e7ec',
        text: '#101828', muted: '#667085', accent: '#2563eb', labelBg: '#ffffff',
      }
      if (typeof document === 'undefined' || document.documentElement === null) return fallback
      // ThemePresenter writes the token variables as inline custom properties on
      // <body>; <html> carries none of them in the shipped themes.
      const themedRoot = document.body === null || document.body === undefined ? null : document.body
      const styles = themedRoot === null
        ? window.getComputedStyle(document.documentElement)
        : window.getComputedStyle(themedRoot)
      const read = (name, alternative) => {
        const value = styles.getPropertyValue(name).trim()
        return value === '' ? alternative : value
      }
      return {
        surface: read('--dsw-alias-bg-base', fallback.surface),
        node: read('--dsw-alias-bg-layer-2', fallback.node),
        border: read('--dsw-alias-border-l2', fallback.border),
        borderSoft: read('--dsw-alias-border-l1', fallback.borderSoft),
        text: read('--dsw-alias-label-primary', fallback.text),
        muted: read('--dsw-alias-label-secondary', fallback.muted),
        accent: read('--dsw-alias-brand-primary', fallback.accent),
        labelBg: read('--dsw-alias-bg-layer-1', fallback.labelBg),
      }
    }

    /** Escape text for direct inclusion in SVG markup. */
    function escapeXml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
    }

    /** Height a numbered legend adds below a diagram of the given width. */
    function legendHeightFor(width, legendItems) {
      if (!Array.isArray(legendItems) || legendItems.length === 0) return 0
      const maxChars = Math.max(24, Math.floor((width - 90) / 6.2))
      let lines = 0
      for (const item of legendItems) lines += wrapLabel(item.label, maxChars).length
      return 52 + lines * 15
    }

    /**
     * Render a positioned diagram as a standalone SVG document string. The
     * document carries its own resolved palette so a download keeps working
     * outside the Harness theme. In numbered mode each distinct transition
     * condition gets a number on its edge, and the key is drawn inside the
     * same SVG so a downloaded file stays readable.
     * @param {object} diagram - output of {@link layoutFsm}.
     * @param {object} options - palette, selected state, numbering and legend.
     * @returns {string} SVG markup.
     */
    function svgDocument(diagram, options) {
      const colors = options.colors
      const labels = options.labels === undefined || options.labels === null ? {} : options.labels
      const resetTag = labels.reset === undefined ? '' : labels.reset
      const ariaLabel = labels.diagram === undefined ? 'State machine diagram' : labels.diagram
      const legendTitle = labels.legend === undefined ? 'Conditions' : labels.legend
      const selected = options.selected === undefined || options.selected === null ? '' : options.selected
      const numbered = options.numbered === true
      const numberMap = options.numberMap === undefined || options.numberMap === null ? {} : options.numberMap
      const edgeModes = options.edgeModes === undefined || options.edgeModes === null ? null : options.edgeModes
      const palette = Array.isArray(options.palette) && options.palette.length > 0
        ? options.palette
        : DEFAULT_EDGE_PALETTE
      const legendItems = Array.isArray(options.legend) ? options.legend : []

      const labelForEdge = (values) => values
        .map((value) => (numberMap[value] === undefined ? value : String(numberMap[value])))
        .join(' / ')
      const modeForEdge = (edge) => {
        if (edgeModes !== null) {
          const override = edgeModes[transitionKey(edge.from, edge.to)]
          if (override !== undefined) return override
        }
        return numbered ? 'number' : 'text'
      }

      const legendVisible = legendItems.length > 0
        && (numbered || (edgeModes !== null && Object.keys(edgeModes).some(key => edgeModes[key] === 'number')))
      const legendMaxChars = Math.max(24, Math.floor((diagram.width - 90) / 6.2))
      const legendRows = []
      let legendLines = 0
      if (legendVisible) {
        for (const item of legendItems) {
          const lines = wrapLabel(item.label, legendMaxChars)
          legendRows.push({ number: item.number, lines })
          legendLines += lines.length
        }
      }
      const legendHeight = legendVisible ? 52 + legendLines * 15 : 0
      const rootHeight = diagram.height + legendHeight

      const selectedRelated = (from, to) => selected !== '' && (from === selected || to === selected)
      const lineParts = []
      lineParts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + diagram.width + '" height="' + rootHeight
        + '" viewBox="0 0 ' + diagram.width + ' ' + rootHeight + '" class="vfsm-svg" role="img" aria-label="'
        + escapeXml(ariaLabel) + '">')
      lineParts.push('<style>'
        + '.vfsm-svg{font-family:ui-sans-serif,system-ui,-apple-system,Roboto,Arial,sans-serif}'
        + '.vfsm-svg .vfsm-node-rect{fill:' + colors.node + ';stroke:' + colors.border + ';stroke-width:1.2}'
        + '.vfsm-svg .vfsm-node.is-reset .vfsm-node-rect{stroke:' + colors.accent + ';stroke-width:2}'
        + '.vfsm-svg .vfsm-node.is-selected .vfsm-node-rect{stroke:' + colors.accent + ';stroke-width:2.6}'
        + '.vfsm-svg .vfsm-node-name{fill:' + colors.text + ';font-size:13px;font-weight:600}'
        + '.vfsm-svg .vfsm-node-enc{fill:' + colors.muted + ';font-size:10px}'
        + '.vfsm-svg .vfsm-edge-line{fill:none;stroke:' + colors.muted + ';stroke-width:1.3;stroke-linecap:round}'
        + '.vfsm-svg .vfsm-edge{cursor:pointer}'
        + '.vfsm-svg .vfsm-edge:hover .vfsm-edge-line{stroke:' + colors.accent + ';stroke-width:2}'
        + '.vfsm-svg .vfsm-edge:hover .vfsm-arrow{fill:' + colors.accent + '}'
        + '.vfsm-svg .vfsm-edge.is-related .vfsm-edge-line{stroke:' + colors.accent + ';stroke-width:2}'
        + '.vfsm-svg .vfsm-arrow{fill:' + colors.muted + '}'
        + '.vfsm-svg .vfsm-edge.is-related .vfsm-arrow{fill:' + colors.accent + '}'
        + '.vfsm-svg .vfsm-label-rect{fill:' + colors.labelBg + ';stroke:' + colors.borderSoft + ';stroke-width:0.8}'
        + '.vfsm-svg .vfsm-label-rect.is-number{fill:' + colors.surface + ';stroke:none}'
        + '.vfsm-svg .vfsm-label-text{fill:' + colors.muted + ';font-size:11px}'
        + '.vfsm-svg .vfsm-start-dot{fill:' + colors.accent + '}'
        + '.vfsm-svg .vfsm-start-line{stroke:' + colors.accent + ';stroke-width:1.6;fill:none}'
        + '.vfsm-svg .vfsm-start-arrow{fill:' + colors.accent + '}'
        + '.vfsm-svg .vfsm-legend-rule{stroke:' + colors.borderSoft + ';stroke-width:1}'
        + '.vfsm-svg .vfsm-legend-title{fill:' + colors.text + ';font-size:12px;font-weight:600}'
        + '.vfsm-svg .vfsm-legend-number{fill:' + colors.accent + ';font-size:11px;font-weight:600}'
        + '.vfsm-svg .vfsm-legend-text{fill:' + colors.muted + ';font-size:11px}'
        + '</style>')
      lineParts.push('<rect x="0" y="0" width="' + diagram.width + '" height="' + rootHeight
        + '" fill="' + colors.surface + '"/>')
      if (diagram.resetNode !== null) {
        const node = diagram.resetNode
        const cx = node.x + node.width / 2
        const dotY = node.y - 34
        lineParts.push('<circle class="vfsm-start-dot" cx="' + cx.toFixed(1) + '" cy="' + dotY.toFixed(1) + '" r="4.5"/>')
        lineParts.push('<path class="vfsm-start-line" d="M' + cx.toFixed(1) + ',' + (dotY + 4).toFixed(1)
          + ' L' + cx.toFixed(1) + ',' + (node.y - 7).toFixed(1) + '"/>')
        lineParts.push('<path class="vfsm-start-arrow" d="' + arrowHead({ x: cx, y: node.y - 3 }, 0, 1) + '"/>')
      }
      lineParts.push('<g class="vfsm-edges">')
      diagram.edges.forEach((edge, edgeIndex) => {
        const related = selectedRelated(edge.from, edge.to)
        const mode = modeForEdge(edge)
        const edgeColor = palette[(edge.colorIndex === undefined ? edgeIndex : edge.colorIndex) % palette.length]
        const displayText = edge.labels.length === 0
          ? ''
          : (mode === 'number' ? labelForEdge(edge.labels) : edge.labels.join(' / '))
        const displayLines = displayText === '' ? [] : capLabelLines(wrapLabel(displayText, mode === 'number' ? 12 : 26), 5)
        lineParts.push('<g class="vfsm-edge' + (related ? ' is-related' : '')
          + '" data-edge="' + edgeIndex + '">')
        lineParts.push('<path class="vfsm-edge-line" style="stroke:' + edgeColor + '" d="' + edge.path + '"/>')
        lineParts.push('<path class="vfsm-arrow" style="fill:' + edgeColor + '" d="' + edge.arrow
          + '"><title>' + escapeXml(edge.title) + '</title></path>')
        if (displayLines.length > 0) {
          const textWidth = Math.max(...displayLines.map(line => estimateTextWidth(line, 11)))
          const boxWidth = textWidth + 12
          const boxHeight = displayLines.length * 14 + 6
          const boxX = edge.labelX - boxWidth / 2
          const boxY = edge.labelY - boxHeight / 2
          lineParts.push('<rect class="vfsm-label-rect' + (mode === 'number' ? ' is-number' : '')
            + '" x="' + boxX.toFixed(1) + '" y="' + boxY.toFixed(1)
            + '" width="' + boxWidth.toFixed(1) + '" height="' + boxHeight.toFixed(1) + '" rx="5"/>')
          const startY = boxY + 12
          displayLines.forEach((line, lineIndex) => {
            lineParts.push('<text class="vfsm-label-text" style="fill:' + edgeColor + '" x="'
              + edge.labelX.toFixed(1) + '" y="' + (startY + lineIndex * 14).toFixed(1)
              + '" text-anchor="middle">' + escapeXml(line) + '</text>')
          })
        }
        lineParts.push('</g>')
      })
      lineParts.push('</g>')
      lineParts.push('<g class="vfsm-nodes">')
      for (const node of diagram.nodes) {
        const classes = 'vfsm-node' + (node.reset ? ' is-reset' : '') + (node.name === selected ? ' is-selected' : '')
        lineParts.push('<g class="' + classes + '" data-state="' + escapeXml(node.name) + '">')
        lineParts.push('<rect class="vfsm-node-rect" x="' + node.x.toFixed(1) + '" y="' + node.y.toFixed(1)
          + '" width="' + node.width.toFixed(1) + '" height="' + node.height.toFixed(1) + '" rx="10"/>')
        const cx = node.x + node.width / 2
        const cy = node.y + node.height / 2
        if (node.encoding !== '') {
          lineParts.push('<text class="vfsm-node-name" x="' + cx.toFixed(1) + '" y="' + (cy - 2).toFixed(1)
            + '" text-anchor="middle">' + escapeXml(node.displayName) + '</text>')
          lineParts.push('<text class="vfsm-node-enc" x="' + cx.toFixed(1) + '" y="' + (cy + 13).toFixed(1)
            + '" text-anchor="middle">' + escapeXml(node.encoding) + '</text>')
        } else {
          lineParts.push('<text class="vfsm-node-name" x="' + cx.toFixed(1) + '" y="' + (cy + 5).toFixed(1)
            + '" text-anchor="middle">' + escapeXml(node.displayName) + '</text>')
        }
        lineParts.push('<title>' + escapeXml(node.name + (node.reset && resetTag !== '' ? ' · ' + resetTag : '')) + '</title>')
        lineParts.push('</g>')
      }
      lineParts.push('</g>')
      if (legendVisible) {
        lineParts.push('<g class="vfsm-legend" transform="translate(0,' + diagram.height + ')">')
        lineParts.push('<line class="vfsm-legend-rule" x1="18" y1="0.5" x2="' + (diagram.width - 18) + '" y2="0.5"/>')
        lineParts.push('<text class="vfsm-legend-title" x="22" y="22">' + escapeXml(legendTitle) + '</text>')
        let y = 42
        for (const row of legendRows) {
          lineParts.push('<text class="vfsm-legend-number" x="26" y="' + y + '">' + row.number + '.</text>')
          row.lines.forEach((legendLine, lineIndex) => {
            lineParts.push('<text class="vfsm-legend-text" x="46" y="' + (y + lineIndex * 15) + '">'
              + escapeXml(legendLine) + '</text>')
          })
          y += row.lines.length * 15
        }
        lineParts.push('</g>')
      }
      lineParts.push('</svg>')
      return lineParts.join('')
    }

    // =====================================================================
    // Locale dictionaries
    // =====================================================================

    const EN = {
      panel: 'FSM diagram',
      title: 'Verilog state machine diagram',
      subtitle: 'Extract case-based FSMs from Verilog and render an interactive state-transition diagram.',
      modeCode: 'Verilog code',
      modeTable: 'Transition table',
      openFile: 'Open file',
      sample: 'Load sample',
      source: 'Verilog source',
      untitled: 'Untitled',
      hint: 'Three-segment and two-segment case FSMs are supported; the diagram updates as you type.',
      clear: 'Clear',
      diagram: 'Diagram',
      emptyTitle: 'No state machine found',
      emptyBody: 'Paste a module whose FSM is driven by a case statement over a state register, or open a file.',
      supportThree: 'Three-segment: clocked state register + combinational case (state) assigning next_state.',
      supportTwo: 'Two-segment: clocked case (state) assigning state directly.',
      supportMulti: 'Multiple modules and several FSMs per file are supported.',
      supportLimit: 'If/else-chain FSMs without a case statement are not parsed yet.',
      trySample: 'Load the sample',
      states: 'states',
      transitions: 'transitions',
      stState: 'State',
      stTransitions: 'Transitions',
      resetTag: 'reset',
      module: 'Module',
      stateVar: 'State register',
      clock: 'Clock',
      reset: 'Reset',
      encoding: 'Encoding',
      threeSeg: 'Three-segment',
      twoSeg: 'Two-segment',
      fit: 'Fit',
      zoomIn: 'Zoom in',
      zoomOut: 'Zoom out',
      download: 'Download SVG',
      table: 'State table',
      hideTable: 'Hide table',
      selectHint: 'Click a state to highlight its transitions; click an edge to switch its label between text and numbers.',
      warning: 'Warning',
      noCode: 'Paste Verilog code to see its state machine.',
      hintNoCase: 'Module {module} has state register {state}, but no case-based FSM was found (only case style is supported).',
      warnRenamed: 'Generated Verilog renamed "{from}" to "{to}" to avoid a name conflict.',
      warnStateCollision: 'State "{from}" was emitted as "{to}" after a name collision.',
      warnConditionFunction: 'Condition calls function "{name}"; the generated module cannot declare it, so the call is replaced by a 1-bit input named after the function.',
      warnConditionKeyword: 'Condition uses the Verilog keyword "{name}"; the generated expression may not compile.',
      fileReadFailed: 'Could not read the selected file.',
      warnNestedCase: 'Nested state case is not expanded (line {line}).',
      warnUnresolvedTarget: 'Line {line}: transition target is not a state: {expr}.',
      warnLoop: 'Line {line}: a state assignment inside a loop is treated as a single pass.',
      warnLabel: 'Unrecognized state label: {label}.',
      warnModuleError: 'Module {module} could not be parsed: {message}.',
      warnNoCase: 'Module {module} has state register {state}, but no case-based FSM was found (only case style is supported).',
      tableTitle: 'Transition table',
      tableHint: 'One row per transition; an empty condition is the unconditional fallback. Signals used in conditions become 1-bit inputs.',
      moduleName: 'Module name',
      stateReg: 'State register',
      clockName: 'Clock',
      resetName: 'Reset (active low)',
      colFrom: 'From',
      colCond: 'Condition',
      colTo: 'To',
      colDelete: 'Delete',
      addTransition: 'Add transition',
      importText: 'Import text',
      importHint: 'One transition per line: FROM -> TO : condition, or FROM,CONDITION,TO (also tab separated).',
      importAction: 'Import',
      importCancel: 'Cancel',
      importEmpty: 'No transitions found in the pasted text.',
      showVerilog: 'Show Verilog',
      hideVerilog: 'Hide Verilog',
      copyVerilog: 'Copy Verilog',
      copied: 'Copied',
      openInCode: 'Open in code mode',
      tableEmpty: 'Add at least one transition to generate Verilog.',
      labelNumber: 'Condition numbers',
      fullscreen: 'Fullscreen',
      exitFullscreen: 'Exit fullscreen',
      legendTitle: 'Conditions',
      viewAll: 'All diagrams',
      fsmView: 'Open',
      fsmCount: '{count} FSMs',
    }

    const ZH = {
      panel: '状态机图',
      title: 'Verilog 状态机图',
      subtitle: '从 Verilog 代码中提取基于 case 的状态机，并绘制可交互的状态跳转图。',
      modeCode: 'Verilog 代码',
      modeTable: '跳转表',
      openFile: '打开文件',
      sample: '载入示例',
      source: 'Verilog 源码',
      untitled: '未命名',
      hint: '支持三段式 / 二段式 case 状态机；编辑时自动更新图像。',
      clear: '清空',
      diagram: '状态机图',
      emptyTitle: '未找到状态机',
      emptyBody: '请粘贴一个用 case 语句描述状态跳转的模块，或打开一个 Verilog 文件。',
      supportThree: '三段式：时序 always 寄存状态 + 组合 case (state) 计算 next_state。',
      supportTwo: '二段式：时序 always 内 case (state) 直接给 state 赋值。',
      supportMulti: '支持同一文件中的多个 module 和多个状态机。',
      supportLimit: '暂不支持只靠 if-else 链描述跳转、没有 case 语句的状态机。',
      trySample: '载入示例',
      states: '个状态',
      transitions: '条跳转',
      stState: '状态',
      stTransitions: '跳转',
      resetTag: '复位',
      module: '模块',
      stateVar: '状态寄存器',
      clock: '时钟',
      reset: '复位',
      encoding: '编码',
      threeSeg: '三段式',
      twoSeg: '二段式',
      fit: '适应窗口',
      zoomIn: '放大',
      zoomOut: '缩小',
      download: '下载 SVG',
      table: '状态表',
      hideTable: '收起状态表',
      selectHint: '点击状态节点可高亮相关跳转；点击连线可切换该线的编号/文字标签。',
      warning: '警告',
      noCode: '粘贴 Verilog 代码后即可看到状态机图。',
      hintNoCase: '模块 {module} 检测到状态寄存器 {state}，但没有找到 case 状态机（当前仅支持 case 写法）。',
      warnRenamed: '生成的 Verilog 将 "{from}" 重命名为 "{to}" 以避免命名冲突。',
      warnStateCollision: '状态 "{from}" 因命名冲突生成为 "{to}"。',
      warnConditionFunction: '条件里调用了函数 "{name}"；生成的模块无法声明该函数，已改用同名 1-bit 输入端口代替。',
      warnConditionKeyword: '条件里使用了 Verilog 关键字 "{name}"，生成的表达式可能无法编译。',
      fileReadFailed: '无法读取所选文件。',
      warnNestedCase: '嵌套在状态分支里的状态 case 未展开（第 {line} 行）。',
      warnUnresolvedTarget: '第 {line} 行跳转目标无法解析为状态：{expr}。',
      warnLoop: '第 {line} 行循环里的状态赋值按单次执行处理。',
      warnLabel: '无法识别的状态标签：{label}。',
      warnModuleError: '解析模块 {module} 时出错：{message}。',
      warnNoCase: '模块 {module} 检测到状态寄存器 {state}，但没有找到 case 状态机（当前仅支持 case 写法）。',
      tableTitle: '状态跳转表',
      tableHint: '每行一条跳转；条件留空表示无条件跳转（按最后一行生效）。条件中出现的信号会自动声明为 1-bit 输入端口。',
      moduleName: '模块名',
      stateReg: '状态寄存器',
      clockName: '时钟',
      resetName: '复位（低有效）',
      colFrom: '当前状态',
      colCond: '条件',
      colTo: '下一状态',
      colDelete: '删除',
      addTransition: '添加跳转',
      importText: '导入文本',
      importHint: '每行一条：FROM -> TO : 条件，或 FROM,条件,TO（也支持 Tab 分隔）。',
      importAction: '导入',
      importCancel: '取消',
      importEmpty: '粘贴的文本里没有解析到跳转。',
      showVerilog: '显示 Verilog',
      hideVerilog: '收起 Verilog',
      copyVerilog: '复制 Verilog',
      copied: '已复制',
      openInCode: '在代码模式打开',
      tableEmpty: '至少添加一条跳转才能生成 Verilog。',
      labelNumber: '条件编号',
      fullscreen: '全屏',
      exitFullscreen: '退出全屏',
      legendTitle: '跳转条件',
      viewAll: '全部图',
      fsmView: '查看',
      fsmCount: '{count} 个状态机',
    }

    // =====================================================================
    // Sample code and page styles
    // =====================================================================

    const SAMPLE_CODE = [
      '// Three-segment FSM example: paste your own module to replace it.',
      'module fsm_demo (',
      '  input  wire       clk,',
      '  input  wire       rst_n,',
      '  input  wire       start,',
      '  input  wire       done,',
      '  output reg  [1:0] state_out',
      ');',
      '',
      '  localparam [1:0] IDLE  = 2\'b00;',
      '  localparam [1:0] START = 2\'b01;',
      '  localparam [1:0] RUN   = 2\'b10;',
      '  localparam [1:0] STOP  = 2\'b11;',
      '',
      '  reg [1:0] state_current;',
      '  reg [1:0] state_next;',
      '',
      '  // State register: asynchronous reset, synchronous update.',
      '  always @(posedge clk or negedge rst_n) begin',
      '    if (!rst_n) begin',
      '      state_current <= IDLE;',
      '    end else begin',
      '      state_current <= state_next;',
      '    end',
      '  end',
      '',
      '  // Next-state logic.',
      '  always @(*) begin',
      '    state_next = state_current;',
      '    case (state_current)',
      '      IDLE: begin',
      '        if (start) state_next = START;',
      '      end',
      '      START: begin',
      '        if (done) state_next = RUN;',
      '        else      state_next = START;',
      '      end',
      '      RUN: begin',
      '        if (done) state_next = STOP;',
      '      end',
      '      STOP: begin',
      '        state_next = IDLE;',
      '      end',
      '      default: state_next = IDLE;',
      '    endcase',
      '  end',
      '',
      '  always @(*) begin',
      '    state_out = state_current;',
      '  end',
      'endmodule',
    ].join('\n')

    const PAGE_CSS = `
.vfsm-page {
  display: flex; flex-direction: column; flex: 1 1 auto; height: 100%; min-height: 0; box-sizing: border-box;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font-family: ui-sans-serif, system-ui, -apple-system, Roboto, Arial, sans-serif;
}
html[data-platform='darwin'] .vfsm-page { padding-top: var(--dsh-frame-top-clearance, 0px); }
.vfsm-header {
  display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap;
  padding: 14px 20px; border-bottom: 1px solid var(--dsw-alias-border-l1); flex: none;
  padding-inline-start: calc(20px + var(--dsh-frame-leading-clearance, 0px));
}
.vfsm-brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
.vfsm-logo { display: inline-flex; color: var(--dsw-alias-brand-primary); flex: none; }
.vfsm-brand-text { min-width: 0; }
.vfsm-title { margin: 0; font-size: 15px; font-weight: 600; line-height: 1.3; }
.vfsm-subtitle { margin: 2px 0 0; font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.35; }
.vfsm-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex: none; flex-wrap: wrap; }
.vfsm-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 30px; padding: 0 12px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font-size: 12px; font-family: inherit; white-space: nowrap;
}
.vfsm-btn:hover { background: var(--dsw-alias-bg-layer-2); }
.vfsm-btn:disabled { opacity: 0.45; cursor: default; background: var(--dsw-alias-bg-layer-1); }
.vfsm-btn-sm { height: 24px; padding: 0 9px; font-size: 11px; border-radius: 7px; }
.vfsm-btn-primary { border-color: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); background: var(--dsw-alias-button-primary-fill); }
.vfsm-btn-primary:hover { background: var(--dsw-alias-brand-primary); filter: brightness(1.06); }
.vfsm-main { display: flex; gap: 12px; flex: 1; min-height: 0; padding: 12px 16px 16px; }
.vfsm-pane {
  display: flex; flex-direction: column; min-height: 0; overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
}
.vfsm-source { flex: 0 1 38%; min-width: 320px; max-width: 640px; }
.vfsm-view { flex: 1 1 0; min-width: 0; }
.vfsm-pane-head {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  height: 40px; padding: 0 12px; flex: none;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  font-size: 12px; color: var(--dsw-alias-label-secondary);
}
.vfsm-file { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 55%; }
.vfsm-code {
  flex: 1; min-height: 0; width: 100%; resize: none; border: 0; outline: none;
  padding: 12px 14px; margin: 0; box-sizing: border-box;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 12px; line-height: 1.55; tab-size: 2;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
}
.vfsm-source-foot {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 7px 10px; flex: none;
  border-top: 1px solid var(--dsw-alias-border-l1);
  font-size: 11px; color: var(--dsw-alias-label-secondary);
}
.vfsm-hint { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vfsm-view-head { gap: 8px; height: auto; min-height: 40px; padding-top: 4px; padding-bottom: 4px; flex-wrap: wrap; }
.vfsm-view-title { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
.vfsm-tools { display: flex; align-items: center; gap: 6px; flex: none; flex-wrap: wrap; }
.vfsm-zoom { min-width: 42px; text-align: center; font-variant-numeric: tabular-nums; }
.vfsm-meta {
  display: flex; align-items: center; flex-wrap: wrap; gap: 6px;
  padding: 8px 12px; flex: none; font-size: 11px; color: var(--dsw-alias-label-secondary);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.vfsm-tag {
  display: inline-flex; align-items: center; gap: 4px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px;
  padding: 2px 8px; background: var(--dsw-alias-bg-layer-2); white-space: nowrap;
}
.vfsm-tag strong { font-weight: 600; color: var(--dsw-alias-label-primary); }
.vfsm-tag-accent { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); background: transparent; }
.vfsm-hint-inline { margin-left: auto; font-size: 11px; }
.vfsm-canvas {
  position: relative; flex: 1; min-height: 260px; overflow: hidden;
  background: var(--dsw-alias-bg-base);
  background-image: radial-gradient(circle, var(--dsw-alias-border-l1) 1px, transparent 1px);
  background-size: 22px 22px;
  cursor: grab; touch-action: none; user-select: none;
}
.vfsm-canvas:active { cursor: grabbing; }
.vfsm-canvas-inner { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
.vfsm-canvas-inner svg { display: block; }
.vfsm-empty {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 8px; padding: 28px;
  text-align: center; color: var(--dsw-alias-label-secondary);
}
.vfsm-empty-icon { color: var(--dsw-alias-state-idle-primary); }
.vfsm-empty-title { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.vfsm-empty-body { margin: 0; font-size: 12px; line-height: 1.5; max-width: 420px; }
.vfsm-empty-list { margin: 2px 0 6px; padding: 0; list-style: none; font-size: 11px; line-height: 1.55; max-width: 460px; }
.vfsm-empty-list li::before { content: "·"; margin-right: 6px; color: var(--dsw-alias-brand-primary); }
.vfsm-warnings { margin: 8px 12px 0; padding: 8px 10px; flex: none; border-radius: 8px; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-state-warn-primary); border: 1px solid var(--dsw-alias-state-warn-primary); }
.vfsm-warnings div { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vfsm-table-wrap { flex: 0 0 auto; max-height: 36%; overflow: auto; border-top: 1px solid var(--dsw-alias-border-l1); }
.vfsm-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.vfsm-table th {
  position: sticky; top: 0; z-index: 1; text-align: left; padding: 7px 12px;
  font-size: 11px; font-weight: 500; color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.vfsm-table td { padding: 7px 12px; vertical-align: top; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.vfsm-table tbody tr { cursor: pointer; }
.vfsm-table tbody tr:hover { background: var(--dsw-alias-bg-layer-2); }
.vfsm-table tbody tr:last-child td { border-bottom: 0; }
.vfsm-table tbody tr.is-selected { background: var(--dsw-alias-bg-layer-2); box-shadow: inset 2px 0 0 var(--dsw-alias-brand-primary); }
.vfsm-table tbody tr:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.vfsm-table .vfsm-enc { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.vfsm-chip {
  display: inline-flex; align-items: center; margin: 1px 4px 1px 0; padding: 1px 7px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-secondary);
  font-size: 11px; white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis;
}
.vfsm-chip-target { color: var(--dsw-alias-label-primary); font-weight: 500; }
.vfsm-muted { color: var(--dsw-alias-label-secondary); }
.vfsm-tabs { display: flex; align-items: center; gap: 4px; overflow-x: auto; min-width: 0; }
.vfsm-seg { display: inline-flex; align-items: center; gap: 2px; padding: 2px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: var(--dsw-alias-bg-layer-2); }
.vfsm-seg-btn { height: 24px; padding: 0 10px; border: 0; border-radius: 7px; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 11px; font-family: inherit; cursor: pointer; }
.vfsm-seg-btn.is-active { background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); box-shadow: 0 0 0 1px var(--dsw-alias-border-l1); }
.vfsm-btn.is-on { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.vfsm-table-editor { flex: 1; min-height: 0; overflow: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; }
.vfsm-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.vfsm-field { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.vfsm-input { height: 26px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 12px; outline: none; min-width: 0; }
.vfsm-input:focus { border-color: var(--dsw-alias-brand-primary); }
.vfsm-rows { display: flex; flex-direction: column; gap: 4px; }
.vfsm-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr) minmax(0, 1fr) 26px; gap: 4px; align-items: center; }
.vfsm-row-head { font-size: 11px; color: var(--dsw-alias-label-secondary); padding: 0 1px; }
.vfsm-icon-btn { width: 26px; height: 26px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 14px; line-height: 1; }
.vfsm-icon-btn:hover { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.vfsm-row-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.vfsm-import { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 9px; }
.vfsm-import-text { width: 100%; box-sizing: border-box; resize: vertical; min-height: 76px; padding: 6px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; outline: none; }
.vfsm-import-error { font-size: 11px; color: var(--dsw-alias-state-error-primary); }
.vfsm-gen { display: flex; flex-direction: column; gap: 6px; }
.vfsm-gen-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.vfsm-gen-code { margin: 0; padding: 10px 12px; max-height: 240px; overflow: auto; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; line-height: 1.5; white-space: pre; }
.vfsm-view.is-fullscreen {
  position: fixed; inset: 0; z-index: 9999; border-radius: 0; border: 0;
  background: var(--dsw-alias-bg-base); box-shadow: none;
}
.vfsm-view:fullscreen { border-radius: 0; border: 0; background: var(--dsw-alias-bg-base); }
.vfsm-view.is-fullscreen .vfsm-canvas,
.vfsm-view:fullscreen .vfsm-canvas { min-height: 0; }
.vfsm-canvas-all { cursor: default; background-image: none; overflow: auto; }
.vfsm-all-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 12px; padding: 12px; }
.vfsm-mini { display: flex; flex-direction: column; gap: 6px; min-width: 0; padding: 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.vfsm-mini-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.vfsm-mini-title { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vfsm-mini-tools { display: flex; align-items: center; gap: 4px; flex: none; }
.vfsm-mini-canvas { overflow: hidden; border-radius: 8px; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); }
.vfsm-mini-canvas svg { display: block; width: 100%; height: auto; }
.vfsm-mini-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.vfsm-tab {
  height: 24px; padding: 0 9px; border-radius: 7px; cursor: pointer; font-size: 11px;
  border: 1px solid var(--dsw-alias-border-l1); background: transparent;
  color: var(--dsw-alias-label-secondary); font-family: inherit; white-space: nowrap;
}
.vfsm-tab.is-active { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
@media (max-width: 940px) {
  .vfsm-main { flex-direction: column; }
  .vfsm-source { flex: 0 0 auto; max-width: none; min-width: 0; height: 34%; }
  .vfsm-view { flex: 1 1 auto; }
}
.vfsm-page {
  --vfsm-edge-0: #1d4ed8; --vfsm-edge-1: #b45309; --vfsm-edge-2: #15803d;
  --vfsm-edge-3: #6d28d9; --vfsm-edge-4: #0e7490; --vfsm-edge-5: #be185d;
  --vfsm-edge-6: #0f766e; --vfsm-edge-7: #a16207; --vfsm-edge-8: #b91c1c;
  --vfsm-edge-9: #4338ca; --vfsm-edge-10: #4d7c0f; --vfsm-edge-11: #475569;
}
body[data-ds-dark-theme] .vfsm-page {
  --vfsm-edge-0: #93c5fd; --vfsm-edge-1: #fbbf24; --vfsm-edge-2: #4ade80;
  --vfsm-edge-3: #c4b5fd; --vfsm-edge-4: #67e8f9; --vfsm-edge-5: #f9a8d4;
  --vfsm-edge-6: #5eead4; --vfsm-edge-7: #fde047; --vfsm-edge-8: #fca5a5;
  --vfsm-edge-9: #a5b4fc; --vfsm-edge-10: #bef264; --vfsm-edge-11: #cbd5e1;
}
`

    // =====================================================================
    // Panel glyph and page component
    // =====================================================================

    /** Theme-following glyph used by the sidebar entry and the page header. */
    function PanelGlyph(props) {
      const size = props !== undefined && props.size !== undefined ? props.size : 18
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      h('circle', { cx: 7.2, cy: 7.6, r: 3.1, key: 'a' }),
      h('circle', { cx: 16.8, cy: 16.4, r: 3.1, key: 'b' }),
      h('path', { d: 'M9.9 9.5 C 13.6 10 11.4 13.2 14.1 14.6', key: 'c' }),
      h('path', { d: 'M16 15.2 L 13.1 14.4 L 14.6 12.3', key: 'd' }))
    }

    /** Transitions grouped by their source state for the state table. */
    function transitionsOf(fsm, stateName) {
      return fsm.transitions.filter(transition => transition.from === stateName)
    }

    /** Ordered unique state names referenced by a transition-table model. */
    function tableStateNames(rows) {
      const names = []
      for (const row of rows) {
        const from = sanitizeIdentifier(row.from, 'S')
        const to = sanitizeIdentifier(row.to, 'S')
        if (from !== '' && names.indexOf(from) < 0) names.push(from)
        if (to !== '' && names.indexOf(to) < 0) names.push(to)
      }
      return names
    }

    /** Make a legal Verilog identifier out of free-form table text. */
    function sanitizeIdentifier(text, fallback) {
      const prefix = fallback === undefined ? 'S' : fallback
      let value = String(text === undefined || text === null ? '' : text).trim()
      value = value.replace(/[^A-Za-z0-9_$]/g, '_')
      if (value === '') value = prefix
      if (value.charAt(0) === '$') {
        const tail = value.slice(1)
        value = prefix + (tail === '' ? '' : '_' + tail)
      }
      if (/^[0-9]/.test(value)) value = prefix + '_' + value
      if (VERILOG_KEYWORDS.has(value)) value = value + '_'
      return value
    }

    /** Return an identifier for the next free state name in a table. */
    function nextTableStateName(rows) {
      const names = tableStateNames(rows)
      let index = names.length
      while (names.indexOf('S' + index) >= 0) index += 1
      return 'S' + index
    }

    /** Verilog-2001 / common SystemVerilog keywords that cannot name a port. */
    const VERILOG_KEYWORDS = new Set([
      'module', 'endmodule', 'macromodule', 'input', 'output', 'inout', 'ref', 'reg', 'wire', 'logic',
      'always', 'always_ff', 'always_comb', 'always_latch', 'assign', 'deassign', 'force', 'release',
      'begin', 'end', 'case', 'casez', 'casex', 'endcase', 'if', 'else', 'default', 'parameter',
      'localparam', 'defparam', 'function', 'endfunction', 'task', 'endtask', 'return', 'task',
      'posedge', 'negedge', 'or', 'and', 'not', 'xor', 'nand', 'nor', 'xnor', 'buf', 'bufif0', 'bufif1',
      'notif0', 'notif1', 'pullup', 'pulldown', 'for', 'while', 'repeat', 'forever', 'do', 'integer',
      'genvar', 'generate', 'endgenerate', 'signed', 'unsigned', 'initial', 'final', 'fork', 'join',
      'join_any', 'join_none', 'wait', 'disable', 'specify', 'endspecify', 'primitive', 'endprimitive',
      'table', 'endtable', 'typedef', 'enum', 'struct', 'union', 'packed', 'bit', 'byte', 'shortint',
      'int', 'longint', 'real', 'realtime', 'shortreal', 'time', 'timeunit', 'timeprecision', 'event',
      'tri', 'tri0', 'tri1', 'wand', 'wor', 'supply0', 'supply1', 'reg', 'automatic', 'static',
    ])

    /** Strip comments from a condition expression before it is emitted. */
    function stripConditionComments(text) {
      return String(text)
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/.*$/gm, ' ')
        .replace(/\s+#.*$/gm, ' ')
    }

    /** Width prefix of a based literal token (`4'd3` -> 4), else null. */
    function literalWidth(token) {
      if (token === undefined || token.type !== 'num') return null
      const match = /^(\d+)'[sS]?[bBoOdDhH]/.exec(token.value)
      return match === null ? null : parseInt(match[1], 10)
    }

    /** Width implied by a bit-select starting at tokens[bracket]. */
    function bitSelectWidth(tokens, bracket) {
      let depth = 0
      let high = null
      for (let index = bracket; index < tokens.length; index += 1) {
        const value = tokens[index].value
        if (value === '[') depth += 1
        else if (value === ']') {
          depth -= 1
          if (depth === 0) break
        } else if (depth === 1 && tokens[index].type === 'num') {
          const numeric = numericValue(tokens[index].value)
          if (numeric !== null) high = high === null ? Number(numeric) : Math.max(high, Number(numeric))
        }
      }
      return high === null ? null : high + 1
    }

    /** Width implied by comparing a signal with a sized literal. */
    function comparisonWidth(tokens, signalIndex) {
      const comparisons = ['==', '!=', '<', '>', '<=', '>=', '===', '!==']
      const next = tokens[signalIndex + 1]
      if (next !== undefined && comparisons.indexOf(next.value) >= 0) {
        const width = literalWidth(tokens[signalIndex + 2])
        if (width !== null) return width
      }
      const previous = tokens[signalIndex - 1]
      const before = tokens[signalIndex - 2]
      if (previous !== undefined && comparisons.indexOf(previous.value) >= 0 && before !== undefined) {
        const width = literalWidth(before)
        if (width !== null) return width
      }
      return null
    }

    /** Rewrite identifiers in a condition through a raw-name -> emitted-name map. */
    function rewriteCondition(text, rename) {
      if (rename.size === 0) return text
      const tokens = tokenize(text)
      let changed = false
      const rewritten = tokens.map((token) => {
        if (token.type === 'id' && rename.has(token.value)) {
          changed = true
          return { type: 'id', value: rename.get(token.value), line: token.line }
        }
        return token
      })
      return changed ? tokensToText(rewritten) : text
    }

    /**
     * Render a transition-table model as a three-segment synthesizable Verilog
     * FSM. Condition signals become inferred input ports (widths inferred from
     * bit-selects and sized literals), symbol collisions are resolved with a
     * warning, and an empty-condition row becomes the state's fallback.
     * @param {object} model - { moduleName, stateVar, clock, reset, rows }.
     * @returns {{code: string, states: string[], warnings: object[], empty: boolean}}
     */
    function generateVerilogFromTable(model) {
      const warnings = []
      const rows = []
      for (const row of model.rows === undefined || model.rows === null ? [] : model.rows) {
        const fromRaw = String(row.from === undefined || row.from === null ? '' : row.from).trim()
        const toRaw = String(row.to === undefined || row.to === null ? '' : row.to).trim()
        if (fromRaw === '' || toRaw === '') continue
        const condition = stripConditionComments(String(row.cond === undefined || row.cond === null ? '' : row.cond))
          .replace(/\s+/g, ' ')
          .trim()
          .replace(/^if\s+/i, '')
          .replace(/;\s*$/, '')
          .replace(/\s+\)/g, ')')
          .trim()
        rows.push({ fromRaw, toRaw, condition })
      }
      if (rows.length === 0) return { code: '', states: [], warnings: ['empty'], empty: true }

      // Emitted symbols must be unique; conditions are rewritten to match.
      const used = new Set(['state_next', 'state_out'])
      const unique = (base, suffix) => {
        let name = base
        let index = 2
        while (used.has(name)) { name = base + suffix + index; index += 1 }
        used.add(name)
        return name
      }
      const rawToName = new Map()
      const assignField = (raw, fallback, suffix) => {
        const base = sanitizeIdentifier(raw, fallback)
        const name = unique(base, suffix)
        if (name !== base) warnings.push({ code: 'warnRenamed', params: { from: base, to: name } })
        const rawText = String(raw === undefined || raw === null ? '' : raw).trim()
        if (rawText !== '' && rawText !== name) rawToName.set(rawText, name)
        return name
      }
      const moduleName = unique(sanitizeIdentifier(model.moduleName, 'fsm_generated'), '_m')
      const stateVar = assignField(model.stateVar, 'state_current', '_v')
      const clock = assignField(model.clock, 'clk', '_c')
      const reset = assignField(model.reset, 'rst_n', '_r')

      const stateNameForRaw = new Map()
      const stateOrder = []
      const stateName = (raw) => {
        if (stateNameForRaw.has(raw)) return stateNameForRaw.get(raw)
        const base = sanitizeIdentifier(raw, 'S')
        let name = base
        if (used.has(name)) {
          let index = 2
          do {
            name = base + '_s' + index
            index += 1
          } while (used.has(name))
          warnings.push({ code: 'warnStateCollision', params: { from: raw, to: name } })
        }
        used.add(name)
        stateNameForRaw.set(raw, name)
        stateOrder.push(name)
        if (String(raw).trim() !== name) rawToName.set(String(raw).trim(), name)
        return name
      }
      for (const row of rows) {
        row.from = stateName(row.fromRaw)
        row.to = stateName(row.toRaw)
      }

      // A condition calling an undeclared function cannot be emitted as a
      // call; keep the call's name as an opaque input port instead.
      const conditionFunctions = []
      const rewriteFunctionCalls = (text) => {
        const tokens = tokenize(text)
        const out = []
        for (let index = 0; index < tokens.length; index += 1) {
          const token = tokens[index]
          const next = tokens[index + 1]
          if (token.type === 'id' && next !== undefined && next.value === '(' && !VERILOG_KEYWORDS.has(token.value)) {
            let depth = 0
            let end = index + 1
            for (; end < tokens.length; end += 1) {
              const value = tokens[end].value
              if (value === '(') depth += 1
              else if (value === ')') {
                depth -= 1
                if (depth === 0) { end += 1; break }
              }
            }
            out.push({ type: 'id', value: token.value, line: token.line })
            if (conditionFunctions.indexOf(token.value) < 0) conditionFunctions.push(token.value)
            index = end - 1
            continue
          }
          out.push(token)
        }
        return tokensToText(out)
      }
      for (const row of rows) {
        if (row.condition !== '') row.condition = rewriteFunctionCalls(row.condition)
      }

      // Condition signals plus inferred widths.
      const reservedRaw = new Set(['state_next', 'state_out', 'state_out'])
      for (const raw of [String(model.stateVar ?? ''), String(model.clock ?? ''), String(model.reset ?? '')]) {
        const trimmed = raw.trim()
        if (trimmed !== '') reservedRaw.add(trimmed)
      }
      for (const raw of stateNameForRaw.keys()) reservedRaw.add(String(raw).trim())
      const signalOrder = []
      const signalWidths = new Map()
      for (const row of rows) {
        if (row.condition === '') continue
        const tokens = tokenize(row.condition)
        for (let index = 0; index < tokens.length; index += 1) {
          const token = tokens[index]
          if (token.type !== 'id') continue
          if (VERILOG_KEYWORDS.has(token.value) || reservedRaw.has(token.value)) continue
          const next = tokens[index + 1]
          if (next !== undefined && next.value === '(') continue
          let width = 1
          if (next !== undefined && next.value === '[') {
            const selected = bitSelectWidth(tokens, index + 1)
            if (selected !== null) width = Math.max(width, selected)
          }
          const compared = comparisonWidth(tokens, index)
          if (compared !== null) width = Math.max(width, compared)
          if (!signalWidths.has(token.value)) {
            signalWidths.set(token.value, width)
            signalOrder.push(token.value)
          } else {
            signalWidths.set(token.value, Math.max(signalWidths.get(token.value), width))
          }
        }
      }
      for (const name of conditionFunctions) {
        warnings.push({ code: 'warnConditionFunction', params: { name } })
      }
      const conditionKeywords = []
      for (const row of rows) {
        if (row.condition === '') continue
        for (const token of tokenize(row.condition)) {
          if (token.type === 'id' && VERILOG_KEYWORDS.has(token.value)
            && conditionKeywords.indexOf(token.value) < 0) conditionKeywords.push(token.value)
        }
      }
      for (const name of conditionKeywords) {
        warnings.push({ code: 'warnConditionKeyword', params: { name } })
      }
      const signals = []
      for (const raw of signalOrder) {
        const base = sanitizeIdentifier(raw, 'sig')
        let name = base
        if (used.has(name)) {
          let index = 2
          do {
            name = base + '_c' + index
            index += 1
          } while (used.has(name))
          warnings.push({ code: 'warnRenamed', params: { from: base, to: name } })
        }
        used.add(name)
        if (name !== raw) rawToName.set(raw, name)
        signals.push({ name, width: signalWidths.get(raw) })
      }
      for (const row of rows) row.condition = rewriteCondition(row.condition, rawToName)

      const width = Math.max(1, Math.ceil(Math.log2(Math.max(2, stateOrder.length))))
      const range = '[' + (width - 1) + ':0]'
      const portLines = []
      portLines.push('  input  wire ' + clock)
      portLines.push('  input  wire ' + reset)
      for (const signal of signals) {
        portLines.push('  input  wire ' + (signal.width > 1 ? '[' + (signal.width - 1) + ':0] ' : '') + signal.name)
      }
      portLines.push('  output wire ' + range + ' state_out')

      const grouped = new Map()
      for (const row of rows) {
        if (!grouped.has(row.from)) grouped.set(row.from, [])
        grouped.get(row.from).push(row)
      }
      const lines = []
      lines.push('// Generated from the transition table; edit the table to regenerate.')
      lines.push('module ' + moduleName + ' (')
      lines.push(portLines.join(',\n'))
      lines.push(');')
      lines.push('')
      stateOrder.forEach((name, index) => {
        lines.push('  localparam ' + range + ' ' + name + ' = ' + width + "'d" + index + ';')
      })
      lines.push('')
      lines.push('  reg ' + range + ' ' + stateVar + ';')
      lines.push('  reg ' + range + ' state_next;')
      lines.push('')
      lines.push('  assign state_out = ' + stateVar + ';')
      lines.push('')
      lines.push('  always @(posedge ' + clock + ' or negedge ' + reset + ') begin')
      lines.push('    if (!' + reset + ') begin')
      lines.push('      ' + stateVar + ' <= ' + stateOrder[0] + ';')
      lines.push('    end else begin')
      lines.push('      ' + stateVar + ' <= state_next;')
      lines.push('    end')
      lines.push('  end')
      lines.push('')
      lines.push('  always @(*) begin')
      lines.push('    state_next = ' + stateVar + ';')
      lines.push('    case (' + stateVar + ')')
      for (const state of stateOrder) {
        const outgoing = grouped.get(state) === undefined ? [] : grouped.get(state)
        lines.push('      ' + state + ': begin')
        if (outgoing.length === 0) {
          lines.push('        // no outgoing transition: stay here')
        } else {
          const conditional = outgoing.filter(row => row.condition !== '')
          const unconditional = outgoing.filter(row => row.condition === '')
          const fallback = unconditional.length === 0 ? null : unconditional[unconditional.length - 1]
          if (conditional.length === 0) {
            lines.push('        state_next = ' + fallback.to + ';')
          } else {
            conditional.forEach((row, index) => {
              const prefix = index === 0 ? '        if (' : '        else if ('
              lines.push(prefix + row.condition + ') state_next = ' + row.to + ';')
            })
            if (fallback !== null) lines.push('        else state_next = ' + fallback.to + ';')
          }
        }
        lines.push('      end')
      }
      lines.push('      default: state_next = ' + stateVar + ';')
      lines.push('    endcase')
      lines.push('  end')
      lines.push('')
      lines.push('endmodule')
      return { code: lines.join('\n'), states: stateOrder, warnings, empty: false }
    }

    /**
     * Read a pasted transition table. Accepts arrow lines (`A -> B : cond`)
     * and CSV/TSV rows in the table's column order (from, condition, to).
     */
    function parseTransitionTableText(text) {
      const rows = []
      for (const rawLine of String(text).split(/\r?\n/)) {
        const cleaned = rawLine
          .replace(/\/\*[\s\S]*?\*\//g, ' ')
          .replace(/\/\/.*$/, '')
          .replace(/\s+#.*$/, ' ')
          .trim()
        const line = cleaned
        if (line === '') continue
        let from = ''
        let to = ''
        let condition = ''
        if (line.indexOf('->') >= 0) {
          const arrow = line.split('->')
          from = arrow[0].trim()
          let rest = arrow.slice(1).join('->').trim()
          const colon = rest.indexOf(':')
          if (colon >= 0) {
            to = rest.slice(0, colon).trim()
            condition = rest.slice(colon + 1).trim()
          } else {
            const ifMatch = /^(.*?)\s+if\s+(.*)$/i.exec(rest)
            if (ifMatch !== null) {
              to = ifMatch[1].trim()
              condition = ifMatch[2].trim()
            } else {
              to = rest
            }
          }
        } else {
          let cells = line.split(/\t|,|;/).map(cell => cell.trim())
          if (cells.length < 3 && line.indexOf('|') >= 0) {
            // Markdown-style table row: | from | condition | to |
            cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
            if (cells.every(cell => /^:?-{2,}:?$/.test(cell))) continue
          }
          const headerWords = cells.filter(cell => /^(from|to|condition|source|target|current|next|state|状态|当前状态|条件|下一状态|跳转)$/i.test(cell)).length
          if (headerWords >= 2) continue
          if (cells.length >= 3) {
            from = cells[0]
            condition = cells[1]
            to = cells[2]
          } else if (cells.length === 2) {
            from = cells[0]
            to = cells[1]
          }
        }
        if (from !== '' && to !== '') rows.push({ from, cond: condition, to })
      }
      return rows
    }

    /** A small editable table used when the panel opens in table mode. */
    function createDefaultTable() {
      return {
        moduleName: 'fsm_generated',
        stateVar: 'state_current',
        clock: 'clk',
        reset: 'rst_n',
        rows: [
          { from: 'IDLE', cond: 'start', to: 'START' },
          { from: 'START', cond: 'done', to: 'RUN' },
          { from: 'RUN', cond: 'done', to: 'STOP' },
          { from: 'STOP', cond: '', to: 'IDLE' },
        ],
      }
    }

    /** Stable per-diagram key for one transition (from/to are node names). */
    function transitionKey(from, to) {
      return from + '\u0000' + to
    }

    /** Per-edge label mode: a per-edge override wins over the global switch. */
    function edgeModeMap(fsm, numbering, overrides) {
      const modes = {}
      for (const transition of fsm.transitions) {
        const key = transitionKey(transition.from, transition.to)
        const override = overrides[fsm.id + '\u0000' + key]
        modes[key] = override === undefined ? (numbering ? 'number' : 'text') : override
      }
      return modes
    }

    /** Legend rows for the conditions whose edges currently show numbers. */
    function legendForEdgeModes(fsm, numbering, modes) {
      const used = new Set()
      for (const transition of fsm.transitions) {
        if (modes[transitionKey(transition.from, transition.to)] !== 'number') continue
        for (const label of transition.labels) used.add(label)
      }
      return numbering.legend.filter(item => used.has(item.label))
    }

    /** Number every distinct transition condition and build the legend rows. */
    function buildConditionNumbering(fsm) {
      const numberMap = {}
      const legend = []
      for (const transition of fsm.transitions) {
        for (const label of transition.labels) {
          if (numberMap[label] === undefined) {
            numberMap[label] = legend.length + 1
            legend.push({ number: numberMap[label], label })
          }
        }
      }
      return { numberMap, legend }
    }

    /**
     * The Verilog FSM panel: a source editor or transition-table editor on the
     * left, the extracted diagram and state table on the right.
     */
    function VerilogFsmPage(props) {
      const t = typeof props.t === 'function' ? props.t : key => key
      const [mode, setMode] = useState(sessionState.mode)
      const [code, setCode] = useState(sessionState.code)
      const [fileName, setFileName] = useState(sessionState.fileName)
      const [table, setTable] = useState(() => sessionState.table)
      const [importOpen, setImportOpen] = useState(false)
      const [importText, setImportText] = useState('')
      const [importError, setImportError] = useState('')
      const [showVerilog, setShowVerilog] = useState(sessionState.showVerilog)
      const [fileError, setFileError] = useState('')
      const [copied, setCopied] = useState(false)
      const [fsmIndex, setFsmIndex] = useState(sessionState.fsmIndex)
      const [viewAll, setViewAll] = useState(sessionState.viewAll)
      const [numbering, setNumbering] = useState(sessionState.numbering)
      const [edgeModes, setEdgeModes] = useState(() => sessionState.edgeModes)
      const [selected, setSelected] = useState(null)
      const [zoom, setZoom] = useState(1)
      const [pan, setPan] = useState({ x: 0, y: 0 })
      const [showTable, setShowTable] = useState(sessionState.showTable)
      const [isFullscreen, setIsFullscreen] = useState(false)
      const fileInput = useRef(null)
      const viewPane = useRef(null)
      const fitRef = useRef(null)
      const viewport = useRef(null)
      const drag = useRef(null)
      const fitKey = useRef('')
      const copyTimer = useRef(null)

      useEffect(() => () => {
        if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
      }, [])

      const generated = useMemo(
        () => (mode === 'table' ? generateVerilogFromTable(table) : null),
        [mode, table],
      )
      const generatedCode = generated === null ? '' : generated.code
      const sourceCode = mode === 'table' ? generatedCode : code
      const parsed = useMemo(() => {
        if (sourceCode.trim() === '') return { modules: [], fsms: [], warnings: [], hints: [] }
        return parseVerilog(sourceCode)
      }, [sourceCode])
      const fsms = parsed.fsms
      const allView = viewAll && fsms.length > 1
      const activeIndex = fsms.length === 0 ? 0 : Math.min(fsmIndex, fsms.length - 1)
      const current = fsms.length === 0 ? null : fsms[activeIndex]
      const numberingInfo = useMemo(
        () => (current === null ? { numberMap: {}, legend: [] } : buildConditionNumbering(current)),
        [current],
      )
      const currentEdgeModes = useMemo(
        () => (current === null ? {} : edgeModeMap(current, numbering, edgeModes)),
        [current, numbering, edgeModes],
      )
      const currentLegend = useMemo(
        () => (current === null ? [] : legendForEdgeModes(current, numberingInfo, currentEdgeModes)),
        [current, numberingInfo, currentEdgeModes],
      )
      const diagram = useMemo(() => (current === null ? null : layoutFsm(current, {
        labelModes: currentEdgeModes,
        numberMap: numberingInfo.numberMap,
      })), [current, currentEdgeModes, numberingInfo])
      const svg = useMemo(
        () => (diagram === null ? '' : svgDocument(diagram, {
          colors: CSS_COLORS,
          selected,
          labels: { reset: t('resetTag'), diagram: t('diagram'), legend: t('legendTitle') },
          numbered: numbering,
          numberMap: numberingInfo.numberMap,
          edgeModes: currentEdgeModes,
          palette: CSS_EDGE_PALETTE,
          legend: currentLegend,
        })),
        [diagram, selected, numbering, numberingInfo, currentEdgeModes, currentLegend, t],
      )
      const allCards = useMemo(() => {
        if (!allView) return []
        return fsms.map((fsm) => {
          const info = buildConditionNumbering(fsm)
          const modes = edgeModeMap(fsm, numbering, edgeModes)
          const cardDiagram = layoutFsm(fsm, { labelModes: modes, numberMap: info.numberMap })
          return {
            fsm,
            diagram: cardDiagram,
            svg: svgDocument(cardDiagram, {
              colors: CSS_COLORS,
              selected: '',
              labels: { reset: t('resetTag'), diagram: t('diagram'), legend: t('legendTitle') },
              numbered: numbering,
              numberMap: info.numberMap,
              edgeModes: modes,
              palette: CSS_EDGE_PALETTE,
              legend: legendForEdgeModes(fsm, info, modes),
            }),
          }
        })
      }, [allView, fsms, numbering, edgeModes, t])

      const fit = useCallback(() => {
        const element = viewport.current
        if (element === null || diagram === null) return
        const width = element.clientWidth
        const height = element.clientHeight
        if (width <= 0 || height <= 0) return
        const legendExtra = currentLegend.length > 0 ? legendHeightFor(diagram.width, currentLegend) : 0
        const totalHeight = diagram.height + legendExtra
        const scale = Math.max(0.15, Math.min(1.15,
          Math.min((width - 36) / diagram.width, (height - 36) / totalHeight)))
        setZoom(scale)
        setPan({ x: (width - diagram.width * scale) / 2, y: (height - totalHeight * scale) / 2 })
      }, [diagram, currentLegend])
      fitRef.current = fit

      useEffect(() => {
        if (typeof document === 'undefined' || document.addEventListener === undefined) return undefined
        const onFullscreenChange = () => {
          const active = document.fullscreenElement !== null && document.fullscreenElement !== undefined
          setIsFullscreen(active)
        }
        document.addEventListener('fullscreenchange', onFullscreenChange)
        return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
      }, [])

      useEffect(() => {
        // Fullscreen changes the viewport size: refit once it has settled.
        const timer = window.setTimeout(() => { if (fitRef.current !== null) fitRef.current() }, 80)
        return () => window.clearTimeout(timer)
      }, [isFullscreen])

      useEffect(() => {
        if (!isFullscreen) return undefined
        const previousOverflow = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        const onKeyDown = (event) => {
          const native = document.fullscreenElement !== null && document.fullscreenElement !== undefined
          if (event.key === 'Escape' && !native) setIsFullscreen(false)
        }
        window.addEventListener('keydown', onKeyDown)
        return () => {
          window.removeEventListener('keydown', onKeyDown)
          document.body.style.overflow = previousOverflow
        }
      }, [isFullscreen])

      useEffect(() => {
        // Refit only when the drawn graph itself changes shape. Toggling a
        // label between text and numbers (globally or per edge) keeps the
        // user's zoom and pan.
        const key = allView
          ? 'all'
          : (current === null
            ? 'none'
            : current.id + ':' + current.states.length + ':' + current.transitions.length)
        if (key === fitKey.current) return
        fitKey.current = key
        setSelected(null)
        if (!allView) fit()
      }, [parsed, current, fit, allView])

      // A newly shown legend must not change the zoom; pan just enough to keep
      // its bottom edge reachable inside the viewport.
      useEffect(() => {
        const element = viewport.current
        if (element === null || diagram === null) return
        const height = element.clientHeight
        if (height <= 0) return
        const legendExtra = currentLegend.length > 0 ? legendHeightFor(diagram.width, currentLegend) : 0
        const totalHeight = diagram.height + legendExtra
        const overflow = pan.y + totalHeight * zoom - (height - 6)
        if (overflow <= 0) return
        const shift = Math.min(overflow, Math.max(0, pan.y - 6))
        if (shift > 0.5) setPan(previous => ({ ...previous, y: previous.y - shift }))
      }, [currentLegend.length])

      const changeCode = (nextCode, nextFileName) => {
        setCode(nextCode)
        if (nextFileName !== undefined) setFileName(nextFileName)
        sessionState.code = nextCode
        if (nextFileName !== undefined) sessionState.fileName = nextFileName
      }

      const switchMode = (nextMode) => {
        setMode(nextMode)
        sessionState.mode = nextMode
        setSelected(null)
      }

      const loadSample = () => {
        switchMode('code')
        setFsmIndex(0)
        sessionState.fsmIndex = 0
        changeCode(SAMPLE_CODE, '')
      }

      const clearSource = () => {
        setFsmIndex(0)
        sessionState.fsmIndex = 0
        changeCode('', '')
      }

      const onFilePicked = async (event) => {
        const files = event.target.files
        const file = files !== null && files !== undefined ? files[0] : null
        if (file === null || file === undefined) return
        try {
          const text = await file.text()
          switchMode('code')
          setFsmIndex(0)
          sessionState.fsmIndex = 0
          setFileError('')
          changeCode(text, file.name)
        } catch (error) {
          setFileError(t('fileReadFailed'))
        }
        event.target.value = ''
      }

      const onDrop = async (event) => {
        event.preventDefault()
        const files = event.dataTransfer !== null ? event.dataTransfer.files : null
        const file = files !== null && files !== undefined ? files[0] : null
        if (file === null || file === undefined) return
        try {
          const text = await file.text()
          switchMode('code')
          setFsmIndex(0)
          sessionState.fsmIndex = 0
          setFileError('')
          changeCode(text, file.name)
        } catch (error) {
          setFileError(t('fileReadFailed'))
        }
      }

      const updateTable = (nextTable) => {
        setTable(nextTable)
        sessionState.table = nextTable
      }

      const setTableField = (field, value) => {
        const next = { ...table }
        next[field] = value
        updateTable(next)
      }

      const updateRow = (index, patch) => {
        const rows = table.rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row))
        updateTable({ ...table, rows })
      }

      const addRow = () => {
        const names = tableStateNames(table.rows)
        const from = names.length === 0 ? 'IDLE' : names[names.length - 1]
        updateTable({ ...table, rows: table.rows.concat([{ from, cond: '', to: nextTableStateName(table.rows) }]) })
      }

      const deleteRow = (index) => {
        updateTable({ ...table, rows: table.rows.filter((row, rowIndex) => rowIndex !== index) })
      }

      const applyImport = () => {
        const rows = parseTransitionTableText(importText)
        if (rows.length === 0) {
          setImportError(t('importEmpty'))
          return
        }
        updateTable({ ...table, rows })
        setImportOpen(false)
        setImportText('')
        setImportError('')
      }

      const openGeneratedInCode = () => {
        if (generatedCode === '') return
        switchMode('code')
        setFsmIndex(0)
        sessionState.fsmIndex = 0
        changeCode(generatedCode, '')
      }

      const copyVerilog = async () => {
        if (generatedCode === '') return
        let copiedNow = false
        try {
          await navigator.clipboard.writeText(generatedCode)
          copiedNow = true
        } catch (error) {
          copiedNow = false
        }
        if (!copiedNow) {
          try {
            const helper = document.createElement('textarea')
            helper.value = generatedCode
            helper.style.position = 'fixed'
            helper.style.opacity = '0'
            document.body.appendChild(helper)
            helper.select()
            copiedNow = document.execCommand('copy')
            helper.remove()
          } catch (error) {
            copiedNow = false
          }
        }
        setCopied(copiedNow)
        if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
        if (copiedNow) copyTimer.current = window.setTimeout(() => setCopied(false), 1200)
      }

      const zoomBy = (factor) => {
        const element = viewport.current
        if (element === null) return
        const nextZoom = Math.max(0.15, Math.min(3, zoom * factor))
        const width = element.clientWidth
        const height = element.clientHeight
        const anchorX = (width / 2 - pan.x) / zoom
        const anchorY = (height / 2 - pan.y) / zoom
        setZoom(nextZoom)
        setPan({ x: width / 2 - anchorX * nextZoom, y: height / 2 - anchorY * nextZoom })
      }

      const onPointerDown = (event) => {
        if (event.button !== 0) return
        drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y, moved: false }
        if (event.currentTarget.setPointerCapture !== undefined) event.currentTarget.setPointerCapture(event.pointerId)
      }

      const onPointerMove = (event) => {
        const state = drag.current
        if (state === null) return
        const dx = event.clientX - state.x
        const dy = event.clientY - state.y
        if (Math.abs(dx) + Math.abs(dy) > 3) state.moved = true
        setPan({ x: state.panX + dx, y: state.panY + dy })
      }

      const onPointerCancel = () => {
        drag.current = null
      }

      const onPointerUp = (event) => {
        const state = drag.current
        drag.current = null
        if (state === null || state.moved) return
        // Pointer capture retargets the event to the canvas, so resolve the
        // glyph under the pointer explicitly before toggling the selection.
        const element = document.elementFromPoint(event.clientX, event.clientY)
        if (element === null || element === undefined || element.closest === undefined) {
          setSelected(null)
          return
        }
        const stateTarget = element.closest('[data-state]')
        if (stateTarget !== null && stateTarget !== undefined) {
          const name = stateTarget.getAttribute('data-state')
          setSelected(previous => (previous === name ? null : name))
          return
        }
        const edgeTarget = element.closest('[data-edge]')
        if (edgeTarget !== null && edgeTarget !== undefined && current !== null && diagram !== null) {
          const edgeIndex = Number(edgeTarget.getAttribute('data-edge'))
          const edge = diagram.edges[edgeIndex]
          if (edge !== undefined) {
            toggleEdgeLabel(current.id, edge.from, edge.to)
            return
          }
        }
        setSelected(null)
      }

      const selectState = (name) => {
        setSelected(previous => (previous === name ? null : name))
      }

      const selectFsm = (index) => {
        setViewAll(false)
        sessionState.viewAll = false
        setFsmIndex(index)
        sessionState.fsmIndex = index
        setSelected(null)
      }

      const showAll = () => {
        setViewAll(true)
        sessionState.viewAll = true
        setSelected(null)
      }

      const toggleTable = () => {
        setShowTable((value) => {
          sessionState.showTable = !value
          return !value
        })
      }

      const toggleNumbering = () => {
        setNumbering((value) => {
          sessionState.numbering = !value
          return !value
        })
        // The global switch returns every edge to the chosen style.
        setEdgeModes({})
        sessionState.edgeModes = {}
      }

      const toggleEdgeLabel = (fsmId, from, to) => {
        const key = fsmId + '\u0000' + transitionKey(from, to)
        setEdgeModes((previous) => {
          const next = { ...previous }
          const globalMode = numbering ? 'number' : 'text'
          const effective = next[key] === undefined ? globalMode : next[key]
          next[key] = effective === 'number' ? 'text' : 'number'
          sessionState.edgeModes = next
          return next
        })
      }

      const toggleFullscreen = async () => {
        const element = viewPane.current
        if (isFullscreen) {
          const native = document.fullscreenElement !== null && document.fullscreenElement !== undefined
          if (native) {
            try { await document.exitFullscreen() } catch (error) { /* ignore */ }
          }
          setIsFullscreen(false)
          return
        }
        if (element !== null && typeof element.requestFullscreen === 'function') {
          try {
            await element.requestFullscreen()
            return
          } catch (error) { /* fall back to an in-app overlay */ }
        }
        setIsFullscreen(true)
      }

      const onMiniCanvasClick = (card, event) => {
        const target = event.target
        if (target === null || target === undefined || target.closest === undefined) return
        const edgeTarget = target.closest('[data-edge]')
        if (edgeTarget === null || edgeTarget === undefined) return
        const edgeIndex = Number(edgeTarget.getAttribute('data-edge'))
        const edge = card.diagram.edges[edgeIndex]
        if (edge !== undefined) toggleEdgeLabel(card.fsm.id, edge.from, edge.to)
      }

      const downloadSvgFor = (targetFsm, targetDiagram) => {
        if (targetFsm === null || targetDiagram === null) return
        const info = buildConditionNumbering(targetFsm)
        const modes = edgeModeMap(targetFsm, numbering, edgeModes)
        const markup = svgDocument(targetDiagram, {
          colors: readThemeColors(),
          selected: '',
          labels: { reset: t('resetTag'), diagram: t('diagram'), legend: t('legendTitle') },
          numbered: numbering,
          numberMap: info.numberMap,
          edgeModes: modes,
          palette: readEdgePalette(),
          legend: legendForEdgeModes(targetFsm, info, modes),
        })
        const blob = new Blob([markup], { type: 'image/svg+xml;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = (targetFsm.moduleName || 'fsm') + '-' + (targetFsm.stateVar || 'diagram') + '.svg'
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        window.setTimeout(() => URL.revokeObjectURL(url), 1200)
      }

      const warningText = (warning) => {
        if (typeof warning === 'string') return warning
        if (warning === null || warning === undefined || typeof warning.code !== 'string') return String(warning)
        return t(warning.code, warning.params)
      }
      const warnings = []
      if (fileError !== '') warnings.push(fileError)
      for (const warning of parsed.warnings) warnings.push(warning)
      if (current !== null) for (const warning of current.warnings) warnings.push(warning)
      if (mode === 'table' && generated !== null) {
        for (const warning of generated.warnings) {
          if (warning !== 'empty') warnings.push(warning)
        }
      }
      const hints = parsed.hints === undefined ? [] : parsed.hints

      const statusTags = []
      if (allView) {
        statusTags.push(h('span', { className: 'vfsm-tag vfsm-tag-accent', key: 'all' },
          t('fsmCount', { count: fsms.length })))
      } else if (current !== null) {
        statusTags.push(h('span', { className: 'vfsm-tag', key: 'count' },
          h('strong', null, String(current.states.length)), t('states'),
          h('span', { className: 'vfsm-muted' }, ' · '),
          h('strong', null, String(current.transitions.length)), t('transitions')))
        if (current.moduleName !== '' && current.moduleName !== 'snippet') {
          statusTags.push(h('span', { className: 'vfsm-tag', key: 'module' }, t('module'), ' ', h('strong', null, current.moduleName)))
        }
        statusTags.push(h('span', { className: 'vfsm-tag', key: 'stateVar' }, t('stateVar'), ' ', h('strong', null, current.stateVar)))
        statusTags.push(h('span', { className: 'vfsm-tag vfsm-tag-accent', key: 'style' },
          current.style === 'three' ? t('threeSeg') : t('twoSeg')))
        if (current.clock !== null) statusTags.push(h('span', { className: 'vfsm-tag', key: 'clock' }, t('clock'), ' ', h('strong', null, current.clock)))
        if (current.resetSignal !== null) statusTags.push(h('span', { className: 'vfsm-tag', key: 'reset' }, t('reset'), ' ', h('strong', null, current.resetSignal)))
        statusTags.push(h('span', { className: 'vfsm-hint-inline vfsm-muted', key: 'hint' }, t('selectHint')))
      }

      const fsmTabs = fsms.length > 1
        ? h('div', { className: 'vfsm-tabs' },
          fsms.map((fsm, index) => h('button', {
            type: 'button',
            key: fsm.id,
            className: 'vfsm-tab' + (!allView && index === activeIndex ? ' is-active' : ''),
            title: fsm.id,
            onClick: () => selectFsm(index),
          }, fsm.moduleName + ' · ' + fsm.stateVar)))
        : null

      const tableRows = current === null ? [] : current.states.map((state) => {
        const outgoing = transitionsOf(current, state.name)
        return h('tr', {
          key: state.name,
          className: selected === state.name ? 'is-selected' : '',
          tabIndex: 0,
          role: 'button',
          'aria-pressed': selected === state.name,
          onClick: () => selectState(state.name),
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
              event.preventDefault()
              selectState(state.name)
            }
          },
        },
        h('td', null, state.name),
        h('td', { className: 'vfsm-enc' }, state.encoding === '' ? '—' : state.encoding),
        h('td', null, outgoing.length === 0
          ? h('span', { className: 'vfsm-muted' }, '—')
          : outgoing.map(edge => {
            const label = edge.labels.length === 0 ? '' : edge.labels.join(' / ') + ' → '
            return h('span', { className: 'vfsm-chip', key: edge.from + edge.to }, label,
              h('span', { className: 'vfsm-chip-target' }, edge.to))
          })))
      })

      const emptyBody = mode === 'table'
        ? t('tableEmpty')
        : (code.trim() === '' ? t('noCode') : t('emptyBody'))
      const empty = current === null
        ? h('div', { className: 'vfsm-empty' },
          h('span', { className: 'vfsm-empty-icon' }, h(PanelGlyph, { size: 40 })),
          h('div', { className: 'vfsm-empty-title' }, mode === 'table' ? t('tableTitle') : (code.trim() === '' ? t('noCode') : t('emptyTitle'))),
          h('p', { className: 'vfsm-empty-body' }, emptyBody),
          mode === 'code' && code.trim() !== ''
            ? h('ul', { className: 'vfsm-empty-list' },
              h('li', { key: 'a' }, t('supportThree')),
              h('li', { key: 'b' }, t('supportTwo')),
              h('li', { key: 'c' }, t('supportMulti')),
              h('li', { key: 'd' }, t('supportLimit')))
            : null,
          hints.length === 0
            ? null
            : h('p', { className: 'vfsm-empty-body vfsm-muted' },
              hints.map(hint => (typeof hint === 'string' ? hint : t(hint.code, hint.params))).join(' ')),
          mode === 'code' && code.trim() !== ''
            ? h('button', { type: 'button', className: 'vfsm-btn vfsm-btn-primary', onClick: loadSample }, t('trySample'))
            : null)
        : null

      const field = (label, value, onChange) => h('label', { className: 'vfsm-field' },
        h('span', null, label),
        h('input', {
          className: 'vfsm-input', value, spellCheck: false,
          onChange: event => onChange(event.target.value),
        }))

      const tableEditor = h('div', { className: 'vfsm-table-editor' },
        h('div', { className: 'vfsm-fields' },
          field(t('moduleName'), table.moduleName, value => setTableField('moduleName', value)),
          field(t('stateReg'), table.stateVar, value => setTableField('stateVar', value)),
          field(t('clockName'), table.clock, value => setTableField('clock', value)),
          field(t('resetName'), table.reset, value => setTableField('reset', value))),
        h('div', { className: 'vfsm-rows' },
          h('div', { className: 'vfsm-row vfsm-row-head' },
            h('span', null, t('colFrom')),
            h('span', null, t('colCond')),
            h('span', null, t('colTo')),
            h('span', null, '')),
          table.rows.map((row, index) => h('div', { className: 'vfsm-row', key: 'row-' + index },
            h('input', {
              className: 'vfsm-input', value: row.from, spellCheck: false,
              'aria-label': t('colFrom') + ' ' + (index + 1),
              onChange: event => updateRow(index, { from: event.target.value }),
            }),
            h('input', {
              className: 'vfsm-input', value: row.cond, spellCheck: false,
              placeholder: t('colCond'),
              'aria-label': t('colCond') + ' ' + (index + 1),
              onChange: event => updateRow(index, { cond: event.target.value }),
            }),
            h('input', {
              className: 'vfsm-input', value: row.to, spellCheck: false,
              'aria-label': t('colTo') + ' ' + (index + 1),
              onChange: event => updateRow(index, { to: event.target.value }),
            }),
            h('button', {
              type: 'button', className: 'vfsm-icon-btn', title: t('colDelete'),
              onClick: () => deleteRow(index),
            }, '×')))),
        h('div', { className: 'vfsm-row-actions' },
          h('button', { type: 'button', className: 'vfsm-btn vfsm-btn-sm', onClick: addRow }, '+ ' + t('addTransition')),
          h('button', {
            type: 'button', className: 'vfsm-btn vfsm-btn-sm',
            onClick: () => { setImportOpen(value => !value); setImportError('') },
          }, t('importText'))),
        importOpen
          ? h('div', { className: 'vfsm-import' },
            h('p', { className: 'vfsm-hint', style: { margin: 0 } }, t('importHint')),
            h('textarea', {
              className: 'vfsm-import-text', value: importText, spellCheck: false,
              onChange: event => setImportText(event.target.value),
            }),
            importError === '' ? null : h('div', { className: 'vfsm-import-error' }, importError),
            h('div', { className: 'vfsm-row-actions' },
              h('button', { type: 'button', className: 'vfsm-btn vfsm-btn-sm vfsm-btn-primary', onClick: applyImport }, t('importAction')),
              h('button', { type: 'button', className: 'vfsm-btn vfsm-btn-sm', onClick: () => setImportOpen(false) }, t('importCancel'))))
          : null,
        h('div', { className: 'vfsm-gen' },
          h('div', { className: 'vfsm-gen-head' },
            h('button', {
              type: 'button', className: 'vfsm-btn vfsm-btn-sm',
              onClick: () => setShowVerilog((value) => {
                sessionState.showVerilog = !value
                return !value
              }),
            }, showVerilog ? t('hideVerilog') : t('showVerilog')),
            h('button', {
              type: 'button', className: 'vfsm-btn vfsm-btn-sm',
              onClick: copyVerilog, disabled: generatedCode === '',
            }, copied ? t('copied') : t('copyVerilog')),
            h('button', {
              type: 'button', className: 'vfsm-btn vfsm-btn-sm',
              onClick: openGeneratedInCode, disabled: generatedCode === '',
            }, t('openInCode'))),
          showVerilog
            ? h('pre', { className: 'vfsm-gen-code' }, generatedCode === '' ? t('tableEmpty') : generatedCode)
            : null))

      const sourcePaneBody = mode === 'table'
        ? tableEditor
        : h('textarea', {
          className: 'vfsm-code', value: code, spellCheck: false, wrap: 'off',
          onChange: event => changeCode(event.target.value),
          onDragOver: event => event.preventDefault(),
          onDrop,
        })

      const viewHead = h('div', { className: 'vfsm-pane-head vfsm-view-head' },
        h('div', { className: 'vfsm-view-title' },
          fsmTabs !== null ? fsmTabs : h('span', null, t('diagram'))),
        h('div', { className: 'vfsm-tools' },
          allView
            ? null
            : h('button', { type: 'button', className: 'vfsm-btn vfsm-btn-sm', onClick: () => zoomBy(0.85), title: t('zoomOut') }, '−'),
          allView ? null : h('span', { className: 'vfsm-zoom' }, Math.round(zoom * 100) + '%'),
          allView
            ? null
            : h('button', { type: 'button', className: 'vfsm-btn vfsm-btn-sm', onClick: () => zoomBy(1.18), title: t('zoomIn') }, '+'),
          allView
            ? null
            : h('button', { type: 'button', className: 'vfsm-btn vfsm-btn-sm', onClick: fit, disabled: diagram === null }, t('fit')),
          fsms.length > 1
            ? h('button', {
              type: 'button',
              className: 'vfsm-btn vfsm-btn-sm' + (allView ? ' is-on' : ''),
              'aria-pressed': allView,
              onClick: () => (allView ? selectFsm(activeIndex) : showAll()),
            }, t('viewAll'))
            : null,
          h('button', {
            type: 'button',
            className: 'vfsm-btn vfsm-btn-sm' + (numbering ? ' is-on' : ''),
            'aria-pressed': numbering,
            onClick: toggleNumbering,
          }, t('labelNumber')),
          allView
            ? null
            : h('button', { type: 'button', className: 'vfsm-btn vfsm-btn-sm', onClick: toggleTable, disabled: current === null }, showTable ? t('hideTable') : t('table')),
          h('button', {
            type: 'button',
            className: 'vfsm-btn vfsm-btn-sm' + (isFullscreen ? ' is-on' : ''),
            'aria-pressed': isFullscreen,
            onClick: toggleFullscreen,
          }, isFullscreen ? t('exitFullscreen') : t('fullscreen')),
          allView || current === null
            ? null
            : h('button', { type: 'button', className: 'vfsm-btn vfsm-btn-sm vfsm-btn-primary', onClick: () => downloadSvgFor(current, diagram) }, t('download'))))

      const miniCards = allCards.map((card, cardIndex) => {
        const head = h('div', { className: 'vfsm-mini-head' },
          h('div', { className: 'vfsm-mini-title', title: card.fsm.id }, card.fsm.moduleName + ' · ' + card.fsm.stateVar),
          h('div', { className: 'vfsm-mini-tools' },
            h('button', {
              type: 'button', className: 'vfsm-btn vfsm-btn-sm',
              onClick: () => selectFsm(fsms.indexOf(card.fsm)),
            }, t('fsmView')),
            h('button', {
              type: 'button', className: 'vfsm-btn vfsm-btn-sm',
              onClick: () => downloadSvgFor(card.fsm, card.diagram),
            }, t('download'))))
        const canvas = h('div', {
          className: 'vfsm-mini-canvas',
          onClick: (event) => onMiniCanvasClick(card, event),
          dangerouslySetInnerHTML: { __html: card.svg },
        })
        const meta = h('div', { className: 'vfsm-mini-meta' },
          card.fsm.states.length + ' ' + t('states') + ' · '
          + card.fsm.transitions.length + ' ' + t('transitions'))
        return h('div', { className: 'vfsm-mini', key: card.fsm.id + ':' + cardIndex }, head, canvas, meta)
      })
      const allViewBody = h('div', { className: 'vfsm-canvas vfsm-canvas-all' },
        h('div', { className: 'vfsm-all-grid' }, miniCards))
      const singleViewBody = h('div', {
        className: 'vfsm-canvas',
        ref: viewport,
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel,
      },
      empty,
      current === null
        ? null
        : h('div', {
          className: 'vfsm-canvas-inner',
          style: { transform: 'translate(' + pan.x + 'px, ' + pan.y + 'px) scale(' + zoom + ')' },
          dangerouslySetInnerHTML: { __html: svg },
        }))

      const metaBar = allView
        ? h('div', { className: 'vfsm-meta' },
          h('span', { className: 'vfsm-tag vfsm-tag-accent', key: 'all' }, t('fsmCount', { count: fsms.length })),
          h('span', { className: 'vfsm-hint-inline vfsm-muted', key: 'hint' }, t('selectHint')))
        : (current === null ? null : h('div', { className: 'vfsm-meta' }, statusTags))

      const warningBar = warnings.length > 0
        ? h('div', { className: 'vfsm-warnings' }, warnings.slice(0, 4).map((warning, index) => {
          const text = warningText(warning)
          return h('div', { key: index, title: text }, t('warning') + ': ' + text)
        }))
        : null

      const stateTableView = !allView && current !== null && showTable
        ? h('div', { className: 'vfsm-table-wrap' },
          h('table', { className: 'vfsm-table' },
            h('thead', null, h('tr', null,
              h('th', null, t('stState')),
              h('th', null, t('encoding')),
              h('th', null, t('stTransitions')))),
            h('tbody', null, tableRows)))
        : null

      const viewBody = h('div', {
        className: 'vfsm-pane vfsm-view' + (isFullscreen ? ' is-fullscreen' : ''),
        ref: viewPane,
      },
        viewHead,
        metaBar,
        allView ? allViewBody : singleViewBody,
        warningBar,
        stateTableView)

      return h('div', { className: 'vfsm-page' },
        h('style', null, PAGE_CSS),
        h('header', { className: 'vfsm-header' },
          h('div', { className: 'vfsm-brand' },
            h('span', { className: 'vfsm-logo' }, h(PanelGlyph, { size: 24 })),
            h('div', { className: 'vfsm-brand-text' },
              h('h1', { className: 'vfsm-title' }, t('title')),
              h('p', { className: 'vfsm-subtitle' }, t('subtitle')))),
          h('div', { className: 'vfsm-actions' },
            h('div', { className: 'vfsm-seg' },
              h('button', {
                type: 'button',
                className: 'vfsm-seg-btn' + (mode === 'code' ? ' is-active' : ''),
                onClick: () => switchMode('code'),
              }, t('modeCode')),
              h('button', {
                type: 'button',
                className: 'vfsm-seg-btn' + (mode === 'table' ? ' is-active' : ''),
                onClick: () => switchMode('table'),
              }, t('modeTable'))),
            h('button', {
              type: 'button',
              className: 'vfsm-btn',
              onClick: () => { if (fileInput.current !== null) fileInput.current.click() },
            }, t('openFile')),
            h('input', {
              ref: fileInput, type: 'file', accept: '.v,.sv,.vh,.txt', style: { display: 'none' },
              onChange: onFilePicked,
            }),
            h('button', { type: 'button', className: 'vfsm-btn', onClick: loadSample }, t('sample')))),
        h('div', { className: 'vfsm-main' },
          h('section', { className: 'vfsm-pane vfsm-source' },
            h('div', { className: 'vfsm-pane-head' },
              h('span', null, mode === 'table' ? t('tableTitle') : t('source')),
              h('span', { className: 'vfsm-file', title: table.moduleName },
                mode === 'table' ? table.moduleName : (fileName === '' ? t('untitled') : fileName))),
            sourcePaneBody,
            h('div', { className: 'vfsm-source-foot' },
              h('span', { className: 'vfsm-hint', title: mode === 'table' ? t('tableHint') : t('hint') },
                mode === 'table' ? t('tableHint') : t('hint')),
              mode === 'code'
                ? h('button', { type: 'button', className: 'vfsm-btn vfsm-btn-sm', onClick: clearSource }, t('clear'))
                : null)),
          viewBody))
    }

    /** Values persisted while the panel is unmounted by panel navigation. */
    const sessionState = {
      code: SAMPLE_CODE,
      fileName: '',
      fsmIndex: 0,
      showTable: true,
      mode: 'code',
      viewAll: false,
      numbering: false,
      edgeModes: {},
      showVerilog: true,
      table: createDefaultTable(),
    }

    /** Ordered edge palette; incident edges pick different slots. */
    const EDGE_PALETTE_SIZE = 12
    const LIGHT_EDGE_PALETTE = [
      '#1d4ed8', '#b45309', '#15803d', '#6d28d9', '#0e7490', '#be185d',
      '#0f766e', '#a16207', '#b91c1c', '#4338ca', '#4d7c0f', '#475569',
    ]
    const DARK_EDGE_PALETTE = [
      '#93c5fd', '#fbbf24', '#4ade80', '#c4b5fd', '#67e8f9', '#f9a8d4',
      '#5eead4', '#fde047', '#fca5a5', '#a5b4fc', '#bef264', '#cbd5e1',
    ]
    const DEFAULT_EDGE_PALETTE = LIGHT_EDGE_PALETTE
    const CSS_EDGE_PALETTE = LIGHT_EDGE_PALETTE.map((fallback, index) =>
      'var(--vfsm-edge-' + index + ', ' + fallback + ')')

    /** Resolve the live palette into literal colours for a downloaded SVG. */
    function readEdgePalette() {
      if (typeof document === 'undefined') return LIGHT_EDGE_PALETTE
      const page = document.querySelector('.vfsm-page')
      if (page === null) return LIGHT_EDGE_PALETTE
      const styles = window.getComputedStyle(page)
      return LIGHT_EDGE_PALETTE.map((fallback, index) => {
        const value = styles.getPropertyValue('--vfsm-edge-' + index).trim()
        return value === '' ? fallback : value
      })
    }

    /** Theme-variable palette for the live SVG, so theme switches need no re-render. */
    const CSS_COLORS = {
      surface: 'var(--dsw-alias-bg-base)',
      node: 'var(--dsw-alias-bg-layer-2, #f7f8fa)',
      border: 'var(--dsw-alias-border-l2, #d0d5dd)',
      borderSoft: 'var(--dsw-alias-border-l1, #e4e7ec)',
      text: 'var(--dsw-alias-label-primary, #101828)',
      muted: 'var(--dsw-alias-label-secondary, #667085)',
      accent: 'var(--dsw-alias-brand-primary, #2563eb)',
      labelBg: 'var(--dsw-alias-bg-layer-1, #ffffff)',
    }

    // =====================================================================
    // Browser plugin registration
    // =====================================================================

    /** Contribute the sidebar entry and the main panel it opens. */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), 'verilog-fsm: dictionaries')
      const t = ctx.locale.bind(NS)
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 12,
        label: () => t('panel'),
        locale: NS,
      }, PanelGlyph))
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
      }, VerilogFsmPage))
    }

    return {
      inject: ['slots', 'locale'],
      apply,
      __internals: {
        tokenize,
        parseVerilog,
        layoutFsm,
        svgDocument,
        wrapLabel,
        buildConditionNumbering,
        generateVerilogFromTable,
        parseTransitionTableText,
        sanitizeIdentifier,
        createDefaultTable,
        sessionState,
      },
    }
  },
})
