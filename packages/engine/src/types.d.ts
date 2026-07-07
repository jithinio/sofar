/**
 * Ambient module declarations for non-TS imports.
 *
 * .sh imports are hook shim sources bundled as TEXT: esbuild uses
 * `loader: { '.sh': 'text' }` (build.mjs) and vitest mirrors it with the
 * sh-as-text plugin in the root vitest.config.ts. Only dist/ ships, so
 * `sofar init` must carry the shim bytes inside the bundle — it never
 * reads them from the package directory at runtime.
 */
declare module '*.sh' {
  const text: string
  export default text
}
