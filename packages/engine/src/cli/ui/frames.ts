/**
 * Spinner frame sets (1.4), keyed by use case so the animation reads as
 * the operation (user requirement: animated symbols per use case). Frame
 * data vendored from cli-spinners (MIT, Sindre Sorhus) — pure glyph
 * arrays, no code taken. The brand pulse is a ping-pong over the
 * · ✢ ✳ ✶ ✻ ✽ set with doubled endpoints, a fixed-interval approximation
 * of the raised-cosine easing Claude Code uses (holds longest at rest and
 * full bloom).
 */

export interface FrameSet {
  frames: string[]
  intervalMs: number
}

/** Braille sweep — reading/folding/scanning. */
export const DOTS: FrameSet = {
  frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  intervalMs: 80,
}

/** Filling bar — writes/installs landing on disk. */
export const GROW_VERTICAL: FrameSet = {
  frames: ['▁', '▃', '▄', '▅', '▆', '▇', '▆', '▅', '▄', '▃'],
  intervalMs: 120,
}

/** Packet in flight — network operations. */
export const POINT: FrameSet = {
  frames: ['∙∙∙', '●∙∙', '∙●∙', '∙∙●', '∙∙∙'],
  intervalMs: 125,
}

/** Brand pulse — sofar itself thinking (ping-pong, eased-ish endpoints). */
export const BRAND_PULSE: FrameSet = {
  frames: ['·', '·', '✢', '✳', '✶', '✻', '✽', '✽', '✻', '✶', '✳', '✢'],
  intervalMs: 120,
}

/** Pure-ASCII fallbacks (legacy conhost, TERM=linux). */
export const LINE: FrameSet = {
  frames: ['-', '\\', '|', '/'],
  intervalMs: 130,
}

export const BOUNCING_BAR: FrameSet = {
  frames: [
    '[    ]',
    '[=   ]',
    '[==  ]',
    '[=== ]',
    '[====]',
    '[ ===]',
    '[  ==]',
    '[   =]',
  ],
  intervalMs: 80,
}

export type SpinnerUseCase = 'scan' | 'write' | 'network' | 'brand'

export function framesFor(useCase: SpinnerUseCase, unicode: boolean): FrameSet {
  if (!unicode) return useCase === 'write' ? BOUNCING_BAR : LINE
  switch (useCase) {
    case 'scan':
      return DOTS
    case 'write':
      return GROW_VERTICAL
    case 'network':
      return POINT
    case 'brand':
      return BRAND_PULSE
  }
}
