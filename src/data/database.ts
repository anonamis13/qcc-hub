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
    

  } catch (error) {
    console.error('Error during database cleanup:', error);
  }
}

function initializeDb() {
  if (!db) {
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
      
      // Create membership snapshots table
      db.exec(`
        CREATE TABLE IF NOT EXISTS membership_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          date TEXT NOT NULL,
          group_id TEXT NOT NULL,
          group_name TEXT NOT NULL,
          person_id TEXT NOT NULL,
          person_first_name TEXT,
          person_last_name TEXT,
          role TEXT,
          timestamp INTEGER NOT NULL,
          UNIQUE(date, group_id, person_id)
        )
      `);
      
      // Create index for faster queries
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_membership_snapshots_date_group 
        ON membership_snapshots(date, group_id)
      `);
      
      // Run initial cleanup
      cleanupOldData();
      
      // Schedule regular cleanup
      setInterval(cleanupOldData, CLEANUP_INTERVAL);
      
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

      // Always return cached data if it exists
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
  cleanup: cleanupOldData,

  needsRefresh: (key: string, ttlMinutes: number = 60): boolean => {
    try {
      const db = initializeDb();
      const stmt = db.prepare('SELECT timestamp FROM cache WHERE key = ?');
      const row = stmt.get(key) as CacheRow | undefined;

      if (!row) return true;

      // Check if data is expired
      const age = Date.now() - row.timestamp;
      return age > ttlMinutes * 60 * 1000;
    } catch (error) {
      console.error(`Failed to check refresh status for key ${key}:`, error);
      return true;
    }
  }
};

// Add membership snapshot functions
export const membershipSnapshots = {
  // Store a daily snapshot of group memberships
  storeDailySnapshot: (date: string, groupId: string, groupName: string, memberships: any[]): void => {
    try {
      const db = initializeDb();
      const timestamp = Date.now();
      
      // First, delete any existing snapshot for this date/group combination
      const deleteStmt = db.prepare('DELETE FROM membership_snapshots WHERE date = ? AND group_id = ?');
      deleteStmt.run(date, groupId);
      
      // Insert new membership data
      const insertStmt = db.prepare(`
        INSERT INTO membership_snapshots 
        (date, group_id, group_name, person_id, person_first_name, person_last_name, role, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      const insertMany = db.transaction((memberships: any[]) => {
        for (const membership of memberships) {
          if (membership.person) {
            insertStmt.run(
              date,
              groupId,
              groupName,
              membership.personId,
              membership.person.firstName || '',
              membership.person.lastName || '',
              membership.role || '',
              timestamp
            );
          }
        }
      });
      
      insertMany(memberships);
    } catch (error) {
      console.error(`Failed to store membership snapshot for group ${groupId} on ${date}:`, error);
      throw error;
    }
  },

  // Get membership changes over a time period
  getMembershipChanges: (daysBack: number = 30): any => {
    try {
      const db = initializeDb();
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysBack);
      const cutoffDateStr = cutoffDate.toISOString().split('T')[0];
      
      // Get the most recent snapshot date for each group
      const latestSnapshotsStmt = db.prepare(`
        SELECT group_id, MAX(date) as latest_date
        FROM membership_snapshots 
        GROUP BY group_id
      `);
      const latestSnapshots = latestSnapshotsStmt.all() as Array<{group_id: string, latest_date: string}>;
      
      const changes = {
        joins: [] as any[],
        leaves: [] as any[],
        totalJoins: 0,
        totalLeaves: 0
      };
      
      for (const snapshot of latestSnapshots) {
        const groupId = snapshot.group_id;
        const latestDate = snapshot.latest_date;
        
        // Get current members (latest snapshot)
        const currentMembersStmt = db.prepare(`
          SELECT person_id, person_first_name, person_last_name, group_name
          FROM membership_snapshots 
          WHERE group_id = ? AND date = ?
        `);
        const currentMembers = currentMembersStmt.all(groupId, latestDate) as Array<{
          person_id: string,
          person_first_name: string,
          person_last_name: string,
          group_name: string
        }>;
        
        // Get members from the cutoff date (or closest date after cutoff)
        const pastMembersStmt = db.prepare(`
          SELECT person_id, person_first_name, person_last_name, group_name, date
          FROM membership_snapshots 
          WHERE group_id = ? AND date >= ?
          ORDER BY date ASC
          LIMIT 1
        `);
        const pastMembersResult = pastMembersStmt.all(groupId, cutoffDateStr);
        
        if (pastMembersResult.length === 0) continue; // No historical data for this group
        
        const comparisonDate = (pastMembersResult[0] as {date: string}).date;
        const pastMembersStmt2 = db.prepare(`
          SELECT person_id, person_first_name, person_last_name, group_name
          FROM membership_snapshots 
          WHERE group_id = ? AND date = ?
        `);
        const pastMembers = pastMembersStmt2.all(groupId, comparisonDate) as Array<{
          person_id: string,
          person_first_name: string,
          person_last_name: string,
          group_name: string
        }>;
        
        // Find joins (in current but not in past)
        const currentMemberIds = new Set(currentMembers.map(m => m.person_id));
        const pastMemberIds = new Set(pastMembers.map(m => m.person_id));
        
        const joins = currentMembers.filter(member => !pastMemberIds.has(member.person_id));
        const leaves = pastMembers.filter(member => !currentMemberIds.has(member.person_id));
        
        // Add to results
        changes.joins.push(...joins.map(member => ({
          personId: member.person_id,
          firstName: member.person_first_name,
          lastName: member.person_last_name,
          groupName: member.group_name,
          groupId: groupId,
          type: 'join'
        })));
        
        changes.leaves.push(...leaves.map(member => ({
          personId: member.person_id,
          firstName: member.person_first_name,
          lastName: member.person_last_name,
          groupName: member.group_name,
          groupId: groupId,
          type: 'leave'
        })));
      }
      
      changes.totalJoins = changes.joins.length;
      changes.totalLeaves = changes.leaves.length;
      
      return changes;
    } catch (error) {
      console.error('Failed to get membership changes:', error);
      return { joins: [], leaves: [], totalJoins: 0, totalLeaves: 0 };
    }
  },

  // Get the latest snapshot date
  getLatestSnapshotDate: (): string | null => {
    try {
      const db = initializeDb();
      const stmt = db.prepare('SELECT MAX(date) as latest_date FROM membership_snapshots');
      const result = stmt.get() as { latest_date: string | null } | undefined;
      return result?.latest_date || null;
    } catch (error) {
      console.error('Failed to get latest snapshot date:', error);
      return null;
    }
  },

  // Check if we have a snapshot for today
  hasSnapshotForDate: (date: string): boolean => {
    try {
      const db = initializeDb();
      const stmt = db.prepare('SELECT COUNT(*) as count FROM membership_snapshots WHERE date = ?');
      const result = stmt.get(date) as { count: number } | undefined;
      return (result?.count || 0) > 0;
    } catch (error) {
      console.error(`Failed to check snapshot for date ${date}:`, error);
      return false;
    }
  }
}; 