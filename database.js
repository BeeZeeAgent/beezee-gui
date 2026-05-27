import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
import { initSchema } from './database-schema.js';
import { migrateFromJson, migrateToACP, migrateConversationColumns } from './database-migrations.js';
import { migrateACPSchema, migrateBackfillMessages, migrateFTS, migrateAutoVacuum } from './database-migrations-acp.js';
// db-queries layer removed; queries is now a no-op proxy. History is served by ccsniff.
function createQueries(db) {
  const noop = () => undefined;
  const target = {
    _db: db,
    cleanup: noop,
    cleanupEmptyConversations: () => 0,
    cleanupOrphanedSessions: () => 0,
    clearAllStreamingFlags: () => 0,
    getStreamingConversations: () => [],
    getResumableConversations: () => [],
    getActiveSessions: () => [],
    getSessionsProcessingLongerThan: () => [],
    getConversationsList: () => [],
    getConversation: () => null,
    getSession: () => null,
    getLatestSession: () => null,
    getAllSessions: () => [],
    getStreamChunks: () => [],
    getExecutionEvents: () => [],
    searchAgents: () => [],
  };
  return new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === 'symbol') return undefined;
      return () => undefined;
    },
  });
}

const require = createRequire(import.meta.url);

function getDataDir() {
  if (process.env.PORTABLE_DATA_DIR) return process.env.PORTABLE_DATA_DIR;
  const exeDir = process.pkg?.path ? path.dirname(process.pkg.path) : null;
  if (exeDir) return path.join(exeDir, 'data');
  if (process.env.BUN_BE_BUN && process.argv[1]) return path.join(path.dirname(process.argv[1]), 'data');
  return path.join(os.homedir(), '.gmgui');
}

export const dataDir = getDataDir();
const dbDir = dataDir;
const dbFilePath = path.join(dbDir, 'data.db');
const oldJsonPath = path.join(dbDir, 'data.json');

if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

let db;
try {
  const Database = (await import('bun:sqlite')).default;
  db = new Database(dbFilePath);
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');
  db.run('PRAGMA encoding = "UTF-8"');
  db.run('PRAGMA synchronous = NORMAL');
  db.run('PRAGMA busy_timeout = 5000');
  db.run('PRAGMA cache_size = -64000');
  db.run('PRAGMA mmap_size = 268435456');
  db.run('PRAGMA temp_store = MEMORY');
  db.run('PRAGMA auto_vacuum = INCREMENTAL');
} catch (e) {
  try {
    const sqlite3 = require('better-sqlite3');
    db = new sqlite3(dbFilePath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('encoding = "UTF-8"');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('cache_size = -64000');
    db.pragma('mmap_size = 268435456');
    db.pragma('temp_store = MEMORY');
    db.pragma('auto_vacuum = INCREMENTAL');
  } catch (e2) {
    throw new Error('SQLite database is required. Please run with bun (recommended) or install better-sqlite3: npm install better-sqlite3');
  }
}

initSchema(db);
migrateFromJson(db, oldJsonPath);
migrateToACP(db);
migrateConversationColumns(db);
migrateACPSchema(db);
migrateBackfillMessages(db);
migrateFTS(db);
migrateAutoVacuum(db);

const stmtCache = new Map();
function prep(sql) {
  let s = stmtCache.get(sql);
  if (!s) { s = db.prepare(sql); stmtCache.set(sql, s); }
  return s;
}

function generateId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export const queries = createQueries(db);

export default { queries };
