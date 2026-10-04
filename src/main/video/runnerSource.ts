// The render/inspect page, bundled with mediabunny into one script at build
// time (scripts/viteIifePlugin.ts) and served to the sandbox from memory.
import source from '../../videoRunner/runner?iife'

export const RUNNER_SOURCE: string = source
