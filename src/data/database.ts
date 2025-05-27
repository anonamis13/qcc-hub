import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

// Define interfaces for database results
interface CacheRow {
  key: string;
  data: string;
  timestamp: number;
}

interface CacheStats {
  count: number;
  keys: string;
}

// Helper to get __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Constants for data retention
const DAYS_TO_KEEP = 30;
const MS_IN_DAY = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // Run cleanup once per day

// Initialize SQLite database
// In Render, we should use the persistent disk mount path
// Locally, we'll use the same directory as before
const dbPath = process.env.RENDER 
  ? '/data/cache.db'  // This should match your Render disk mount path
  : path.join(__dirname, 'cache.db');

let db: Database.Database;

function cleanupOldData() {
  try {
    const db = initializeDb();
    const cutoffTime = Date.now() - (DAYS_TO_KEEP * MS_IN_DAY);
    
    // Delete records older than cutoff time
    const deleteStmt = db.prepare('DELETE FROM cache WHERE timestamp < ?');
    const result = deleteStmt.run(cutoffTime);
    
    console.log(`Cleaned up ${result.changes} old records from the database`);
  } catch (error) {
    console.error('Error during database cleanup:', error);
  }
}

function initializeDb() {
  if (!db) {
    console.log('Initializing SQLite database at:', dbPath);
    // Ensure the directory exists
    try {
      const dbDir = path.dirname(dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }
      
      db = new Database(dbPath);
      
      // Create cache table if it doesn't exist
      db.exec(`
        CREATE TABLE IF NOT EXISTS cache (
          key TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          timestamp INTEGER NOT NULL
        )
      `);
      
      // Run initial cleanup
      cleanupOldData();
      
      // Schedule regular cleanup
      setInterval(cleanupOldData, CLEANUP_INTERVAL);
      
      console.log('Successfully initialized SQLite database');
    } catch (error) {
      console.error('Error initializing database:', error);
      throw error;
    }
  }
  return db;
}

export const dbCache = {
  set: <T>(key: string, data: T, ttlMinutes: number = 60): void => {
    try {
      const db = initializeDb();
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
      const db = initializeDb();
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
      const db = initializeDb();
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
      const db = initializeDb();
      db.prepare('DELETE FROM cache').run();
    } catch (error) {
      console.error('Failed to clear cache:', error);
      throw error;
    }
  },

  getStats: (): { size: number; keys: string[] } => {
    try {
      const db = initializeDb();
      const countStmt = db.prepare('SELECT COUNT(*) as count FROM cache');
      const keysStmt = db.prepare('SELECT key FROM cache');
      
      const { count } = countStmt.get() as { count: number };
      const rows = keysStmt.all() as Array<{ key: string }>;
      const keys = rows.map(row => row.key);

      return {
        size: count,
        keys: keys
      };
    } catch (error) {
      console.error('Failed to get cache stats:', error);
      return { size: 0, keys: [] };
    }
  },

  // Expose cleanup function for manual triggering if needed
  cleanup: cleanupOldData
}; 