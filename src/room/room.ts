/**
 * Compatibility entry point. The room reducer is split into:
 *   types.ts      state shapes and createRoom
 *   selectors.ts  pure lookups and eligibility predicates
 *   commands.ts   apply(), command handlers and the version rule
 *   view.ts       per-viewer projection (redaction lives here)
 *
 * New code may import from './index.ts' directly; existing imports from
 * './room.ts' keep working through this re-export.
 */
export * from './index.ts'
