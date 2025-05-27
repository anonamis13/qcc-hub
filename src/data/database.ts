import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

// Define interfaces for database results
interface CacheRow {
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

// Initialize SQLite database
const dbPath = process.env.RENDER_INTERNAL_PATH 
  ? path.join(process.env.RENDER_INTERNAL_PATH, 'cache.db')
  : path.join(__dirname, 'cache.db');

let db: Database.Database;

const cacheStore = new Map<string, { data: any; timestamp: number }>();

export const dbCache = {
  set: <T>(key: string, data: T, ttlMinutes: number = 60): void => {
    try {
      const timestamp = Date.now();
      cacheStore.set(key, { data, timestamp });
    } catch (error) {
      console.error(`Failed to set cache for key ${key}:`, error);
      throw error;
    }
  },

  get: <T>(key: string, ttlMinutes: number = 60): T | null => {
    try {
      const entry = cacheStore.get(key);
      if (!entry) return null;

      // Check if data is expired
      const age = Date.now() - entry.timestamp;
      if (age > ttlMinutes * 60 * 1000) {
        // Data is expired, delete it
        cacheStore.delete(key);
        return null;
      }

      return entry.data as T;
    } catch (error) {
      console.error(`Failed to get cache for key ${key}:`, error);
      return null;
    }
  },

  getTimestamp: (key: string): number | null => {
    try {
      const entry = cacheStore.get(key);
      return entry ? entry.timestamp : null;
    } catch (error) {
      console.error(`Failed to get timestamp for key ${key}:`, error);
      return null;
    }
  },

  clear: (): void => {
    try {
      cacheStore.clear();
    } catch (error) {
      console.error('Failed to clear cache:', error);
      throw error;
    }
  },

  getStats: (): { size: number; keys: string[] } => {
    try {
      return {
        size: cacheStore.size,
        keys: Array.from(cacheStore.keys())
      };
    } catch (error) {
      console.error('Failed to get cache stats:', error);
      return { size: 0, keys: [] };
    }
  }
}; 