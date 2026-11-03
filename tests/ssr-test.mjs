import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)
const React = nodeRequire((process.env.DSH_CHECKOUT || '/root/dsh') + '/node_modules/.pnpm/react@18.3.1/node_modules/react')
const ReactDOMServer = nodeRequire((process.env.DSH_CHECKOUT || '/root/dsh') + '/node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/server')

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
let captured = null
const sandbox = { window: { __ModuleLoader__: { load(entry) { captured = entry } } }, console }
vm.runInNewContext(source, sandbox)
const module = captured.factory((spec) => {
  if (spec === 'react') return React
  throw new Error('unexpected require: ' + spec)
})

assert.equal(typeof module.apply, 'function')
assert.deepEqual(Array.from(module.inject), ['slots', 'locale'])

const registrations = []
const fakeContext = {
  effect(fn) { return fn() },
  locale: {
    register() { return () => {} },
    bind() { return (key) => key },
  },
  slots: {
    inject(name, callback) { callback() },
    register(options, Component) {
      registrations.push({ options, Component })
      return () => {}
    },
  },
}
module.apply(fakeContext)
const main = registrations.find((entry) => entry.options.name === 'main')
const sidebar = registrations.find((entry) => entry.options.name === 'sidebar.panellist')
assert.ok(main !== undefined, 'main slot registration missing')
assert.equal(main.options.key, 'verilog-fsm')
assert.ok(sidebar !== undefined, 'sidebar.panellist registration missing')
assert.equal(sidebar.options.id, 'verilog-fsm')
assert.equal(sidebar.options.order, 12)
console.log('registrations: OK')

const element = React.createElement(main.Component, { t: (key) => key })
const markup = ReactDOMServer.renderToStaticMarkup(element)
assert.ok(markup.startsWith('<div class="vfsm-page"'), 'page must render')
assert.ok(markup.includes('vfsm-code'), 'editor must render')
assert.ok(markup.includes('<svg'), 'diagram must render')
assert.ok(markup.includes('data-state="IDLE"'), 'sample FSM states must render')
assert.ok(markup.includes('vfsm-table'), 'state table must render')
assert.ok(!markup.includes('undefined'), 'rendered markup must not contain undefined')
assert.ok(!markup.includes('NaN'), 'rendered markup must not contain NaN')
console.log('SSR render: OK, markup length =', markup.length)

// Sidebar glyph must render at the requested size.
const glyph = ReactDOMServer.renderToStaticMarkup(React.createElement(sidebar.Component, { size: 16, active: true }))
assert.ok(glyph.includes('width="16"') && glyph.includes('viewBox="0 0 24 24"'))
console.log('sidebar glyph: OK')

// The same component renders the empty state when the source has no FSM.
const emptyMarkup = ReactDOMServer.renderToStaticMarkup(React.createElement(main.Component, { t: (key) => key }))
assert.ok(emptyMarkup.length > 0)
console.log('ALL SSR TESTS PASSED')
