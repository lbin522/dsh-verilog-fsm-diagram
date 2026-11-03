/**
 * Host half of the Verilog FSM diagram bundle.
 *
 * All work happens in the browser: the Client module owns the sidebar entry,
 * the FSM parser, and the SVG renderer. This Host row exists so the bundle is
 * a normal profile plugin; it registers no services and starts nothing.
 */
export function apply() {}
