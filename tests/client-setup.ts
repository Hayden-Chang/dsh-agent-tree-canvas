/** Browser primitives needed by pure client behavior fixtures. */
import { vi } from 'vitest'
if (typeof requestAnimationFrame === 'undefined') {
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => setTimeout(() => run(performance.now()), 0))
  vi.stubGlobal('cancelAnimationFrame', clearTimeout)
}
