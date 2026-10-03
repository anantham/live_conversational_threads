import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// Private owner metadata only. R2 holds the bytes; no public listing is derived from this table.
export const cloudFiles = sqliteTable('lct_cloud_files', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull(),
  ownerProvider: text('owner_provider', { enum: ['chatgpt', 'google'] }).notNull().default('chatgpt'),
  objectKey: text('object_key').notNull(),
  kind: text('kind', { enum: ['file', 'threads', 'audio'] }).notNull(),
  title: text('title').notNull(),
  filename: text('filename').notNull(),
  contentType: text('content_type').notNull(),
  byteSize: integer('byte_size').notNull(),
  state: text('state', { enum: ['staging', 'ready', 'deleting'] }).notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => [
  uniqueIndex('lct_cloud_files_object_key_unique').on(table.objectKey),
  index('lct_cloud_files_owner_state_created_id_idx').on(table.ownerUserId, table.state, table.createdAt, table.id),
  index('lct_cloud_files_provider_owner_idx').on(table.ownerProvider, table.ownerUserId),
  check('lct_cloud_files_kind_check', sql`${table.kind} in ('file', 'threads', 'audio')`),
  check('lct_cloud_files_state_check', sql`${table.state} in ('staging', 'ready', 'deleting')`),
  check('lct_cloud_files_byte_size_check', sql`${table.byteSize} > 0`),
]);

// Revocable Google sessions; only stable subjects and random-token/nonce hashes.
// Used challenges remain until expiry, including after sign-out, to refuse replay.
export const googleSessions = sqliteTable('lct_google_sessions', {
  jtiHash: text('jti_hash').primaryKey(),
  googleSub: text('google_sub').notNull(),
  challengeHash: text('challenge_hash').notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  revokedAt: integer('revoked_at'),
}, (table) => [
  uniqueIndex('lct_google_sessions_challenge_unique').on(table.challengeHash),
  index('lct_google_sessions_sub_idx').on(table.googleSub),
  index('lct_google_sessions_expiry_idx').on(table.expiresAt),
]);

// Anonymous write fences retain only random object keys; never identity or file metadata.
export const fileFences = sqliteTable('lct_cloud_file_fences', {
  objectKey: text('object_key').primaryKey(),
  createdAt: integer('created_at').notNull(),
});

// Bounded anonymous admission receipts only; no key, identity, transcript or audio.
export const sonioxSessions = sqliteTable('lct_soniox_sessions', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  maxSessionSeconds: integer('max_session_seconds').notNull(),
  leaseUntil: integer('lease_until'),
}, (table) => [
  index('lct_soniox_sessions_created_idx').on(table.createdAt),
  check('lct_soniox_sessions_duration_check', sql`${table.maxSessionSeconds} >= 15 and ${table.maxSessionSeconds} <= 900`),
]);

// Provider admission metadata only; unknown completion retains its concurrency slot.
export const openRouterAttempts = sqliteTable('lct_openrouter_attempts', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  maxOutputTokens: integer('max_output_tokens').notNull(),
  completedAt: integer('completed_at'),
}, (table) => [
  index('lct_openrouter_attempts_created_idx').on(table.createdAt),
  check('lct_openrouter_attempts_tokens_check', sql`${table.maxOutputTokens} >= 1 and ${table.maxOutputTokens} <= 8192`),
]);

// Explicit guest publications only; never populated from private or local files.
export const publicThreads = sqliteTable('lct_public_threads', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  payload: text('payload'),
  byteSize: integer('byte_size').notNull(),
  nodeCount: integer('node_count').notNull(),
  deleteHash: text('delete_hash').notNull(),
  payloadHash: text('payload_hash'),
  state: text('state', { enum: ['ready', 'removed'] }).notNull(),
  createdAt: integer('created_at').notNull(),
}, (table) => [
  index('lct_public_threads_state_created_id_idx').on(table.state, table.createdAt, table.id),
  index('lct_public_threads_created_idx').on(table.createdAt),
  check('lct_public_threads_state_check', sql`${table.state} in ('ready', 'removed')`),
  check('lct_public_threads_payload_check', sql`(${table.state} = 'ready' and ${table.payload} is not null and ${table.payloadHash} is not null and ${table.byteSize} > 0 and ${table.byteSize} <= 524288) or (${table.state} = 'removed' and ${table.payload} is null and ${table.payloadHash} is null and ${table.byteSize} = 0 and ${table.nodeCount} = 0 and ${table.title} = '')`),
]);
