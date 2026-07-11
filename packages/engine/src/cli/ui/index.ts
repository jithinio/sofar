/**
 * cli/ui — zero-dependency terminal UI kernel (cli-ui Phase 1, D2).
 * Human-facing CLI surfaces only: the agent-facing surfaces (renderStatus
 * digest, hook stdout, export/import NDJSON, mcp stdio) must never import
 * from here.
 */

export { detectCaps, stdoutCaps, stderrCaps, type Caps, type CapsInput } from './caps'
export { createStyle, type Style, type Format } from './style'
export { symbolsFor, type Symbols } from './symbols'
export {
  stripAnsi,
  visibleWidth,
  padEndVisible,
  padStartVisible,
  truncatePlain,
  columnsOf,
} from './text'
export {
  framesFor,
  DOTS,
  GROW_VERTICAL,
  POINT,
  BRAND_PULSE,
  LINE,
  BOUNCING_BAR,
  type FrameSet,
  type SpinnerUseCase,
} from './frames'
export { createSpinner, type Spinner, type SpinnerOptions, type SpinnerStream } from './spinner'
