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

  // Get membership changes over a time period with exact dates
  getMembershipChanges: (daysBack: number = 30): any => {
    try {
      const db = initializeDb();
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysBack);
      const cutoffDateStr = cutoffDate.toISOString().split('T')[0];
      
      // Get all unique group IDs that have snapshots
      const groupsStmt = db.prepare(`
        SELECT DISTINCT group_id, group_name
        FROM membership_snapshots 
        WHERE date >= ?
        ORDER BY group_id
      `);
      const groups = groupsStmt.all(cutoffDateStr) as Array<{group_id: string, group_name: string}>;
      
      const changes = {
        joins: [] as any[],
        leaves: [] as any[],
        totalJoins: 0,
        totalLeaves: 0
      };
      
      for (const group of groups) {
        const groupId = group.group_id;
        const groupName = group.group_name;
        
        // Get all snapshots for this group within the time period, ordered by date
        const snapshotsStmt = db.prepare(`
          SELECT date, person_id, person_first_name, person_last_name
          FROM membership_snapshots 
          WHERE group_id = ? AND date >= ?
          ORDER BY date ASC
        `);
        const snapshots = snapshotsStmt.all(groupId, cutoffDateStr) as Array<{
          date: string,
          person_id: string,
          person_first_name: string,
          person_last_name: string
        }>;
        
        if (snapshots.length === 0) continue;
        
        // Group snapshots by date
        const snapshotsByDate = new Map<string, Set<string>>();
        const memberDetails = new Map<string, {firstName: string, lastName: string}>();
        
        snapshots.forEach(snapshot => {
          if (!snapshotsByDate.has(snapshot.date)) {
            snapshotsByDate.set(snapshot.date, new Set());
          }
          snapshotsByDate.get(snapshot.date)!.add(snapshot.person_id);
          memberDetails.set(snapshot.person_id, {
            firstName: snapshot.person_first_name,
            lastName: snapshot.person_last_name
          });
        });
        
        // Sort dates to process chronologically
        const sortedDates = Array.from(snapshotsByDate.keys()).sort();
        
        // Track membership changes day by day
        let previousMembers: Set<string> | null = null;
        
        for (const date of sortedDates) {
          const currentMembers = snapshotsByDate.get(date)!;
          
          if (previousMembers !== null) {
            // Find joins (in current but not in previous)
            const joins = Array.from(currentMembers).filter(personId => !previousMembers!.has(personId));
            
            // Find leaves (in previous but not in current)
            const leaves = Array.from(previousMembers).filter(personId => !currentMembers.has(personId));
            
            // Add joins for this date
            joins.forEach(personId => {
              const details = memberDetails.get(personId);
              if (details) {
                changes.joins.push({
                  personId: personId,
                  firstName: details.firstName,
                  lastName: details.lastName,
                  groupName: groupName,
                  groupId: groupId,
                  type: 'join',
                  date: date
                });
              }
            });
            
            // Add leaves for this date
            leaves.forEach(personId => {
              const details = memberDetails.get(personId);
              if (details) {
                changes.leaves.push({
                  personId: personId,
                  firstName: details.firstName,
                  lastName: details.lastName,
                  groupName: groupName,
                  groupId: groupId,
                  type: 'leave',
                  date: date
                });
              }
            });
          }
          
          previousMembers = new Set(currentMembers);
        }
      }
      
      // Sort the results: Group Name, then Date, then First Name alphabetically
      changes.joins.sort((a, b) => {
        // First by group name
        if (a.groupName !== b.groupName) {
          return a.groupName.localeCompare(b.groupName);
        }
        // Then by date (most recent first)
        if (a.date !== b.date) {
          return new Date(b.date).getTime() - new Date(a.date).getTime();
        }
        // Finally by first name alphabetically
        return a.firstName.localeCompare(b.firstName);
      });
      
      changes.leaves.sort((a, b) => {
        // First by group name
        if (a.groupName !== b.groupName) {
          return a.groupName.localeCompare(b.groupName);
        }
        // Then by date (most recent first)
        if (a.date !== b.date) {
          return new Date(b.date).getTime() - new Date(a.date).getTime();
        }
        // Finally by first name alphabetically
        return a.firstName.localeCompare(b.firstName);
      });
      
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