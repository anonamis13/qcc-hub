import Database from 'better-sqlite3';
import path from 'path';

// Define interfaces for database results
interface CacheRow {
  data: string;
  timestamp: number;
}

interface CacheStats {
  count: number;
  keys: string;
}

// Initialize SQLite database
const dbPath = process.env.RENDER_INTERNAL_PATH 
  ? path.join(process.env.RENDER_INTERNAL_PATH, 'cache.db')
  : path.join(__dirname, 'cache.db');

let db: Database.Database;

try {
  db = new Database(dbPath);
  
  // Create tables if they don't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    )
  `);
} catch (error) {
  console.error('Failed to initialize SQLite database:', error);
  throw error;
}

// Helper functions for database operations
export const dbCache = {
  set: <T>(key: string, data: T, ttlMinutes: number = 60): void => {
    try {
      const timestamp = Date.now();
      const stmt = db.prepare('INSERT OR REPLACE INTO cache (key, data, timestamp) VALUES (?, ?, ?)');
      stmt.run(key, JSON.stringify(data), timestamp);
    } catch (error) {
      console.error(`Failed to set cache for key ${key}:`, error);
      throw error;
    }
  },

  get: <T>(key: string, ttlMinutes: number = 60): T | null => {
    try {
      const stmt = db.prepare('SELECT data, timestamp FROM cache WHERE key = ?');
      const row = stmt.get(key) as CacheRow | undefined;

      if (!row) return null;

      // Check if data is expired
      const age = Date.now() - row.timestamp;
      if (age > ttlMinutes * 60 * 1000) {
        // Data is expired, delete it
        const deleteStmt = db.prepare('DELETE FROM cache WHERE key = ?');
        deleteStmt.run(key);
        return null;
      }

      return JSON.parse(row.data) as T;
    } catch (error) {
      console.error(`Failed to get cache for key ${key}:`, error);
      return null;
    }
  },

  getTimestamp: (key: string): number | null => {
    try {
      const stmt = db.prepare('SELECT timestamp FROM cache WHERE key = ?');
      const row = stmt.get(key) as { timestamp: number } | undefined;
      return row ? row.timestamp : null;
    } catch (error) {
      console.error(`Failed to get timestamp for key ${key}:`, error);
      return null;
    }
  },

  clear: (): void => {
    try {
      const stmt = db.prepare('DELETE FROM cache');
      stmt.run();
    } catch (error) {
      console.error('Failed to clear cache:', error);
      throw error;
    }
  },

  getStats: (): { size: number; keys: string[] } => {
    try {
      const stmt = db.prepare('SELECT COUNT(*) as count, GROUP_CONCAT(key) as keys FROM cache');
      const result = stmt.get() as CacheStats | undefined;
      return {
        size: result?.count || 0,
        keys: (result?.keys || '').split(',').filter(Boolean)
      };
    } catch (error) {
      console.error('Failed to get cache stats:', error);
      return { size: 0, keys: [] };
    }
  }
}; 