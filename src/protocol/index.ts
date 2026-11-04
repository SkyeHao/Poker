/**
 * Wire protocol and shared command contracts.
 *
 * Every schema in this module is the single source of truth for one type:
 * the runtime Zod schema validates untrusted input, and `z.infer` produces the
 * TypeScript type used by the server, the room reducer, and the client.
 *
 * The client must import these types with `import type` so the Zod runtime is
 * never pulled into the browser bundle.
 */
import { z } from 'zod'
import { MAX_SEATS, PLAYER_ACTIONS } from '../engine/game.ts'

export const SeatIndexSchema = z.number().int().min(0).max(MAX_SEATS - 1)

export const PlayerActionSchema = z.enum(PLAYER_ACTIONS)

export const AdminActorSchema = z.object({
  kind: z.enum(['account', 'tableKey']),
  label: z.string(),
})
export type AdminActor = z.infer<typeof AdminActorSchema>

/**
 * Card cosmetics are free-form asset ids (`''` = the built-in look). The room
 * never learns which art exists: the server publishes a manifest from the
 * optional art directory, and the client ignores ids it cannot resolve.
 */
const ArtIdSchema = z.string().max(40).regex(/^[a-z0-9-]*$/)

export const CosmeticsSchema = z.object({
  back: ArtIdSchema,
  faces: z.object({
    spades: ArtIdSchema,
    hearts: ArtIdSchema,
    clubs: ArtIdSchema,
    diamonds: ArtIdSchema,
  }),
})
export type Cosmetics = z.infer<typeof CosmeticsSchema>

export const InviteRecordSchema = z.object({
  id: z.string(),
  codeHash: z.string(),
  label: z.string(),
  nickname: z.string().nullable(),
  maxUses: z.number().int(),
  usedCount: z.number().int(),
  expiresAt: z.number().nullable(),
  revoked: z.boolean(),
  createdAt: z.number(),
  createdBy: z.string(),
})
export type InviteRecord = z.infer<typeof InviteRecordSchema>

/** Invite fields safe to show to the administrator (the code hash stays private). */
export type InviteMeta = Omit<InviteRecord, 'codeHash'>

/**
 * Every state transition accepted by the room reducer. Join and authenticate
 * arrive over HTTP; reconnect/disconnect are emitted by the WebSocket layer;
 * admin commands arrive over HTTP (account) or WebSocket (table key).
 */
export const RoomCommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('join'),
    name: z.string(),
    pinHash: z.string(),
    tokenHash: z.string(),
    inviteCodeHash: z.string().nullable(),
    seat: SeatIndexSchema.nullable(),
  }),
  z.object({ type: z.literal('authenticate'), playerId: z.string(), tokenHash: z.string() }),
  z.object({ type: z.literal('reconnect'), playerId: z.string() }),
  z.object({ type: z.literal('disconnect'), playerId: z.string() }),
  z.object({ type: z.literal('sit'), playerId: z.string(), seat: SeatIndexSchema }),
  z.object({ type: z.literal('stand'), playerId: z.string() }),
  z.object({ type: z.literal('ready'), playerId: z.string() }),
  z.object({ type: z.literal('setCosmetics'), playerId: z.string(), cosmetics: CosmeticsSchema }),
  z.object({
    type: z.literal('act'),
    playerId: z.string(),
    handId: z.string(),
    version: z.number().int().nonnegative(),
    action: PlayerActionSchema,
    raiseTo: z.number().int().positive().optional(),
  }),
  z.object({ type: z.literal('adminRedeal'), actor: AdminActorSchema }),
  z.object({ type: z.literal('adminResetTable'), actor: AdminActorSchema }),
  z.object({ type: z.literal('adminResetRoom'), actor: AdminActorSchema }),
  z.object({ type: z.literal('adminTopUp'), actor: AdminActorSchema, playerId: z.string(), amount: z.number().int().positive() }),
  z.object({ type: z.literal('adminSetStack'), actor: AdminActorSchema, playerId: z.string(), stack: z.number().int().nonnegative() }),
  z.object({ type: z.literal('adminKick'), actor: AdminActorSchema, playerId: z.string() }),
  z.object({ type: z.literal('adminPause'), actor: AdminActorSchema, paused: z.boolean() }),
  z.object({ type: z.literal('adminForceAction'), actor: AdminActorSchema, playerId: z.string(), action: z.enum(['fold', 'check']) }),
  z.object({ type: z.literal('adminSetBlinds'), actor: AdminActorSchema, smallBlind: z.number().int().positive(), bigBlind: z.number().int().positive() }),
  z.object({ type: z.literal('adminSetStartingStack'), actor: AdminActorSchema, startingStack: z.number().int().positive() }),
  z.object({ type: z.literal('adminCreateInvite'), actor: AdminActorSchema, invite: InviteRecordSchema }),
  z.object({ type: z.literal('adminRevokeInvite'), actor: AdminActorSchema, inviteId: z.string() }),
  z.object({ type: z.literal('adminDeleteInvite'), actor: AdminActorSchema, inviteId: z.string() }),
  z.object({ type: z.literal('adminRevokeAllInvites'), actor: AdminActorSchema }),
  z.object({ type: z.literal('adminSetJoinOpen'), actor: AdminActorSchema, joinOpen: z.boolean() }),
  z.object({ type: z.literal('adminSetTableCosmetics'), actor: AdminActorSchema, cosmetics: CosmeticsSchema.nullable() }),
])
export type RoomCommand = z.infer<typeof RoomCommandSchema>

/** In-table emergency controls unlocked with TABLE_ADMIN_KEY. */
export const AdminCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('redeal') }),
  z.object({ type: z.literal('resetTable') }),
  z.object({ type: z.literal('topUp'), playerId: z.string().min(1), amount: z.number().int().positive() }),
  z.object({ type: z.literal('setStack'), playerId: z.string().min(1), stack: z.number().int().nonnegative() }),
  z.object({ type: z.literal('kick'), playerId: z.string().min(1) }),
  z.object({ type: z.literal('pause'), paused: z.boolean() }),
  z.object({ type: z.literal('forceAction'), playerId: z.string().min(1), action: z.enum(['fold', 'check']) }),
  z.object({ type: z.literal('setBlinds'), smallBlind: z.number().int().positive(), bigBlind: z.number().int().positive() }),
  z.object({ type: z.literal('setStartingStack'), startingStack: z.number().int().positive() }),
  z.object({ type: z.literal('setTableCosmetics'), cosmetics: CosmeticsSchema.nullable() }),
])
export type AdminCommand = z.infer<typeof AdminCommandSchema>

/** Browser → server WebSocket frames. */
export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('sit'), seat: SeatIndexSchema }),
  z.object({ type: z.literal('stand') }),
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('setCosmetics'), cosmetics: CosmeticsSchema }),
  z.object({
    type: z.literal('act'),
    handId: z.string().min(1).max(64),
    version: z.number().int().nonnegative(),
    action: PlayerActionSchema,
    raiseTo: z.number().int().positive().optional(),
  }),
  z.object({ type: z.literal('adminUnlock'), key: z.string().min(1).max(256) }),
  z.object({ type: z.literal('admin'), command: AdminCommandSchema }),
])
export type ClientMessage = z.infer<typeof ClientMessageSchema>

/** POST /api/join */
export const JoinRequestSchema = z.object({
  name: z.string().min(1).max(64),
  pin: z.string().regex(/^\d{4}$/),
  invite: z.string().min(1).max(256).optional(),
  seat: SeatIndexSchema.nullable().optional(),
})
export type JoinInput = z.infer<typeof JoinRequestSchema>

/** POST /api/admin/login */
export const AdminLoginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
})
export type AdminLoginInput = z.infer<typeof AdminLoginSchema>

/** POST /api/admin/invites */
export const InviteCreateSchema = z.object({
  label: z.string().max(80).optional(),
  nickname: z.string().max(24).nullable().optional(),
  maxUses: z.number().int().min(1).max(1000).optional(),
  expiresInHours: z.number().int().min(1).max(24 * 365).optional(),
})
export type CreateInviteInput = z.infer<typeof InviteCreateSchema>

/** POST /api/admin/room/reset */
export const ResetRoomSchema = z.object({ confirm: z.literal('RESET') })

/** POST /api/admin/room/open */
export const JoinOpenSchema = z.object({ joinOpen: z.boolean() })

/** Route params for POST /api/admin/invites/:id/revoke */
export const InviteIdParamsSchema = z.object({ id: z.string().min(1) })
