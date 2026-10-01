import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// Private owner metadata only. R2 holds the bytes; no public listing is derived from this table.
export const cloudFiles = sqliteTable('lct_cloud_files', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull(),
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
  check('lct_cloud_files_kind_check', sql`${table.kind} in ('file', 'threads', 'audio')`),
  check('lct_cloud_files_state_check', sql`${table.state} in ('staging', 'ready', 'deleting')`),
  check('lct_cloud_files_byte_size_check', sql`${table.byteSize} > 0`),
]);
