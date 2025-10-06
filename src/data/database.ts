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
      
      // Create dream teams review tracking table
      db.exec(`
        CREATE TABLE IF NOT EXISTS dream_team_reviews (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workflow_id TEXT NOT NULL,
          workflow_name TEXT NOT NULL,
          review_date TEXT NOT NULL,
          reviewer_name TEXT NOT NULL,
          reviewer_notes TEXT,
          has_changes BOOLEAN DEFAULT 0,
          timestamp INTEGER NOT NULL
        )
      `);
      
      // Create dream teams removal tracking table
      db.exec(`
        CREATE TABLE IF NOT EXISTS dream_team_removals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workflow_id TEXT NOT NULL,
          workflow_name TEXT NOT NULL,
          person_id TEXT NOT NULL,
          person_first_name TEXT NOT NULL,
          person_last_name TEXT NOT NULL,
          removal_reason TEXT,
          removal_date TEXT NOT NULL,
          reviewer_name TEXT NOT NULL,
          processed BOOLEAN DEFAULT 0,
          timestamp INTEGER NOT NULL
        )
      `);
      
      // Add reviewer_name column to existing tables if it doesn't exist
      try {
        db.exec(`ALTER TABLE dream_team_reviews ADD COLUMN reviewer_name TEXT DEFAULT 'Unknown'`);
      } catch (error) {
        // Column already exists, ignore error
      }
      
      try {
        db.exec(`ALTER TABLE dream_team_removals ADD COLUMN reviewer_name TEXT DEFAULT 'Unknown'`);
      } catch (error) {
        // Column already exists, ignore error
      }
      
      // Create indexes for faster queries
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_dream_team_reviews_workflow 
        ON dream_team_reviews(workflow_id, review_date)
      `);
      
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_dream_team_removals_workflow 
        ON dream_team_removals(workflow_id, processed)
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

  delete: (key: string): void => {
    try {
      const db = initializeDb();
      db.prepare('DELETE FROM cache WHERE key = ?').run(key);
    } catch (error) {
      console.error(`Failed to delete cache key ${key}:`, error);
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

// Helper function to get local date in YYYY-MM-DD format (Eastern timezone)
const getLocalDateString = (): string => {
  const now = new Date();
  
  const easternViaIntl = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
  
  // Use Intl.DateTimeFormat to get Eastern timezone date parts reliably
  return easternViaIntl;
};

// Dream Teams tracking functions
export const dreamTeamsTracking = {
  // Record a team review (no changes)
  recordReview: (workflowId: string, workflowName: string, reviewerName: string, notes?: string): void => {
    try {
      const db = initializeDb();
      const reviewDate = getLocalDateString(); // YYYY-MM-DD format in local time
      const timestamp = Date.now();
      
      const stmt = db.prepare(`
        INSERT INTO dream_team_reviews 
        (workflow_id, workflow_name, review_date, reviewer_name, reviewer_notes, has_changes, timestamp)
        VALUES (?, ?, ?, ?, ?, 0, ?)
      `);
      
      stmt.run(workflowId, workflowName, reviewDate, reviewerName, notes || null, timestamp);
    } catch (error) {
      console.error(`Failed to record review for workflow ${workflowId}:`, error);
      throw error;
    }
  },

  // Record team removals
  recordRemovals: (workflowId: string, workflowName: string, reviewerName: string, removals: Array<{
    personId: string;
    firstName: string;
    lastName: string;
    reason?: string;
  }>): void => {
    try {
      const db = initializeDb();
      const removalDate = getLocalDateString(); // YYYY-MM-DD format in local time
      const timestamp = Date.now();
      
      const insertStmt = db.prepare(`
        INSERT INTO dream_team_removals 
        (workflow_id, workflow_name, person_id, person_first_name, person_last_name, removal_reason, removal_date, reviewer_name, processed, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      `);
      
      // Also record a review with changes
      const reviewStmt = db.prepare(`
        INSERT INTO dream_team_reviews 
        (workflow_id, workflow_name, review_date, reviewer_name, reviewer_notes, has_changes, timestamp)
        VALUES (?, ?, ?, ?, ?, 1, ?)
      `);
      
      const transaction = db.transaction((removals: any[]) => {
        // Record the review
        reviewStmt.run(workflowId, workflowName, removalDate, reviewerName, `Removed ${removals.length} member(s)`, timestamp);
        
        // Record each removal
        for (const removal of removals) {
          insertStmt.run(
            workflowId,
            workflowName,
            removal.personId,
            removal.firstName,
            removal.lastName,
            removal.reason || null,
            removalDate,
            reviewerName,
            timestamp
          );
        }
      });
      
      transaction(removals);
    } catch (error) {
      console.error(`Failed to record removals for workflow ${workflowId}:`, error);
      throw error;
    }
  },

  // Get last review date for a workflow
  getLastReviewDate: (workflowId: string): string | null => {
    try {
      const db = initializeDb();
      const stmt = db.prepare(`
        SELECT review_date 
        FROM dream_team_reviews 
        WHERE workflow_id = ? 
        ORDER BY review_date DESC 
        LIMIT 1
      `);
      
      const result = stmt.get(workflowId) as { review_date: string } | undefined;
      return result?.review_date || null;
    } catch (error) {
      console.error(`Failed to get last review date for workflow ${workflowId}:`, error);
      return null;
    }
  },

  getLastReviewInfo: (workflowId: string): { date: string; reviewer: string } | null => {
    try {
      const db = initializeDb();
      const stmt = db.prepare(`
        SELECT review_date, reviewer_name 
        FROM dream_team_reviews 
        WHERE workflow_id = ? 
        ORDER BY review_date DESC 
        LIMIT 1
      `);
      
      const result = stmt.get(workflowId) as { review_date: string; reviewer_name: string } | undefined;
      
      return result ? { date: result.review_date, reviewer: result.reviewer_name } : null;
    } catch (error) {
      console.error(`Failed to get last review info for workflow ${workflowId}:`, error);
      return null;
    }
  },

  // Get pending removals for a workflow
  getPendingRemovals: (workflowId: string): Array<{
    id: number;
    personId: string;
    firstName: string;
    lastName: string;
    reason: string | null;
    removalDate: string;
  }> => {
    try {
      const db = initializeDb();
      const stmt = db.prepare(`
        SELECT id, person_id as personId, person_first_name as firstName, 
               person_last_name as lastName, removal_reason as reason, removal_date as removalDate
        FROM dream_team_removals 
        WHERE workflow_id = ? AND processed = 0
        ORDER BY removal_date DESC, person_last_name ASC
      `);
      
      return stmt.all(workflowId) as Array<{
        id: number;
        personId: string;
        firstName: string;
        lastName: string;
        reason: string | null;
        removalDate: string;
      }>;
    } catch (error) {
      console.error(`Failed to get pending removals for workflow ${workflowId}:`, error);
      return [];
    }
  },

  // Get processed removals (past members) for a workflow
  getPastMembers: (workflowId: string): Array<{
    id: number;
    personId: string;
    firstName: string;
    lastName: string;
    reason: string | null;
    removalDate: string;
  }> => {
    try {
      const db = initializeDb();
      const stmt = db.prepare(`
        SELECT id, person_id as personId, person_first_name as firstName, 
               person_last_name as lastName, removal_reason as reason, removal_date as removalDate
        FROM dream_team_removals 
        WHERE workflow_id = ? AND processed = 1
        ORDER BY removal_date DESC, person_last_name ASC
      `);
      
      return stmt.all(workflowId) as Array<{
        id: number;
        personId: string;
        firstName: string;
        lastName: string;
        reason: string | null;
        removalDate: string;
      }>;
    } catch (error) {
      console.error(`Failed to get past members for workflow ${workflowId}:`, error);
      return [];
    }
  },

  // Mark removals as processed
  markRemovalsProcessed: (workflowId: string): void => {
    try {
      const db = initializeDb();
      const stmt = db.prepare(`
        UPDATE dream_team_removals 
        SET processed = 1 
        WHERE workflow_id = ? AND processed = 0
      `);
      
      stmt.run(workflowId);
    } catch (error) {
      console.error(`Failed to mark removals as processed for workflow ${workflowId}:`, error);
      throw error;
    }
  },

  // Get all pending removals across all teams (for admin review)
  // Note: This now returns ALL removals - the API will filter based on current PCO data
  getAllPendingRemovals: (): Array<{
    id: number;
    workflowId: string;
    workflowName: string;
    personId: string;
    firstName: string;
    lastName: string;
    reason: string | null;
    removalDate: string;
    reviewerName: string;
  }> => {
    try {
      const db = initializeDb();
      const stmt = db.prepare(`
        SELECT id, workflow_id as workflowId, workflow_name as workflowName,
               person_id as personId, person_first_name as firstName, 
               person_last_name as lastName, removal_reason as reason, 
               removal_date as removalDate, reviewer_name as reviewerName
        FROM dream_team_removals 
        ORDER BY workflow_name ASC, person_last_name ASC, person_first_name ASC
      `);
      
      return stmt.all() as Array<{
        id: number;
        workflowId: string;
        workflowName: string;
        personId: string;
        firstName: string;
        lastName: string;
        reason: string | null;
        removalDate: string;
        reviewerName: string;
      }>;
    } catch (error) {
      console.error('Failed to get all pending removals:', error);
      return [];
    }
  },

  // Mark a single removal as processed (for admin use)
  markSingleRemovalProcessed: (removalId: number): void => {
    try {
      const db = initializeDb();
      const stmt = db.prepare(`
        UPDATE dream_team_removals 
        SET processed = 1 
        WHERE id = ?
      `);
      
      stmt.run(removalId);
    } catch (error) {
      console.error(`Failed to mark removal ${removalId} as processed:`, error);
      throw error;
    }
  },

  // Undo a removal (delete the removal record)
  undoRemoval: (workflowId: string, memberId: string): void => {
    try {
      const db = initializeDb();
      const stmt = db.prepare(`
        DELETE FROM dream_team_removals 
        WHERE workflow_id = ? AND person_id = ?
      `);
      
      const result = stmt.run(workflowId, memberId);
      
      if (result.changes === 0) {
        console.warn(`No removal record found to undo for member ${memberId} in workflow ${workflowId}`);
      } else {
        console.log(`Successfully undid removal for member ${memberId} in workflow ${workflowId}`);
      }
    } catch (error) {
      console.error(`Failed to undo removal for member ${memberId} in workflow ${workflowId}:`, error);
      throw error;
    }
  }
}; 