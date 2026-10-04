declare module '*.png?asset' {
  const src: string
  export default src
}

declare module '*.png' {
  const src: string
  export default src
}

/** A browser page bundled to one script by scripts/viteIifePlugin.ts. */
declare module '*?iife' {
  const source: string
  export default source
}
