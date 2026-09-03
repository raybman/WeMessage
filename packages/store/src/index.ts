// @wemessage/store — SQLite store + migrations (schema §2.3). Implements the
// `Store` port from @wemessage/core.
export { applyMigrations } from './migrate.js';
export {
  DB_FILENAME,
  SqliteStore,
  openStore,
  type OpenStoreOptions,
} from './store.js';
export { verifyAuditChain, type AuditRowsSource } from './verify-audit.js';
export { hashAdapterToken, verifyAdapterToken } from './token-hash.js';
