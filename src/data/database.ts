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
      
      // Create dream teams check-in tracking table
      db.exec(`
        CREATE TABLE IF NOT EXISTS dream_team_checkins (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workflow_id TEXT NOT NULL,
          person_id TEXT NOT NULL,
          checkin_type TEXT NOT NULL,
          completed_by TEXT,
          completed_date TEXT,
          is_legacy BOOLEAN DEFAULT 0,
          timestamp INTEGER NOT NULL,
          UNIQUE(workflow_id, person_id, checkin_type)
        )
      `);
      
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_dream_team_checkins_workflow_person 
        ON dream_team_checkins(workflow_id, person_id)
      `);
      
      // Create dream teams leadership table
      db.exec(`
        CREATE TABLE IF NOT EXISTS dream_team_leaders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workflow_id TEXT NOT NULL,
          person_id TEXT NOT NULL,
          person_name TEXT NOT NULL,
          role TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE(workflow_id, person_id, role)
        )
      `);
      
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_dream_team_leaders_workflow 
        ON dream_team_leaders(workflow_id)
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
    processed: number;
  }> => {
    try {
      const db = initializeDb();
      const stmt = db.prepare(`
        SELECT id, workflow_id as workflowId, workflow_name as workflowName,
               person_id as personId, person_first_name as firstName, 
               person_last_name as lastName, removal_reason as reason, 
               removal_date as removalDate, reviewer_name as reviewerName,
               processed
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
        processed: number;
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
  },

  // Record a check-in for a member
  recordCheckIn: (workflowId: string, personId: string, checkInType: '2-month' | '6-month', completedBy: string): void => {
    try {
      const db = initializeDb();
      const completedDate = getLocalDateString();
      const timestamp = Date.now();
      
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO dream_team_checkins 
        (workflow_id, person_id, checkin_type, completed_by, completed_date, is_legacy, timestamp)
        VALUES (?, ?, ?, ?, ?, 0, ?)
      `);
      
      stmt.run(workflowId, personId, checkInType, completedBy, completedDate, timestamp);
    } catch (error) {
      console.error(`Failed to record check-in for person ${personId} in workflow ${workflowId}:`, error);
      throw error;
    }
  },

  // Record a legacy check-in (for members who joined before the feature was implemented)
  recordLegacyCheckIn: (workflowId: string, personId: string, checkInType: '2-month' | '6-month'): void => {
    try {
      const db = initializeDb();
      const timestamp = Date.now();
      
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO dream_team_checkins 
        (workflow_id, person_id, checkin_type, completed_by, completed_date, is_legacy, timestamp)
        VALUES (?, ?, ?, NULL, NULL, 1, ?)
      `);
      
      stmt.run(workflowId, personId, checkInType, timestamp);
    } catch (error) {
      console.error(`Failed to record legacy check-in for person ${personId} in workflow ${workflowId}:`, error);
      throw error;
    }
  },

  // Get check-ins for a specific member in a workflow
  getMemberCheckIns: (workflowId: string, personId: string): Array<{
    checkInType: string;
    completedBy: string | null;
    completedDate: string | null;
    isLegacy: boolean;
  }> => {
    try {
      const db = initializeDb();
      const stmt = db.prepare(`
        SELECT checkin_type as checkInType, completed_by as completedBy, 
               completed_date as completedDate, is_legacy as isLegacy
        FROM dream_team_checkins 
        WHERE workflow_id = ? AND person_id = ?
      `);
      
      return stmt.all(workflowId, personId) as Array<{
        checkInType: string;
        completedBy: string | null;
        completedDate: string | null;
        isLegacy: boolean;
      }>;
    } catch (error) {
      console.error(`Failed to get check-ins for person ${personId} in workflow ${workflowId}:`, error);
      return [];
    }
  },

  // Get all check-ins for a workflow (for bulk loading)
  getWorkflowCheckIns: (workflowId: string): Map<string, Array<{
    checkInType: string;
    completedBy: string | null;
    completedDate: string | null;
    isLegacy: boolean;
  }>> => {
    try {
      const db = initializeDb();
      const stmt = db.prepare(`
        SELECT person_id as personId, checkin_type as checkInType, 
               completed_by as completedBy, completed_date as completedDate, 
               is_legacy as isLegacy
        FROM dream_team_checkins 
        WHERE workflow_id = ?
      `);
      
      const rows = stmt.all(workflowId) as Array<{
        personId: string;
        checkInType: string;
        completedBy: string | null;
        completedDate: string | null;
        isLegacy: number;
      }>;
      
      const checkInsMap = new Map<string, Array<{
        checkInType: string;
        completedBy: string | null;
        completedDate: string | null;
        isLegacy: boolean;
      }>>();
      
      for (const row of rows) {
        if (!checkInsMap.has(row.personId)) {
          checkInsMap.set(row.personId, []);
        }
        checkInsMap.get(row.personId)!.push({
          checkInType: row.checkInType,
          completedBy: row.completedBy,
          completedDate: row.completedDate,
          isLegacy: row.isLegacy === 1
        });
      }
      
      return checkInsMap;
    } catch (error) {
      console.error(`Failed to get check-ins for workflow ${workflowId}:`, error);
      return new Map();
    }
  },

  // Add a leader to a team
  addLeader: (workflowId: string, personId: string, personName: string, role: 'team_leader' | 'director'): void => {
    try {
      const db = initializeDb();
      const createdAt = Date.now();
      
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO dream_team_leaders 
        (workflow_id, person_id, person_name, role, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      
      stmt.run(workflowId, personId, personName, role, createdAt);
    } catch (error) {
      console.error(`Failed to add leader ${personId} to workflow ${workflowId}:`, error);
      throw error;
    }
  },

  // Remove a leader from a team
  removeLeader: (workflowId: string, personId: string, role: 'team_leader' | 'director'): void => {
    try {
      const db = initializeDb();
      
      const stmt = db.prepare(`
        DELETE FROM dream_team_leaders 
        WHERE workflow_id = ? AND person_id = ? AND role = ?
      `);
      
      stmt.run(workflowId, personId, role);
    } catch (error) {
      console.error(`Failed to remove leader ${personId} from workflow ${workflowId}:`, error);
      throw error;
    }
  },

  // Get all leaders for a team
  getTeamLeaders: (workflowId: string): Array<{
    id: number;
    personId: string;
    personName: string;
    role: string;
    createdAt: number;
  }> => {
    try {
      const db = initializeDb();
      const stmt = db.prepare(`
        SELECT id, person_id as personId, person_name as personName, role, created_at as createdAt
        FROM dream_team_leaders 
        WHERE workflow_id = ?
        ORDER BY role DESC, person_name ASC
      `);
      
      return stmt.all(workflowId) as Array<{
        id: number;
        personId: string;
        personName: string;
        role: string;
        createdAt: number;
      }>;
    } catch (error) {
      console.error(`Failed to get leaders for workflow ${workflowId}:`, error);
      return [];
    }
  },

  // Update a leader's name (in case it changed in PCO)
  updateLeaderName: (workflowId: string, personId: string, newName: string): void => {
    try {
      const db = initializeDb();
      
      const stmt = db.prepare(`
        UPDATE dream_team_leaders 
        SET person_name = ?
        WHERE workflow_id = ? AND person_id = ?
      `);
      
      stmt.run(newName, workflowId, personId);
    } catch (error) {
      console.error(`Failed to update leader name for ${personId} in workflow ${workflowId}:`, error);
      throw error;
    }
  }
};

// Replenishment Requests tracking functions
export const replenishmentRequests = {
  // Initialize replenishment tables
  initializeTables: (): void => {
    try {
      const db = initializeDb();
      
      // Create departments table
      db.exec(`
        CREATE TABLE IF NOT EXISTS replenishment_departments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          description TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      
      // Create items table
      db.exec(`
        CREATE TABLE IF NOT EXISTS replenishment_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          department_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          current_stock INTEGER DEFAULT 0,
          min_threshold INTEGER DEFAULT 10,
          unit TEXT DEFAULT 'units',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          is_active BOOLEAN DEFAULT 1,
          FOREIGN KEY (department_id) REFERENCES replenishment_departments(id),
          UNIQUE(department_id, name)
        )
      `);
      
      // Create requests table
      db.exec(`
        CREATE TABLE IF NOT EXISTS replenishment_requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          item_id INTEGER NOT NULL,
          department_id INTEGER NOT NULL,
          quantity_requested INTEGER NOT NULL,
          status TEXT DEFAULT 'requested',
          requested_by TEXT NOT NULL,
          requested_date TEXT NOT NULL,
          ordered_date TEXT,
          ordered_by TEXT,
          delivered_date TEXT,
          delivered_by TEXT,
          stocked_date TEXT,
          stocked_by TEXT,
          notes TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (item_id) REFERENCES replenishment_items(id),
          FOREIGN KEY (department_id) REFERENCES replenishment_departments(id)
        )
      `);
      
      // Create status log table for audit trail
      db.exec(`
        CREATE TABLE IF NOT EXISTS replenishment_status_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          request_id INTEGER NOT NULL,
          old_status TEXT,
          new_status TEXT NOT NULL,
          changed_by TEXT NOT NULL,
          changed_at TEXT NOT NULL,
          notes TEXT,
          timestamp INTEGER NOT NULL,
          FOREIGN KEY (request_id) REFERENCES replenishment_requests(id)
        )
      `);
      
      // Create indexes
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_replenishment_requests_status 
        ON replenishment_requests(status)
      `);
      
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_replenishment_requests_department 
        ON replenishment_requests(department_id)
      `);
      
      console.log('Replenishment tables initialized successfully');
    } catch (error) {
      console.error('Error initializing replenishment tables:', error);
      throw error;
    }
  },
  
  // Seed initial data
  seedInitialData: (): void => {
    try {
      const db = initializeDb();
      
      // Check if we already have data
      const checkStmt = db.prepare('SELECT COUNT(*) as count FROM replenishment_departments');
      const result = checkStmt.get() as { count: number };
      
      if (result.count > 0) {
        console.log('Replenishment data already seeded');
        return;
      }
      
      const timestamp = Date.now();
      
      // Seed departments
      const deptStmt = db.prepare(`
        INSERT INTO replenishment_departments (name, description, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `);
      
      const depts = [
        { name: 'Connect Area', description: 'First-time guest connections and welcome resources' },
        { name: 'Baptisms', description: 'Baptism ceremony supplies and apparel' },
        { name: 'Admin', description: 'Administrative office supplies' }
      ];
      
      const insertDepts = db.transaction(() => {
        for (const dept of depts) {
          deptStmt.run(dept.name, dept.description, timestamp, timestamp);
        }
      });
      insertDepts();
      
      // Get department IDs
      const getDeptId = (name: string): number => {
        const stmt = db.prepare('SELECT id FROM replenishment_departments WHERE name = ?');
        const row = stmt.get(name) as { id: number };
        return row.id;
      };
      
      const connectId = getDeptId('Connect Area');
      const baptismsId = getDeptId('Baptisms');
      const adminId = getDeptId('Admin');
      
      // Seed items
      const itemStmt = db.prepare(`
        INSERT INTO replenishment_items 
        (department_id, name, description, current_stock, min_threshold, unit, created_at, updated_at, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      `);
      
      const items = [
        // Connect Area
        { deptId: connectId, name: 'Mugs', description: 'Coffee mugs for first-time guests', stock: 50, min: 20, unit: 'units' },
        { deptId: connectId, name: 'Bibles', description: 'Gift Bibles for new believers', stock: 30, min: 15, unit: 'units' },
        // Baptisms
        { deptId: baptismsId, name: 'T-Shirts', description: 'Baptism t-shirts', stock: 40, min: 20, unit: 'units' },
        { deptId: baptismsId, name: 'Gym Shorts', description: 'Baptism gym shorts', stock: 35, min: 15, unit: 'units' },
        { deptId: baptismsId, name: 'Towels', description: 'Baptism towels', stock: 25, min: 10, unit: 'units' },
        // Admin
        { deptId: adminId, name: 'Kids Birthday Cards', description: 'Birthday cards for kids ministry', stock: 100, min: 30, unit: 'cards' },
        { deptId: adminId, name: 'Stamps', description: 'Postage stamps', stock: 50, min: 20, unit: 'stamps' },
        { deptId: adminId, name: 'Printer Paper', description: 'Letter-size printer paper', stock: 5, min: 3, unit: 'reams' }
      ];
      
      const insertItems = db.transaction(() => {
        for (const item of items) {
          itemStmt.run(
            item.deptId,
            item.name,
            item.description,
            item.stock,
            item.min,
            item.unit,
            timestamp,
            timestamp
          );
        }
      });
      insertItems();
      
      console.log('Replenishment initial data seeded successfully');
    } catch (error) {
      console.error('Error seeding replenishment data:', error);
      throw error;
    }
  },
  
  // Get all departments
  getDepartments: (): Array<{
    id: number;
    name: string;
    description: string | null;
    created_at: number;
    updated_at: number;
  }> => {
    try {
      const db = initializeDb();
      const stmt = db.prepare(`
        SELECT id, name, description, created_at, updated_at
        FROM replenishment_departments
        ORDER BY name ASC
      `);
      return stmt.all() as Array<{
        id: number;
        name: string;
        description: string | null;
        created_at: number;
        updated_at: number;
      }>;
    } catch (error) {
      console.error('Error getting departments:', error);
      return [];
    }
  },
  
  // Get items for a department
  getItemsByDepartment: (departmentId: number): Array<{
    id: number;
    department_id: number;
    name: string;
    description: string | null;
    current_stock: number;
    min_threshold: number;
    unit: string;
    is_active: number;
    needs_replenishment: boolean;
  }> => {
    try {
      const db = initializeDb();
      const stmt = db.prepare(`
        SELECT id, department_id, name, description, current_stock, min_threshold, unit, is_active
        FROM replenishment_items
        WHERE department_id = ? AND is_active = 1
        ORDER BY name ASC
      `);
      const items = stmt.all(departmentId) as Array<{
        id: number;
        department_id: number;
        name: string;
        description: string | null;
        current_stock: number;
        min_threshold: number;
        unit: string;
        is_active: number;
      }>;
      
      // Add needs_replenishment flag
      return items.map(item => ({
        ...item,
        needs_replenishment: item.current_stock <= item.min_threshold
      }));
    } catch (error) {
      console.error(`Error getting items for department ${departmentId}:`, error);
      return [];
    }
  },
  
  // Get all items with department info
  getAllItems: (): Array<{
    id: number;
    department_id: number;
    department_name: string;
    name: string;
    description: string | null;
    current_stock: number;
    min_threshold: number;
    unit: string;
    is_active: number;
    needs_replenishment: boolean;
  }> => {
    try {
      const db = initializeDb();
      const stmt = db.prepare(`
        SELECT 
          i.id, 
          i.department_id, 
          d.name as department_name,
          i.name, 
          i.description, 
          i.current_stock, 
          i.min_threshold, 
          i.unit, 
          i.is_active
        FROM replenishment_items i
        JOIN replenishment_departments d ON i.department_id = d.id
        WHERE i.is_active = 1
        ORDER BY d.name ASC, i.name ASC
      `);
      const items = stmt.all() as Array<{
        id: number;
        department_id: number;
        department_name: string;
        name: string;
        description: string | null;
        current_stock: number;
        min_threshold: number;
        unit: string;
        is_active: number;
      }>;
      
      return items.map(item => ({
        ...item,
        needs_replenishment: item.current_stock <= item.min_threshold
      }));
    } catch (error) {
      console.error('Error getting all items:', error);
      return [];
    }
  },
  
  // Create a new request
  createRequest: (
    itemId: number,
    departmentId: number,
    quantityRequested: number,
    requestedBy: string,
    notes?: string
  ): number => {
    try {
      const db = initializeDb();
      const timestamp = Date.now();
      const requestedDate = getLocalDateString();
      
      const stmt = db.prepare(`
        INSERT INTO replenishment_requests 
        (item_id, department_id, quantity_requested, status, requested_by, requested_date, notes, created_at, updated_at)
        VALUES (?, ?, ?, 'requested', ?, ?, ?, ?, ?)
      `);
      
      const result = stmt.run(itemId, departmentId, quantityRequested, requestedBy, requestedDate, notes || null, timestamp, timestamp);
      const requestId = result.lastInsertRowid as number;
      
      // Log the status change
      const logStmt = db.prepare(`
        INSERT INTO replenishment_status_log
        (request_id, old_status, new_status, changed_by, changed_at, notes, timestamp)
        VALUES (?, NULL, 'requested', ?, ?, ?, ?)
      `);
      logStmt.run(requestId, requestedBy, requestedDate, 'Request created', timestamp);
      
      return requestId;
    } catch (error) {
      console.error('Error creating request:', error);
      throw error;
    }
  },
  
  // Update request status
  updateRequestStatus: (
    requestId: number,
    newStatus: 'requested' | 'ordered' | 'delivered' | 'stocked',
    changedBy: string,
    notes?: string
  ): void => {
    try {
      const db = initializeDb();
      const timestamp = Date.now();
      const changedDate = getLocalDateString();
      
      // Get current status
      const getCurrentStmt = db.prepare('SELECT status, item_id, quantity_requested FROM replenishment_requests WHERE id = ?');
      const current = getCurrentStmt.get(requestId) as { status: string; item_id: number; quantity_requested: number } | undefined;
      
      if (!current) {
        throw new Error(`Request ${requestId} not found`);
      }
      
      // Update the request with status-specific fields
      let updateQuery = 'UPDATE replenishment_requests SET status = ?, updated_at = ?';
      const params: any[] = [newStatus, timestamp];
      
      if (newStatus === 'ordered') {
        updateQuery += ', ordered_date = ?, ordered_by = ?';
        params.push(changedDate, changedBy);
      } else if (newStatus === 'delivered') {
        updateQuery += ', delivered_date = ?, delivered_by = ?';
        params.push(changedDate, changedBy);
      } else if (newStatus === 'stocked') {
        updateQuery += ', stocked_date = ?, stocked_by = ?';
        params.push(changedDate, changedBy);
      }
      
      if (notes) {
        updateQuery += ', notes = ?';
        params.push(notes);
      }
      
      updateQuery += ' WHERE id = ?';
      params.push(requestId);
      
      const updateStmt = db.prepare(updateQuery);
      updateStmt.run(...params);
      
      // Log the status change
      const logStmt = db.prepare(`
        INSERT INTO replenishment_status_log
        (request_id, old_status, new_status, changed_by, changed_at, notes, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      logStmt.run(requestId, current.status, newStatus, changedBy, changedDate, notes || null, timestamp);
      
      // If status is 'stocked', update the item's current_stock
      if (newStatus === 'stocked') {
        const updateStockStmt = db.prepare(`
          UPDATE replenishment_items 
          SET current_stock = current_stock + ?, updated_at = ?
          WHERE id = ?
        `);
        updateStockStmt.run(current.quantity_requested, timestamp, current.item_id);
      }
    } catch (error) {
      console.error(`Error updating request status for request ${requestId}:`, error);
      throw error;
    }
  },
  
  // Get all requests
  getAllRequests: (): Array<{
    id: number;
    item_id: number;
    item_name: string;
    department_id: number;
    department_name: string;
    quantity_requested: number;
    current_stock: number;
    unit: string;
    status: string;
    requested_by: string;
    requested_date: string;
    ordered_date: string | null;
    ordered_by: string | null;
    delivered_date: string | null;
    delivered_by: string | null;
    stocked_date: string | null;
    stocked_by: string | null;
    notes: string | null;
    created_at: number;
  }> => {
    try {
      const db = initializeDb();
      const stmt = db.prepare(`
        SELECT 
          r.id,
          r.item_id,
          i.name as item_name,
          r.department_id,
          d.name as department_name,
          r.quantity_requested,
          i.current_stock,
          i.unit,
          r.status,
          r.requested_by,
          r.requested_date,
          r.ordered_date,
          r.ordered_by,
          r.delivered_date,
          r.delivered_by,
          r.stocked_date,
          r.stocked_by,
          r.notes,
          r.created_at
        FROM replenishment_requests r
        JOIN replenishment_items i ON r.item_id = i.id
        JOIN replenishment_departments d ON r.department_id = d.id
        ORDER BY r.created_at DESC
      `);
      return stmt.all() as Array<{
        id: number;
        item_id: number;
        item_name: string;
        department_id: number;
        department_name: string;
        quantity_requested: number;
        current_stock: number;
        unit: string;
        status: string;
        requested_by: string;
        requested_date: string;
        ordered_date: string | null;
        ordered_by: string | null;
        delivered_date: string | null;
        delivered_by: string | null;
        stocked_date: string | null;
        stocked_by: string | null;
        notes: string | null;
        created_at: number;
      }>;
    } catch (error) {
      console.error('Error getting all requests:', error);
      return [];
    }
  },
  
  // Get requests by status
  getRequestsByStatus: (status: string): Array<any> => {
    try {
      const db = initializeDb();
      const stmt = db.prepare(`
        SELECT 
          r.id,
          r.item_id,
          i.name as item_name,
          r.department_id,
          d.name as department_name,
          r.quantity_requested,
          i.current_stock,
          i.unit,
          r.status,
          r.requested_by,
          r.requested_date,
          r.ordered_date,
          r.ordered_by,
          r.delivered_date,
          r.delivered_by,
          r.stocked_date,
          r.stocked_by,
          r.notes,
          r.created_at
        FROM replenishment_requests r
        JOIN replenishment_items i ON r.item_id = i.id
        JOIN replenishment_departments d ON r.department_id = d.id
        WHERE r.status = ?
        ORDER BY r.created_at DESC
      `);
      return stmt.all(status) as Array<any>;
    } catch (error) {
      console.error(`Error getting requests with status ${status}:`, error);
      return [];
    }
  },
  
  // Get status history for a request
  getRequestHistory: (requestId: number): Array<{
    id: number;
    request_id: number;
    old_status: string | null;
    new_status: string;
    changed_by: string;
    changed_at: string;
    notes: string | null;
    timestamp: number;
  }> => {
    try {
      const db = initializeDb();
      const stmt = db.prepare(`
        SELECT id, request_id, old_status, new_status, changed_by, changed_at, notes, timestamp
        FROM replenishment_status_log
        WHERE request_id = ?
        ORDER BY timestamp ASC
      `);
      return stmt.all(requestId) as Array<{
        id: number;
        request_id: number;
        old_status: string | null;
        new_status: string;
        changed_by: string;
        changed_at: string;
        notes: string | null;
        timestamp: number;
      }>;
    } catch (error) {
      console.error(`Error getting request history for request ${requestId}:`, error);
      return [];
    }
  },
  
  // Update item stock manually
  updateItemStock: (itemId: number, newStock: number): void => {
    try {
      const db = initializeDb();
      const timestamp = Date.now();
      
      const stmt = db.prepare(`
        UPDATE replenishment_items 
        SET current_stock = ?, updated_at = ?
        WHERE id = ?
      `);
      stmt.run(newStock, timestamp, itemId);
    } catch (error) {
      console.error(`Error updating stock for item ${itemId}:`, error);
      throw error;
    }
  }
};

// Initialize replenishment tables when database is initialized
initializeDb();
replenishmentRequests.initializeTables();
replenishmentRequests.seedInitialData(); 