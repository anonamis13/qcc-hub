import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cron from 'node-cron';
import nodemailer from 'nodemailer';
import pcoClient, { getPeopleGroups, getGroupAttendance, getGroup, getGroupMemberships, getDreamTeamWorkflows, getWorkflowCards } from './config/pco.js';
import { cache } from './config/cache.js';
import { membershipSnapshots, dreamTeamsTracking, replenishmentRequests } from '../data/database.js';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const GROUP_ATTENDANCE_CONCURRENCY = Math.max(1, parseInt(process.env.PCO_GROUP_ATTENDANCE_CONCURRENCY || '2', 10) || 2);
const SMTP_AUTH_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours
let lastSmtpAuthAlertAt = 0;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files (for logo)
app.use(express.static('.'));

// Helper function to format date
const formatDate = (dateString: string) => {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', { 
    weekday: 'short',
    month: 'short', 
    day: 'numeric',
    year: 'numeric'
  });
};

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];

  const safeConcurrency = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let currentIndex = 0;

  async function worker() {
    while (true) {
      const index = currentIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: safeConcurrency }, () => worker()));
  return results;
}

// Routes
app.get('/api/group-stats/:groupId', async (req, res) => {
  try {
    const { groupId } = req.params;
    const forceRefresh = req.query.forceRefresh === 'true';
    const showAll = req.query.showAll === 'true';
    const stats = await getGroupAttendance(groupId, showAll, forceRefresh);
    
    // Check if this group needs attention for recent events without attendance
    const needsAttention = checkForMissingAttendance(stats.events);
    
    res.json({
      ...stats.overall_statistics,
      needsAttention: needsAttention
    });
  } catch (error) {
    console.error(`Error fetching stats for group ${req.params.groupId}:`, error);
    res.status(500).json({ error: 'Failed to fetch group statistics' });
  }
});

// Helper function to check if a group needs attention for missing attendance
function checkForMissingAttendance(events: any[]): boolean {
  const now = new Date();
  const sixDaysAgo = new Date(now.getTime() - (6 * 24 * 60 * 60 * 1000));
  
  // Look for recent events (within last 6 days) that don't have attendance data
  const recentEventsNeedingAttention = events.filter((event: any) => {
    const eventDate = new Date(event.event.date);
    
    // Only check events from the last 6 days
    if (eventDate < sixDaysAgo || eventDate > now) {
      return false;
    }
    
    // Check if event is cancelled
    if (event.event.canceled) {
      return false;
    }
    
    // Check if attendance has been submitted (present_count > 0 means attendance was taken)
    // Also consider it "submitted" if it's explicitly marked as 0 attendance
    const hasAttendanceData = event.attendance_summary.present_count > 0 || 
                             (event.attendance_summary.present_count === 0 && event.attendance_summary.total_count > 0);
    
    // Add a buffer time - only flag events that ended at least 4 hours ago
    // This accounts for timezone issues and gives time for attendance submission
    const fourHoursAgo = new Date(now.getTime() - (4 * 60 * 60 * 1000));
    const eventEndTime = new Date(eventDate.getTime() + (2 * 60 * 60 * 1000)); // Assume 2-hour event duration
    
    return eventEndTime < fourHoursAgo && !hasAttendanceData;
  });
  
  return recentEventsNeedingAttention.length > 0;
}

// Add new endpoint for loading group data
app.get('/api/load-groups', async (req, res) => {
  try {
    // Check environment variables first
    const hasApiCreds = !!(process.env.PCO_APP_ID && process.env.PCO_SECRET);
    
    if (!hasApiCreds) {
      console.error('Missing PCO API credentials');
      return res.status(500).json({ 
        error: 'Server configuration error: Missing PCO API credentials',
        details: 'PCO_APP_ID and PCO_SECRET environment variables are required'
      });
    }
    
    const groupTypeIdFromEnv = process.env.PCO_GROUP_TYPE_ID;
    const groupTypeId = groupTypeIdFromEnv ? parseInt(groupTypeIdFromEnv, 10) : 429361;
    const forceRefresh = req.query.forceRefresh === 'true';

    if (groupTypeIdFromEnv && isNaN(groupTypeId)) {
      console.warn(`Warning: PCO_GROUP_TYPE_ID environment variable ('${groupTypeIdFromEnv}') is not a valid number. Using default 429361.`);
    }

    const result = await getPeopleGroups(groupTypeId, forceRefresh);
    
    res.json(result);
  } catch (error) {
    console.error('Error in /api/load-groups:', error);
    
    let errorMessage = 'Failed to fetch groups';
    let errorDetails = 'Unknown error';
    
    if (error instanceof Error) {
      console.error('Error details:', {
        message: error.message,
        stack: error.stack,
        name: error.name
      });
      
      errorDetails = error.message;
      
      // Provide more specific error messages
      if (error.message.includes('401') || error.message.includes('Unauthorized')) {
        errorMessage = 'PCO API authentication failed';
        errorDetails = 'Check PCO_APP_ID and PCO_SECRET environment variables';
      } else if (error.message.includes('timeout') || error.message.includes('TIMEOUT')) {
        errorMessage = 'Request timeout';
        errorDetails = 'PCO API request timed out. This may be due to network issues.';
      } else if (error.message.includes('ENOTFOUND') || error.message.includes('network')) {
        errorMessage = 'Network error';
        errorDetails = 'Unable to connect to PCO API. Check network connectivity.';
      } else if (error.message.includes('database') || error.message.includes('cache')) {
        errorMessage = 'Database/cache error';
        errorDetails = error.message;
      }
    }
    
    res.status(500).json({ 
      error: errorMessage,
      details: errorDetails,
      timestamp: new Date().toISOString()
    });
  }
});

// Add new endpoint to check cache status
app.get('/api/check-cache', async (req, res) => {
  try {
    const cacheKey = 'all_groups';
    const cachedGroups = cache.get(cacheKey);
    res.json({ 
      hasCachedData: !!cachedGroups
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to check cache status' });
  }
});

// Add new endpoint to get cache timestamp with context
app.get('/api/cache-info', async (req, res) => {
  try {
    const showAll = req.query.showAll === 'true';
    const groupsTimestamp = await cache.getTimestamp('all_groups');
    
    // Get a sample of event cache timestamps to find the oldest one
    // Check a few groups to get representative cache age
    const groupsResponse = await cache.get('all_groups') as any;
    let oldestEventCache: number | null = null;
    
    if (groupsResponse && Array.isArray(groupsResponse.data)) {
      // Check first 5 groups for their event cache timestamps
      const sampleGroups = groupsResponse.data.slice(0, 5);
      for (const group of sampleGroups) {
        const eventCacheKey = `events_${group.id}_${showAll}`;
        const eventTimestamp = await cache.getTimestamp(eventCacheKey);
        if (eventTimestamp && (!oldestEventCache || eventTimestamp < oldestEventCache)) {
          oldestEventCache = eventTimestamp;
        }
      }
    }
    
    // Return the oldest relevant timestamp (groups or events)
    const relevantTimestamp = oldestEventCache && groupsTimestamp && oldestEventCache < groupsTimestamp 
      ? oldestEventCache 
      : groupsTimestamp;
    
    res.json({ 
      timestamp: relevantTimestamp,
      groupsTimestamp,
      eventsTimestamp: oldestEventCache,
      showingAllYears: showAll
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get cache info' });
  }
});

// Get Dream Teams cache timestamp
app.get('/api/dream-teams/cache-info', async (req, res) => {
  try {
    // The cache key for Dream Team workflows (category ID 11927)
    const cacheKey = 'workflows_category_11927';
    const timestamp = await cache.getTimestamp(cacheKey);
    res.json({ timestamp });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get cache info' });
  }
});

// Add new endpoint for individual group attendance time-series
app.get('/api/individual-group-attendance', async (req, res) => {
  try {
    const forceRefresh = req.query.forceRefresh === 'true';
    const showAllEvents = req.query.showAll === 'true';
    const groupTypeIdFromEnv = process.env.PCO_GROUP_TYPE_ID;
    const groupTypeId = groupTypeIdFromEnv ? parseInt(groupTypeIdFromEnv, 10) : 429361;
    
    // Parse selected group IDs (required for this endpoint)
    const selectedGroupIds = req.query.selectedGroups ? 
                           (req.query.selectedGroups as string).split(',').filter(id => id.trim()) : 
                           [];
    
    // Parse metric type (attendance, membership, percentage)
    const metric = req.query.metric || 'attendance';
    
    if (selectedGroupIds.length === 0) {
      return res.json([]);
    }
    
    if (selectedGroupIds.length > 5) {
      return res.status(400).json({ error: 'Maximum 5 groups allowed for individual comparison' });
    }

    
    // Get all groups first to filter and get metadata
    const groups = await getPeopleGroups(groupTypeId, forceRefresh);
    const selectedGroups = groups.data.filter(group => selectedGroupIds.includes(group.id));
    
    if (selectedGroups.length === 0) {
      return res.json([]);
    }
    
    // Get attendance data for each selected group with a concurrency limit
    const allGroupsAttendance = await mapWithConcurrency(selectedGroups, GROUP_ATTENDANCE_CONCURRENCY, async (group) => {
      const attendance = await getGroupAttendance(group.id, showAllEvents, forceRefresh);
      return {
        groupId: group.id,
        groupName: group.attributes.name,
        ...attendance
      };
    });
    
    // Helper function to get Wednesday of the week for any given date
    const getWednesdayOfWeek = (date: Date) => {
      const result = new Date(date);
      const day = result.getUTCDay();
      
      if (day < 3) {
        result.setUTCDate(result.getUTCDate() - (day + 4));
      } else {
        result.setUTCDate(result.getUTCDate() - (day - 3));
      }
      
      result.setUTCHours(0, 0, 0, 0);
      return result;
    };
    
    // Collect all weeks from all groups to ensure consistent time series
    const allWeeks = new Set();
    
    allGroupsAttendance.forEach(groupData => {
      groupData.events.forEach(event => {
        const eventDate = new Date(event.event.date);
        const dayOfWeek = eventDate.getDay();
        
        // Only process Wednesday and Thursday events
        if (dayOfWeek === 3 || dayOfWeek === 4) {
          const wednesday = getWednesdayOfWeek(eventDate);
          const weekKey = wednesday.toISOString().split('T')[0];
          
          // Only include past/current events
          const now = new Date();
          if (eventDate <= now) {
            allWeeks.add(weekKey);
          }
        }
      });
    });
    
    // Sort weeks chronologically
    const sortedWeeks = Array.from(allWeeks).sort();
    
    // Build time series for each group
    const groupTimeSeries = allGroupsAttendance.map(groupData => {
      const groupWeekMap = new Map();
      
      // Process events for this group
      groupData.events.forEach(event => {
        const eventDate = new Date(event.event.date);
        const dayOfWeek = eventDate.getDay();
        
        if (dayOfWeek === 3 || dayOfWeek === 4) {
          const wednesday = getWednesdayOfWeek(eventDate);
          const weekKey = wednesday.toISOString().split('T')[0];
          
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          yesterday.setHours(23, 59, 59, 999);
          
          if (!event.event.canceled && 
              (event.attendance_summary.present_count > 0 || eventDate <= yesterday)) {
            
            const existing = groupWeekMap.get(weekKey) || { 
              totalPresent: 0,
              totalVisitors: 0,
              totalMembers: 0,
              hasData: false
            };
            
            // Only count each event once per week
            const eventKey = `${event.event.id}-${dayOfWeek}`;
            if (!existing.processedEvents) {
              existing.processedEvents = new Set();
            }
            
            if (!existing.processedEvents.has(eventKey)) {
              existing.totalPresent += event.attendance_summary.present_members;
              existing.totalVisitors += event.attendance_summary.present_visitors;
              existing.totalMembers = Math.max(existing.totalMembers, event.attendance_summary.total_count || 0);
              existing.hasData = true;
              existing.processedEvents.add(eventKey);
            }
            
            groupWeekMap.set(weekKey, existing);
          }
        }
      });
      
      // Create time series array for this group
      const timeSeries = sortedWeeks.map(weekKey => {
        const weekData = groupWeekMap.get(weekKey);
        if (weekData && weekData.hasData) {
          let value;
          
          switch (metric) {
            case 'attendance':
              value = weekData.totalPresent + weekData.totalVisitors;
              break;
            case 'membership':
              value = weekData.totalMembers;
              break;
            case 'percentage':
              value = weekData.totalMembers > 0 ? 
                     Math.round((weekData.totalPresent / weekData.totalMembers) * 100) : 
                     0;
              break;
            default:
              value = weekData.totalPresent + weekData.totalVisitors;
          }
          
          return {
            date: weekKey,
            attendance: value
          };
        } else {
          return {
            date: weekKey,
            attendance: null // No data for this week
          };
        }
      });
      
      return {
        groupId: groupData.groupId,
        groupName: groupData.groupName,
        data: timeSeries
      };
    });
    
    res.json({
      groups: groupTimeSeries,
      weeks: sortedWeeks
    });
  } catch (error) {
    console.error('Error fetching individual group attendance:', error);
    res.status(500).json({ 
      error: 'Failed to fetch individual group attendance data', 
      details: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
});

// Add new endpoint for aggregated attendance data
app.get('/api/aggregate-attendance', async (req, res) => {
  try {
    const forceRefresh = req.query.forceRefresh === 'true';
    const showAllEvents = req.query.showAll === 'true';
    const groupTypeIdFromEnv = process.env.PCO_GROUP_TYPE_ID;
    const groupTypeId = groupTypeIdFromEnv ? parseInt(groupTypeIdFromEnv, 10) : 429361;
    
    // Parse filter parameters
    // If no filters are provided, use defaults. If empty string is provided, use empty array (no groups)
    const groupTypesFilter = req.query.groupTypes === '' ? [] : 
                           req.query.groupTypes ? (req.query.groupTypes as string).split(',') : 
                           ['Family', 'Stage of Life', 'Location Based'];
    const meetingDaysFilter = req.query.meetingDays === '' ? [] : 
                            req.query.meetingDays ? (req.query.meetingDays as string).split(',') : 
                            ['Wednesday', 'Thursday'];
    
    // Parse selected group IDs filter
    const selectedGroupIds = req.query.selectedGroups ? 
                           (req.query.selectedGroups as string).split(',').filter(id => id.trim()) : 
                           null;
    

    
    // Get all groups first
    const groups = await getPeopleGroups(groupTypeId, forceRefresh);
    
    // Apply filters to groups
    const filteredGroups = {
      ...groups,
      data: groups.data.filter(group => {
        const groupType = group.metadata?.groupType || 'Unknown';
        const meetingDay = group.metadata?.meetingDay || 'Unknown';
        
        // If specific groups are selected, only include those groups
        if (selectedGroupIds && selectedGroupIds.length > 0) {
          return selectedGroupIds.includes(group.id);
        }
        
        // Otherwise, use the normal filtering logic
        // If no group types are selected, show no groups
        if (groupTypesFilter.length === 0) {
          return false;
        }
        
        // If no meeting days are selected, show no groups
        if (meetingDaysFilter.length === 0) {
          return false;
        }
        
        // For group types: include if type is selected, or if type is Unknown and at least one type is selected
        const matchesGroupType = groupTypesFilter.includes(groupType) || 
                               (groupType === 'Unknown' && groupTypesFilter.length > 0);
        
        // For meeting days: include if day is selected, or if day is Unknown and at least one day is selected
        const matchesMeetingDay = meetingDaysFilter.includes(meetingDay) || 
                                (meetingDay === 'Unknown' && meetingDaysFilter.length > 0);
        
        return matchesGroupType && matchesMeetingDay;
      })
    };
    
    // If no groups match the filters, return empty data immediately
    if (filteredGroups.data.length === 0) {
      return res.json([]);
    }
    
    // Get attendance data for each filtered group
    // For aggregate calculations, we need some historical data to find fallback membership counts
    // Use current year + previous year to capture November 2024 data for early 2025 weeks
    const allGroupsAttendance = await mapWithConcurrency(filteredGroups.data, GROUP_ATTENDANCE_CONCURRENCY, async (group) => {
      const attendance = await getGroupAttendance(group.id, showAllEvents, forceRefresh);
      return {
        ...attendance,
        group_name: group.attributes.name
      };
    });
    
    // For groups that are missing membership data in early weeks, fetch additional historical data
    // But keep it separate so it's only used for fallback membership, not for creating weeks
    const historicalFallbackData = new Map();
    const needsHistoricalData = new Set(['2291027', '2385028']); // Groups we know need November 2024 data
    
    // Fetch historical data only for groups that need it, but keep it separate
    // Only fetch additional historical data if we're not already showing all events
    if (!showAllEvents) {
      for (const groupId of needsHistoricalData) {
        try {
          const historicalData = await getGroupAttendance(groupId, true, forceRefresh);
          // Only keep events from previous years for fallback purposes
          const currentYear = new Date().getFullYear();
          const historicalEvents = historicalData.events.filter(event => {
            const eventYear = new Date(event.event.date).getFullYear();
            return eventYear < currentYear; // Only previous year events
          });
          historicalFallbackData.set(groupId, historicalEvents);

        } catch (error) {
          console.error(`Failed to fetch historical data for group ${groupId}:`, error);
        }
      }
    }
    
    // Create a map of week -> attendance data
    const weekMap = new Map();
    

    
    // Helper function to get Wednesday of the week for any given date
    const getWednesdayOfWeek = (date: Date) => {
      const result = new Date(date);
      const day = result.getUTCDay(); // Use UTC to avoid timezone issues
      
      // If it's Sunday (0) through Tuesday (2), get previous Wednesday
      if (day < 3) {
        result.setUTCDate(result.getUTCDate() - (day + 4));
      }
      // If it's Wednesday (3) through Saturday (6), get this week's Wednesday
      else {
        result.setUTCDate(result.getUTCDate() - (day - 3));
      }
      
      // Reset time to midnight UTC to ensure consistent dates
      result.setUTCHours(0, 0, 0, 0);
      return result;
    };
    
    // First pass: collect all weeks that have any events (for attendance data)
    const weeksWithEvents = new Set();
    allGroupsAttendance.forEach((groupData, groupIndex) => {
      
      groupData.events.forEach(event => {
        const eventDate = new Date(event.event.date);
        const dayOfWeek = eventDate.getDay();
        
        // Only process Wednesday and Thursday events
        if (dayOfWeek === 3 || dayOfWeek === 4) {
          const wednesday = getWednesdayOfWeek(eventDate);
          const weekKey = wednesday.toISOString().split('T')[0];
          
          // For events with 0 attendance, only include if the event date is at least yesterday
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          yesterday.setHours(23, 59, 59, 999); // End of yesterday
          
          // Track all groups that had events scheduled (cancelled or not)
          const existing = weekMap.get(weekKey) || { 
            totalPresent: 0,
            totalVisitors: 0,
            familyPresent: 0,
            nonFamilyPresent: 0,
            familyVisitors: 0,
            nonFamilyVisitors: 0,
            groupsProcessed: new Set(),
            groupsWithAttendance: new Set(),
            groupsWithActualAttendance: new Set(),
            groupsWithActualAttendanceNames: new Set(),
            groupsWithCancelledEvents: new Set(),
            groupsWithScheduledEvents: new Set(),
            daysWithAttendance: new Set()
          };
          
          // Track that this group had an event scheduled this week
          existing.groupsWithScheduledEvents.add(groupData.group_name);
          
          // Handle cancelled events separately
          if (event.event.canceled) {
            existing.groupsWithCancelledEvents.add(groupData.group_name);
            weekMap.set(weekKey, existing);
          }
          // Only count attendance for non-cancelled events with attendance or events from yesterday/earlier
          else if (event.attendance_summary.present_count > 0 || 
                   (event.attendance_summary.present_count === 0 && eventDate <= yesterday)) {
            
            // Add this group's data if we haven't processed it for this week
            const groupKey = `${event.event.id}-${dayOfWeek}`;
            if (!existing.groupsProcessed.has(groupKey)) {
              existing.totalPresent += event.attendance_summary.present_members;
              existing.totalVisitors += event.attendance_summary.present_visitors;
              
              // Track family vs non-family attendance
              // Find the corresponding group data to check if it's a family group
              // Since allGroupsAttendance was built from filteredGroups.data, we can find the group there
              const correspondingGroup = filteredGroups.data.find(g => g.id === groupData.group_id);
              if (correspondingGroup && correspondingGroup.isFamilyGroup) {
                existing.familyPresent += event.attendance_summary.present_members;
                existing.familyVisitors += event.attendance_summary.present_visitors;
              } else {
                existing.nonFamilyPresent += event.attendance_summary.present_members;
                existing.nonFamilyVisitors += event.attendance_summary.present_visitors;
              }
              
              existing.groupsProcessed.add(groupKey);
              existing.groupsProcessed.add(event.event.id);
              existing.groupsWithAttendance.add(groupData.group_id);
              
              // Only count groups with actual attendance (> 0 people present)
              if (event.attendance_summary.present_count > 0) {
                existing.groupsWithActualAttendance.add(groupData.group_id);
                existing.groupsWithActualAttendanceNames.add(groupData.group_name);
              }
              
              existing.daysWithAttendance.add(dayOfWeek);
            }
            
            weekMap.set(weekKey, existing);
          }
        }
      });
    });
    
    // Filter out weeks with insufficient group participation
    // Check if we're using filters or selected groups - if so, show all data regardless of group count
    const isFiltered = groupTypesFilter.length < 3 || meetingDaysFilter.length < 2 || selectedGroupIds;
    
    const validWeeks = new Set();
    if (isFiltered) {
      // When filtered, include all weeks that have any attendance data
      weekMap.forEach((weekData, weekKey) => {
        if (weekData.groupsWithAttendance.size >= 1) {
          validWeeks.add(weekKey);
        }
      });
    } else {
      // When showing all groups, maintain the 5-group minimum for statistical relevance
      weekMap.forEach((weekData, weekKey) => {
        if (weekData.groupsWithAttendance.size >= 5) {
          validWeeks.add(weekKey);
        }
      });
    }
    
    // Remove weeks with insufficient group participation
    weekMap.forEach((weekData, weekKey) => {
      if (!validWeeks.has(weekKey)) {
        weekMap.delete(weekKey);
      }
    });
    
    // Second pass: calculate total membership for each week (including ALL groups)
    validWeeks.forEach(weekKey => {
      const existing = weekMap.get(weekKey) || { 
        totalPresent: 0,
        totalVisitors: 0,
        familyPresent: 0,
        nonFamilyPresent: 0,
        familyVisitors: 0,
        nonFamilyVisitors: 0,
        groupsProcessed: new Set(),
        groupsWithAttendance: new Set(),
        daysWithAttendance: new Set()
      };
      
      // Calculate total membership from ALL groups for this week
      let totalMembers = 0;
      const groupsWithMembershipData = new Set();
      
      allGroupsAttendance.forEach(groupData => {
        // Find the most recent total_count for this group in this week
        let maxTotalCount = 0;
        let membershipSource = 'none';
        
        // First, try to get membership data from events in the target week
        groupData.events.forEach(event => {
          const eventDate = new Date(event.event.date);
          const dayOfWeek = eventDate.getDay();
          
          // Only Wed/Thu events
          if (dayOfWeek === 3 || dayOfWeek === 4) {
            const eventWednesday = getWednesdayOfWeek(eventDate);
            const eventWeekKey = eventWednesday.toISOString().split('T')[0];
            
            // If this event is in our target week and has reliable attendance data
            // For events with 0 attendance, only include if the event date is at least yesterday
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            yesterday.setHours(23, 59, 59, 999); // End of yesterday
            
            if (eventWeekKey === weekKey && !event.event.canceled && event.attendance_summary.present_count >= 0 && event.attendance_summary.total_count > 0 &&
                (event.attendance_summary.present_count > 0 || eventDate <= yesterday)) {
              maxTotalCount = Math.max(maxTotalCount, event.attendance_summary.total_count);
              membershipSource = 'week_events';
            }
          }
        });
        
        // If no reliable attendance data for this week, find the most recent reliable data from any week
        if (maxTotalCount === 0) {
          // For early 2025 weeks, we need to look back to November 2024 for some groups
          // Set a reasonable time limit for fallback data (e.g., within the last 4 months)
          const weekDate = new Date(weekKey + 'T00:00:00.000Z');
          const fourMonthsAgo = new Date(weekDate);
          fourMonthsAgo.setMonth(fourMonthsAgo.getMonth() - 4);
          
          // Sort events by date (most recent first) and find the first valid one
          // Only look at events that are not in the future relative to the week we're calculating
          // Include historical fallback data if available for this group
          let eventsToSearch = groupData.events.slice(); // Create a copy
          if (historicalFallbackData.has(groupData.group_id)) {
            eventsToSearch = eventsToSearch.concat(historicalFallbackData.get(groupData.group_id));
          }
          
          const mostRecentEvent = eventsToSearch
            .filter(event => {
              const eventDate = new Date(event.event.date);
              return eventDate <= weekDate; // Only consider events up to the week we're calculating
            })
            .sort((a, b) => new Date(b.event.date).getTime() - new Date(a.event.date).getTime())
            .find(event => {
              const eventDate = new Date(event.event.date);
              // For events with 0 attendance, only include if the event date is at least yesterday
              const yesterday = new Date();
              yesterday.setDate(yesterday.getDate() - 1);
              yesterday.setHours(23, 59, 59, 999); // End of yesterday
              
              return !event.event.canceled && 
                     event.attendance_summary.present_count >= 0 && 
                     event.attendance_summary.total_count > 0 &&
                     eventDate >= fourMonthsAgo && // Don't use data older than 4 months
                     (event.attendance_summary.present_count > 0 || eventDate <= yesterday); // Only use 0-attendance events if they're from yesterday or earlier
            });
          
          if (mostRecentEvent && mostRecentEvent.attendance_summary) {
            maxTotalCount = mostRecentEvent.attendance_summary.total_count;
            membershipSource = 'most_recent_reliable_event';
            

          }
        }
        
        if (maxTotalCount > 0) {
          totalMembers += maxTotalCount;
          groupsWithMembershipData.add(groupData.group_id);
        }
      });
      
      existing.totalMembers = totalMembers;
      weekMap.set(weekKey, existing);
    });
    
    // Convert map to array and sort by date
    const aggregatedData = Array.from(weekMap.entries())
      .map(([weekKey, data]) => {
        // Find groups that had events scheduled but didn't submit attendance (excluding cancelled)
        const groupsWithDataNames = Array.from(data.groupsWithActualAttendanceNames);
        const groupsWithCancelledEvents = Array.from(data.groupsWithCancelledEvents);
        const groupsWithScheduledEvents = Array.from(data.groupsWithScheduledEvents);
        
        const groupsMissingData = groupsWithScheduledEvents.filter(name => 
          !groupsWithDataNames.includes(name) && !groupsWithCancelledEvents.includes(name)
        );
        
        // Count groups with actual attendance + groups with cancelled events as "groups with data"
        const totalGroupsWithCompleteData = data.groupsWithActualAttendance.size + groupsWithCancelledEvents.length;
        
        return {
          date: weekKey,
          totalPresent: data.totalPresent,
          totalVisitors: data.totalVisitors,
          totalWithVisitors: data.totalPresent + data.totalVisitors,
          familyPresent: data.familyPresent,
          nonFamilyPresent: data.nonFamilyPresent,
          familyVisitors: data.familyVisitors,
          nonFamilyVisitors: data.nonFamilyVisitors,
          totalMembers: data.totalMembers,
          attendanceRate: data.totalMembers > 0 ? Math.round((data.totalPresent / data.totalMembers) * 100) : 0,
          daysIncluded: Array.from(data.daysWithAttendance).length,
          groupsWithData: totalGroupsWithCompleteData,
          totalGroupsWithEvents: groupsWithScheduledEvents.length,
          groupsMissingData: groupsMissingData.sort(),
          groupsWithCancelledEvents: groupsWithCancelledEvents.sort(),
          isPerfectWeek: groupsMissingData.length === 0 && groupsWithScheduledEvents.length > 0
        };
      })
      .filter(week => week.totalMembers > 0 || week.totalPresent > 0) // Only include weeks with actual data
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    
    res.json(aggregatedData);
  } catch (error) {
    console.error('Error fetching aggregate attendance:', error);
    if (error instanceof Error) {
      console.error('Error details:', {
        message: error.message,
        stack: error.stack,
        name: error.name
      });
      res.status(500).json({ error: 'Failed to fetch aggregate attendance data', details: error.message });
    } else {
      res.status(500).json({ error: 'Failed to fetch aggregate attendance data', details: 'Unknown error' });
    }
  }
});




// Add new endpoint to clear cache
app.get('/api/clear-cache', async (req, res) => {
  try {
    cache.clear();
    res.json({ message: 'Cache cleared successfully. Next data refresh will fetch fresh data.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to clear cache', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// Add health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    const envInfo = {
      status: 'ok',
      nodeEnv: process.env.NODE_ENV,
      hasApiCreds: !!(process.env.PCO_APP_ID && process.env.PCO_SECRET),
      pcoAppIdExists: !!process.env.PCO_APP_ID,
      pcoSecretExists: !!process.env.PCO_SECRET,
      groupTypeId: process.env.PCO_GROUP_TYPE_ID || 'using default 429361',
      memoryUsage: process.memoryUsage(),
      uptime: process.uptime(),
      platform: process.platform,
      nodeVersion: process.version,
      timestamp: new Date().toISOString()
    };
    
    res.json(envInfo);
  } catch (error) {
    res.status(500).json({ 
      status: 'error',
      error: 'Health check failed', 
      details: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

// Add new endpoint for membership changes
app.get('/api/membership-changes', async (req, res) => {
  try {
    const daysBack = parseInt(req.query.days as string) || 30;
    const changes = membershipSnapshots.getMembershipChanges(daysBack);
    
    res.json({
      daysBack: daysBack,
      latestSnapshotDate: membershipSnapshots.getLatestSnapshotDate(),
      ...changes
    });
  } catch (error) {
    console.error('Error fetching membership changes:', error);
    res.status(500).json({ error: 'Failed to fetch membership changes' });
  }
});

// Add new endpoint to trigger membership snapshot creation
app.post('/api/create-membership-snapshot', async (req, res) => {
  try {
    const forceRefresh = req.query.forceRefresh === 'true';
    const date = new Date().toISOString().split('T')[0];
    
    // Check if we already have a snapshot for today (unless force refresh)
    if (!forceRefresh && membershipSnapshots.hasSnapshotForDate(date)) {
      return res.json({ 
        message: 'Snapshot already exists for today',
        date: date,
        created: false
      });
    }
    
    const groupTypeIdFromEnv = process.env.PCO_GROUP_TYPE_ID;
    const groupTypeId = groupTypeIdFromEnv ? parseInt(groupTypeIdFromEnv, 10) : 429361;
    
    // Get all groups
    const groups = await getPeopleGroups(groupTypeId, false);
    
    let successCount = 0;
    let errorCount = 0;
    
    // Create snapshots for each group
    for (const group of groups.data) {
      try {
        const memberships = await getGroupMemberships(group.id, true); // Force refresh for snapshots!
        membershipSnapshots.storeDailySnapshot(date, group.id, group.attributes.name, memberships);
        successCount++;
        
        // Add small delay to be respectful to the API
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        console.error(`Failed to create snapshot for group ${group.id} (${group.attributes.name}):`, error);
        errorCount++;
      }
    }
    
    console.log(`Membership snapshot created for ${date}. Success: ${successCount}, Errors: ${errorCount}`);
    
    res.json({
      message: 'Membership snapshot creation completed',
      date: date,
      created: true,
      totalGroups: groups.data.length,
      successCount: successCount,
      errorCount: errorCount
    });
  } catch (error) {
    console.error('Error creating membership snapshot:', error);
    res.status(500).json({ error: 'Failed to create membership snapshot', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// Add new endpoint to get membership snapshot status
app.get('/api/membership-snapshot-status', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const latestSnapshotDate = membershipSnapshots.getLatestSnapshotDate();
    
    res.json({
      latestSnapshotDate: latestSnapshotDate,
      hasSnapshotForToday: membershipSnapshots.hasSnapshotForDate(today),
      daysSinceLastSnapshot: latestSnapshotDate ? 
        Math.floor((new Date().getTime() - new Date(latestSnapshotDate).getTime()) / (1000 * 60 * 60 * 24)) : 
        null
    });
  } catch (error) {
    console.error('Error checking membership snapshot status:', error);
    res.status(500).json({ error: 'Failed to check membership snapshot status' });
  }
});

// Add alias endpoint for manual snapshot capture from the UI
app.post('/api/capture-membership-snapshot', async (req, res) => {
  try {
    const forceRefresh = req.body?.forceRefresh || false;
    const date = new Date().toISOString().split('T')[0];
    
    // Check if we already have a snapshot for today (unless force refresh)
    if (!forceRefresh && membershipSnapshots.hasSnapshotForDate(date)) {
      return res.json({
        success: true,
        message: 'Snapshot already exists for today',
        date: date
      });
    }
    
    // Get all groups
    const groupTypeIdFromEnv = process.env.PCO_GROUP_TYPE_ID;
    const groupTypeId = groupTypeIdFromEnv ? parseInt(groupTypeIdFromEnv, 10) : 429361;
    const groups = await getPeopleGroups(groupTypeId, false);
    
    let successCount = 0;
    let errorCount = 0;
    
    // Create snapshots for each group
    for (const group of groups.data) {
      try {
        const memberships = await getGroupMemberships(group.id, true); // Force refresh for snapshots!
        membershipSnapshots.storeDailySnapshot(date, group.id, group.attributes.name, memberships);
        successCount++;
      } catch (error) {
        errorCount++;
        console.error(`Failed to create snapshot for group ${group.id} (${group.attributes.name}):`, error);
      }
    }
    
    console.log(`Membership snapshot created for ${date}. Success: ${successCount}, Errors: ${errorCount}`);
    
    res.json({
      success: true,
      message: `Captured snapshot for ${successCount} group${successCount !== 1 ? 's' : ''}`,
      date: date,
      successCount: successCount,
      errorCount: errorCount
    });
  } catch (error) {
    console.error('Error creating membership snapshot:', error);
    res.status(500).json({ error: 'Failed to create membership snapshot', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// Add endpoint to get attendance request information
app.post('/api/request-attendance', async (req, res) => {
  try {
    const { groupId, getUrlsOnly } = req.body;
    
    if (!groupId) {
      return res.status(400).json({ error: 'Group ID is required' });
    }
    
    // Get recent events for this group that need attendance
    const attendanceData = await getGroupAttendance(groupId, false, false);
    const eventsNeedingAttention = attendanceData.events.filter(event => {
      const now = new Date();
      const sixDaysAgo = new Date(now.getTime() - (6 * 24 * 60 * 60 * 1000));
      const eventDate = new Date(event.event.date);
      
      // Only check events from the last 6 days
      if (eventDate < sixDaysAgo || eventDate > now) {
        return false;
      }
      
      // Check if event is cancelled
      if (event.event.canceled) {
        return false;
      }
      
      // Check if attendance has been submitted
      const hasAttendanceData = event.attendance_summary.present_count > 0 || 
                               (event.attendance_summary.present_count === 0 && event.attendance_summary.total_count > 0);
      
      // Add a buffer time - only flag events that ended at least 4 hours ago
      const fourHoursAgo = new Date(now.getTime() - (4 * 60 * 60 * 1000));
      const eventEndTime = new Date(eventDate.getTime() + (2 * 60 * 60 * 1000));
      
      return eventEndTime < fourHoursAgo && !hasAttendanceData;
    });
    
    if (eventsNeedingAttention.length === 0) {
      return res.json({ 
        success: false, 
        message: 'No events need attendance requests',
        eventUrls: []
      });
    }
    
    // If getUrlsOnly is true, just return the event IDs for opening PCO pages
    if (getUrlsOnly) {
      const eventIds = eventsNeedingAttention.map(event => event.event.id);
      
      res.json({
        success: true,
        message: `Found ${eventIds.length} event${eventIds.length !== 1 ? 's' : ''} needing attendance requests`,
        eventUrls: eventIds
      });
    } else {
      // Legacy response for backwards compatibility
      res.json({
        success: false,
        message: 'API attendance requests are not supported - this endpoint now returns URLs for manual requests',
        eventUrls: eventsNeedingAttention.map(event => event.event.id)
      });
    }
    
  } catch (error) {
    console.error('Fatal error:', error);
    const response = { 
      error: 'Failed to request attendance', 
      details: error instanceof Error ? error.message : 'Unknown error' 
    };

    res.status(500).json(response);
  }
});

// Dream Teams API endpoints
app.get('/api/dream-teams', async (req, res) => {
  try {
    const forceRefresh = req.query.forceRefresh === 'true';
    const workflows = await getDreamTeamWorkflows(forceRefresh);
    
    // Get all removals from database to cross-reference with live PCO data
    const allRemovals = dreamTeamsTracking.getAllPendingRemovals();
    
    // Add local tracking data (review dates, removal flags)
    const workflowsWithTracking = workflows.map(workflow => {
      const lastReviewed = dreamTeamsTracking.getLastReviewDate(workflow.id);
      const lastReviewInfo = dreamTeamsTracking.getLastReviewInfo(workflow.id);
      
      // Filter database removals to only unprocessed ones that are still active in this workflow's PCO data
      const workflowRemovals = allRemovals.filter(removal => 
        removal.workflowId === workflow.id && removal.processed === 0
      );
      const actualPendingRemovals = workflowRemovals.filter(removal => {
        // Check if this person is still in the current workflow roster
        const currentMember = workflow.roster.find(member => member.personId === removal.personId);
        if (!currentMember) {
          return false; // Not in roster
        }
        
        // Check if they rejoined after the removal date (compare dates only, not times)
        const joinDate = new Date(currentMember.movedToStepAt || currentMember.joinedAt);
        
        // Parse removal date string directly (YYYY-MM-DD format) to avoid timezone issues
        const removalDateParts = removal.removalDate.split('-');
        const removalYear = parseInt(removalDateParts[0]);
        const removalMonth = parseInt(removalDateParts[1]) - 1; // JS months are 0-indexed
        const removalDay = parseInt(removalDateParts[2]);
        
        // Compare only the DATE portion (ignore time of day)
        const joinDateOnly = new Date(joinDate.getFullYear(), joinDate.getMonth(), joinDate.getDate());
        const removalDateOnly = new Date(removalYear, removalMonth, removalDay);
        
        // Only consider it pending if they didn't rejoin after removal
        return joinDateOnly <= removalDateOnly;
      });
      
      // Calculate if review is needed based on the 15th-of-the-month logic
      let needsReview = true;
      if (lastReviewed) {
        // Parse the review date (YYYY-MM-DD format) as local time
        const dateParts = lastReviewed.split('-');
        const reviewDate = new Date(parseInt(dateParts[0]), parseInt(dateParts[1]) - 1, parseInt(dateParts[2]));
        const now = new Date();
        
        // Calculate the next 15th after the review date
        let next15th = new Date(reviewDate.getFullYear(), reviewDate.getMonth(), 15);
        
        // If the review date is on or after the 15th of that month, move to the 15th of next month
        if (reviewDate.getDate() >= 15) {
          next15th = new Date(reviewDate.getFullYear(), reviewDate.getMonth() + 1, 15);
        }
        
        // Team needs review if we've reached or passed the next 15th
        needsReview = now >= next15th;
      }
      
      return {
        ...workflow,
        lastReviewed,
        lastReviewer: lastReviewInfo?.reviewer || null,
        needsReview,
        pendingRemovals: actualPendingRemovals.length
      };
    });
    
    res.json({
      success: true,
      data: workflowsWithTracking
    });
  } catch (error) {
    console.error('Dream Teams API Error:', error);
    console.error('Error stack:', error instanceof Error ? error.stack : 'No stack trace');
    
    // More detailed error logging
    if (error instanceof Error) {
      console.error('Error name:', error.name);
      console.error('Error message:', error.message);
      if ('response' in error) {
        console.error('HTTP response:', (error as any).response?.status, (error as any).response?.statusText);
        console.error('Response data:', (error as any).response?.data);
      }
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to fetch dream teams data',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Hidden endpoint: Export all Dream Teamer emails (only enabled when ENABLE_EMAIL_EXPORT=true)
app.get('/api/dream-teams/export-emails', async (req, res) => {
  // Check if email export is enabled via environment variable
  if (process.env.ENABLE_EMAIL_EXPORT !== 'true') {
    return res.status(404).json({ success: false, error: 'Not Found' });
  }
  
  try {
    const forceRefresh = req.query.forceRefresh === 'true';
    
    // Get all dream team workflows
    const currentWorkflows = await getDreamTeamWorkflows(forceRefresh);
    
    // Collect all unique person IDs
    const uniquePersonIds = new Set<string>();
    currentWorkflows.forEach(workflow => {
      workflow.roster.forEach(member => {
        uniquePersonIds.add(member.personId);
      });
    });
    
    console.log(`Fetching email data for ${uniquePersonIds.size} unique dream teamers...`);
    
    // Fetch email addresses for each person
    const emailData: Array<{
      personId: string;
      firstName: string;
      lastName: string;
      emails: string[];
      teams: string[];
    }> = [];
    
    // Helper function to fetch email with retry logic for rate limiting
    const fetchPersonEmail = async (personId: string, retries = 5): Promise<string | null> => {
      try {
        const response = await pcoClient.get(`/people/v2/people/${personId}`, {
          params: {
            include: 'emails'
          }
        });
        
        const emails = response.data.included?.filter((item: any) => item.type === 'Email') || [];
        
        // Find the primary email address
        const primaryEmailObj = emails.find((email: any) => email.attributes.primary === true);
        if (primaryEmailObj) {
          return primaryEmailObj.attributes.address;
        } else if (emails.length > 0) {
          // If no primary email is marked, use the first one
          return emails[0].attributes.address;
        }
        return null;
      } catch (error: any) {
        // Handle rate limiting (429) with exponential backoff
        if (error.response?.status === 429 && retries > 0) {
          const retryAfter = parseInt(error.response.headers['retry-after'] || '0');
          const waitTime = retryAfter * 1000 || 3000 * Math.pow(2, 5 - retries);
          console.log(`Rate limited for person ${personId}, waiting ${waitTime/1000}s (${retries - 1} retries left)`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          return fetchPersonEmail(personId, retries - 1);
        }
        throw error;
      }
    };
    
    for (const personId of uniquePersonIds) {
      // First, get the person's name from the workflow roster data we already have
      let firstName = 'Unknown';
      let lastName = '';
      const teams: string[] = [];
      
      currentWorkflows.forEach(workflow => {
        const member = workflow.roster.find(m => m.personId === personId);
        if (member) {
          firstName = member.firstName;
          lastName = member.lastName;
          teams.push(workflow.name);
        }
      });
      
      // Now try to fetch their email address with retry logic
      let primaryEmail: string | null = null;
      
      try {
        primaryEmail = await fetchPersonEmail(personId);
        
        // Add delay to avoid rate limiting (200ms per request)
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (error: any) {
        console.error(`Error fetching email for person ${personId} (${firstName} ${lastName}):`, error.message);
        // Continue without email - we'll still add the person to the list
      }
      
      // Add person to results (even if we couldn't get their email)
      emailData.push({
        personId,
        firstName,
        lastName,
        emails: primaryEmail ? [primaryEmail] : [],
        teams
      });
    }
    
    // Sort by last name, then first name
    emailData.sort((a, b) => {
      const lastNameCompare = a.lastName.localeCompare(b.lastName);
      if (lastNameCompare !== 0) return lastNameCompare;
      return a.firstName.localeCompare(b.firstName);
    });
    
    res.json({
      success: true,
      data: {
        totalPeople: emailData.length,
        dreamTeamers: emailData
      }
    });
  } catch (error) {
    console.error('Error exporting dream teamer emails:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to export email addresses'
    });
  }
});

// Get all pending removals across all teams (for admin review)
app.get('/api/dream-teams/pending-removals', async (req, res) => {
  try {
    const forceRefresh = req.query.forceRefresh === 'true';
    
    // Get all removals from database
    const allRemovals = dreamTeamsTracking.getAllPendingRemovals();
    
    // Get current PCO data for all workflows to see who's still there
    const currentWorkflows = await getDreamTeamWorkflows(forceRefresh);
    
    // Create a set of current active members across all workflows
    const currentActiveMembers = new Set();
    currentWorkflows.forEach(workflow => {
      workflow.roster.forEach(member => {
        currentActiveMembers.add(`${workflow.id}-${member.personId}`);
      });
    });
    
    // Create a map of current members with their join dates for rejoin checking
    const currentMemberDetails = new Map();
    currentWorkflows.forEach(workflow => {
      workflow.roster.forEach(member => {
        const memberKey = `${workflow.id}-${member.personId}`;
        currentMemberDetails.set(memberKey, {
          joinDate: new Date(member.movedToStepAt || member.joinedAt),
          workflowId: workflow.id,
          personId: member.personId
        });
      });
    });
    
    // Filter removals to only show unprocessed people who are still in PCO workflows AND haven't rejoined
    const actualPendingRemovals = allRemovals.filter(removal => {
      // Only show unprocessed removals
      if (removal.processed === 1) {
        return false;
      }
      
      const memberKey = `${removal.workflowId}-${removal.personId}`;
      const memberDetails = currentMemberDetails.get(memberKey);
      
      if (!memberDetails) {
        return false; // Not currently in any workflow
      }
      
      // Check if they rejoined after the removal date (compare dates only, not times)
      const joinDate = memberDetails.joinDate;
      
      // Parse removal date string directly (YYYY-MM-DD format) to avoid timezone issues
      const removalDateParts = removal.removalDate.split('-');
      const removalYear = parseInt(removalDateParts[0]);
      const removalMonth = parseInt(removalDateParts[1]) - 1; // JS months are 0-indexed
      const removalDay = parseInt(removalDateParts[2]);
      
      // Compare only the DATE portion (ignore time of day)
      const joinDateOnly = new Date(joinDate.getFullYear(), joinDate.getMonth(), joinDate.getDate());
      const removalDateOnly = new Date(removalYear, removalMonth, removalDay);
      
      return joinDateOnly <= removalDateOnly;
    });
    
    res.json({
      success: true,
      data: {
        pendingRemovals: actualPendingRemovals,
        totalCount: actualPendingRemovals.length
      }
    });
  } catch (error) {
    console.error('Error fetching all pending removals:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch pending removals'
    });
  }
});

// Search PCO people for adding as leaders
// NOTE: This route MUST be before /api/dream-teams/:workflowId to avoid conflict
app.get('/api/dream-teams/search-people', async (req, res) => {
  try {
    const { q } = req.query;
    
    if (!q || typeof q !== 'string' || q.trim().length < 2) {
      return res.status(400).json({
        success: false,
        error: 'Search query must be at least 2 characters'
      });
    }
    
    // Search PCO for people matching the query using the search_name parameter
    const searchQuery = q.trim();
    const response = await pcoClient.get('/people/v2/people', {
      params: {
        'where[search_name]': searchQuery,
        'per_page': 20
      }
    });
    
    const people = response.data.data.map((person: any) => ({
      id: person.id,
      firstName: person.attributes.first_name,
      lastName: person.attributes.last_name,
      name: `${person.attributes.first_name} ${person.attributes.last_name}`.trim()
    }));
    
    res.json({
      success: true,
      data: people
    });
  } catch (error) {
    console.error('Error searching PCO people:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to search people'
    });
  }
});

// Test endpoint for check-in notifications (manual trigger)
// IMPORTANT: This must be defined BEFORE the :workflowId route
app.get('/api/dream-teams/test-notifications', async (req, res) => {
  try {
    if (process.env.CHECKIN_EMAIL_FLAG !== 'true') {
      console.log('Check-in notifications are disabled (CHECKIN_EMAIL_FLAG is not set to true)');
      return res.json({
        success: true,
        message: 'Check-in notifications are currently disabled',
        notificationsEnabled: false
      });
    }
    
    console.log('Manually triggering check-in notification check...');
    const result = await sendCheckInNotifications();
    res.json({
      success: true,
      notificationsEnabled: true,
      ...result
    });
  } catch (error) {
    console.error('Error testing notifications:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Admin endpoint: resend check-in notification emails
// IMPORTANT: This must be defined BEFORE the :workflowId route
app.post('/api/dream-teams/resend-checkin-emails', async (req, res) => {
  try {
    console.log('Admin triggered resend of Dream Team check-in notification emails');
    const result = await sendCheckInNotifications();

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Error resending check-in emails:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

app.get('/api/dream-teams/:workflowId', async (req, res) => {
  try {
    const { workflowId } = req.params;
    const forceRefresh = req.query.forceRefresh === 'true';
    
    // Get workflow cards and people data
    const { cards, people } = await getWorkflowCards(workflowId, forceRefresh);
    
    // Get workflow details for the name
    const workflowResponse = await pcoClient.get(`/people/v2/workflows/${workflowId}`);
    const workflowName = workflowResponse.data.data.attributes.name;
    
    // Create person lookup map
    const personMap = new Map();
    people.forEach(person => {
      personMap.set(person.id, person);
    });
    
    // Filter to only current team members (not removed from team)
    const currentMembers = cards.filter(card => 
      // Include members who are in active workflow steps or completed
      // Exclude members who have been "removed" from the workflow
      card.attributes.stage !== 'removed'
    );
    
    // Get tracking data first
    const lastReviewed = dreamTeamsTracking.getLastReviewDate(workflowId);
    const lastReviewInfo = dreamTeamsTracking.getLastReviewInfo(workflowId);
    
    // Get all removals for this workflow
    const allRemovalsForWorkflow = dreamTeamsTracking.getAllPendingRemovals().filter(removal => removal.workflowId === workflowId);
    const currentMemberIds = new Set(currentMembers.map(card => card.relationships.person.data.id));
    
    // Create a map of current members with their join dates for rejoin checking
    const currentMemberJoinDates = new Map();
    currentMembers.forEach(card => {
      const personId = card.relationships.person.data.id;
      // Use the more recent of created_at or moved_to_step_at as the effective join date
      const joinDate = card.attributes.moved_to_step_at || card.attributes.created_at;
      currentMemberJoinDates.set(personId, new Date(joinDate));
    });
    
    // Split removals into categories
    const pendingRemovals: Array<{
      id: number;
      workflowId: string;
      workflowName: string;
      personId: string;
      firstName: string;
      lastName: string;
      reason: string | null;
      removalDate: string;
      reviewerName: string;
    }> = [];
    const pastMembers: Array<{
      id: number;
      workflowId: string;
      workflowName: string;
      personId: string;
      firstName: string;
      lastName: string;
      reason: string | null;
      removalDate: string;
      reviewerName: string;
    }> = [];
    
    allRemovalsForWorkflow.forEach(removal => {
      const isCurrentlyInPCO = currentMemberIds.has(removal.personId);
      
      // Only consider unprocessed removals for "pending" status
      // Processed removals should always go to past members
      if (removal.processed === 1) {
        pastMembers.push(removal);
        return;
      }
      
      if (isCurrentlyInPCO) {
        // Check if they rejoined after the removal date
        const currentJoinDate = currentMemberJoinDates.get(removal.personId);
        
        // Parse removal date string directly (YYYY-MM-DD format) to avoid timezone issues
        const removalDateParts = removal.removalDate.split('-');
        const removalYear = parseInt(removalDateParts[0]);
        const removalMonth = parseInt(removalDateParts[1]) - 1; // JS months are 0-indexed
        const removalDay = parseInt(removalDateParts[2]);
        
        // Compare only the DATE portion (ignore time of day)
        // Create dates at midnight local time for fair comparison
        const joinDateOnly = currentJoinDate ? new Date(currentJoinDate.getFullYear(), currentJoinDate.getMonth(), currentJoinDate.getDate()) : null;
        const removalDateOnly = new Date(removalYear, removalMonth, removalDay);
        
        if (joinDateOnly && joinDateOnly > removalDateOnly) {
          // They rejoined after being removed - treat as past member (don't mark as pending)
          pastMembers.push(removal);
        } else {
          // Still pending removal (unprocessed and not rejoined)
          pendingRemovals.push(removal);
        }
      } else {
        // Not currently in PCO - definitely past member
        pastMembers.push(removal);
      }
    });
    
    // Create a map of pending removals for quick lookup
    const pendingRemovalMap = new Map();
    pendingRemovals.forEach(removal => {
      pendingRemovalMap.set(removal.personId, removal.reason);
    });
    
    // Get all check-ins for this workflow
    const workflowCheckIns = dreamTeamsTracking.getWorkflowCheckIns(workflowId);
    
    // Helper function to calculate months since join date
    const getMonthsSinceJoin = (joinDate: string): number => {
      const join = new Date(joinDate);
      const now = new Date();
      const months = (now.getFullYear() - join.getFullYear()) * 12 + (now.getMonth() - join.getMonth());
      // Adjust if we haven't reached the day of the month yet
      if (now.getDate() < join.getDate()) {
        return months - 1;
      }
      return months;
    };
    
    // Combine card and person data
    const roster = currentMembers.map(card => {
      const person = personMap.get(card.relationships.person.data.id);
      const personId = card.relationships.person.data.id;
      const isPendingRemoval = pendingRemovalMap.has(personId);
      // Calculate time periods for check-in logic
      const originalJoinDate = card.attributes.created_at;
      const completionDate = card.attributes.moved_to_step_at;
      const monthsSinceJoin = getMonthsSinceJoin(originalJoinDate);
      const monthsSinceCompletion = completionDate ? getMonthsSinceJoin(completionDate) : 0;
      
      // For display purposes
      const effectiveDate = completionDate || originalJoinDate;
      const monthsOnTeam = getMonthsSinceJoin(effectiveDate);
      
      // Get existing check-ins for this member
      const memberCheckIns = workflowCheckIns.get(personId) || [];
      const twoMonthCheckIn = memberCheckIns.find(c => c.checkInType === '2-month');
      const sixMonthCheckIn = memberCheckIns.find(c => c.checkInType === '6-month');
      
      // Determine check-in status
      // IMPORTANT: Only show check-ins for COMPLETED members
      let checkIns: {
        twoMonth: { needed: boolean; completed: boolean; completedBy: string | null; completedDate: string | null; isLegacy: boolean } | null;
        sixMonth: { needed: boolean; completed: boolean; completedBy: string | null; completedDate: string | null; isLegacy: boolean } | null;
      } = {
        twoMonth: null,
        sixMonth: null
      };
      
      // Teams that don't require check-ins
      const teamsWithoutCheckIns = ['665166'];
      const skipCheckIns = teamsWithoutCheckIns.includes(workflowId);
      
      // Only process check-ins for completed members (and not for excluded teams)
      if (card.attributes.stage === 'completed' && !skipCheckIns) {
        // Check if this was a bulk completion on 10/1/2025
        const bulkCompletionDate = new Date('2025-10-01');
        const memberCompletionDate = completionDate ? new Date(completionDate) : null;
        const isBulkCompletion = memberCompletionDate && 
          memberCompletionDate.getFullYear() === 2025 && 
          memberCompletionDate.getMonth() === 9 && // October is month 9 (0-indexed)
          memberCompletionDate.getDate() === 1;
        
        // For bulk completions, calculate months between join date and 10/1/2025
        let monthsBeforeBulkCompletion = 0;
        if (isBulkCompletion) {
          const joinDateObj = new Date(originalJoinDate);
          monthsBeforeBulkCompletion = (bulkCompletionDate.getFullYear() - joinDateObj.getFullYear()) * 12 + 
            (bulkCompletionDate.getMonth() - joinDateObj.getMonth());
          if (bulkCompletionDate.getDate() < joinDateObj.getDate()) {
            monthsBeforeBulkCompletion--;
          }
        }
        
        // 2-MONTH CHECK-IN LOGIC
        if (twoMonthCheckIn) {
          // Already has a check-in record
          checkIns.twoMonth = { 
            needed: false, 
            completed: true, 
            completedBy: twoMonthCheckIn.completedBy, 
            completedDate: twoMonthCheckIn.completedDate,
            isLegacy: twoMonthCheckIn.isLegacy
          };
        } else if (monthsSinceCompletion >= 6.5) {
          // Completed 6+ months ago - mark as legacy (feature didn't exist back then)
          dreamTeamsTracking.recordLegacyCheckIn(workflowId, personId, '2-month');
          checkIns.twoMonth = { needed: false, completed: true, completedBy: null, completedDate: null, isLegacy: true };
        } else if (isBulkCompletion) {
          // Bulk completion - use time before 10/1/2025 to determine legacy status
          if (monthsBeforeBulkCompletion >= 4) {
            // Joined 4+ months before bulk completion - both check-ins are legacy
            dreamTeamsTracking.recordLegacyCheckIn(workflowId, personId, '2-month');
            checkIns.twoMonth = { needed: false, completed: true, completedBy: null, completedDate: null, isLegacy: true };
          } else if (monthsBeforeBulkCompletion >= 2) {
            // Joined 2-4 months before bulk completion - 2-month is legacy
            dreamTeamsTracking.recordLegacyCheckIn(workflowId, personId, '2-month');
            checkIns.twoMonth = { needed: false, completed: true, completedBy: null, completedDate: null, isLegacy: true };
          } else if (monthsSinceCompletion >= 2) {
            // Joined recently before bulk completion, now 2+ months since - check-in is needed
            checkIns.twoMonth = { needed: true, completed: false, completedBy: null, completedDate: null, isLegacy: false };
          }
          // Else: not yet due
        } else {
          // Regular completion - use completion date
          if (monthsSinceCompletion >= 2) {
            // 2+ months since completion - check-in is needed
            checkIns.twoMonth = { needed: true, completed: false, completedBy: null, completedDate: null, isLegacy: false };
          }
          // Else: not yet due
        }
        
        // 6-MONTH CHECK-IN LOGIC
        if (sixMonthCheckIn) {
          // Already has a check-in record
          checkIns.sixMonth = { 
            needed: false, 
            completed: true, 
            completedBy: sixMonthCheckIn.completedBy, 
            completedDate: sixMonthCheckIn.completedDate,
            isLegacy: sixMonthCheckIn.isLegacy
          };
        } else if (monthsSinceCompletion >= 6.5) {
          // Completed 6+ months ago - mark as legacy (feature didn't exist back then)
          dreamTeamsTracking.recordLegacyCheckIn(workflowId, personId, '6-month');
          checkIns.sixMonth = { needed: false, completed: true, completedBy: null, completedDate: null, isLegacy: true };
        } else if (isBulkCompletion) {
          // Bulk completion - use time before 10/1/2025 to determine legacy status
          if (monthsBeforeBulkCompletion >= 6) {
            // Joined 6+ months before bulk completion - 6-month is legacy
            dreamTeamsTracking.recordLegacyCheckIn(workflowId, personId, '6-month');
            checkIns.sixMonth = { needed: false, completed: true, completedBy: null, completedDate: null, isLegacy: true };
          } else if (monthsSinceJoin >= 6) {
            // 6+ months since join date - check-in is needed
            checkIns.sixMonth = { needed: true, completed: false, completedBy: null, completedDate: null, isLegacy: false };
          }
          // Else: not yet due (hasn't been 6 months since they joined)
        } else {
          // Regular completion - use completion date
          if (monthsSinceCompletion >= 6) {
            // 6+ months since completion - check-in is needed
            checkIns.sixMonth = { needed: true, completed: false, completedBy: null, completedDate: null, isLegacy: false };
          }
          // Else: not yet due
        }
      }
      // In-progress members (not completed) don't show check-ins at all
      
      return {
        cardId: card.id,
        personId: personId,
        firstName: person?.attributes.first_name || 'Unknown',
        lastName: person?.attributes.last_name || '',
        nickname: person?.attributes.nickname,
        joinedAt: card.attributes.created_at,
        movedToStepAt: card.attributes.moved_to_step_at,
        stage: card.attributes.stage,
        markedForRemoval: isPendingRemoval,
        removalReason: isPendingRemoval ? pendingRemovalMap.get(personId) : null,
        monthsOnTeam,
        checkIns
      };
    }).sort((a, b) => a.firstName.localeCompare(b.firstName));
    
    res.json({
      success: true,
      data: {
        workflowId,
        workflowName,
        roster,
        lastReviewed,
        lastReviewer: lastReviewInfo?.reviewer || null,
        pendingRemovals,
        pendingRemovalsCount: pendingRemovals.length,
        pastMembers
      }
    });
  } catch (error) {
    console.error(`Error fetching dream team roster for workflow ${req.params.workflowId}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch team roster data'
    });
  }
});

// Dream Teams action endpoints
app.post('/api/dream-teams/:workflowId/review', async (req, res) => {
  try {
    const { workflowId } = req.params;
    const { workflowName, reviewerName, notes } = req.body;
    
    if (!workflowName) {
      return res.status(400).json({
        success: false,
        error: 'Workflow name is required'
      });
    }
    
    if (!reviewerName || reviewerName.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Reviewer name is required'
      });
    }
    
    dreamTeamsTracking.recordReview(workflowId, workflowName, reviewerName.trim(), notes);
    
    res.json({
      success: true,
      message: 'Team review recorded successfully'
    });
  } catch (error) {
    console.error(`Error recording team review for workflow ${req.params.workflowId}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to record team review'
    });
  }
});




app.post('/api/dream-teams/:workflowId/removals', async (req, res) => {
  try {
    const { workflowId } = req.params;
    const { workflowName, reviewerName, removals } = req.body;
    
    if (!workflowName || !removals || !Array.isArray(removals)) {
      return res.status(400).json({
        success: false,
        error: 'Workflow name and removals array are required'
      });
    }
    
    if (!reviewerName || reviewerName.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Reviewer name is required'
      });
    }
    
    if (removals.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'At least one removal must be specified'
      });
    }
    
    dreamTeamsTracking.recordRemovals(workflowId, workflowName, reviewerName.trim(), removals);
    
    res.json({
      success: true,
      message: `Recorded ${removals.length} removal(s) successfully`
    });
  } catch (error) {
    console.error(`Error recording team removals for workflow ${req.params.workflowId}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to record team removals'
    });
  }
});

// Undo removal endpoint
app.post('/api/dream-teams/:workflowId/undo-removal', async (req, res) => {
  try {
    const { workflowId } = req.params;
    const { memberId } = req.body;
    
    if (!memberId) {
      return res.status(400).json({
        success: false,
        error: 'Member ID is required'
      });
    }
    
    dreamTeamsTracking.undoRemoval(workflowId, memberId);
    
    res.json({
      success: true,
      message: 'Removal undone successfully'
    });
  } catch (error) {
    console.error(`Error undoing removal for workflow ${req.params.workflowId}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to undo removal'
    });
  }
});

// Record a check-in for a team member
app.post('/api/dream-teams/:workflowId/checkin', async (req, res) => {
  try {
    const { workflowId } = req.params;
    const { personId, checkInType, completedBy } = req.body;
    
    if (!personId) {
      return res.status(400).json({
        success: false,
        error: 'Person ID is required'
      });
    }
    
    if (!checkInType || !['2-month', '6-month'].includes(checkInType)) {
      return res.status(400).json({
        success: false,
        error: 'Valid check-in type (2-month or 6-month) is required'
      });
    }
    
    if (!completedBy || completedBy.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Completed by name is required'
      });
    }
    
    dreamTeamsTracking.recordCheckIn(workflowId, personId, checkInType, completedBy.trim());
    
    res.json({
      success: true,
      message: `${checkInType} check-in recorded successfully`
    });
  } catch (error) {
    console.error(`Error recording check-in for workflow ${req.params.workflowId}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to record check-in'
    });
  }
});

// Get leaders for a team
app.get('/api/dream-teams/:workflowId/leaders', async (req, res) => {
  try {
    const { workflowId } = req.params;
    const leaders = dreamTeamsTracking.getTeamLeaders(workflowId);
    
    // Separate into directors and team leaders
    const directors = leaders.filter(l => l.role === 'director');
    const teamLeaders = leaders.filter(l => l.role === 'team_leader');
    
    res.json({
      success: true,
      data: {
        directors,
        teamLeaders
      }
    });
  } catch (error) {
    console.error(`Error fetching leaders for workflow ${req.params.workflowId}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch team leaders'
    });
  }
});

// Add a leader to a team
app.post('/api/dream-teams/:workflowId/leaders', async (req, res) => {
  try {
    const { workflowId } = req.params;
    const { personId, personName, role } = req.body;
    
    if (!personId || !personName) {
      return res.status(400).json({
        success: false,
        error: 'Person ID and name are required'
      });
    }
    
    if (!role || !['team_leader', 'director'].includes(role)) {
      return res.status(400).json({
        success: false,
        error: 'Valid role (team_leader or director) is required'
      });
    }
    
    dreamTeamsTracking.addLeader(workflowId, personId, personName.trim(), role);
    
    res.json({
      success: true,
      message: `${role === 'director' ? 'Director' : 'Team Leader'} added successfully`
    });
  } catch (error) {
    console.error(`Error adding leader to workflow ${req.params.workflowId}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to add leader'
    });
  }
});

// Remove a leader from a team
app.delete('/api/dream-teams/:workflowId/leaders/:personId', async (req, res) => {
  try {
    const { workflowId, personId } = req.params;
    const { role } = req.query;
    
    if (!role || !['team_leader', 'director'].includes(role as string)) {
      return res.status(400).json({
        success: false,
        error: 'Valid role (team_leader or director) is required as query parameter'
      });
    }
    
    dreamTeamsTracking.removeLeader(workflowId, personId, role as 'team_leader' | 'director');
    
    res.json({
      success: true,
      message: 'Leader removed successfully'
    });
  } catch (error) {
    console.error(`Error removing leader from workflow ${req.params.workflowId}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to remove leader'
    });
  }
});

// Cache clearing endpoint for Dream Teams testing (supports both GET and POST)
app.all('/api/dream-teams-cache/clear', async (req, res) => {
  try {
    const clearDatabase = req.query.database === 'true' || req.body?.database === true;

    const { cache } = await import('./config/cache.js');
    
    let result = {
      success: true,
      clearedCache: 0,
      clearedDatabase: 0,
      cacheKeys: [] as string[],
      message: ''
    };
    
    // Clear PCO API cache
    const cacheStats = cache.getStats();
    const dreamTeamKeys = cacheStats.keys.filter(key => 
      key.includes('workflow') || 
      key.includes('dream') ||
      key.includes('Dream') ||
      key === 'workflow_categories'
    );
    
    for (const key of dreamTeamKeys) {
      try {
        cache.delete(key);
        result.clearedCache++;
      } catch (error) {
        console.error(`Error clearing cache key ${key}:`, error);
      }
    }
    result.cacheKeys = dreamTeamKeys;
    
    // Clear database tracking data if requested
    if (clearDatabase) {
      try {
        // Import database functions
        const { dreamTeamsTracking } = await import('../data/database.js');
        
        // Use database initialization from cache module
        const Database = await import('better-sqlite3').then(m => m.default);
        const path = await import('path');
        const { fileURLToPath } = await import('url');
        
        // Get database path
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const dbPath = process.env.RENDER 
          ? '/data/cache.db'
          : path.join(__dirname, '../data/cache.db');
        
        const dbInstance = new Database(dbPath);
        
        // Get counts before clearing
        const reviewCount = (dbInstance.prepare('SELECT COUNT(*) as count FROM dream_team_reviews').get() as { count: number })?.count || 0;
        const removalCount = (dbInstance.prepare('SELECT COUNT(*) as count FROM dream_team_removals').get() as { count: number })?.count || 0;
        
        // Check if checkins table exists and get count
        let checkinCount = 0;
        try {
          checkinCount = (dbInstance.prepare('SELECT COUNT(*) as count FROM dream_team_checkins').get() as { count: number })?.count || 0;
        } catch (e) {
          // Table might not exist yet
        }
        
        // Clear the tables
        const reviewResult = dbInstance.prepare('DELETE FROM dream_team_reviews').run();
        const removalResult = dbInstance.prepare('DELETE FROM dream_team_removals').run();
        
        // Clear checkins table if it exists
        try {
          dbInstance.prepare('DELETE FROM dream_team_checkins').run();
        } catch (e) {
          // Table might not exist yet
        }
        
        // Clear leaders table if it exists (only if explicitly requested via ?leaders=true)
        let leaderCount = 0;
        if (req.query.leaders === 'true' || req.body?.leaders === true) {
          try {
            const leaderResult = dbInstance.prepare('DELETE FROM dream_team_leaders').run();
            leaderCount = leaderResult.changes;
          } catch (e) {
            // Table might not exist yet
          }
        }
        
        result.clearedDatabase = reviewCount + removalCount + checkinCount + leaderCount;
        dbInstance.close();
      } catch (error) {
        console.error('Error clearing database:', error);
        console.error('Error stack:', error instanceof Error ? error.stack : 'No stack');
        result.message += ' (Database clearing failed: ' + (error instanceof Error ? error.message : 'Unknown error') + ')';
      }
    }
    
    // Build response message
    const parts = [];
    if (result.clearedCache > 0) {
      parts.push(`${result.clearedCache} cache keys`);
    }
    if (result.clearedDatabase > 0) {
      parts.push(`${result.clearedDatabase} database records`);
    }
    
    result.message = parts.length > 0 
      ? `Cleared ${parts.join(' and ')}`
      : 'Nothing to clear';
    
    res.json(result);
  } catch (error) {
    console.error('Error clearing Dream Teams data:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to clear Dream Teams data'
    });
  }
});

//Membership Changes Page
app.get('/life-groups/membership-changes', async (req, res) => {
  try {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>QCC Hub - LGHR - Membership Changes</title>
          <link rel="icon" type="image/x-icon" href="https://www.queencitypeople.com/favicon.ico">
          <style>
            /* Fix radio buttons and checkboxes to show blue when checked */
            input[type="radio"]:checked {
              accent-color: #007bff;
            }
            input[type="checkbox"]:checked {
              accent-color: #007bff;
            }
            /* Fallback for older browsers */
            input[type="radio"] {
              appearance: auto;
              -webkit-appearance: auto;
            }
            input[type="checkbox"] {
              appearance: auto;
              -webkit-appearance: auto;
            }
            body {
              font-family: Arial, sans-serif;
              margin: 20px;
              background-color: #f5f5f5;
            }
            .container {
              max-width: 1200px;
              margin: 0 auto;
              background-color: white;
              padding: 20px;
              border-radius: 8px;
              box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            }
            h1 {
              color: #333;
              margin-bottom: 20px;
            }
            .back-button {
              display: inline-flex;
              align-items: center;
              gap: 8px;
              padding: 10px 16px;
              background-color: #6c757d;
              color: white;
              text-decoration: none;
              border-radius: 4px;
              font-size: 14px;
              margin-bottom: 20px;
              transition: background-color 0.3s ease;
            }
            .back-button:hover {
              background-color: #5a6268;
            }
            .capture-button {
              display: inline-flex;
              align-items: center;
              gap: 8px;
              padding: 10px 16px;
              background-color: #007bff;
              color: white;
              border: none;
              border-radius: 4px;
              font-size: 14px;
              margin-bottom: 20px;
              margin-left: 10px;
              cursor: pointer;
              transition: background-color 0.3s ease;
            }
            .capture-button:hover {
              background-color: #0056b3;
            }
            .capture-button:disabled {
              background-color: #6c757d;
              cursor: not-allowed;
            }
            .loading {
              display: inline-block;
              width: 20px;
              height: 20px;
              border: 3px solid #f3f3f3;
              border-radius: 50%;
              border-top: 3px solid #007bff;
              animation: spin 1s linear infinite;
            }
            @keyframes spin {
              0% { transform: rotate(0deg); }
              100% { transform: rotate(360deg); }
            }
            .loading-container {
              text-align: center;
              padding: 40px;
              color: #666;
            }
            .loading-container .loading {
              width: 40px;
              height: 40px;
              border: 4px solid #f3f3f3;
              border-top: 4px solid #007bff;
              margin: 0 auto 20px;
            }
            .no-data {
              color: #6c757d;
              font-style: italic;
              text-align: center;
              padding: 40px;
            }
            .error-message {
              background-color: #f8d7da;
              color: #721c24;
              padding: 12px;
              border-radius: 4px;
              margin-bottom: 20px;
              border: 1px solid #f5c6cb;
            }
            .success-message {
              background-color: #d4edda;
              color: #155724;
              padding: 12px;
              border-radius: 4px;
              margin-bottom: 20px;
              border: 1px solid #c3e6cb;
            }
            .button-group {
              display: flex;
              gap: 10px;
              margin-bottom: 20px;
            }
            
            
            /* Dark Mode Styles */
            body {
              transition: background-color 0.3s ease;
            }
            
            body.dark-mode {
              background-color: #1a1a1a;
              color: #ffffff;
            }
            
            body.dark-mode .container {
              background-color: #2d2d2d;
              color: #ffffff;
            }
            
            body.dark-mode h1 {
              color: #ffffff;
            }
            
            body.dark-mode .back-button {
              background-color: #495057;
              color: #ffffff;
            }
            
            body.dark-mode .back-button:hover {
              background-color: #6c757d;
            }
            
            body.dark-mode .capture-button {
              background-color: #0056b3;
            }
            
            body.dark-mode .capture-button:hover {
              background-color: #004085;
            }
            
            body.dark-mode .loading-container {
              color: #cccccc;
            }
            
            body.dark-mode .no-data {
              color: #aaaaaa;
            }
            
            body.dark-mode .error-message {
              background-color: #721c24;
              color: #f8d7da;
              border-color: #a94442;
            }
            
            body.dark-mode .success-message {
              background-color: #155724;
              color: #d4edda;
              border-color: #28a745;
            }
            
            /* Dark mode styles for membership changes content */
            body.dark-mode #contentContainer div[style*="background-color: #f8f9fa"] {
              background-color: #3d3d3d !important;
            }
            
            body.dark-mode #contentContainer div[style*="background-color: white"] {
              background-color: #2d2d2d !important;
              color: #ffffff !important;
            }
            
            body.dark-mode #contentContainer div[style*="color: #666"] {
              color: #cccccc !important;
            }
            
            body.dark-mode #contentContainer div[style*="color: #333"] {
              color: #ffffff !important;
            }
            
            body.dark-mode #contentContainer span[style*="color: #666"] {
              color: #cccccc !important;
            }
            
            /* Lighten up member names specifically for better readability */
            body.dark-mode #contentContainer span[style*="font-weight: 500"] {
              color: #ffffff !important;
            }
            
            body.dark-mode #contentContainer div[style*="background-color: rgba(40, 167, 69, 0.1)"] {
              background-color: rgba(40, 167, 69, 0.2) !important;
            }
            
            body.dark-mode #contentContainer div[style*="background-color: rgba(220, 53, 69, 0.1)"] {
              background-color: rgba(220, 53, 69, 0.2) !important;
            }
            
            /* FOUC Prevention - Temporary loading styles */
            html.dark-mode-loading {
              background-color: #1a1a1a !important;
            }
            
            html.dark-mode-loading body {
              background-color: #1a1a1a !important;
              color: #ffffff !important;
            }
            
            html.dark-mode-loading .container {
              background-color: #2d2d2d !important;
              color: #ffffff !important;
            }
          </style>
          <script>
            // Apply dark mode immediately to prevent flash
            if (localStorage.getItem('darkMode') === 'true') {
              document.documentElement.classList.add('dark-mode-loading');
            }
          </script>
        </head>
        <body>
          <div class="container">
            <div class="button-group">
              <a href="/life-groups" class="back-button">
                <span><strong>⟵</strong></span>
                <span>Back to Groups</span>
              </a>
              <button id="captureSnapshotBtn" class="capture-button">
                <span>📸</span>
                <span>Capture Snapshot</span>
              </button>
            </div>
            
            <h1>Recent Membership Changes (Last 30 Days)</h1>
            
            <div id="loadingContainer" class="loading-container">
              <div class="loading"></div>
              <p>Loading membership changes...</p>
            </div>
            
            <div id="errorContainer" style="display: none;">
              <div class="error-message" id="errorMessage"></div>
            </div>
            
            <div id="successContainer" style="display: none;">
              <div class="success-message" id="successMessage"></div>
            </div>
            
            <div id="contentContainer" style="display: none;">
              <!-- Membership changes will be populated here in old dropdown format -->
            </div>
          </div>
          
          <script>
            // Load membership changes when page loads
            document.addEventListener('DOMContentLoaded', function() {
              // Remove temporary dark mode loading class
              document.documentElement.classList.remove('dark-mode-loading');
              
              // Initialize dark mode
              const body = document.body;
              const isDarkMode = localStorage.getItem('darkMode') === 'true';
              
              if (isDarkMode) {
                body.classList.add('dark-mode');
              }
              
              
              loadMembershipChanges();
              
              // Setup capture snapshot button
              document.getElementById('captureSnapshotBtn').addEventListener('click', captureSnapshot);
            });
            
            async function loadMembershipChanges() {
              const loadingContainer = document.getElementById('loadingContainer');
              const errorContainer = document.getElementById('errorContainer');
              const contentContainer = document.getElementById('contentContainer');
              const errorMessage = document.getElementById('errorMessage');
              
              try {
                // Show loading
                loadingContainer.style.display = 'block';
                errorContainer.style.display = 'none';
                contentContainer.style.display = 'none';
                
                // Fetch membership changes (last 30 days)
                const response = await fetch('/api/membership-changes?days=30');
                if (!response.ok) {
                  throw new Error('Failed to fetch membership changes');
                }
                
                const data = await response.json();
                
                // Hide loading
                loadingContainer.style.display = 'none';
                
                if (data.totalJoins === 0 && data.totalLeaves === 0) {
                  // Show no data message
                  contentContainer.innerHTML = '<div class="no-data">No membership changes in the last 30 days</div>';
                  contentContainer.style.display = 'block';
                } else {
                  // Display the data using old dropdown format
                  displayMembershipChanges(data);
                  contentContainer.style.display = 'block';
                }
                
              } catch (error) {
                console.error('Error loading membership changes:', error);
                loadingContainer.style.display = 'none';
                errorMessage.textContent = 'Failed to load membership changes: ' + error.message;
                errorContainer.style.display = 'block';
              }
            }
            
            function displayMembershipChanges(data) {
              const contentContainer = document.getElementById('contentContainer');
              
              // Generate comprehensive HTML with summary stats and member details (old dropdown format)
              let timelineHtml = '<div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px;">';
              
              // Data source info for summary stats
              const dataText = data.latestSnapshotDate ? 
                'Data as of: ' + new Date(data.latestSnapshotDate).toLocaleDateString() : 
                'No snapshot data available';
              
              // Show summary stats with data source
              const netChange = data.totalJoins - data.totalLeaves;
              const netChangeText = netChange > 0 ? '+' + netChange : netChange.toString();
              const netChangeColor = netChange > 0 ? '#007bff' : netChange < 0 ? '#fd7e14' : '#666';
              
              timelineHtml += 
                '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; padding: 15px; background-color: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">' +
                  '<div style="display: flex; gap: 20px;">' +
                    '<div style="display: flex; align-items: center; gap: 8px;">' +
                      '<span style="color: #28a745; font-weight: bold; font-size: 18px;">+' + data.totalJoins + '</span>' +
                      '<span style="color: #666; font-weight: 500;">Members Joined</span>' +
                    '</div>' +
                    '<div style="display: flex; align-items: center; gap: 8px;">' +
                      '<span style="color: #dc3545; font-weight: bold; font-size: 18px;">-' + data.totalLeaves + '</span>' +
                      '<span style="color: #666; font-weight: 500;">Members Left</span>' +
                    '</div>' +
                    '<div style="display: flex; align-items: center; gap: 8px;">' +
                      '<span style="color: ' + netChangeColor + '; font-weight: bold; font-size: 20px;">' + netChangeText + '</span>' +
                      '<span style="color: #666; font-weight: 500;">Net Change</span>' +
                    '</div>' +
                  '</div>' +
                  '<div style="color: #666; font-size: 14px;">' + dataText + '</div>' +
                '</div>';
              
              // Show joins section
              if (data.joins.length > 0) {
                timelineHtml += 
                  '<div style="color: #666; font-size: 13px; margin-bottom: 15px; font-style: italic; padding-left: 4px; border-left: 2px solid #e9ecef;">' +
                    'Members are sorted by group name, then date (most recent first), then name alphabetically' +
                  '</div>' +
                  '<div style="margin-bottom: 25px;">' +
                    '<h4 style="margin: 0 0 15px 0; color: #28a745; font-weight: 500; display: flex; align-items: center; gap: 8px;">' +
                      '<span style="background-color: #28a745; color: white; border-radius: 50%; width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: bold;">+</span>' +
                      'Members Joined (' + data.joins.length + ')' +
                    '</h4>' +
                    '<div style="display: grid; gap: 8px;">';
                
                data.joins.forEach(member => {
                  const formattedJoinDate = member.date ? 
                    new Date(member.date).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' }) : 
                    'recent';
                  
                  timelineHtml += 
                    '<div style="padding: 8px 12px; background-color: rgba(40, 167, 69, 0.1); border-radius: 6px; border-left: 4px solid #28a745; display: flex; justify-content: space-between; align-items: center;">' +
                      '<div style="display: flex; align-items: center; gap: 8px;">' +
                        '<span style="font-weight: 500; color: #333;">' + member.firstName + ' ' + member.lastName + '</span>' +
                        '<span style="color: #666; font-size: 12px;">' + formattedJoinDate + '</span>' +
                      '</div>' +
                      '<span style="color: #666; font-size: 14px;">' + member.groupName + '</span>' +
                    '</div>';
                });
                
                timelineHtml += '</div></div>';
              }
              
              // Show leaves section
              if (data.leaves.length > 0) {
                timelineHtml += 
                  '<div style="margin-bottom: 20px;">' +
                    '<h4 style="margin: 0 0 15px 0; color: #dc3545; font-weight: 500; display: flex; align-items: center; gap: 8px;">' +
                      '<span style="background-color: #dc3545; color: white; border-radius: 50%; width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: bold;">-</span>' +
                      'Members Left (' + data.leaves.length + ')' +
                    '</h4>' +
                    '<div style="display: grid; gap: 8px;">';
                
                data.leaves.forEach(member => {
                  const formattedLeaveDate = member.date ? 
                    new Date(member.date).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' }) : 
                    'recent';
                  
                  timelineHtml += 
                    '<div style="padding: 8px 12px; background-color: rgba(220, 53, 69, 0.1); border-radius: 6px; border-left: 4px solid #dc3545; display: flex; justify-content: space-between; align-items: center;">' +
                      '<div style="display: flex; align-items: center; gap: 8px;">' +
                        '<span style="font-weight: 500; color: #333;">' + member.firstName + ' ' + member.lastName + '</span>' +
                        '<span style="color: #666; font-size: 12px;">' + formattedLeaveDate + '</span>' +
                      '</div>' +
                      '<span style="color: #666; font-size: 14px;">' + member.groupName + '</span>' +
                    '</div>';
                });
                
                timelineHtml += '</div></div>';
              }
              
              timelineHtml += '</div>';
              contentContainer.innerHTML = timelineHtml;
            }
            
            async function captureSnapshot() {
              const captureBtn = document.getElementById('captureSnapshotBtn');
              const errorContainer = document.getElementById('errorContainer');
              const successContainer = document.getElementById('successContainer');
              const errorMessage = document.getElementById('errorMessage');
              const successMessage = document.getElementById('successMessage');
              
              try {
                // Disable button and show loading
                captureBtn.disabled = true;
                captureBtn.innerHTML = '<span class="loading" style="width: 16px; height: 16px; border: 2px solid #fff; border-top: 2px solid transparent; margin-right: 8px;"></span>Capturing...';
                
                // Hide previous messages
                errorContainer.style.display = 'none';
                successContainer.style.display = 'none';
                
                // Make API call to capture snapshot
                const response = await fetch('/api/capture-membership-snapshot', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json'
                  }
                });
                
                if (!response.ok) {
                  throw new Error('Failed to capture snapshot');
                }
                
                const result = await response.json();
                
                // Show success message
                successMessage.textContent = 'Snapshot captured successfully! ' + result.message;
                successContainer.style.display = 'block';
                
                // Refresh the data to show updated snapshot date
                setTimeout(() => {
                  loadMembershipChanges();
                }, 2000);
                
              } catch (error) {
                console.error('Error capturing snapshot:', error);
                errorMessage.textContent = 'Failed to capture snapshot: ' + error.message;
                errorContainer.style.display = 'block';
              } finally {
                // Re-enable button
                captureBtn.disabled = false;
                captureBtn.innerHTML = '<span>📸</span><span>Capture Snapshot</span>';
              }
            }
          </script>
        </body>
      </html>
    `;
    
    res.send(html);
  } catch (error) {
    console.error('Error rendering membership changes page:', error);
    res.status(500).send('Error rendering membership changes page');
  }
});

//Home Page
// Root landing page - simple navigation to both apps
app.get('/home-page', async (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>QCC Hub</title>
      <link rel="icon" type="image/x-icon" href="https://www.queencitypeople.com/favicon.ico">
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          margin: 0;
          padding: 0;
          background-color: #f8f9fa;
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          min-height: 100vh;
          padding: 20px;
          box-sizing: border-box;
          transition: background-color 0.3s ease;
        }
        
        /* Dark mode styles */
        body.dark-mode {
          background-color: #1a1a1a;
        }
        
        body.dark-mode .container {
          background-color: #2d2d2d;
          color: #ffffff;
        }
        
        body.dark-mode h1 {
          color: #ffffff;
        }
        
        body.dark-mode .subtitle {
          color: #cccccc;
        }
        
        body.dark-mode .description {
          color: #aaaaaa;
        }
        .logo-container {
          background-color: #1a1a1a;
          padding: 30px;
          border-radius: 12px;
          margin-bottom: 20px;
          width: 100%;
          max-width: 400px;
          box-sizing: border-box;
          display: flex;
          justify-content: center;
          align-items: center;
        }
        .logo {
          max-width: 100%;
          height: auto;
          max-height: 150px;
          object-fit: contain;
        }
        .container {
          text-align: center;
          background: white;
          padding: 40px;
          border-radius: 12px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.1);
          max-width: 400px;
          width: 100%;
          box-sizing: border-box;
        }
        h1 {
          color: #333;
          margin-bottom: 10px;
          font-size: 2.2em;
        }
        .subtitle {
          color: #666;
          margin-bottom: 40px;
          font-size: 1.1em;
        }
        .app-button {
          display: block;
          width: 100%;
          padding: 16px 24px;
          margin: 12px auto;
          background-color: #007bff;
          color: white;
          text-decoration: none;
          border-radius: 8px;
          font-size: 16px;
          font-weight: 500;
          transition: background-color 0.3s ease, transform 0.1s ease;
          border: none;
          cursor: pointer;
          text-align: center;
          box-sizing: border-box;
        }
        .app-button:hover {
          background-color: #0056b3;
          transform: translateY(-1px);
        }
        .app-button.dream-teams {
          background-color: #28a745;
        }
        .app-button.dream-teams:hover {
          background-color: #1e7e34;
        }
        .app-button.replenishment {
          background-color: #6f42c1;
        }
        .app-button.replenishment:hover {
          background-color: #5a32a3;
        }
        .description {
          color: #888;
          font-size: 14px;
          margin-top: 8px;
          margin-bottom: 20px;
        }
        
        .dark-mode-toggle {
          position: absolute;
          top: 20px;
          right: 20px;
          background-color: #007bff;
          color: white;
          border: none;
          border-radius: 50px;
          padding: 8px 16px;
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.3s ease;
          box-shadow: 0 2px 8px rgba(0,0,0,0.1);
          z-index: 1000;
        }
        
        .dark-mode-toggle:hover {
          background-color: #0056b3;
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        }
        
        body.dark-mode .dark-mode-toggle {
          background-color: #ffc107;
          color: #212529;
        }
        
        body.dark-mode .dark-mode-toggle:hover {
          background-color: #e0a800;
        }
      </style>
      <script>
        // Apply dark mode immediately to prevent flash
        if (localStorage.getItem('darkMode') === 'true') {
          document.documentElement.classList.add('dark-mode-loading');
        }
      </script>
      <style>
        /* Temporary class to apply dark mode before body loads */
        html.dark-mode-loading body {
          background-color: #1a1a1a !important;
        }
        html.dark-mode-loading .container {
          background-color: #2d2d2d !important;
          color: #ffffff !important;
        }
        html.dark-mode-loading h1 {
          color: #ffffff !important;
        }
        html.dark-mode-loading .subtitle {
          color: #cccccc !important;
        }
        html.dark-mode-loading .description {
          color: #aaaaaa !important;
        }
      </style>
    </head>
    <body>
      <button class="dark-mode-toggle" id="darkModeToggle">🌙 Dark Mode</button>
      <div class="logo-container">
        <img src="/QC_Mark_White_translu.webp" alt="Queen City Church Logo" class="logo">
      </div>
      <div class="container">
        <h1>QCC Hub</h1>
        <p class="subtitle">Choose an application</p>
        
        <a href="/life-groups" class="app-button">
          Life Groups Health Report
        </a>
        <p class="description">View groups attendance, membership changes, and health report metrics</p>
        
        <a href="/dream-teams" class="app-button dream-teams">
          Dream Team Health Report
        </a>
        <p class="description">Manage Dream Team rosters and review member status</p>
        
        <a href="/replenishment-requests" class="app-button replenishment">
          Replenishment Requests
        </a>
        <p class="description">Submit and manage resource replenishment requests</p>
      </div>
      
      <script>
        // Dark mode toggle functionality
        const darkModeToggle = document.getElementById('darkModeToggle');
        const body = document.body;
        
        // Check for saved dark mode preference or default to light mode
        const isDarkMode = localStorage.getItem('darkMode') === 'true';
        
        // Clean up temporary loading class and apply proper dark mode
        document.documentElement.classList.remove('dark-mode-loading');
        if (isDarkMode) {
          body.classList.add('dark-mode');
          darkModeToggle.innerHTML = '☀️ Light Mode';
        }
        
        // Toggle dark mode
        darkModeToggle.addEventListener('click', function() {
          body.classList.toggle('dark-mode');
          const isCurrentlyDark = body.classList.contains('dark-mode');
          
          // Update button text and icon
          if (isCurrentlyDark) {
            darkModeToggle.innerHTML = '☀️ Light Mode';
            localStorage.setItem('darkMode', 'true');
          } else {
            darkModeToggle.innerHTML = '🌙 Dark Mode';
            localStorage.setItem('darkMode', 'false');
          }
        });
      </script>
    </body>
    </html>
  `);
});

// Life Groups Health Report - Main dashboard
app.get('/life-groups', async (req, res) => {
  try {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>QCC Hub - LGHR</title>
          <link rel="icon" type="image/x-icon" href="https://www.queencitypeople.com/favicon.ico">
          <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
          <style>
            /* Fix radio buttons and checkboxes to show blue when checked */
            input[type="radio"]:checked {
              accent-color: #007bff;
            }
            input[type="checkbox"]:checked {
              accent-color: #007bff;
            }
            /* Fallback for older browsers */
            input[type="radio"] {
              appearance: auto;
              -webkit-appearance: auto;
            }
            input[type="checkbox"] {
              appearance: auto;
              -webkit-appearance: auto;
            }
            body {
              font-family: Arial, sans-serif;
              margin: 20px;
              background-color: #f5f5f5;
              transition: background-color 0.3s ease;
            }
            
            /* Dark mode styles */
            body.dark-mode {
              background-color: #1a1a1a;
            }
            
            body.dark-mode .container {
              background-color: #2d2d2d;
              color: #ffffff;
            }
            
            body.dark-mode h1 {
              color: #ffffff;
            }
            
            body.dark-mode .group-item {
              background-color: #3d3d3d;
              color: #ffffff;
            }
            
            body.dark-mode .group-item.not-selected {
              background-color: #2a2a2a;
            }
            
            body.dark-mode .group-item.selection-mode:hover {
              background-color: #0d47a1;
            }
            
            body.dark-mode .group-item a {
              color: #87ceeb;
            }
            
            body.dark-mode .stats-container {
              color: #e0e0e0;
            }
            
            body.dark-mode .stat-value {
              color: #ffffff;
            }
            
            body.dark-mode .stat-value.attendance-good {
              color: #4caf50;
            }
            
            body.dark-mode .stat-value.attendance-warning {
              color: #ff9800;
            }
            
            body.dark-mode .stat-value.attendance-poor {
              color: #f44336;
            }
            
            body.dark-mode .stat-label {
              color: #e0e0e0;
            }
            
            body.dark-mode #lastUpdate {
              /* Color will be set dynamically based on age */
              /* Yellow and red have good contrast in dark mode */
            }
            
            body.dark-mode .chart-container {
              background-color: #2d2d2d;
            }
            
            body.dark-mode .toggle-container {
              background-color: #3d3d3d;
            }
            
            body.dark-mode .sort-filter-container button {
              background-color: #3d3d3d !important;
              color: #ffffff !important;
              border-color: #555 !important;
            }
            
            body.dark-mode .sort-filter-container button:hover {
              background-color: #4d4d4d !important;
              border-color: #4fc3f7 !important;
            }
            
            body.dark-mode #sortFilterToggleBtn {
              background-color: #3d3d3d !important;
              color: #ffffff !important;
              border-color: #555 !important;
            }
            
            body.dark-mode #sortFilterToggleBtn:hover {
              background-color: #4d4d4d !important;
              border-color: #4fc3f7 !important;
            }
            
            body.dark-mode #sortFilterToggleBtn h3 {
              color: #ffffff !important;
            }
            
            body.dark-mode #sortFilterSummary {
              color: #e0e0e0 !important;
            }
            
            body.dark-mode #sortFilterSummary span {
              color: #e0e0e0 !important;
            }
            
            body.dark-mode #sortFilterToggleIcon {
              color: #e0e0e0 !important;
            }
            
            body.dark-mode #sortFilterExpandedContent {
              background-color: #3d3d3d !important;
              color: #ffffff !important;
            }
            
            body.dark-mode #sortFilterExpandedContent > div {
              background-color: #4d4d4d !important;
            }
            
            body.dark-mode #sortFilterExpandedContent > div > div {
              background-color: #4d4d4d !important;
            }
            
            body.dark-mode #sortFilterExpandedContent h4 {
              color: #4fc3f7 !important;
            }
            
            body.dark-mode #sortFilterExpandedContent div[style*="background-color: #f8f9fa"] {
              background-color: #4d4d4d !important;
            }
            
            body.dark-mode #sortFilterExpandedContent div[style*="border-left: 4px solid #007bff"] {
              border-left-color: #4fc3f7 !important;
            }
            
            body.dark-mode #sortFilterExpandedContent div[style*="border-left: 4px solid #28a745"] {
              border-left-color: #28a745 !important;
            }
            
            body.dark-mode #sortFilterExpandedContent select {
              background-color: #2d2d2d !important;
              color: #ffffff !important;
              border-color: #555 !important;
            }
            
            body.dark-mode #sortFilterExpandedContent select option {
              background-color: #2d2d2d !important;
              color: #ffffff !important;
            }
            
            body.dark-mode #sortFilterExpandedContent input[type="checkbox"] {
              accent-color: #4fc3f7;
            }
            
            body.dark-mode #sortFilterExpandedContent label {
              color: #e0e0e0 !important;
            }
            
            body.dark-mode #sortFilterExpandedContent div[style*="color: #333"] {
              color: #ffffff !important;
            }
            
            body.dark-mode #sortFilterExpandedContent label[style*="font-weight: 500"] {
              color: #ffffff !important;
            }
            
            body.dark-mode #clearFiltersBtn {
              background-color: #dc3545;
              color: #ffffff;
            }
            
            body.dark-mode #clearFiltersBtn:hover {
              background-color: #c82333;
            }
            
            body.dark-mode .group-selection-controls {
              background-color: #3d3d3d !important;
              border-color: #4fc3f7 !important;
            }
            
            body.dark-mode .group-selection-controls strong {
              color: #ffffff !important;
            }
            
            body.dark-mode .group-selection-controls span:not(#selectedGroupsCount) {
              color: #e0e0e0 !important;
            }
            
            body.dark-mode #chartSelectionModeBtn {
              background-color: #2d2d2d;
              color: #4fc3f7;
              border-color: #4fc3f7;
            }
            
            body.dark-mode #chartSelectionModeBtn:hover {
              background-color: #4fc3f7;
              color: #ffffff;
            }
            
            body.dark-mode #individualMetricSelect {
              background-color: #2d2d2d;
              color: #ffffff;
              border-color: #555;
            }
            
            body.dark-mode #selectAllGroupsBtn {
              background-color: #2d2d2d;
              color: #28a745;
              border-color: #28a745;
            }
            
            body.dark-mode #selectAllGroupsBtn:hover {
              background-color: #28a745;
              color: #ffffff;
            }
            
            body.dark-mode #deselectAllGroupsBtn {
              background-color: #2d2d2d;
              color: #dc3545;
              border-color: #dc3545;
            }
            
            body.dark-mode #deselectAllGroupsBtn:hover {
              background-color: #dc3545;
              color: #ffffff;
            }
            
            body.dark-mode #confirmSelectionBtn {
              background-color: #4fc3f7;
              color: #ffffff;
              border-color: #4fc3f7;
            }
            
            body.dark-mode #confirmSelectionBtn:hover {
              background-color: #29b6f6;
            }
            
            body.dark-mode #chartDisplayModeToggle span {
              color: #e0e0e0 !important;
            }
            
            body.dark-mode #chartDisplayModeToggle label {
              color: #e0e0e0 !important;
            }
            
            body.dark-mode input[type="radio"] {
              accent-color: #4fc3f7;
            }
            
            body.dark-mode #individualMetricSelector span {
              color: #e0e0e0 !important;
            }
            
            body.dark-mode .initial-message {
              color: #e0e0e0;
            }
            
            body.dark-mode #lastUpdate {
              color: #e0e0e0;
            }
            
            body.dark-mode .toggle-label {
              color: #e0e0e0;
            }
            
            body.dark-mode .date-range {
              color: #e0e0e0;
            }
            
            body.dark-mode #chartToggleLoadingMessage {
              color: #e0e0e0;
            }
            
            body.dark-mode .elapsed-time {
              color: #e0e0e0;
            }
            
            body.dark-mode .sort-filter-container span {
              color: #e0e0e0;
            }
            
            body.dark-mode .group-selection-controls span {
              color: #e0e0e0;
            }
            
            body.dark-mode #selectedGroupsCount {
              color: #e0e0e0;
            }
            
            body.dark-mode #individualModeNote {
              color: #e0e0e0;
            }
            
            body.dark-mode #chartGroupCount {
              background-color: #0d47a1;
              color: #ffffff;
              border-color: #1976d2;
            }
            
            /* Chart.js text colors for dark mode */
            body.dark-mode canvas {
              filter: brightness(1.3) contrast(1.1);
            }
            .container {
              max-width: 1200px;
              margin: 0 auto;
              background-color: white;
              padding: 20px;
              border-radius: 8px;
              box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            }
            h1 {
              color: #333;
              margin-bottom: 20px;
            }
            .group-list {
              list-style: none;
              padding: 0;
            }
            .group-item {
              padding: 15px;
              margin: 10px 0;
              background-color: #f8f9fa;
              border-radius: 8px;
              border-left: 4px solid #007bff;
              display: flex;
              justify-content: space-between;
              align-items: center;
              transition: all 0.3s ease;
            }
            .group-item.not-selected {
              border-left: 4px solid transparent;
              opacity: 0.6;
              background-color: #f0f0f0;
            }
            .group-item.selection-mode {
              cursor: pointer;
              border: 2px solid #ddd;
              border-left: 4px solid #007bff;
            }
            .group-item.selection-mode:hover {
              border-color: #007bff;
              background-color: #e3f2fd;
            }
            .group-item.selection-mode.selected {
              background-color: #007bff;
              color: white;
              border-color: #0056b3;
            }
            .group-item.selection-mode.selected .stat-value,
            .group-item.selection-mode.selected .stat-label,
            .group-item.selection-mode.selected a {
              color: white !important;
            }
            .group-item a {
              color: #007bff;
              text-decoration: none;
              font-size: 18px;
              font-weight: 500;
            }
            .group-item a:hover {
              text-decoration: underline;
            }
            .stats-container {
              display: flex;
              gap: 20px;
              color: #666;
              min-width: 600px;
              justify-content: flex-end;
            }
            .stat {
              text-align: right;
            }
            .stat-value {
              font-weight: bold;
              color: #333;
            }
            .stat-label {
              font-size: 14px;
            }
            .attendance-good { color: #28a745; }
            .attendance-warning { color: #ffc107; }
            .attendance-poor { color: #dc3545; }
            .no-data {
              color: #6c757d;
              font-style: italic;
              font-size: 14px;
            }
            .loading {
              display: inline-block;
              width: 20px;
              height: 20px;
              border: 3px solid #f3f3f3;
              border-radius: 50%;
              border-top: 3px solid #007bff;
              animation: spin 1s linear infinite;
            }
            @keyframes spin {
              0% { transform: rotate(0deg); }
              100% { transform: rotate(360deg); }
            }
            #loadDataBtn {
              padding: 12px 24px;
              font-size: 16px;
              font-weight: 500;
              color: white;
              background-color: #007bff;
              border: none;
              border-radius: 4px;
              cursor: pointer;
              margin-bottom: 20px;
              transition: all 0.3s ease;
              display: flex;
              flex-direction: column;
              align-items: center;
              min-width: 160px;
            }
            #loadDataBtn .est-time {
              font-size: 12px;
              opacity: 0.8;
              margin-top: 4px;
            }
            #loadDataBtn:hover:not(:disabled) {
              background-color: #0056b3;
            }
            #loadDataBtn:disabled {
              background-color: #007bff !important;
              cursor: not-allowed !important;
            }
            #viewMembershipChangesBtn:disabled {
              background-color: #6c757d !important;
              cursor: not-allowed !important;
            }

            #groupList {
              display: none;
            }
            .initial-message {
              text-align: center;
              color: #666;
              padding: 40px;
              font-size: 18px;
            }
            .elapsed-time {
              display: block;
              font-size: 14px;
              color: #666;
              margin-top: 10px;
            }
            #lastUpdate {
              margin: 10px 0;
              color: #666;
              font-size: 14px;
              display: none;
            }
            .chart-container {
              background-color: white;
              padding: 20px;
              border-radius: 8px;
              margin: 20px 0;
              height: 400px;
              position: relative;
            }
            .chart-loading {
              position: absolute;
              top: 50%;
              left: 50%;
              transform: translate(-50%, -50%);
              display: flex;
              flex-direction: column;
              align-items: center;
              gap: 15px;
              color: #666;
              font-size: 16px;
            }
            .chart-loading .loading {
              width: 40px;
              height: 40px;
              border: 4px solid #f3f3f3;
              border-top: 4px solid #007bff;
            }
            .toggle-container {
              margin: 20px 0;
              padding: 15px;
              background-color: #f8f9fa;
              border-radius: 8px;
              display: flex;
              align-items: center;
              gap: 10px;
            }
            .toggle-switch {
              position: relative;
              display: inline-block;
              width: 60px;
              height: 34px;
            }
            .toggle-switch input {
              opacity: 0;
              width: 0;
              height: 0;
            }
            .toggle-slider {
              position: absolute;
              cursor: pointer;
              top: 0;
              left: 0;
              right: 0;
              bottom: 0;
              background-color: #ccc;
              transition: .4s;
              border-radius: 34px;
            }
            .toggle-slider:before {
              position: absolute;
              content: "";
              height: 26px;
              width: 26px;
              left: 4px;
              bottom: 4px;
              background-color: white;
              transition: .4s;
              border-radius: 50%;
            }
            input:checked + .toggle-slider {
              background-color: #2196F3;
            }
            input:checked + .toggle-slider:before {
              transform: translateX(26px);
            }
            .toggle-label {
              font-size: 16px;
              color: #666;
            }
            .date-range {
              font-size: 14px;
              color: #666;
              margin-left: auto;
            }
            .group-item.needs-attention {
              border-left: 12px solid #ff6b47;
              position: relative;
            }
            .group-item.needs-attention.not-selected {
              border-left: 12px solid #ff6b47;
              opacity: 0.6;
              background-color: #f0f0f0;
            }
            .attention-button {
              position: absolute;
              left: -10px;
              top: 50%;
              transform: translateY(-50%);
              background-color: #ff6b47;
              color: white;
              width: 18px;
              height: 18px;
              border-radius: 50%;
              display: flex;
              align-items: center;
              justify-content: center;
              font-size: 13px;
              font-weight: bold;
              font-family: Arial, sans-serif;
              border: 2px solid white;
              cursor: pointer;
              transition: all 0.3s ease;
              z-index: 10;
              user-select: none;
            }
            .attention-button:hover {
              background-color: #e55a3a;
              transform: translateY(-50%) scale(1.1);
            }

            @keyframes spin {
              0% { transform: translateY(-50%) rotate(0deg); }
              100% { transform: translateY(-50%) rotate(360deg); }
            }
            .attention-tooltip {
              position: absolute;
              background-color: #333;
              color: white;
              padding: 8px 12px;
              border-radius: 4px;
              font-size: 12px;
              white-space: nowrap;
              z-index: 1000;
              box-shadow: 0 2px 8px rgba(0,0,0,0.2);
              pointer-events: none;
              opacity: 0;
              transition: opacity 0.2s;
            }
            .attention-tooltip.show {
              opacity: 1;
            }
            .attention-tooltip::after {
              content: "";
              position: absolute;
              top: 50%;
              right: 100%;
              margin-top: -5px;
              border: 5px solid transparent;
              border-right-color: #333;
            }
            .date-range {
              font-size: 14px;
              color: #666;
              margin-left: auto;
            }
            .meeting-type {
              display: inline-block;
              padding: 4px 8px;
              border-radius: 4px;
              font-size: 12px;
              font-weight: bold;
              text-align: center;
              min-width: 50px;
            }
            .meeting-type.moms {
              background-color: #ffebee;
              color: #c2185b;
              border: 1px solid #f8bbd9;
            }
            .meeting-type.dads {
              background-color: #e3f2fd;
              color: #1976d2;
              border: 1px solid #90caf9;
            }
            .meeting-type.family {
              background-color: #e8f5e8;
              color: #388e3c;
              border: 1px solid #a5d6a7;
            }
            .meeting-type.other {
              background-color: #f5f5f5;
              color: #666;
              border: 1px solid #ddd;
            }
            
            .dark-mode-toggle {
              position: absolute;
              top: 20px;
              right: 20px;
              background-color: #007bff;
              color: white;
              border: none;
              border-radius: 50px;
              padding: 8px 16px;
              font-size: 12px;
              font-weight: 500;
              cursor: pointer;
              transition: all 0.3s ease;
              box-shadow: 0 2px 8px rgba(0,0,0,0.1);
              z-index: 1000;
            }
            
            .dark-mode-toggle:hover {
              background-color: #0056b3;
              transform: translateY(-1px);
              box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            }
            
            body.dark-mode .dark-mode-toggle {
              background-color: #ffc107;
              color: #212529;
            }
            
            body.dark-mode .dark-mode-toggle:hover {
              background-color: #e0a800;
            }
          </style>
          <script>
            // Apply dark mode immediately to prevent flash
            if (localStorage.getItem('darkMode') === 'true') {
              document.documentElement.classList.add('dark-mode-loading');
            }
          </script>
          <style>
            /* Temporary class to apply dark mode before body loads */
            html.dark-mode-loading body {
              background-color: #1a1a1a !important;
            }
            html.dark-mode-loading .container {
              background-color: #2d2d2d !important;
              color: #ffffff !important;
            }
            html.dark-mode-loading h1 {
              color: #ffffff !important;
            }
            html.dark-mode-loading .group-item {
              background-color: #3d3d3d !important;
              color: #ffffff !important;
            }
            html.dark-mode-loading .stats-container {
              color: #e0e0e0 !important;
            }
            html.dark-mode-loading .stat-value {
              color: #ffffff !important;
            }
            html.dark-mode-loading .stat-value.attendance-good {
              color: #4caf50 !important;
            }
            html.dark-mode-loading .stat-value.attendance-warning {
              color: #ff9800 !important;
            }
            html.dark-mode-loading .stat-value.attendance-poor {
              color: #f44336 !important;
            }
            html.dark-mode-loading .stat-label {
              color: #e0e0e0 !important;
            }
            html.dark-mode-loading #lastUpdate {
              color: #e0e0e0 !important;
            }
            html.dark-mode-loading .toggle-label {
              color: #e0e0e0 !important;
            }
            html.dark-mode-loading .date-range {
              color: #e0e0e0 !important;
            }
            html.dark-mode-loading .initial-message {
              color: #e0e0e0 !important;
            }
            html.dark-mode-loading canvas {
              filter: brightness(1.3) contrast(1.1) !important;
            }
          </style>
        </head>
        <body>
          <button class="dark-mode-toggle" id="darkModeToggle">🌙 Dark Mode</button>
          <div class="container">
            <h1>Queen City Church - Life Groups Health Report</h1>
            <div style="display: flex; gap: 15px; align-items: center; margin-bottom: -10px;">
              <button id="loadDataBtn" title="Click to refresh current year data. Shift+Click to refresh ALL historical data." onmouseover="if (!this.disabled) { this.style.backgroundColor='#0056b3'; this.style.cursor='pointer'; } else { this.style.cursor='not-allowed'; }" onmouseout="if (!this.disabled) { this.style.backgroundColor='#007bff'; this.style.cursor='pointer'; } else { this.style.cursor='not-allowed'; }">
              <span>Load Data</span>
              <span class="est-time">est. time ≈ 3 min.</span>
            </button>
                          <button id="viewMembershipChangesBtn" style="padding: 12px 24px; font-size: 16px; font-weight: 500; color: white; background-color: #28a745; border: none; border-radius: 4px; cursor: pointer; margin-bottom: 20px; transition: all 0.3s ease; display: flex; flex-direction: column; align-items: center; min-width: 160px;" onmouseover="if (!this.disabled) { this.style.backgroundColor='#218838'; this.style.cursor='pointer'; } else { this.style.cursor='not-allowed'; }" onmouseout="if (!this.disabled) { this.style.backgroundColor='#28a745'; this.style.cursor='pointer'; } else { this.style.cursor='not-allowed'; }">
              <span>View Membership Changes</span>
              <span id="membershipButtonSummary" style="font-size: 11px; opacity: 0.9; margin-top: 4px; line-height: 1.2;">Loading...</span>
            </button>
            </div>
            <p id="lastUpdate"></p>

            
            <div class="toggle-container" id="toggleContainer" style="display: none;">
              <label class="toggle-switch">
                <input type="checkbox" id="showAllYears">
                <span class="toggle-slider"></span>
              </label>
              <span class="toggle-label">Show all years</span>
              <span id="chartToggleLoadingMessage" style="color: #666; display: none; align-items: center;">
                <div class="loading" style="width: 16px; height: 16px; margin: 0 8px;"></div>
                Updating data...
              </span>
              <span class="date-range" id="chartDateRange">
                Showing data from: Current year
              </span>
            </div>
            

            
            
            <div class="chart-container">
              <div id="chartLoading" class="chart-loading">
                <div class="loading"></div>
                <span>Loading chart data...</span>
              </div>
              <canvas id="aggregateChart"></canvas>
              <div id="chartGroupCount" style="display: none; margin-top: 15px; padding: 6px 12px; background-color: #e3f2fd; border-radius: 4px; font-size: 13px; color: #1976d2; text-align: center; border: 1px solid #90caf9;">
                Chart represents data from X groups
              </div>
            </div>
            
            <div class="sort-filter-container" id="sortFilterContainer" style="display: none; margin-top: 30px;">
              <button id="sortFilterToggleBtn" style="width: 100%; background: white; border: 1px solid #ddd; border-radius: 8px; padding: 15px 20px; cursor: pointer; display: flex; align-items: center; justify-content: space-between; margin: 20px 0; box-shadow: 0 2px 4px rgba(0,0,0,0.1); transition: all 0.3s ease;" onmouseover="this.style.borderColor=&quot;#007bff&quot;; this.style.backgroundColor=&quot;#f8f9fa&quot;;" onmouseout="this.style.borderColor=&quot;#ddd&quot;; this.style.backgroundColor=&quot;white&quot;;">
                <div style="display: flex; align-items: center; gap: 15px;">
                  <h3 style="margin: 0; color: #333; font-weight: 500;">Sort & Filter Groups</h3>
                  <div id="sortFilterSummary" style="display: flex; gap: 15px; font-size: 14px; color: #666;">
                    <span>Click to customize view</span>
                  </div>
                </div>
                <span id="sortFilterToggleIcon" style="color: #666; font-size: 16px;">▼</span>
              </button>
              
              <div id="sortFilterExpandedContent" style="display: none; background-color: white; padding: 20px; border-radius: 8px; margin: 20px 0; box-shadow: 0 2px 4px rgba(0,0,0,0.1); border-top: none; margin-top: -20px; border-top-left-radius: 0; border-top-right-radius: 0;">
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 30px;">
                  <!-- Sort Section -->
                  <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; border-left: 4px solid #007bff;">
                    <h4 style="margin: 0 0 15px 0; color: #007bff; font-weight: 500;">Sort Groups</h4>
                    <select id="sortSelect" style="width: 100%; padding: 8px 12px; border: 1px solid #ddd; border-radius: 4px; background: white; font-size: 14px;">
                      <option value="name">Group Name (A-Z)</option>
                      <option value="attendance">Average Attendance</option>
                      <option value="members">Average Membership</option>
                      <option value="rate">Attendance Rate</option>
                      <option value="events">Number of Events</option>
                      <option value="parents-rate">Parents Nights Rate (Family Groups)</option>
                      <option value="family-rate">Family Nights Rate (Family Groups)</option>
                    </select>
                    <div style="margin-top: 10px;">
                      <label style="display: flex; align-items: center; gap: 8px; font-size: 14px; color: #666;">
                        <input type="checkbox" id="sortDescending" style="margin: 0;">
                        Descending order (highest first)
                      </label>
                    </div>
                  </div>
                  
                  <!-- Filter Section -->
                  <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; border-left: 4px solid #28a745;">
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 15px;">
                      <h4 style="margin: 0; color: #28a745; font-weight: 500;">Filter Groups</h4>
                      <button id="clearFiltersBtn" title="Clear All Filters" style="background: #dc3545; color: white; border: none; border-radius: 50%; width: 24px; height: 24px; cursor: pointer; font-size: 14px; font-weight: bold; display: flex; align-items: center; justify-content: center; transition: background-color 0.3s ease;" onmouseover="this.style.backgroundColor=&quot;#c82333&quot;;" onmouseout="this.style.backgroundColor=&quot;#dc3545&quot;;">
                        X
                      </button>
                    </div>
                    
                    <!-- Filters in two columns -->
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
                      <!-- Group Type Filter -->
                      <div>
                        <label style="display: block; margin-bottom: 5px; font-weight: 500; color: #333;">Group Type:</label>
                        <div style="display: flex; flex-direction: column; gap: 5px;">
                          <label style="display: flex; align-items: center; gap: 8px; font-size: 14px;">
                            <input type="checkbox" id="filterFamily" checked style="margin: 0;">
                            Family Groups
                          </label>
                          <label style="display: flex; align-items: center; gap: 8px; font-size: 14px;">
                            <input type="checkbox" id="filterStageOfLife" checked style="margin: 0;">
                            Stage of Life Groups
                          </label>
                          <label style="display: flex; align-items: center; gap: 8px; font-size: 14px;">
                            <input type="checkbox" id="filterLocationBased" checked style="margin: 0;">
                            Location Based Groups
                          </label>
                        </div>
                      </div>
                      
                      <!-- Meeting Day Filter -->
                      <div>
                        <label style="display: block; margin-bottom: 5px; font-weight: 500; color: #333;">Meeting Day:</label>
                        <div style="display: flex; flex-direction: column; gap: 5px;">
                          <label style="display: flex; align-items: center; gap: 8px; font-size: 14px;">
                            <input type="checkbox" id="filterWednesday" checked style="margin: 0;">
                            Wednesday
                          </label>
                          <label style="display: flex; align-items: center; gap: 8px; font-size: 14px;">
                            <input type="checkbox" id="filterThursday" checked style="margin: 0;">
                            Thursday
                          </label>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            
            <div class="group-selection-controls" id="groupSelectionControls" style="display: none; flex-wrap: wrap; align-items: center; gap: 15px; margin-bottom: 20px; padding: 15px; background-color: #f8f9fa; border-radius: 8px; border-left: 4px solid #007bff;">
              <span style="font-weight: bold; color: #333;"><strong>Chart Groups:</strong></span>
              <button id="chartSelectionModeBtn" style="padding: 8px 16px; border: 1px solid #007bff; border-radius: 4px; background-color: white; color: #007bff; cursor: pointer; font-size: 14px; transition: all 0.3s ease;" onmouseover="this.style.backgroundColor=&quot;#007bff&quot;; this.style.color=&quot;white&quot;;" onmouseout="this.style.backgroundColor=&quot;white&quot;; this.style.color=&quot;#007bff&quot;;">Select Groups for Chart</button>
              <span id="selectedGroupsCount" style="color: #666; font-size: 14px;">All groups selected for chart</span>
              
              <!-- Chart Display Mode Toggle -->
              <div id="chartDisplayModeToggle" style="display: flex; align-items: center; gap: 10px; margin-left: 20px; padding-left: 20px; border-left: 1px solid #ddd;">
                <span style="color: #333; font-size: 14px; font-weight: 500;">Display:</span>
                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                  <input type="radio" name="chartDisplayMode" value="combined" id="combinedModeRadio" checked style="margin: 0;">
                  <span style="font-size: 14px; color: #666;">Combined Data</span>
                </label>
                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                  <input type="radio" name="chartDisplayMode" value="individual" id="individualModeRadio" style="margin: 0;">
                  <span style="font-size: 14px; color: #666;">Individual Groups</span>
                </label>
                <span id="individualModeNote" style="display: none; color: #666; font-size: 12px; font-style: italic;">(max 5 groups)</span>
              </div>
              
              <!-- Individual Metric Selector (hidden by default) -->
              <div id="individualMetricSelector" style="display: none; align-items: center; gap: 10px; margin-left: 20px; padding-left: 20px; border-left: 1px solid #ddd;">
                <span style="color: #333; font-size: 14px; font-weight: 500;">Show:</span>
                <select id="individualMetricSelect" style="padding: 5px 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; background-color: white; color: #333; cursor: pointer;">
                  <option value="attendance">Total Attendance</option>
                  <option value="membership">Total Membership</option>
                  <option value="percentage">Attendance %</option>
                </select>
              </div>
              
              <!-- Selection mode controls (hidden by default) -->
              <div id="selectionModeControls" style="display: none; gap: 10px; align-items: center;">
                <span style="color: #666; font-size: 12px; font-style: italic;">Click groups to select/deselect:</span>
                <button id="selectAllGroupsBtn" style="padding: 6px 12px; border: 1px solid #28a745; border-radius: 4px; background-color: white; color: #28a745; cursor: pointer; font-size: 12px; transition: all 0.3s ease;" onmouseover="this.style.backgroundColor=&quot;#28a745&quot;; this.style.color=&quot;white&quot;;" onmouseout="this.style.backgroundColor=&quot;white&quot;; this.style.color=&quot;#28a745&quot;;">Select All</button>
                <button id="deselectAllGroupsBtn" style="padding: 6px 12px; border: 1px solid #dc3545; border-radius: 4px; background-color: white; color: #dc3545; cursor: pointer; font-size: 12px; transition: all 0.3s ease;" onmouseover="this.style.backgroundColor=&quot;#dc3545&quot;; this.style.color=&quot;white&quot;;" onmouseout="this.style.backgroundColor=&quot;white&quot;; this.style.color=&quot;#dc3545&quot;;">Deselect All</button>
                <button id="confirmSelectionBtn" style="padding: 6px 12px; border: 1px solid #007bff; border-radius: 4px; background-color: #007bff; color: white; cursor: pointer; font-size: 12px; transition: all 0.3s ease;" onmouseover="this.style.backgroundColor=&quot;#0056b3&quot;;" onmouseout="this.style.backgroundColor=&quot;#007bff&quot;;">Done</button>
              </div>
            </div>
            
            <div id="initialMessage" class="initial-message">
              Loading...
            </div>
            <ul id="groupList" class="group-list"></ul>
          </div>

          <script>
            const loadDataBtn = document.getElementById('loadDataBtn');
            const groupList = document.getElementById('groupList');
            const initialMessage = document.getElementById('initialMessage');
            const lastUpdate = document.getElementById('lastUpdate');

            // Add a global variable to track force refresh state
            let forceRefreshParam = '';
            
            // Global variables for sorting and filtering
            let allGroupsData = [];
            let currentFilters = {
              groupTypes: ['Family', 'Stage of Life', 'Location Based'],
              meetingDays: ['Wednesday', 'Thursday']
            };
            let currentSort = {
              field: 'name',
              descending: false
            };
            
            // Global variables for group selection
            let selectedGroupIds = new Set();
            let isSelectionMode = false;
            let currentlyVisibleGroups = [];
            let chartDisplayMode = 'combined'; // 'combined' or 'individual'
            let individualMetric = 'attendance'; // 'attendance', 'membership', 'percentage'

            // Sort and Filter Functions
            function setupSortFilterToggle() {
              const sortFilterToggleBtn = document.getElementById('sortFilterToggleBtn');
              const sortFilterToggleIcon = document.getElementById('sortFilterToggleIcon');
              const sortFilterExpandedContent = document.getElementById('sortFilterExpandedContent');
              
              if (sortFilterToggleBtn && sortFilterToggleIcon && sortFilterExpandedContent) {
                sortFilterToggleBtn.addEventListener('click', function() {
                  const isVisible = sortFilterExpandedContent.style.display === 'block';
                  
                  if (isVisible) {
                    sortFilterExpandedContent.style.display = 'none';
                    sortFilterToggleIcon.textContent = '▼';
                    sortFilterToggleBtn.style.borderBottomLeftRadius = '8px';
                    sortFilterToggleBtn.style.borderBottomRightRadius = '8px';
                  } else {
                    sortFilterExpandedContent.style.display = 'block';
                    sortFilterToggleIcon.textContent = '▲';
                    sortFilterToggleBtn.style.borderBottomLeftRadius = '0';
                    sortFilterToggleBtn.style.borderBottomRightRadius = '0';
                  }
                });
              } else {
                console.error('Sort/filter toggle elements not found!');
              }
            }
            
            function setupSortFilterControls() {
              // Sort controls
              const sortSelect = document.getElementById('sortSelect');
              const sortDescending = document.getElementById('sortDescending');
              
              if (sortSelect) {
                sortSelect.addEventListener('change', function() {
                  currentSort.field = this.value;
                  applyCurrentSortAndFilter();
                });
              }
              
              if (sortDescending) {
                sortDescending.addEventListener('change', function() {
                  currentSort.descending = this.checked;
                  applyCurrentSortAndFilter();
                });
              }
              
              // Filter controls
              const filterCheckboxes = [
                'filterFamily', 'filterStageOfLife', 'filterLocationBased',
                'filterWednesday', 'filterThursday'
              ];
              
              filterCheckboxes.forEach(id => {
                const checkbox = document.getElementById(id);
                if (checkbox) {
                  checkbox.addEventListener('change', function() {
                    updateCurrentFilters();
                    applyCurrentSortAndFilter();
                  });
                }
              });
              
              // Clear filters button
              const clearFiltersBtn = document.getElementById('clearFiltersBtn');
              if (clearFiltersBtn) {
                clearFiltersBtn.addEventListener('click', function() {
                  // Reset all filters
                  document.getElementById('filterFamily').checked = true;
                  document.getElementById('filterStageOfLife').checked = true;
                  document.getElementById('filterLocationBased').checked = true;
                  document.getElementById('filterWednesday').checked = true;
                  document.getElementById('filterThursday').checked = true;
                  
                  updateCurrentFilters();
                  applyCurrentSortAndFilter();
                });
              }
            }
            
            function updateCurrentFilters() {
              currentFilters.groupTypes = [];
              currentFilters.meetingDays = [];
              
              if (document.getElementById('filterFamily').checked) currentFilters.groupTypes.push('Family');
              if (document.getElementById('filterStageOfLife').checked) currentFilters.groupTypes.push('Stage of Life');
              if (document.getElementById('filterLocationBased').checked) currentFilters.groupTypes.push('Location Based');
              
              if (document.getElementById('filterWednesday').checked) currentFilters.meetingDays.push('Wednesday');
              if (document.getElementById('filterThursday').checked) currentFilters.meetingDays.push('Thursday');
            }
            
            function applyCurrentSortAndFilter() {
              if (allGroupsData.length === 0) return;
              
              // Apply filters first
              let filteredGroups = allGroupsData.filter(group => {
                const groupType = group.metadata?.groupType || 'Unknown';
                const meetingDay = group.metadata?.meetingDay || 'Unknown';
                
                // If no group types are selected, show no groups
                if (currentFilters.groupTypes.length === 0) {
                  return false;
                }
                
                // If no meeting days are selected, show no groups
                if (currentFilters.meetingDays.length === 0) {
                  return false;
                }
                
                // For group types: include if type is selected, or if type is Unknown and at least one type is selected
                const matchesGroupType = currentFilters.groupTypes.includes(groupType) || 
                                       (groupType === 'Unknown' && currentFilters.groupTypes.length > 0);
                
                // For meeting days: include if day is selected, or if day is Unknown and at least one day is selected
                const matchesMeetingDay = currentFilters.meetingDays.includes(meetingDay) || 
                                        (meetingDay === 'Unknown' && currentFilters.meetingDays.length > 0);
                
                return matchesGroupType && matchesMeetingDay;
              });
              
              // Apply sorting
              filteredGroups.sort((a, b) => {
                let aValue, bValue;
                
                switch (currentSort.field) {
                  case 'name':
                    aValue = a.attributes.name.toLowerCase();
                    bValue = b.attributes.name.toLowerCase();
                    return currentSort.descending ? bValue.localeCompare(aValue) : aValue.localeCompare(bValue);
                  
                  case 'attendance':
                    aValue = a.stats?.average_attendance || 0;
                    bValue = b.stats?.average_attendance || 0;
                    break;
                  
                  case 'members':
                    aValue = a.stats?.average_members || 0;
                    bValue = b.stats?.average_members || 0;
                    break;
                  
                  case 'rate':
                    aValue = a.stats?.overall_attendance_rate || 0;
                    bValue = b.stats?.overall_attendance_rate || 0;
                    break;
                  
                  case 'events':
                    aValue = a.stats?.events_with_attendance || 0;
                    bValue = b.stats?.events_with_attendance || 0;
                    break;
                  
                  case 'parents-rate':
                    aValue = (a.stats?.familyGroup?.parentsNightsRate) || 0;
                    bValue = (b.stats?.familyGroup?.parentsNightsRate) || 0;
                    break;
                  
                  case 'family-rate':
                    aValue = (a.stats?.familyGroup?.familyNightsRate) || 0;
                    bValue = (b.stats?.familyGroup?.familyNightsRate) || 0;
                    break;
                  
                  default:
                    return 0;
                }
                
                if (currentSort.descending) {
                  return bValue - aValue;
                } else {
                  return aValue - bValue;
                }
              });
              
              // Update the display
              displayFilteredGroups(filteredGroups);
              updateSortFilterSummary(filteredGroups.length);
              
              // Update the chart with filtered data
              updateChartWithFilteredGroups(filteredGroups);
            }
            
            function displayFilteredGroups(groups) {
              const groupList = document.getElementById('groupList');
              
              // Track currently visible groups for selection logic
              currentlyVisibleGroups = groups;
              
              if (groupList) {
                const groupsHtml = groups.map(group => {
                  // Check if this group is selected
                  const isSelected = selectedGroupIds.has(group.id);
                  let statsHtml = '';
                  
                  if (group.stats) {
                    const stats = group.stats;
                    let rateClass = '';
                    if (stats.overall_attendance_rate >= 70) rateClass = 'attendance-good';
                    else if (stats.overall_attendance_rate >= 50) rateClass = 'attendance-warning';
                    else if (stats.overall_attendance_rate > 0) rateClass = 'attendance-poor';

                    if (group.isFamilyGroup && stats.familyGroup) {
                      // Family Group specific stats
                      const getColorClass = (rate) => {
                        if (rate >= 70) return 'attendance-good';
                        else if (rate >= 50) return 'attendance-warning';
                        else if (rate > 0) return 'attendance-poor';
                        return '';
                      };
                      
                      const parentsRateClass = getColorClass(stats.familyGroup.parentsNightsRate || 0);
                      const familyRateClass = getColorClass(stats.familyGroup.familyNightsRate || 0);
                      
                      statsHtml = 
                        '<div class="stat">' +
                          '<div class="stat-value">' + (stats.familyGroup.parentsNightsAttendance || 0) + '</div>' +
                          '<div class="stat-label">Parents Nights Avg.</div>' +
                        '</div>' +
                        '<div class="stat">' +
                          '<div class="stat-value">' + (stats.familyGroup.familyNightsAttendance || 0) + '</div>' +
                          '<div class="stat-label">Family Nights Avg.</div>' +
                        '</div>' +
                        '<div class="stat">' +
                          '<div class="stat-value">' + (stats.average_members || 0) + '</div>' +
                          '<div class="stat-label">Avg. Membership</div>' +
                        '</div>' +
                        '<div class="stat">' +
                          '<div class="stat-value ' + parentsRateClass + '">' + (stats.familyGroup.parentsNightsRate || 0) + '%</div>' +
                          '<div class="stat-label">Parents Nights %</div>' +
                        '</div>' +
                        '<div class="stat">' +
                          '<div class="stat-value ' + familyRateClass + '">' + (stats.familyGroup.familyNightsRate || 0) + '%</div>' +
                          '<div class="stat-label">Family Nights %</div>' +
                        '</div>' +
                        '<div class="stat">' +
                          '<div class="stat-value">' + (stats.events_with_attendance || 0) + '</div>' +
                          '<div class="stat-label">Events</div>' +
                        '</div>';
                    } else {
                      // Regular group stats
                      statsHtml = 
                        '<div class="stat">' +
                          '<div class="stat-value">' + (stats.average_attendance || 0) + '</div>' +
                          '<div class="stat-label">Avg. Attendance</div>' +
                        '</div>' +
                        '<div class="stat">' +
                          '<div class="stat-value">' + (stats.average_members || 0) + '</div>' +
                          '<div class="stat-label">Avg. Membership</div>' +
                        '</div>' +
                        '<div class="stat">' +
                          '<div class="stat-value ' + rateClass + '">' + (stats.overall_attendance_rate || 0) + '%</div>' +
                          '<div class="stat-label">Attendance Rate</div>' +
                        '</div>' +
                        '<div class="stat">' +
                          '<div class="stat-value">' + (stats.events_with_attendance || 0) + '</div>' +
                          '<div class="stat-label">Events</div>' +
                        '</div>';
                    }
                  } else {
                    statsHtml = '<div class="loading"></div>';
                  }

                  // Build the group item classes
                  let groupItemClasses = 'group-item';
                  if (group.isFamilyGroup) groupItemClasses += ' family-group';
                  if (group.stats?.needsAttention) groupItemClasses += ' needs-attention';
                  if (isSelectionMode) groupItemClasses += ' selection-mode';
                  if (isSelectionMode && isSelected) groupItemClasses += ' selected';
                  
                  // Add visual indicator for chart selection when not in selection mode
                  if (!isSelectionMode) {
                    const hasCustomSelection = selectedGroupIds.size < allGroupsData.length;
                    if (hasCustomSelection && !isSelected) {
                      groupItemClasses += ' not-selected';
                    }
                  }

                  return '<li class="' + groupItemClasses + '" id="group-' + group.id + '" data-group-id="' + group.id + '"' +
                         (group.stats?.needsAttention ? ' title="Recent event missing attendance data - Click exclamation mark to open Planning Center"' : '') + '>' +
                    '<a href="/life-groups/groups/' + group.id + '/attendance" style="color: ' + (document.body.classList.contains('dark-mode') ? '#87ceeb' : '#007bff') + '; text-decoration: none; font-size: 18px; font-weight: 500;" onmouseover="this.style.textDecoration=&quot;underline&quot;;" onmouseout="this.style.textDecoration=&quot;none&quot;;">' +
                      group.attributes.name +
                    '</a>' +
                    '<div class="stats-container" id="stats-' + group.id + '">' +
                      statsHtml +
                    '</div>' +
                    (group.stats?.needsAttention ? '<div class="attention-button" title="Click to open Planning Center">!</div>' : '') +
                  '</li>';
                }).join('');
                
                groupList.innerHTML = groupsHtml;
              }
            }
            
            function updateSortFilterSummary(filteredCount) {
              const sortFilterSummary = document.getElementById('sortFilterSummary');
              if (sortFilterSummary) {
                const totalCount = allGroupsData.length;
                if (filteredCount === totalCount) {
                  sortFilterSummary.innerHTML = '<span>Showing all groups</span>';
                } else {
                  sortFilterSummary.innerHTML = \`<span>Showing \${filteredCount} of \${totalCount} groups</span>\`;
                }
              }
            }
            
            function updateChartWithFilteredGroups(filteredGroups) {
              // Update chart with filtered data
              
              // Preserve scroll position to prevent page jumping
              const currentScrollPosition = window.pageYOffset || document.documentElement.scrollTop;
              
              // Show loading indicator on chart
              const chartLoading = document.getElementById('chartLoading');
              const chartCanvas = document.getElementById('aggregateChart');
              if (chartLoading && chartCanvas) {
                chartLoading.style.display = 'flex';
                chartLoading.innerHTML = '<div class="loading"></div><span>Updating chart with filters...</span>';
                chartCanvas.style.display = 'none';
                
                // Hide chart group count info box while loading
                const chartGroupCountElement = document.getElementById('chartGroupCount');
                if (chartGroupCountElement) chartGroupCountElement.style.display = 'none';
                
                // Restore scroll position immediately after DOM manipulation
                window.scrollTo(0, currentScrollPosition);
              }
              
              // Check if we have a custom selection that should be preserved
              // If selectedGroupIds contains a subset of the currently visible groups, use group selection
              // Otherwise, use normal filtering
              updateChartWithSelectedGroups();
            }
            
            // Group selection functions
            function updateSelectedGroupsCount() {
              const countElement = document.getElementById('selectedGroupsCount');
              if (countElement) {
                if (isSelectionMode) {
                  if (chartDisplayMode === 'individual') {
                    countElement.textContent = \`\${selectedGroupIds.size} of 5 groups selected for chart\`;
                  } else {
                    countElement.textContent = \`\${selectedGroupIds.size} groups selected for chart\`;
                  }
                } else {
                  // Check if user has made a custom selection
                  const hasCustomSelection = selectedGroupIds.size < allGroupsData.length;
                  
                  if (hasCustomSelection) {
                    if (chartDisplayMode === 'individual') {
                      countElement.textContent = \`\${selectedGroupIds.size} groups selected for individual comparison\`;
                    } else {
                      countElement.textContent = \`\${selectedGroupIds.size} groups selected for chart\`;
                    }
                  } else {
                    countElement.textContent = 'All groups selected for chart';
                  }
                }
              }
            }
            
            function updateChartGroupCount(aggregateData) {
              const chartGroupCountElement = document.getElementById('chartGroupCount');
              if (chartGroupCountElement && aggregateData && aggregateData.length > 0) {
                // Find the week with the most groups to get the total group count for the chart
                let maxGroups = 0;
                aggregateData.forEach(week => {
                  const totalGroups = week.groupsWithData || 0;
                  maxGroups = Math.max(maxGroups, totalGroups);
                });
                
                if (maxGroups > 0) {
                  chartGroupCountElement.textContent = \`Chart represents data from \${maxGroups} groups\`;
                  chartGroupCountElement.style.display = 'block';
                } else {
                  chartGroupCountElement.style.display = 'none';
                }
              } else {
                if (chartGroupCountElement) {
                  chartGroupCountElement.style.display = 'none';
                }
              }
            }
            
            function enterSelectionMode() {
              isSelectionMode = true;
              
              // Update UI to show selection mode
              const chartSelectionModeBtn = document.getElementById('chartSelectionModeBtn');
              const selectionModeControls = document.getElementById('selectionModeControls');
              
              if (chartSelectionModeBtn) {
                chartSelectionModeBtn.style.display = 'none';
              }
              
              if (selectionModeControls) {
                selectionModeControls.style.display = 'flex';
              }
              
              // Update all group items to show selection mode and restore selection state
              applyCurrentSortAndFilter();
              
              // Disable links in selection mode
              document.querySelectorAll('.group-item a').forEach(link => {
                link.style.pointerEvents = 'none';
              });
              
              // Restore visual selection state to match selectedGroupIds
              document.querySelectorAll('.group-item').forEach(groupItem => {
                const groupId = groupItem.dataset.groupId;
                if (groupId && selectedGroupIds.has(groupId)) {
                  groupItem.classList.add('selected');
                } else {
                  groupItem.classList.remove('selected');
                }
              });
              
              // Update the selected groups count to show current selection in selection mode
              updateSelectedGroupsCount();
            }
            
            function exitSelectionMode() {
              isSelectionMode = false;
              
              // Update UI to hide selection mode
              const chartSelectionModeBtn = document.getElementById('chartSelectionModeBtn');
              const selectionModeControls = document.getElementById('selectionModeControls');
              
              if (chartSelectionModeBtn) {
                chartSelectionModeBtn.style.display = 'block';
              }
              
              if (selectionModeControls) {
                selectionModeControls.style.display = 'none';
              }
              
              // Update all group items to hide selection mode
              applyCurrentSortAndFilter();
              
              // Re-enable links
              document.querySelectorAll('.group-item a').forEach(link => {
                link.style.pointerEvents = 'auto';
              });
              
              // Update the chart with selected groups
              updateChartWithSelectedGroups();
              updateSelectedGroupsCount();
            }
            
            function setupGroupSelectionControls() {
              const chartSelectionModeBtn = document.getElementById('chartSelectionModeBtn');
              const selectAllBtn = document.getElementById('selectAllGroupsBtn');
              const deselectAllBtn = document.getElementById('deselectAllGroupsBtn');
              const confirmSelectionBtn = document.getElementById('confirmSelectionBtn');
              const groupSelectionControls = document.getElementById('groupSelectionControls');
              
              // Setup chart display mode toggle
              const combinedModeRadio = document.getElementById('combinedModeRadio');
              const individualModeRadio = document.getElementById('individualModeRadio');
              const individualModeNote = document.getElementById('individualModeNote');
              const individualMetricSelector = document.getElementById('individualMetricSelector');
              const individualMetricSelect = document.getElementById('individualMetricSelect');
              
              if (combinedModeRadio && individualModeRadio) {
                combinedModeRadio.addEventListener('change', function() {
                  if (this.checked) {
                    chartDisplayMode = 'combined';
                    if (individualModeNote) individualModeNote.style.display = 'none';
                    if (individualMetricSelector) individualMetricSelector.style.display = 'none';
                    updateSelectedGroupsCount();
                    updateChartWithSelectedGroups();
                  }
                });
                
                individualModeRadio.addEventListener('change', function() {
                  if (this.checked) {
                    chartDisplayMode = 'individual';
                    if (individualModeNote) individualModeNote.style.display = 'inline';
                    if (individualMetricSelector) individualMetricSelector.style.display = 'flex';
                    
                    // Enforce 5-group limit for individual mode
                    if (selectedGroupIds.size > 5) {
                      // Keep only the first 5 selected groups
                      const selectedArray = Array.from(selectedGroupIds);
                      selectedGroupIds.clear();
                      selectedArray.slice(0, 5).forEach(id => selectedGroupIds.add(id));
                      
                      // Update visual selection state
                      document.querySelectorAll('.group-item').forEach(groupItem => {
                        const groupId = groupItem.dataset.groupId;
                        if (groupId && selectedGroupIds.has(groupId)) {
                          groupItem.classList.add('selected');
                        } else {
                          groupItem.classList.remove('selected');
                        }
                      });
                    }
                    
                    updateSelectedGroupsCount();
                    updateChartWithSelectedGroups();
                  }
                });
              }
              
              // Setup individual metric selector
              if (individualMetricSelect) {
                individualMetricSelect.addEventListener('change', function() {
                  individualMetric = this.value;
                  if (chartDisplayMode === 'individual') {
                    updateChartWithSelectedGroups();
                  }
                });
              }
              
              if (chartSelectionModeBtn) {
                chartSelectionModeBtn.addEventListener('click', function(event) {
                  event.preventDefault();
                  enterSelectionMode();
                });
              }
              
              if (selectAllBtn) {
                selectAllBtn.addEventListener('click', function(event) {
                  event.preventDefault();
                  // Select all currently visible groups (with limit for individual mode)
                  const visibleGroups = document.querySelectorAll('.group-item:not([style*="display: none"])');
                  const maxGroups = chartDisplayMode === 'individual' ? 5 : visibleGroups.length;
                  
                  let selectedCount = 0;
                  visibleGroups.forEach(groupItem => {
                    const groupId = groupItem.dataset.groupId;
                    if (groupId && selectedCount < maxGroups) {
                      selectedGroupIds.add(groupId);
                      groupItem.classList.add('selected');
                      selectedCount++;
                    }
                  });
                  updateSelectedGroupsCount();
                });
              }
              
              if (deselectAllBtn) {
                deselectAllBtn.addEventListener('click', function(event) {
                  event.preventDefault();
                  // Deselect all groups
                  const allGroupItems = document.querySelectorAll('.group-item');
                  allGroupItems.forEach(groupItem => {
                    groupItem.classList.remove('selected');
                  });
                  selectedGroupIds.clear();
                  updateSelectedGroupsCount();
                });
              }
              
              if (confirmSelectionBtn) {
                confirmSelectionBtn.addEventListener('click', function(event) {
                  event.preventDefault();
                  exitSelectionMode();
                });
              }
              
              // Show the controls when groups are loaded
              if (groupSelectionControls) {
                groupSelectionControls.style.display = 'flex';
              }
            }
            
                        function updateChartWithSelectedGroups() {
              // Check what groups are actually selected from the currently visible/filtered groups
              const visibleGroupIds = new Set(currentlyVisibleGroups.map(g => g.id));
              const selectedVisibleGroups = Array.from(selectedGroupIds).filter(id => visibleGroupIds.has(id));
              
              // Determine if user has made a custom selection (subset of all available groups)
              // We need to check against ALL groups, not just visible ones, to detect custom selections
              const hasCustomSelection = selectedGroupIds.size < allGroupsData.length;
              
              if (selectedVisibleGroups.length === 0) {
                // No groups selected - show empty chart
                if (chartDisplayMode === 'individual') {
                  loadIndividualGroupChart([]); // Empty array = no groups
                } else {
                  loadAggregateData(false, '', ''); // Empty filters = no groups
                }
              } else if (chartDisplayMode === 'individual') {
                // Individual mode - load individual group comparison chart
                loadIndividualGroupChart(selectedVisibleGroups);
              } else if (hasCustomSelection && selectedVisibleGroups.length < currentlyVisibleGroups.length) {
                // Combined mode: User has made a custom selection AND not all visible groups are selected
                // Use selected groups (overrides filtering)
                const selectedGroupsParam = selectedVisibleGroups.join(',');
                loadAggregateData(false, null, null, selectedGroupsParam);
              } else {
                // Combined mode: All visible groups are selected OR no custom selection made - use normal filtering (more efficient)
              const groupTypesParam = currentFilters.groupTypes.length > 0 ? currentFilters.groupTypes.join(',') : 'EMPTY';
              const meetingDaysParam = currentFilters.meetingDays.length > 0 ? currentFilters.meetingDays.join(',') : 'EMPTY';
                loadAggregateData(false, groupTypesParam, meetingDaysParam);
              }
            }
            
            function setupGroupClickListeners() {
              // Use event delegation to handle group item clicks in selection mode
              document.addEventListener('click', function(event) {
                const groupItem = event.target.closest('.group-item');
                
                if (groupItem && isSelectionMode) {
                  // Prevent the link from being followed
                  event.preventDefault();
                  
                  const groupId = groupItem.dataset.groupId;
                  if (groupId) {
                    if (selectedGroupIds.has(groupId)) {
                      selectedGroupIds.delete(groupId);
                      groupItem.classList.remove('selected');
                    } else {
                      // Check group limit for individual mode
                      if (chartDisplayMode === 'individual' && selectedGroupIds.size >= 5) {
                        alert('You can select a maximum of 5 groups for individual comparison.');
                        return;
                      }
                      
                      selectedGroupIds.add(groupId);
                      groupItem.classList.add('selected');
                    }
                    
                    updateSelectedGroupsCount();
                  }
                }
              });
              
              // Add event delegation for attention button clicks
              document.addEventListener('click', function(event) {
                const attentionButton = event.target.closest('.attention-button');
                
                if (attentionButton && !isSelectionMode) {
                  event.preventDefault();
                  event.stopPropagation();
                  
                  const groupItem = attentionButton.closest('.group-item');
                  const groupId = groupItem.id.replace('group-', '');
                  if (groupId) {
                    requestAttendanceForGroup(groupId, groupItem);
                  }
                }
              });
            }
            
            // Function to open Planning Center attendance request page
            async function requestAttendanceForGroup(groupId, groupElement) {
              try {
                // Get recent events for this group that need attendance
                const response = await fetch('/api/request-attendance', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({ groupId, getUrlsOnly: true })
                });
                
                const result = await response.json();
                
                if (response.ok && result.eventUrls && result.eventUrls.length > 0) {
                  // Open the first event's attendance request page
                  const eventUrl = \`https://groups.planningcenteronline.com/groups/\${groupId}/events/\${result.eventUrls[0]}\`;
                  window.open(eventUrl, '_blank');
                  
                  // Update tooltip to indicate the page was opened
                  groupElement.title = 'Opened Planning Center page - click "Request attendance from leaders" button there';
                } else {
                  // No events need attention
                  groupElement.title = result.message || 'No recent events need attendance requests';
                }
                
              } catch (error) {
                console.error('Error getting attendance request info:', error);
                groupElement.title = 'Error getting event information';
              }
            }

            function formatLastUpdateTime(timestamp) {
              if (!timestamp) return '';
              const date = new Date(timestamp);
              return date.toLocaleString('en-US', { 
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                year: 'numeric',
                hour: 'numeric',
                minute: 'numeric',
                hour12: true
              });
            }

            async function updateLastUpdateTime(showAll = false) {
              try {
                const url = showAll ? '/api/cache-info?showAll=true' : '/api/cache-info';
                const response = await fetch(url);
                if (!response.ok) throw new Error('Failed to fetch cache info');
                const { timestamp, showingAllYears } = await response.json();
                if (timestamp) {
                  const ageInHours = (Date.now() - timestamp) / (1000 * 60 * 60);
                  const ageInDays = ageInHours / 24;
                  
                  // Determine color based on age
                  let color = '#666'; // Default gray
                  if (ageInDays > 10) {
                    color = '#dc3545'; // Red for > 10 days
                  } else if (ageInHours > 48) {
                    color = '#ffc107'; // Yellow for > 48 hours
                  }
                  
                  const label = showingAllYears ? 'All Years Data' : 'Current Year Data';
                  lastUpdate.textContent = \`Last updated: \${formatLastUpdateTime(timestamp)} (\${label})\`;
                  lastUpdate.style.color = color;
                  lastUpdate.style.display = 'block';
                  lastUpdate.style.fontWeight = (ageInDays > 10 || ageInHours > 48) ? 'bold' : 'normal';
                }
              } catch (error) {
                console.error('Error fetching cache info:', error);
              }
            }

            // Setup membership changes button
            function setupMembershipChangesButton() {
              const viewMembershipChangesBtn = document.getElementById('viewMembershipChangesBtn');
              if (viewMembershipChangesBtn) {
                viewMembershipChangesBtn.addEventListener('click', function() {
                  window.location.href = '/life-groups/membership-changes';
                });
              }
              
              // Load membership changes summary for the button
              loadMembershipChangesSummary();
            }
            
            // Function to load membership changes summary for the button
            async function loadMembershipChangesSummary() {
              const membershipButtonSummary = document.getElementById('membershipButtonSummary');
              
              try {
                const response = await fetch('/api/membership-changes?days=30');
                if (!response.ok) throw new Error('Failed to fetch membership changes');
                
                const data = await response.json();
                
                if (membershipButtonSummary) {
                  if (data.totalJoins === 0 && data.totalLeaves === 0) {
                    membershipButtonSummary.textContent = 'No changes in last 30 days';
                  } else {
                    const netChange = data.totalJoins - data.totalLeaves;
                    const netChangeText = netChange > 0 ? '+' + netChange : netChange.toString();
                    
                    // Format with colored numbers: "+13 Joined -5 Left +8 Net"
                    // Use same colors as membership changes page: blue for positive, orange for negative, gray for zero
                    const netChangeColor = netChange > 0 ? 'rgba(0, 123, 255, 0.9)' : netChange < 0 ? 'rgba(253, 126, 20, 0.9)' : 'rgba(102, 102, 102, 0.9)';
                    
                    membershipButtonSummary.innerHTML = 
                      '<span style="color: #fff; background-color: rgba(46, 125, 50, 0.8); padding: 2px 4px; border-radius: 3px; font-weight: bold; text-shadow: 0 1px 2px rgba(0,0,0,0.3);">+' + data.totalJoins + '</span> Joined ' +
                      '<span style="color: #fff; background-color: rgba(220, 53, 69, 0.9); padding: 2px 4px; border-radius: 3px; font-weight: bold; text-shadow: 0 1px 2px rgba(0,0,0,0.3);">-' + data.totalLeaves + '</span> Left ' +
                      '<span style="color: #fff; background-color: ' + netChangeColor + '; padding: 2px 4px; border-radius: 3px; font-weight: bold; text-shadow: 0 1px 2px rgba(0,0,0,0.3);">' + netChangeText + '</span> Net';
                  }
                }
              } catch (error) {
                console.error('Error loading membership changes summary:', error);
                if (membershipButtonSummary) {
                  membershipButtonSummary.textContent = 'Unable to load summary';
                }
              }
            }

            // Add click event listener
            loadDataBtn.addEventListener('click', async (event) => {
              const isHistoricalRefresh = event.shiftKey;
              
              // Show confirmation for historical refresh
              if (isHistoricalRefresh) {
                const confirmed = confirm(
                  \`This will refresh ALL historical data (all years) which may take 10+ minutes.\\n\\n\` +
                  \`Are you sure you want to proceed?\\n\\n\` +
                  \`(Regular refresh without Shift key only refreshes current year data)\`
                );
                if (!confirmed) {
                  return; // Exit without refreshing
                }
              } else {
                // Check if it's been less than 1 hour since last refresh for regular refresh
                try {
                  const response = await fetch('/api/cache-info');
                  if (response.ok) {
                    const { timestamp } = await response.json();
                    if (timestamp) {
                      const hoursSinceLastUpdate = (Date.now() - timestamp) / (1000 * 60 * 60);
                      if (hoursSinceLastUpdate < 1) {
                        const confirmed = confirm(
                          \`Data was last refreshed less than 1 hour ago.\\n\\n\` +
                          \`Are you sure you want to refresh now?\\n\\n\` +
                          \`(Tip: Hold Shift while clicking to refresh ALL historical data)\`
                        );
                        if (!confirmed) {
                          return; // Exit without refreshing
                        }
                      }
                    }
                  }
                } catch (error) {
                  console.warn('Could not check last update time:', error);
                  // If we can't check, proceed with refresh
                }
              }

              const loadingHtml = isHistoricalRefresh 
                ? '<span>Refreshing All Data...</span><span class="est-time">est. time ≈ 10+ min.</span>'
                : '<span>Refreshing...</span><span class="est-time">est. time ≈ 3 min.</span>';
              loadDataBtn.innerHTML = loadingHtml;
              loadDataBtn.style.backgroundColor = '#007bff';
              loadDataBtn.disabled = true;
              
              // Disable membership changes button during refresh
              const viewMembershipChangesBtn = document.getElementById('viewMembershipChangesBtn');
              if (viewMembershipChangesBtn) {
                viewMembershipChangesBtn.disabled = true;
              }

              // Clear everything and show loading state
              groupList.innerHTML = '';
              groupList.style.display = 'none';
              
              // Hide toggle container while refreshing
              const toggleContainer = document.getElementById('toggleContainer');
              if (toggleContainer) {
                toggleContainer.style.display = 'none';
              }
              
              // Hide sort/filter container while refreshing
              const sortFilterContainer = document.getElementById('sortFilterContainer');
              if (sortFilterContainer) {
                sortFilterContainer.style.display = 'none';
              }
              
              // Hide group selection controls while refreshing
              const groupSelectionControls = document.getElementById('groupSelectionControls');
              if (groupSelectionControls) {
                groupSelectionControls.style.display = 'none';
              }
              
              // Hide chart container while loading
              const chartContainer = document.querySelector('.chart-container');
              if (chartContainer) {
                chartContainer.style.display = 'none';
              }
              
              initialMessage.textContent = isHistoricalRefresh 
                ? 'Loading fresh data (including all historical data)...'
                : 'Loading fresh data...';
              const elapsedTimeSpan = document.createElement('span');
              elapsedTimeSpan.className = 'elapsed-time';
              initialMessage.appendChild(elapsedTimeSpan);
              initialMessage.style.display = 'block';

              // Start timer
              const startTime = Date.now();
              let currentGroupIndex = 0;
              let totalGroups = 0;
              
              const updateElapsedTime = () => {
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                const minutes = Math.floor(elapsed / 60);
                const seconds = elapsed % 60;
                const timeStr = \`\${minutes}:\${seconds.toString().padStart(2, '0')}\`;
                
                if (totalGroups > 0 && currentGroupIndex > 0) {
                  elapsedTimeSpan.textContent = \`Time elapsed: \${timeStr} | Processing group \${currentGroupIndex} of \${totalGroups}\`;
                } else {
                  elapsedTimeSpan.textContent = \`Time elapsed: \${timeStr}\`;
                }
              };
              const timerInterval = setInterval(updateElapsedTime, 1000);
              updateElapsedTime(); // Show initial time

              // Clear the chart
              const chartCanvas = document.getElementById('aggregateChart');
              if (chartCanvas) {
                const ctx = chartCanvas.getContext('2d');
                ctx.clearRect(0, 0, chartCanvas.width, chartCanvas.height);
              }
              
              try {
                // Fetch all data first
                const groupsResponse = await fetch('/api/load-groups?forceRefresh=true');
                
                if (!groupsResponse.ok) {
                  const errorText = await groupsResponse.text();
                  console.error('Groups response error:', errorText);
                  throw new Error('Failed to fetch groups: ' + groupsResponse.status + ' ' + errorText);
                }
                
                const result = await groupsResponse.json();
                
                // Process groups sequentially to avoid cache race conditions
                const groupStats = [];
                totalGroups = result.data.length;
                
                for (let i = 0; i < result.data.length; i++) {
                  currentGroupIndex = i + 1;
                  const group = result.data[i];
                  
                  try {
                    // For historical refresh, we need to fetch both current year and all historical data
                    if (isHistoricalRefresh) {
                      // Fetch all historical attendance data to populate cache
                      const historicalResponse = await fetch(\`/life-groups/groups/\${group.id}/attendance?showAll=true&forceRefresh=true\`);
                      if (!historicalResponse.ok) {
                        console.warn(\`Failed to fetch historical data for group \${group.id}\`);
                      }
                      
                      // Also fetch current year data to ensure both caches are in sync
                      const currentYearResponse = await fetch(\`/life-groups/groups/\${group.id}/attendance?showAll=false&forceRefresh=true\`);
                      if (!currentYearResponse.ok) {
                        console.warn(\`Failed to fetch current year data for group \${group.id}\`);
                      }
                    }
                    
                    const params = new URLSearchParams();
                    params.set('forceRefresh', 'true');
                    if (isHistoricalRefresh) params.set('showAll', 'true');
                    const response = await fetch('/api/group-stats/' + group.id + '?' + params.toString());
                    
                    if (!response.ok) {
                      const errorText = await response.text();
                      console.error('Failed to fetch stats for group', group.id, 'Status:', response.status, response.statusText, 'Error:', errorText);
                      groupStats.push(null);
                    } else {
                      const stats = await response.json();
                      groupStats.push(stats);
                    }
                    
                    // Add delay between group processing to reduce API load (especially important for production)
                    // Use longer delay for historical refresh due to more intensive processing
                    if (i < result.data.length - 1) { // Don't delay after the last group
                      const delayMs = isHistoricalRefresh ? 2000 : 500; // 2s for historical, 500ms for current year
                      await new Promise(resolve => setTimeout(resolve, delayMs));
                    }
                  } catch (error) {
                    console.error(\`Error fetching stats for group \${group.id} (\${group.attributes.name}):\`, error);
                    groupStats.push(null);
                  }
                }
              
                                              // Update progress message to show we're finishing up
                currentGroupIndex = totalGroups;
                initialMessage.textContent = isHistoricalRefresh 
                  ? 'Finalizing data (including all historical data)...'
                  : 'Finalizing data...';
                
                // Add a brief delay to ensure all cache writes from individual group processing are complete
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                // Load aggregate chart - use cached data since we just populated it
                await loadAggregateData(false); // Always use cached data here since we just refreshed everything

                  // If this was a historical refresh, set the toggle to show all years
                  if (isHistoricalRefresh) {
                    const showAllYearsToggle = document.getElementById('showAllYears');
                    if (showAllYearsToggle) {
                      showAllYearsToggle.checked = true;
                    }
                  }
                  
                  // Force a page refresh to ensure we display consistent cached data
                  window.location.reload();
                
                // The code below will run after the page refresh loads the cached data
                
                // Prepare the HTML with stats data first
                const groupsHtml = result.data
                  .sort((a, b) => a.attributes.name.localeCompare(b.attributes.name))
                  .map((group, index) => {
                    const stats = groupStats[index];
                    let statsHtml = '';
                    
                    if (stats) {
                      let rateClass = '';
                      if (stats.overall_attendance_rate >= 70) rateClass = 'attendance-good';
                      else if (stats.overall_attendance_rate >= 50) rateClass = 'attendance-warning';
                      else if (stats.overall_attendance_rate > 0) rateClass = 'attendance-poor';

                      // Validate stats - if they seem suspicious, show a warning
                      const isSuspicious = stats.events_with_attendance === 0 || 
                                         (stats.average_attendance === 0 && stats.overall_attendance_rate > 0) ||
                                         (stats.overall_attendance_rate === 0 && stats.average_attendance > 0);

                      if (isSuspicious) {
                        statsHtml = '<div class="no-data">Stats calculating... (refresh if this persists)</div>';
                      } else if (group.isFamilyGroup && stats.familyGroup) {
                        // Family Group specific stats - calculate separate color classes for each rate
                        const getColorClass = (rate) => {
                          if (rate >= 70) return 'attendance-good';
                          else if (rate >= 50) return 'attendance-warning';
                          else if (rate > 0) return 'attendance-poor';
                          return '';
                        };
                        
                        const parentsRateClass = getColorClass(stats.familyGroup.parentsNightsRate || 0);
                        const familyRateClass = getColorClass(stats.familyGroup.familyNightsRate || 0);
                        
                        statsHtml = 
                          '<div class="stat">' +
                            '<div class="stat-value">' + (stats.familyGroup.parentsNightsAttendance || 0) + '</div>' +
                            '<div class="stat-label">Parents Nights Avg.</div>' +
                          '</div>' +
                          '<div class="stat">' +
                            '<div class="stat-value">' + (stats.familyGroup.familyNightsAttendance || 0) + '</div>' +
                            '<div class="stat-label">Family Nights Avg.</div>' +
                          '</div>' +
                          '<div class="stat">' +
                            '<div class="stat-value">' + (stats.average_members || 0) + '</div>' +
                            '<div class="stat-label">Avg. Membership</div>' +
                          '</div>' +
                          '<div class="stat">' +
                            '<div class="stat-value ' + parentsRateClass + '">' + (stats.familyGroup.parentsNightsRate || 0) + '%</div>' +
                            '<div class="stat-label">Parents Nights %</div>' +
                          '</div>' +
                          '<div class="stat">' +
                            '<div class="stat-value ' + familyRateClass + '">' + (stats.familyGroup.familyNightsRate || 0) + '%</div>' +
                            '<div class="stat-label">Family Nights %</div>' +
                          '</div>' +
                          '<div class="stat">' +
                            '<div class="stat-value">' + (stats.events_with_attendance || 0) + '</div>' +
                            '<div class="stat-label">Events</div>' +
                          '</div>';
                      } else {
                        // Regular group stats
                        statsHtml = 
                          '<div class="stat">' +
                            '<div class="stat-value">' + (stats.average_attendance || 0) + '</div>' +
                            '<div class="stat-label">Avg. Attendance</div>' +
                          '</div>' +
                          '<div class="stat">' +
                            '<div class="stat-value">' + (stats.average_members || 0) + '</div>' +
                            '<div class="stat-label">Avg. Membership</div>' +
                          '</div>' +
                          '<div class="stat">' +
                            '<div class="stat-value ' + rateClass + '">' + (stats.overall_attendance_rate || 0) + '%</div>' +
                            '<div class="stat-label">Attendance Rate</div>' +
                          '</div>' +
                          '<div class="stat">' +
                            '<div class="stat-value">' + (stats.events_with_attendance || 0) + '</div>' +
                            '<div class="stat-label">Events</div>' +
                          '</div>';
                      }
                    } else {
                      statsHtml = '<div class="no-data">Failed to load statistics</div>';
                    }

                    return '<li class="group-item' + (group.isFamilyGroup ? ' family-group' : '') + '" id="group-' + group.id + '">' +
                      '<a href="/life-groups/groups/' + group.id + '/attendance">' +
                        group.attributes.name +
                      '</a>' +
                      '<div class="stats-container" id="stats-' + group.id + '">' +
                        statsHtml +
                      '</div>' +
                    '</li>';
                  }).join('');

                // Now display everything at once
                groupList.style.display = 'block';
                initialMessage.style.display = 'none';
                groupList.innerHTML = groupsHtml;
                
                // Show the toggle container now that we have data
                const toggleContainer = document.getElementById('toggleContainer');
                if (toggleContainer) {
                  toggleContainer.style.display = 'flex';
                }
                
                // Show sort/filter container now that data is loaded
                const sortFilterContainer = document.getElementById('sortFilterContainer');
                if (sortFilterContainer) {
                  sortFilterContainer.style.display = 'block';
                }
                
                // Show group selection controls now that data is loaded
                const groupSelectionControls = document.getElementById('groupSelectionControls');
                if (groupSelectionControls) {
                  groupSelectionControls.style.display = 'flex';
                }
                
                // Show membership changes container now that data is loaded
                const membershipChangesContainer = document.getElementById('membershipChangesContainer');
                if (membershipChangesContainer) {
                  membershipChangesContainer.style.display = 'block';
                }
                
                // Show chart container now that data is loaded
                if (chartContainer) {
                  chartContainer.style.display = 'block';
                }
                
                // Setup sort/filter functionality after containers are shown
                setTimeout(() => {
                  setupSortFilterToggle();
                  setupSortFilterControls();
                }, 100);
                
                const showAllYears = document.getElementById('showAllYears')?.checked || false;
                await updateLastUpdateTime(showAllYears);
                clearInterval(timerInterval); // Stop the timer
              } catch (error) {
                console.error('Error refreshing data:', error);
                console.error('Error details:', {
                  message: error.message,
                  stack: error.stack,
                  name: error.name
                });
                
                let errorMessage = 'Failed to refresh data. Check console for details.';
                if (error instanceof Error) {
                  errorMessage = \`Failed to refresh data: \${error.message}\`;
                }
                
                initialMessage.textContent = errorMessage;
                alert(errorMessage);
              } finally {
                // Update button state
                const refreshHtml = '<span>Refresh Data</span><span class="est-time">est. time ≈ 3 min.</span>';
                loadDataBtn.innerHTML = refreshHtml;
                loadDataBtn.style.backgroundColor = '#007bff';
                loadDataBtn.disabled = false;
                
                // Re-enable membership changes button after refresh
                const viewMembershipChangesBtn = document.getElementById('viewMembershipChangesBtn');
                if (viewMembershipChangesBtn) {
                  viewMembershipChangesBtn.disabled = false;
                }
              }
            });

            // Check cache and load data if available
            async function checkCacheAndLoad() {
              try {
                const response = await fetch('/api/check-cache');
                if (!response.ok) throw new Error('Failed to check cache');
                const { hasCachedData } = await response.json();
                
                const buttonHtml = '<span>Refresh Data</span><span class="est-time">est. time ≈ 3 min.</span>';
                const initialButtonHtml = '<span>Load Data</span><span class="est-time">est. time ≈ 3 min.</span>';
                
                if (hasCachedData) {
                  // Always load cached data
                  loadGroups();
                  const showAllYears = document.getElementById('showAllYears')?.checked || false;
                  await updateLastUpdateTime(showAllYears);
                  loadDataBtn.innerHTML = buttonHtml;
                  loadDataBtn.style.backgroundColor = '#007bff';
                } else {
                  // If no cached data, show initial load message and hide chart loading
                  const chartLoading = document.getElementById('chartLoading');
                  if (chartLoading) chartLoading.style.display = 'none';
                  
                  loadDataBtn.disabled = false;
                  loadDataBtn.innerHTML = initialButtonHtml;
                  initialMessage.textContent = 'No data available. Click "Load Data" to fetch Life Groups data.';
                  
                  // Enable membership changes button when no cached data
                  const viewMembershipChangesBtn = document.getElementById('viewMembershipChangesBtn');
                  if (viewMembershipChangesBtn) {
                    viewMembershipChangesBtn.disabled = false;
                  }
                }
              } catch (error) {
                console.error('Error checking cache:', error);
                loadDataBtn.disabled = false;
                loadDataBtn.innerHTML = '<span>Load Data</span><span class="est-time">est. time ≈ 3 min.</span>';
                initialMessage.textContent = 'Error checking data status. Click "Load Data" to try fetching Life Groups data.';
                
                // Enable membership changes button on error
                const viewMembershipChangesBtn = document.getElementById('viewMembershipChangesBtn');
                if (viewMembershipChangesBtn) {
                  viewMembershipChangesBtn.disabled = false;
                }
              }
            }

            async function loadGroups() {
              try {
                loadDataBtn.disabled = true;
                loadDataBtn.innerHTML = '<span>Loading...</span><span class="est-time">est. time ≈ 3 min.</span>';
                
                // Disable membership changes button during loading
                const viewMembershipChangesBtn = document.getElementById('viewMembershipChangesBtn');
                if (viewMembershipChangesBtn) {
                  viewMembershipChangesBtn.disabled = true;
                }
                
                // Only load groups, don't load aggregate data here to avoid duplicate API calls
                const response = await fetch('/api/load-groups');
                
                if (!response.ok) throw new Error('Failed to fetch groups');
                const result = await response.json();
                
                displayGroups(result);
                
                // Note: Chart is loaded automatically by applyCurrentSortAndFilter() in displayGroups()
                // so we don't need to call loadAggregateData() explicitly here
                const showAllYears = document.getElementById('showAllYears')?.checked || false;
                await updateLastUpdateTime(showAllYears);
              } catch (error) {
                console.error('Error:', error);
                loadDataBtn.disabled = false;
                loadDataBtn.innerHTML = '<span>Load Data</span><span class="est-time">est. time ≈ 3 min.</span>';
                initialMessage.textContent = 'Failed to load groups. Please try again.';
                initialMessage.style.display = 'block';
                alert('Failed to load groups. Please try again.');
                
                // Re-enable membership changes button on error
                const viewMembershipChangesBtn = document.getElementById('viewMembershipChangesBtn');
                if (viewMembershipChangesBtn) {
                  viewMembershipChangesBtn.disabled = false;
                }
              } finally {
                loadDataBtn.disabled = false;
                
                // Re-enable membership changes button when loading completes
                const viewMembershipChangesBtn = document.getElementById('viewMembershipChangesBtn');
                if (viewMembershipChangesBtn) {
                  viewMembershipChangesBtn.disabled = false;
                }
              }
            }

            function displayGroups(result) {
              // Store the groups data globally for sorting/filtering
              allGroupsData = result.data.map(group => ({
                ...group,
                stats: null // Will be populated as stats load
              }));
              
              // Initialize selectedGroupIds with all visible groups (default behavior)
              // Note: This will be updated when filters are applied in applyCurrentSortAndFilter()
              selectedGroupIds.clear();
              result.data.forEach(group => {
                selectedGroupIds.add(group.id);
              });
              
              initialMessage.style.display = 'none';
              groupList.style.display = 'block';
              
              // Show the toggle container now that we have data
              const toggleContainer = document.getElementById('toggleContainer');
              if (toggleContainer) {
                toggleContainer.style.display = 'flex';
              }
              
              // Show sort/filter container now that we have data
              const sortFilterContainer = document.getElementById('sortFilterContainer');
              if (sortFilterContainer) {
                sortFilterContainer.style.display = 'block';
              }
              
              // Show group selection controls now that we have data
              const groupSelectionControls = document.getElementById('groupSelectionControls');
              if (groupSelectionControls) {
                groupSelectionControls.style.display = 'flex';
              }
              
              // Initial display with default sort (by name)
              applyCurrentSortAndFilter();
              
              // Setup sort/filter functionality after elements are in DOM
              setTimeout(() => {
                setupSortFilterToggle();
                setupSortFilterControls();
                setupGroupSelectionControls();
                setupGroupClickListeners();
                updateSelectedGroupsCount();
                setupMembershipChangesButton();
              }, 100);

              loadDataBtn.innerHTML = '<span>Refresh Data</span><span class="est-time">est. time ≈ 3 min.</span>';
              
              // Load stats for each group
              result.data.forEach(group => {
                const showAllYears = document.getElementById('showAllYears').checked;
                updateGroupStats(group.id, showAllYears);
              });
            }

            // Function to update stats for a group
            async function updateGroupStats(groupId, showAllYears = false, forceRefresh = false) {
              const container = document.querySelector(\`#group-\${groupId} .stats-container\`);
              try {
                // Build query parameters
                const params = new URLSearchParams();
                if (forceRefresh) params.set('forceRefresh', 'true');
                if (showAllYears) params.set('showAll', 'true');
                const queryString = params.toString();
                const url = \`/api/group-stats/\${groupId}\` + (queryString ? '?' + queryString : '');
                
                const response = await fetch(url);
                if (!response.ok) throw new Error('Failed to fetch stats');
                const stats = await response.json();
                
                // Update the stored group data with stats
                const groupIndex = allGroupsData.findIndex(g => g.id === groupId);
                if (groupIndex !== -1) {
                  allGroupsData[groupIndex].stats = stats;
                }
                
                let rateClass = '';
                if (stats.overall_attendance_rate >= 70) rateClass = 'attendance-good';
                else if (stats.overall_attendance_rate >= 50) rateClass = 'attendance-warning';
                else if (stats.overall_attendance_rate > 0) rateClass = 'attendance-poor';

                if (container) {
                  const isFamilyGroup = document.querySelector(\`#group-\${groupId}\`).classList.contains('family-group');
                  const groupElement = document.querySelector(\`#group-\${groupId}\`);
                  
                  // Update attention styling and button
                  if (stats.needsAttention) {
                    groupElement.classList.add('needs-attention');
                    groupElement.setAttribute('title', 'Recent event missing attendance data - Click exclamation mark to open Planning Center');
                    
                    // Add attention button if it doesn't exist
                    if (!groupElement.querySelector('.attention-button')) {
                      const attentionButton = document.createElement('div');
                      attentionButton.className = 'attention-button';
                      attentionButton.textContent = '!';
                      attentionButton.title = 'Click to open Planning Center';
                      groupElement.appendChild(attentionButton);
                    }
                  } else {
                    groupElement.classList.remove('needs-attention');
                    groupElement.removeAttribute('title');
                    
                    // Remove attention button if it exists
                    const existingButton = groupElement.querySelector('.attention-button');
                    if (existingButton) {
                      existingButton.remove();
                    }
                  }
                  
                  if (isFamilyGroup && stats.familyGroup) {
                    // Family Group specific stats - calculate separate color classes for each rate
                    const getColorClass = (rate) => {
                      if (rate >= 70) return 'attendance-good';
                      else if (rate >= 50) return 'attendance-warning';
                      else if (rate > 0) return 'attendance-poor';
                      return '';
                    };
                    
                    const parentsRateClass = getColorClass(stats.familyGroup.parentsNightsRate || 0);
                    const familyRateClass = getColorClass(stats.familyGroup.familyNightsRate || 0);
                    
                    container.innerHTML = \`
                      <div class="stat">
                        <div class="stat-value">\${stats.familyGroup.parentsNightsAttendance}</div>
                        <div class="stat-label">Parents Nights Avg.</div>
                      </div>
                      <div class="stat">
                        <div class="stat-value">\${stats.familyGroup.familyNightsAttendance}</div>
                        <div class="stat-label">Family Nights Avg.</div>
                      </div>
                      <div class="stat">
                        <div class="stat-value">\${stats.average_members}</div>
                        <div class="stat-label">Avg. Membership</div>
                      </div>
                      <div class="stat">
                        <div class="stat-value \${parentsRateClass}">\${stats.familyGroup.parentsNightsRate}%</div>
                        <div class="stat-label">Parents Nights %</div>
                      </div>
                      <div class="stat">
                        <div class="stat-value \${familyRateClass}">\${stats.familyGroup.familyNightsRate}%</div>
                        <div class="stat-label">Family Nights %</div>
                      </div>
                      <div class="stat">
                        <div class="stat-value">\${stats.events_with_attendance}</div>
                        <div class="stat-label">Events</div>
                      </div>
                    \`;
                  } else {
                    // Regular group stats
                    container.innerHTML = \`
                      <div class="stat">
                        <div class="stat-value">\${stats.average_attendance}</div>
                        <div class="stat-label">Avg. Attendance</div>
                      </div>
                      <div class="stat">
                        <div class="stat-value">\${stats.average_members}</div>
                        <div class="stat-label">Avg. Membership</div>
                      </div>
                      <div class="stat">
                        <div class="stat-value \${rateClass}">\${stats.overall_attendance_rate}%</div>
                        <div class="stat-label">Attendance Rate</div>
                      </div>
                      <div class="stat">
                        <div class="stat-value">\${stats.events_with_attendance}</div>
                        <div class="stat-label">Events</div>
                      </div>
                    \`;
                  }
                } else {
                  if (container) {
                    container.innerHTML = \`<div class="no-data">No attendance data available</div>\`;
                  }
                }
              } catch (error) {
                console.error('Error fetching stats:', error);
                if (container) {
                  container.innerHTML = \`<div class="no-data">Failed to load statistics</div>\`;
                }
              }
            }

            // Add function to load and display individual group comparison chart
            async function loadIndividualGroupChart(selectedGroupIds) {
              const chartLoading = document.getElementById('chartLoading');
              const chartCanvas = document.getElementById('aggregateChart');
              const showAllYears = document.getElementById('showAllYears').checked;
              
              // Preserve scroll position to prevent page jumping
              const currentScrollPosition = window.pageYOffset || document.documentElement.scrollTop;
              
              try {
                // Show loading indicator and hide chart
                if (chartLoading) {
                  chartLoading.style.display = 'flex';
                  chartLoading.innerHTML = '<div class="loading"></div><span>Loading individual group comparison...</span>';
                }
                if (chartCanvas) chartCanvas.style.display = 'none';
                
                // Hide chart group count info box while loading
                const chartGroupCountElement = document.getElementById('chartGroupCount');
                if (chartGroupCountElement) chartGroupCountElement.style.display = 'none';
                
                // If no groups selected, show empty chart
                if (selectedGroupIds.length === 0) {
                  createEmptyIndividualChart();
                  return;
                }
                
                // Build query parameters
                const params = new URLSearchParams();
                if (showAllYears) params.set('showAll', 'true');
                params.set('selectedGroups', selectedGroupIds.join(','));
                params.set('metric', individualMetric);
                const queryString = params.toString();
                const url = '/api/individual-group-attendance' + (queryString ? '?' + queryString : '');
                
                const response = await fetch(url);
                
                if (!response.ok) {
                  const errorText = await response.text();
                  throw new Error('Failed to fetch individual group data: ' + response.status + ' ' + errorText);
                }
                
                const individualData = await response.json();
                
                                 // Update chart group count for individual mode
                 if (chartGroupCountElement && selectedGroupIds.length > 0) {
                   chartGroupCountElement.textContent = 'Comparing ' + selectedGroupIds.length + ' individual groups';
                   chartGroupCountElement.style.display = 'block';
                 }
                
                // Create individual group comparison chart
                createIndividualGroupChart(individualData, showAllYears);
                
              } catch (error) {
                console.error('Error loading individual group data:', error);
                
                // Show error in the chart area
                if (chartLoading) {
                  chartLoading.innerHTML = '<div style="color: red; text-align: center;"><strong>Error loading individual group chart:</strong><br>' + error.message + '</div>';
                }
              } finally {
                // Hide loading indicator and show chart
                if (chartLoading) chartLoading.style.display = 'none';
                if (chartCanvas) chartCanvas.style.display = 'block';
                
                // Restore scroll position to prevent page jumping
                window.scrollTo(0, currentScrollPosition);
              }
            }
            
            // Function to create empty individual chart
            function createEmptyIndividualChart() {
              const ctx = document.getElementById('aggregateChart').getContext('2d');
              
              // Clear any existing chart
              if (window.aggregateChartInstance) {
                window.aggregateChartInstance.destroy();
              }
              
              // Get metric-specific labels
              const metricLabels = getMetricLabels(individualMetric);
              
              window.aggregateChartInstance = new Chart(ctx, {
                type: 'line',
                data: {
                  labels: [],
                  datasets: []
                },
                options: {
                  responsive: true,
                  maintainAspectRatio: false,
                  plugins: {
                    title: {
                      display: true,
                      text: 'Individual Group Comparison - No Groups Selected'
                    },
                    subtitle: {
                      display: true,
                      text: 'Select up to 5 groups to compare their ' + metricLabels.subtitle + ' trends.',
                      font: {
                        size: 12
                      },
                      color: '#666'
                    }
                  },
                  scales: {
                    y: {
                      beginAtZero: true,
                      title: {
                        display: true,
                        text: metricLabels.yAxis
                      }
                    },
                    x: {
                      title: {
                        display: true,
                        text: 'Week'
                      }
                    }
                  }
                }
              });
            }
            
            // Function to get metric-specific labels
            function getMetricLabels(metric) {
              switch (metric) {
                case 'attendance':
                  return {
                    yAxis: 'Total Attendance (Members + Visitors)',
                    subtitle: 'attendance'
                  };
                case 'membership':
                  return {
                    yAxis: 'Total Membership',
                    subtitle: 'membership'
                  };
                case 'percentage':
                  return {
                    yAxis: 'Attendance Rate (%)',
                    subtitle: 'attendance rate'
                  };
                default:
                  return {
                    yAxis: 'Total Attendance (Members + Visitors)',
                    subtitle: 'attendance'
                  };
              }
            }
            
            // Function to create individual group comparison chart
            function createIndividualGroupChart(individualData, showAllYears) {
              if (!individualData || !individualData.groups || individualData.groups.length === 0) {
                createEmptyIndividualChart();
                return;
              }
              
              const ctx = document.getElementById('aggregateChart').getContext('2d');
              
              // Clear any existing chart
              if (window.aggregateChartInstance) {
                window.aggregateChartInstance.destroy();
              }
              
              // Define colors for different groups
              const groupColors = [
                '#007bff', // Blue
                '#28a745', // Green
                '#dc3545', // Red
                '#ffc107', // Yellow
                '#6f42c1'  // Purple
              ];
              
              // Create dataset for each group
              const datasets = individualData.groups.map((group, index) => {
                const color = groupColors[index % groupColors.length];
                
                return {
                  label: group.groupName,
                  data: group.data.map(item => item.attendance),
                  borderColor: color,
                  backgroundColor: color + '20', // Add transparency for fill
                  fill: false,
                  tension: 0.4,
                  pointRadius: 3.5,
                  pointHoverRadius: 5
                };
              });
              
              // Create labels from weeks
              const labels = individualData.weeks.map(weekKey => {
                const date = new Date(weekKey);
                const sunday = new Date(date);
                sunday.setDate(sunday.getDate() - date.getDay()); // Get Sunday of the week
                
                return 'Week of ' + sunday.toLocaleDateString('en-US', { 
                  month: 'short', 
                  day: 'numeric',
                  year: 'numeric'
                });
              });
              
              // Calculate year boundaries for vertical lines (if showing all years)
              const yearBoundaries = [];
              if (showAllYears && individualData.weeks.length > 0) {
                let currentYear = null;
                individualData.weeks.forEach((weekKey, index) => {
                  const itemYear = new Date(weekKey).getFullYear();
                  if (currentYear !== null && itemYear !== currentYear) {
                    yearBoundaries.push(index);
                  }
                  currentYear = itemYear;
                });
              }
              
              // Get metric-specific labels
              const metricLabels = getMetricLabels(individualMetric);
              
              window.aggregateChartInstance = new Chart(ctx, {
                type: 'line',
                plugins: showAllYears && yearBoundaries.length > 0 ? [{
                  id: 'yearSeparators',
                  afterDraw: function(chart) {
                    const ctx = chart.ctx;
                    const chartArea = chart.chartArea;
                    
                    ctx.save();
                    ctx.strokeStyle = 'rgba(0, 0, 0, 0.2)';
                    ctx.lineWidth = 1;
                    ctx.setLineDash([5, 5]);
                    
                    yearBoundaries.forEach(boundaryIndex => {
                      const x = chart.scales.x.getPixelForValue(boundaryIndex);
                      ctx.beginPath();
                      ctx.moveTo(x, chartArea.top);
                      ctx.lineTo(x, chartArea.bottom);
                      ctx.stroke();
                    });
                    
                    ctx.restore();
                  }
                }] : [],
                data: {
                  labels: labels,
                  datasets: datasets
                },
                options: {
                  responsive: true,
                  maintainAspectRatio: false,
                  plugins: {
                    title: {
                      display: true,
                      text: 'Individual Group ' + metricLabels.subtitle.charAt(0).toUpperCase() + metricLabels.subtitle.slice(1) + ' Comparison' + (showAllYears ? ' - All Years' : ' - Current Year')
                    },
                    subtitle: {
                      display: true,
                      text: metricLabels.yAxis.toLowerCase() + ' for each selected group. Hover over data points for details.',
                      font: {
                        size: 12
                      },
                      color: '#666'
                    },
                    tooltip: {
                      callbacks: {
                        afterBody: function(context) {
                          const tooltipLines = [];
                          const weekKey = individualData.weeks[context[0].dataIndex];
                          tooltipLines.push('Week: ' + weekKey);
                          return tooltipLines;
                        }
                      }
                    }
                  },
                  scales: {
                    y: {
                      beginAtZero: true,
                      title: {
                        display: true,
                        text: metricLabels.yAxis
                      }
                    },
                    x: {
                      title: {
                        display: true,
                        text: 'Week'
                      },
                      ticks: {
                        maxRotation: 45,
                        minRotation: 45
                      }
                    }
                  }
                }
              });
            }

            // Add function to load and display aggregate data
            async function loadAggregateData(forceRefresh = false, groupTypesFilter = null, meetingDaysFilter = null, selectedGroupsFilter = null) {
              const chartLoading = document.getElementById('chartLoading');
              const chartCanvas = document.getElementById('aggregateChart');
              const showAllYears = document.getElementById('showAllYears').checked;
              
              // Preserve scroll position to prevent page jumping
              const currentScrollPosition = window.pageYOffset || document.documentElement.scrollTop;
              
              try {
                // Show loading indicator and hide chart
                if (chartLoading) {
                  chartLoading.style.display = 'flex';
                  if (showAllYears) {
                    chartLoading.innerHTML = '<div class="loading"></div><span>Loading historical data...</span>';
                  } else {
                    chartLoading.innerHTML = '<div class="loading"></div><span>Loading chart data...</span>';
                  }
                }
                if (chartCanvas) chartCanvas.style.display = 'none';
                
                // Hide chart group count info box while loading
                const chartGroupCountElement = document.getElementById('chartGroupCount');
                if (chartGroupCountElement) chartGroupCountElement.style.display = 'none';
                
                // Build query parameters
                const params = new URLSearchParams();
                if (forceRefresh) params.set('forceRefresh', 'true');
                if (showAllYears) params.set('showAll', 'true');
                if (selectedGroupsFilter) {
                  params.set('selectedGroups', selectedGroupsFilter);
                } else {
                if (groupTypesFilter && groupTypesFilter !== 'EMPTY') params.set('groupTypes', groupTypesFilter);
                if (meetingDaysFilter && meetingDaysFilter !== 'EMPTY') params.set('meetingDays', meetingDaysFilter);
                
                // Handle special case where we explicitly want empty results
                if (groupTypesFilter === 'EMPTY') params.set('groupTypes', '');
                if (meetingDaysFilter === 'EMPTY') params.set('meetingDays', '');
                }
                const queryString = params.toString();
                const url = '/api/aggregate-attendance' + (queryString ? '?' + queryString : '');
                
                // Add progress timer for long-running requests
                let progressInterval;
                if (showAllYears && chartLoading) {
                  const startTime = Date.now();
                  progressInterval = setInterval(() => {
                    const elapsed = Math.floor((Date.now() - startTime) / 1000);
                    const minutes = Math.floor(elapsed / 60);
                    const seconds = elapsed % 60;
                    const timeStr = \`\${minutes}:\${seconds.toString().padStart(2, '0')}\`;
                    chartLoading.innerHTML = \`<div class="loading"></div><span>Loading historical data... \${timeStr} elapsed, this may take several minutes</span>\`;
                  }, 1000);
                }
                
                // Add timeout for aggregate data request
                const controller = new AbortController();
                const timeoutMinutes = showAllYears ? 10 : 2; // 10 minutes for all years, 2 for current year
                const timeoutMs = timeoutMinutes * 60 * 1000;
                
                const timeoutId = setTimeout(() => {
                  console.error(\`Aggregate data request timed out after \${timeoutMinutes} minutes\`);
                  if (progressInterval) clearInterval(progressInterval);
                  controller.abort();
                }, timeoutMs);
                
                const response = await fetch(url, { signal: controller.signal });
                clearTimeout(timeoutId);
                if (progressInterval) clearInterval(progressInterval);
                
                if (!response.ok) {
                  const errorText = await response.text();
                  console.error('Aggregate data response error:', errorText);
                  throw new Error('Failed to fetch aggregate data: ' + response.status + ' ' + errorText);
                }
                
                const aggregateData = await response.json();
                
                // Update chart group count
                updateChartGroupCount(aggregateData);
                
                // Handle empty data case
                if (!aggregateData || aggregateData.length === 0) {
                  
                  // Clear any existing chart
                  if (window.aggregateChartInstance) {
                    window.aggregateChartInstance.destroy();
                  }
                  
                  // Show empty chart
                  const ctx = document.getElementById('aggregateChart').getContext('2d');
                  window.aggregateChartInstance = new Chart(ctx, {
                    type: 'line',
                    data: {
                      labels: [],
                      datasets: [
                        {
                          label: 'Visitors + Members',
                          data: [],
                          borderColor: '#28a745',
                          backgroundColor: 'rgba(40, 167, 69, 0.1)',
                          fill: true,
                          tension: 0.4
                        },
                        {
                          label: 'Members Present',
                          data: [],
                          borderColor: '#007bff',
                          backgroundColor: 'rgba(0, 123, 255, 0.1)',
                          fill: true,
                          tension: 0.4
                        },
                        {
                          label: 'Total Members',
                          data: [],
                          borderColor: '#6c757d',
                          backgroundColor: 'rgba(108, 117, 125, 0.1)',
                          fill: true,
                          tension: 0.4
                        }
                      ]
                    },
                    options: {
                      responsive: true,
                      maintainAspectRatio: false,
                      plugins: {
                        title: {
                          display: true,
                          text: 'Weekly Life Groups Attendance Trends (Wed-Thu Combined)' + (showAllYears ? ' - All Years' : ' - Current Year') + 
                                (selectedGroupsFilter ? ' - Selected Groups' : (groupTypesFilter && groupTypesFilter !== 'Family,Stage of Life,Location Based' || meetingDaysFilter && meetingDaysFilter !== 'Wednesday,Thursday' ? ' - Filtered' : ''))
                        },
                        subtitle: {
                          display: true,
                          text: 'No data available for the selected filters.',
                          font: {
                            size: 12
                          },
                          color: '#666'
                        }
                      },
                      scales: {
                        y: {
                          beginAtZero: true,
                          title: {
                            display: true,
                            text: 'Number of People'
                          }
                        },
                        x: {
                          title: {
                            display: true,
                            text: 'Week'
                          }
                        }
                      }
                    }
                  });
                  
                  return; // Exit early for empty data
                }
                
                const ctx = document.getElementById('aggregateChart').getContext('2d');
                
                // Clear any existing chart
                if (window.aggregateChartInstance) {
                  window.aggregateChartInstance.destroy();
                }
                
                // Calculate year boundaries for vertical lines
                const yearBoundaries = [];
                if (showAllYears && aggregateData.length > 0) {
                  let currentYear = null;
                  aggregateData.forEach((item, index) => {
                    const itemYear = new Date(item.date).getFullYear();
                    if (currentYear !== null && itemYear !== currentYear) {
                      yearBoundaries.push(index);
                    }
                    currentYear = itemYear;
                  });
                }

                window.aggregateChartInstance = new Chart(ctx, {
                  type: 'line',
                  data: {
                    labels: aggregateData.map(item => {
                      // Get the Sunday of the week
                      const date = new Date(item.date);
                      const sunday = new Date(date);
                      const day = sunday.getDay();
                      sunday.setDate(sunday.getDate() - day); // Go back to Sunday (0 days from Sunday, 3 from Wed, 4 from Thu)
                      
                      return 'Week of ' + sunday.toLocaleDateString('en-US', { 
                        month: 'short', 
                        day: 'numeric',
                        year: 'numeric'
                      });
                    }),
                    datasets: [
                      {
                        label: 'Visitors + Members',
                        data: aggregateData.map(item => item.totalWithVisitors),
                        borderColor: '#28a745',
                        backgroundColor: 'rgba(40, 167, 69, 0.1)',
                        fill: true,
                        tension: 0.4
                      },
                      {
                        label: 'Members Present',
                        data: aggregateData.map(item => item.totalPresent),
                        borderColor: '#007bff',
                        backgroundColor: 'rgba(0, 123, 255, 0.1)',
                        fill: true,
                        tension: 0.4
                      },
                      {
                        label: 'Total Members',
                        data: aggregateData.map(item => item.totalMembers),
                        borderColor: '#6c757d',
                        backgroundColor: 'rgba(108, 117, 125, 0.1)',
                        fill: true,
                        tension: 0.4
                      }
                    ]
                  },
                  plugins: [
                    // Perfect week indicators - green checkmarks
                    {
                      id: 'perfectWeekIndicators',
                      beforeDraw: function(chart) {
                        const ctx = chart.ctx;
                        const chartArea = chart.chartArea;
                        
                        // Check if the "Total Members" dataset is visible
                        const totalMembersDatasetIndex = 2; // "Total Members" is the 3rd dataset (index 2)
                        const totalMembersMeta = chart.getDatasetMeta(totalMembersDatasetIndex);
                        
                        // Only draw checkmarks if the Total Members dataset is visible
                        if (!totalMembersMeta.visible) {
                          return;
                        }
                        
                        ctx.save();
                        
                        // Set up text styling for checkmarks
                        ctx.fillStyle = '#28a745';
                        ctx.font = 'bold 14px Arial';
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        
                        // Draw green checkmarks above "Total Members" data points
                        aggregateData.forEach((item, index) => {
                          if (item.isPerfectWeek) {
                            if (totalMembersMeta.data[index] && totalMembersMeta.data[index].x >= chartArea.left && totalMembersMeta.data[index].x <= chartArea.right) {
                              const point = totalMembersMeta.data[index];
                              
                              // Draw checkmark above the data point
                              const checkX = point.x;
                              const checkY = point.y - 15;
                              
                              ctx.fillText('✓', checkX, checkY);
                            }
                          }
                        });
                        
                        ctx.restore();
                      }
                    },
                    // Year separators (if showing all years)
                    ...(showAllYears && yearBoundaries.length > 0 ? [{
                      id: 'yearSeparators',
                      afterDraw: function(chart) {
                        const ctx = chart.ctx;
                        const chartArea = chart.chartArea;
                        
                        ctx.save();
                        ctx.strokeStyle = 'rgba(0, 0, 0, 0.2)';
                        ctx.lineWidth = 1;
                        ctx.setLineDash([5, 5]);
                        
                        yearBoundaries.forEach(boundaryIndex => {
                          const x = chart.scales.x.getPixelForValue(boundaryIndex);
                          ctx.beginPath();
                          ctx.moveTo(x, chartArea.top);
                          ctx.lineTo(x, chartArea.bottom);
                          ctx.stroke();
                        });
                        
                        ctx.restore();
                      }
                    }] : [])
                  ],
                  options: {
                    responsive: true,
                    maintainAspectRatio: false,
                                      plugins: {
                    title: {
                      display: true,
                      text: 'Weekly Life Groups Attendance Trends (Wed-Thu Combined)' + (showAllYears ? ' - All Years' : ' - Current Year') + 
                            (selectedGroupsFilter ? ' - Selected Groups' : (groupTypesFilter && groupTypesFilter !== 'Family,Stage of Life,Location Based' || meetingDaysFilter && meetingDaysFilter !== 'Wednesday,Thursday' ? ' - Filtered' : ''))
                    },
                      subtitle: {
                        display: true,
                        text: 'Click a dataset color to exclude it from the chart. Hover over a data point to see more info. Data shows ' + (showAllYears ? 'all years' : 'current year') + ', past events only.' +
                              (selectedGroupsFilter ? ' (Selected groups only)' : (groupTypesFilter && groupTypesFilter !== 'Family,Stage of Life,Location Based' || meetingDaysFilter && meetingDaysFilter !== 'Wednesday,Thursday' ? ' (Filtered data)' : '')),
                        font: {
                          size: 12
                        },
                        color: '#666'
                      },
                      tooltip: {
                        callbacks: {
                          afterBody: function(context) {
                            const dataIndex = context[0].dataIndex;
                            const data = aggregateData[dataIndex];
                            
                            const groupsDataText = data.isPerfectWeek 
                              ? 'Groups with Data: ' + data.groupsWithData + '/' + data.totalGroupsWithEvents + ' ✅'
                              : 'Groups with Data: ' + data.groupsWithData + '/' + data.totalGroupsWithEvents;
                            
                            const tooltipLines = [
                              'Weekly Attendance Rate: ' + data.attendanceRate + '%',
                              'Members: ' + data.familyPresent + ' Family, ' + data.nonFamilyPresent + ' Regular (' + data.totalPresent + ' total)',
                              'Visitors: +' + data.familyVisitors + ' Family, +' + data.nonFamilyVisitors + ' Regular (+' + data.totalVisitors + ' total)',
                              'Total Attendance: ' + data.totalWithVisitors,
                              groupsDataText + ' | ' + data.daysIncluded + ' days (Wed/Thu)'
                            ];
                            
                            // Add groups missing data
                            if (data.groupsMissingData && data.groupsMissingData.length > 0) {
                              tooltipLines.push('');
                              tooltipLines.push('Groups missing data:');
                              data.groupsMissingData.forEach(name => {
                                tooltipLines.push('  • ' + name);
                              });
                            }
                            
                            // Add groups with cancelled events
                            if (data.groupsWithCancelledEvents && data.groupsWithCancelledEvents.length > 0) {
                              tooltipLines.push('');
                              tooltipLines.push('Groups with cancelled events:');
                              data.groupsWithCancelledEvents.forEach(name => {
                                tooltipLines.push('  • ' + name);
                              });
                            }
                            
                            return tooltipLines;
                          }
                        }
                      }
                    },
                    scales: {
                      y: {
                        beginAtZero: true,
                        title: {
                          display: true,
                          text: 'Number of People'
                        },
                        // Add extra headroom at the top for checkmarks
                        afterDataLimits: function(scale) {
                          // Add 10% extra space at the top, with a minimum of 20 units
                          const range = scale.max - scale.min;
                          const padding = Math.max(range * 0.1, 20);
                          scale.max = scale.max + padding;
                        }
                      },
                      x: {
                        title: {
                          display: true,
                          text: 'Week'
                        },
                        ticks: {
                          maxRotation: 45,
                          minRotation: 45
                        }
                      }
                    }
                  }
                });
              } catch (error) {
                console.error('Error loading aggregate data:', error);
                console.error('Error details:', {
                  message: error.message,
                  stack: error.stack,
                  name: error.name
                });
                
                // Clear any progress interval
                if (progressInterval) clearInterval(progressInterval);
                
                // Show error in the chart area
                if (chartLoading) {
                  if (error.name === 'AbortError') {
                    chartLoading.innerHTML = '<div style="color: red; text-align: center;"><strong>Request timed out</strong><br>Historical data loading took too long. The data may still be loading in the background - try toggling back to "Current Year" and then "Show All Years" again in a few minutes.</div>';
                  } else {
                    chartLoading.innerHTML = '<div style="color: red; text-align: center;"><strong>Error loading chart:</strong><br>' + error.message + '</div>';
                  }
                }
                
                // Restore scroll position even on error
                window.scrollTo(0, currentScrollPosition);
              } finally {
                // Hide loading indicator and show chart
                if (chartLoading) chartLoading.style.display = 'none';
                if (chartCanvas) chartCanvas.style.display = 'block';
                
                // Update date range indicator
                const dateRangeElement = document.getElementById('chartDateRange');
                if (dateRangeElement) {
                  dateRangeElement.textContent = 'Showing data from: ' + (showAllYears ? 'All years' : 'Current year');
                }
                
                // Restore scroll position to prevent page jumping
                window.scrollTo(0, currentScrollPosition);
              }
            }

            // Add event listener for the show all years toggle
            document.getElementById('showAllYears').addEventListener('change', async function() {
              const loadingMessage = document.getElementById('chartToggleLoadingMessage');
              if (loadingMessage) loadingMessage.style.display = 'flex';
              
              const showAllYears = this.checked;
              
              try {
                // Update chart data based on current mode
                if (chartDisplayMode === 'individual') {
                  // For individual mode, reload the individual group chart
                  const visibleGroupIds = new Set(currentlyVisibleGroups.map(g => g.id));
                  const selectedVisibleGroups = Array.from(selectedGroupIds).filter(id => visibleGroupIds.has(id));
                  await loadIndividualGroupChart(selectedVisibleGroups);
                } else {
                  // For combined mode, reload aggregate data
                const groupTypesParam = currentFilters.groupTypes.join(',');
                const meetingDaysParam = currentFilters.meetingDays.join(',');
                await loadAggregateData(false, groupTypesParam, meetingDaysParam);
                }
                
                // Update all group stats to reflect the new time period
                const groupItems = document.querySelectorAll('[id^="group-"]');
                
                // Show loading spinners for all groups first
                const groupIds = [];
                for (const groupItem of groupItems) {
                  const groupId = groupItem.id.replace('group-', '');
                  groupIds.push(groupId);
                  // Show loading spinner for this group's stats
                  const statsContainer = groupItem.querySelector('.stats-container');
                  if (statsContainer) {
                    statsContainer.innerHTML = '<div class="loading"></div>';
                  }
                }
                
                // Update all stats in parallel (much faster)
                await Promise.all(groupIds.map(groupId => 
                  updateGroupStats(groupId, showAllYears, false)
                ));
              } catch (error) {
                console.error('Error loading chart data:', error);
              } finally {
                if (loadingMessage) loadingMessage.style.display = 'none';
                // Update timestamp display based on current toggle state
                updateLastUpdateTime(showAllYears);
              }
            });



            // Function to setup membership toggle functionality
            function setupMembershipToggle() {
              // Main toggle for entire section
              const mainToggleBtn = document.getElementById('membershipMainToggleBtn');
              const mainToggleIcon = document.getElementById('membershipMainToggleIcon');
              const expandedContent = document.getElementById('membershipExpandedContent');
              
              // Main section toggle
              if (mainToggleBtn && mainToggleIcon && expandedContent) {
                mainToggleBtn.addEventListener('click', function() {
                  const isVisible = expandedContent.style.display === 'block';
                  
                  if (isVisible) {
                    expandedContent.style.display = 'none';
                    mainToggleIcon.textContent = '▼';
                    mainToggleBtn.style.borderBottomLeftRadius = '8px';
                    mainToggleBtn.style.borderBottomRightRadius = '8px';
                  } else {
                    expandedContent.style.display = 'block';
                    mainToggleIcon.textContent = '▲';
                    mainToggleBtn.style.borderBottomLeftRadius = '0';
                    mainToggleBtn.style.borderBottomRightRadius = '0';
                  }
                });
              }
            }

            // Function to load membership changes
            async function loadMembershipChanges() {
              const membershipChangesContainer = document.getElementById('membershipChangesContainer');
              const membershipQuickSummary = document.getElementById('membershipQuickSummary');
              const membershipDetails = document.getElementById('membershipDetails');
              
              try {
                const response = await fetch('/api/membership-changes?days=30');
                if (!response.ok) throw new Error('Failed to fetch membership changes');
                
                const data = await response.json();
                
                // Container is already shown in displayGroups(), just setup toggle functionality
                if (membershipChangesContainer) {
                  // Note: setupMembershipToggle() removed since membership changes moved to separate page
                }
                
                // Update quick summary in collapsed button
                if (membershipQuickSummary) {
                  const netChange = data.totalJoins - data.totalLeaves;
                  const netChangeText = netChange > 0 ? '+' + netChange : netChange.toString();
                  const netChangeColor = netChange > 0 ? '#007bff' : netChange < 0 ? '#fd7e14' : '#666';
                  
                  membershipQuickSummary.innerHTML = 
                    '<span><span style="color: #28a745; font-weight: 500;">+' + data.totalJoins + '</span> <span style="color: #666;">members joined</span></span>' +
                    '<span><span style="color: #dc3545; font-weight: 500;">-' + data.totalLeaves + '</span> <span style="color: #666;">members left</span></span>' +
                    '<span><span style="color: ' + netChangeColor + '; font-weight: bold;">' + netChangeText + '</span> <span style="color: #666;">net change</span></span>';
                }
                
                // Update details with comprehensive view including summary stats and member details
                if (membershipDetails) {
                  if (data.totalJoins === 0 && data.totalLeaves === 0) {
                    membershipDetails.innerHTML = '<div style="text-align: center; color: #666; font-style: italic; padding: 20px;">No membership changes in the last 30 days</div>';
                  } else {
                    // Generate comprehensive HTML with summary stats and member details
                    let timelineHtml = '<div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px;">';
                    
                    // Data source info at the top
                    const dataText = data.latestSnapshotDate ? 
                      'Data as of: ' + new Date(data.latestSnapshotDate).toLocaleDateString() : 
                      'No snapshot data available';
                    
                    timelineHtml += 
                      '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; padding-bottom: 15px; border-bottom: 1px solid #dee2e6;">' +
                        '<h3 style="margin: 0; color: #333; font-weight: 500;">Membership Changes (Last 30 Days)</h3>' +
                        '<div style="color: #666; font-size: 14px;">' + dataText + '</div>' +
                      '</div>';
                    
                    // Show summary stats
                    const netChange = data.totalJoins - data.totalLeaves;
                    const netChangeText = netChange > 0 ? '+' + netChange : netChange.toString();
                    const netChangeColor = netChange > 0 ? '#007bff' : netChange < 0 ? '#fd7e14' : '#666';
                    
                    timelineHtml += 
                      '<div style="display: flex; gap: 20px; margin-bottom: 25px; padding: 15px; background-color: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">' +
                        '<div style="display: flex; align-items: center; gap: 8px;">' +
                          '<span style="color: #28a745; font-weight: bold; font-size: 18px;">+' + data.totalJoins + '</span>' +
                          '<span style="color: #666; font-weight: 500;">joined</span>' +
                        '</div>' +
                        '<div style="display: flex; align-items: center; gap: 8px;">' +
                          '<span style="color: #dc3545; font-weight: bold; font-size: 18px;">-' + data.totalLeaves + '</span>' +
                          '<span style="color: #666; font-weight: 500;">left</span>' +
                        '</div>' +
                        '<div style="display: flex; align-items: center; gap: 8px;">' +
                          '<span style="color: ' + netChangeColor + '; font-weight: bold; font-size: 20px;">' + netChangeText + '</span>' +
                          '<span style="color: #666; font-weight: 500;">net</span>' +
                        '</div>' +
                      '</div>';
                    
                    // Show joins section
                    if (data.joins.length > 0) {
                      timelineHtml += 
                        '<div style="color: #666; font-size: 13px; margin-bottom: 15px; font-style: italic; padding-left: 4px; border-left: 2px solid #e9ecef;">' +
                          'Members are sorted by group name, then date (most recent first), then name alphabetically' +
                        '</div>' +
                        '<div style="margin-bottom: 25px;">' +
                          '<h4 style="margin: 0 0 15px 0; color: #28a745; font-weight: 500; display: flex; align-items: center; gap: 8px;">' +
                            '<span style="background-color: #28a745; color: white; border-radius: 50%; width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: bold;">+</span>' +
                            'Members Joined (' + data.joins.length + ')' +
                          '</h4>' +
                          '<div style="display: grid; gap: 8px;">';
                      
                      data.joins.forEach(member => {
                        // Use exact date from the membership change data
                        const formattedJoinDate = member.date ? 
                          new Date(member.date).toLocaleDateString('en-US') : 
                          'recent';
                        
                        timelineHtml += 
                          '<div style="padding: 8px 12px; background-color: rgba(40, 167, 69, 0.1); border-radius: 6px; border-left: 4px solid #28a745; display: flex; justify-content: space-between; align-items: center;">' +
                            '<div style="display: flex; align-items: center; gap: 8px;">' +
                              '<span style="font-weight: 500; color: #333;">' + member.firstName + ' ' + member.lastName + '</span>' +
                              '<span style="color: #666; font-size: 12px;">(' + formattedJoinDate + ')</span>' +
                            '</div>' +
                            '<span style="color: #666; font-size: 14px;">' + member.groupName + '</span>' +
                          '</div>';
                      });
                      
                      timelineHtml += '</div></div>';
                    }
                    
                    // Show leaves section
                    if (data.leaves.length > 0) {
                      timelineHtml += 
                        '<div style="margin-bottom: 20px;">' +
                          '<h4 style="margin: 0 0 15px 0; color: #dc3545; font-weight: 500; display: flex; align-items: center; gap: 8px;">' +
                            '<span style="background-color: #dc3545; color: white; border-radius: 50%; width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: bold;">-</span>' +
                            'Members Left (' + data.leaves.length + ')' +
                          '</h4>' +
                          '<div style="display: grid; gap: 8px;">';
                      
                      data.leaves.forEach(member => {
                        // Use exact date from the membership change data
                        const formattedLeaveDate = member.date ? 
                          new Date(member.date).toLocaleDateString('en-US') : 
                          'recent';
                        
                        timelineHtml += 
                          '<div style="padding: 8px 12px; background-color: rgba(220, 53, 69, 0.1); border-radius: 6px; border-left: 4px solid #dc3545; display: flex; justify-content: space-between; align-items: center;">' +
                            '<div style="display: flex; align-items: center; gap: 8px;">' +
                              '<span style="font-weight: 500; color: #333;">' + member.firstName + ' ' + member.lastName + '</span>' +
                              '<span style="color: #666; font-size: 12px;">(' + formattedLeaveDate + ')</span>' +
                            '</div>' +
                            '<span style="color: #666; font-size: 14px;">' + member.groupName + '</span>' +
                          '</div>';
                      });
                      
                      timelineHtml += '</div></div>';
                    }
                    
                    timelineHtml += '</div>';
                    membershipDetails.innerHTML = timelineHtml;
                  }
                }
              } catch (error) {
                console.error('Error loading membership changes:', error);
                if (membershipDetails) {
                  membershipDetails.innerHTML = '<div style="color: red;">Failed to load membership changes</div>';
                }
              }
            }



            // Setup membership list toggle functionality using event delegation
            document.addEventListener('click', function(event) {
              const button = event.target.closest('.membership-toggle');
              if (button) {
                const targetId = button.getAttribute('data-target');
                const listElement = document.getElementById(targetId);
                const iconElement = button.querySelector('.toggle-icon');
                
                if (listElement && iconElement) {
                  const isVisible = listElement.style.display === 'grid';
                  
                  if (isVisible) {
                    listElement.style.display = 'none';
                    iconElement.textContent = '▼';
                  } else {
                    listElement.style.display = 'grid';
                    iconElement.textContent = '▲';
                  }
                }
              }
            });

            // Check cache and load data when page loads
            checkCacheAndLoad();
            
            // Dark mode toggle functionality
            const darkModeToggle = document.getElementById('darkModeToggle');
            const body = document.body;
            
            // Check for saved dark mode preference or default to light mode
            const isDarkMode = localStorage.getItem('darkMode') === 'true';
            
            // Clean up temporary loading class and apply proper dark mode
            document.documentElement.classList.remove('dark-mode-loading');
            if (isDarkMode) {
              body.classList.add('dark-mode');
              darkModeToggle.innerHTML = '☀️ Light Mode';
            }
            
            // Toggle dark mode
            darkModeToggle.addEventListener('click', function() {
              body.classList.toggle('dark-mode');
              const isCurrentlyDark = body.classList.contains('dark-mode');
              
              // Update button text and icon
              if (isCurrentlyDark) {
                darkModeToggle.innerHTML = '☀️ Light Mode';
                localStorage.setItem('darkMode', 'true');
              } else {
                darkModeToggle.innerHTML = '🌙 Dark Mode';
                localStorage.setItem('darkMode', 'false');
              }
            });
          </script>
        </body>
      </html>
    `;
    
    res.send(html);
  } catch (error) {
    res.status(500).json({ error: 'Failed to load page' });
  }
});

// Dream Teams Roster Manager - Main dashboard
app.get('/dream-teams', async (req, res) => {
  try {
    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>QCC Hub - DTHR</title>
        <link rel="icon" type="image/x-icon" href="https://www.queencitypeople.com/favicon.ico">
        <style>
          body {
            font-family: Arial, sans-serif;
            margin: 20px;
            background-color: #f5f5f5;
            transition: background-color 0.3s ease;
          }
          
          /* Dark mode styles */
          body.dark-mode {
            background-color: #1a1a1a;
          }
          
          body.dark-mode .container {
            background-color: #2d2d2d;
            color: #ffffff;
          }
          
          body.dark-mode h1 {
            color: #ffffff;
          }
          
          body.dark-mode #lastUpdate {
            color: #e0e0e0;
          }
          
          body.dark-mode .header {
            border-bottom-color: #555;
          }
          
          body.dark-mode .team-card {
            background-color: #3d3d3d;
            color: #ffffff;
            border-color: #555;
          }
          
          body.dark-mode .team-card .star-button {
            color: #e0e0e0;
          }
          
          body.dark-mode .team-card .star-button.favorited {
            color: #ffc107;
            text-shadow: 0 0 3px rgba(0,0,0,0.4);
          }
          
          body.dark-mode .team-card.needs-review {
            border-left: 4px solid #ffc107;
          }
          
          body.dark-mode .team-card.old {
            border-left: 4px solid #dc3545;
          }
          
          body.dark-mode .team-card.fresh {
            border-left: 4px solid #28a745;
          }
          
          body.dark-mode .team-name {
            color: #ffffff;
          }
          
          body.dark-mode .member-count {
            background-color: #2d3436;
            color: #cccccc;
            border-color: #495057;
          }
          
          body.dark-mode .stat-value {
            color: #4fc3f7;
          }
          
          body.dark-mode .stat-label {
            color: #cccccc;
          }
          
          body.dark-mode .last-updated {
            color: #cccccc;
            border-top-color: #555;
          }
          
          body.dark-mode .loading {
            color: #cccccc;
          }
          
          body.dark-mode .error {
            background-color: #4a2c2a;
            border-color: #6a3634;
            color: #f5c6cb;
          }
          .container {
            max-width: 1200px;
            margin: 0 auto;
            background-color: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 30px;
            border-bottom: 2px solid #e9ecef;
            padding-bottom: 20px;
          }
          h1 {
            color: #333;
            margin-bottom: 20px;
          }
          #lastUpdate {
            margin: 10px 0;
            color: #666;
            font-size: 14px;
            display: none;
          }
          .back-button {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 10px 16px;
            background-color: #6c757d;
            color: white;
            text-decoration: none;
            border-radius: 4px;
            font-size: 14px;
            transition: background-color 0.3s ease;
          }
          .back-button:hover {
            background-color: #5a6268;
          }
          .refresh-button {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 10px 16px;
            background-color: #007bff;
            color: white;
            border: none;
            border-radius: 4px;
            font-size: 14px;
            cursor: pointer;
            transition: background-color 0.3s ease;
          }
          .refresh-button:hover {
            background-color: #0056b3;
          }
          .refresh-button:disabled {
            background-color: #007bff !important;
            cursor: not-allowed;
            opacity: 0.7;
          }
          .pending-removals-button {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 10px 16px;
            background-color: #ffc107;
            color: #212529;
            border: none;
            border-radius: 4px;
            font-size: 14px;
            text-decoration: none;
            cursor: pointer;
            transition: background-color 0.3s ease;
            font-weight: 500;
          }
          .pending-removals-button:hover {
            background-color: #e0a800;
            color: #212529;
            text-decoration: none;
          }
          #pendingRemovalsCount {
            background-color: rgba(33, 37, 41, 0.2);
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 600;
          }
          .loading {
            text-align: center;
            padding: 40px;
            color: #666;
          }
          .error {
            text-align: center;
            padding: 40px;
            color: #dc3545;
            background-color: #f8d7da;
            border: 1px solid #f5c6cb;
            border-radius: 8px;
            margin: 20px 0;
          }
          .teams-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
            gap: 20px;
            margin-top: 20px;
          }
          .team-card {
            border: 1px solid #e9ecef;
            border-radius: 8px;
            padding: 20px;
            background: white;
            transition: box-shadow 0.2s ease;
            cursor: pointer;
          }
          .team-card:hover {
            box-shadow: 0 4px 12px rgba(0,0,0,0.1);
          }
          .team-card .star-button {
            position: absolute;
            top: 15px;
            right: 15px;
            background: none;
            border: none;
            font-size: 24px;
            cursor: pointer;
            padding: 5px;
            line-height: 1;
            transition: transform 0.2s ease;
            z-index: 10;
          }
          .team-card .star-button:hover {
            transform: scale(1.2);
          }
          .team-card .star-button.favorited {
            color: #ffc107;
            text-shadow: 0 0 3px rgba(0,0,0,0.2);
          }
          .team-card {
            position: relative;
            display: flex;
            flex-direction: column;
          }
          .team-card > *:not(.star-button) {
            pointer-events: none;
          }
          .team-card.needs-review {
            border-left: 4px solid #ffc107;
          }
          .team-card.old {
            border-left: 4px solid #dc3545;
          }
          .team-card.fresh {
            border-left: 4px solid #28a745;
          }
          .team-name {
            font-size: 1.3em;
            font-weight: 600;
            color: #333;
            margin-bottom: 10px;
            display: flex;
            align-items: center;
            gap: 8px;
          }
          
          .member-count {
            background-color: #e9ecef;
            color: #495057;
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 0.75em;
            font-weight: 600;
            min-width: 24px;
            text-align: center;
            border: 1px solid #dee2e6;
          }
          .team-stats {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 15px;
            margin: 15px 0;
          }
          .stat {
            text-align: center;
          }
          .stat-value {
            font-size: 1.5em;
            font-weight: bold;
            color: #007bff;
          }
          .stat-label {
            font-size: 0.9em;
            color: #666;
            margin-top: 5px;
          }
          .last-updated {
            font-size: 0.9em;
            color: #666;
            margin-top: 15px;
            padding-top: 15px;
            border-top: 1px solid #e9ecef;
          }
          .status-indicator {
            display: inline-block;
            font-size: 22px;
            margin-right: 8px;
            font-weight: bold;
          }
          .status-fresh { color: #28a745; }
          .status-fresh::before { content: '✓'; }
          .status-needs-review { color: #ffc107; }
          .status-needs-review::before { content: '‼'; }
          .status-old { color: #dc3545; }
          .status-old::before { content: '✗'; }
          
          .dark-mode-toggle {
            position: absolute;
            top: 20px;
            right: 20px;
            background-color: #007bff;
            color: white;
            border: none;
            border-radius: 50px;
            padding: 8px 16px;
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.3s ease;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            z-index: 1000;
          }
          
          .dark-mode-toggle:hover {
            background-color: #0056b3;
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
          }
          
          body.dark-mode .dark-mode-toggle {
            background-color: #ffc107;
            color: #212529;
          }
          
          body.dark-mode .dark-mode-toggle:hover {
            background-color: #e0a800;
          }
          
          .stats-summary {
            margin: 20px 0;
            padding: 15px 20px;
            background-color: #f8f9fa;
            border-radius: 6px;
            border-left: 3px solid #007bff;
          }
          
          .stats-summary h2 {
            margin: 0 0 12px 0;
            color: #333;
            font-size: 1.2em;
            font-weight: 600;
          }
          
          .stats-grid {
            display: flex;
            gap: 15px;
            justify-content: space-around;
          }
          
          .stat-card {
            background-color: white;
            padding: 12px 16px;
            border-radius: 6px;
            text-align: center;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            transition: transform 0.2s ease;
            flex: 1;
            min-width: 0;
          }
          
          .stat-card:hover {
            transform: translateY(-1px);
          }
          
          .stat-card .stat-value {
            font-size: 1.8em;
            font-weight: bold;
            color: #007bff;
            margin-bottom: 4px;
          }
          
          .stat-card .stat-label {
            color: #666;
            font-size: 0.85em;
            font-weight: 500;
          }
          
          /* Dark mode styles for stats */
          body.dark-mode .stats-summary {
            background-color: #3d3d3d;
            border-left-color: #4fc3f7;
          }
          
          body.dark-mode .stats-summary h2 {
            color: #ffffff;
          }
          
          body.dark-mode .stat-card {
            background-color: #2d2d2d;
          }
          
          body.dark-mode .stat-card .stat-value {
            color: #4fc3f7;
          }
          
          body.dark-mode .stat-card .stat-label {
            color: #cccccc;
          }
        </style>
        <script>
          // Apply dark mode immediately to prevent flash
          if (localStorage.getItem('darkMode') === 'true') {
            document.documentElement.classList.add('dark-mode-loading');
          }
        </script>
        <style>
          /* Temporary class to apply dark mode before body loads */
          html.dark-mode-loading body {
            background-color: #1a1a1a !important;
          }
          html.dark-mode-loading .container {
            background-color: #2d2d2d !important;
            color: #ffffff !important;
          }
          html.dark-mode-loading h1 {
            color: #ffffff !important;
          }
          html.dark-mode-loading .team-card {
            background-color: #3d3d3d !important;
            color: #ffffff !important;
          }
          html.dark-mode-loading .team-card.needs-review {
            border-left: 4px solid #ffc107 !important;
          }
          html.dark-mode-loading .team-card.old {
            border-left: 4px solid #dc3545 !important;
          }
          html.dark-mode-loading .team-card.fresh {
            border-left: 4px solid #28a745 !important;
          }
          html.dark-mode-loading .team-name {
            color: #ffffff !important;
          }
          html.dark-mode-loading .stat-value {
            color: #4fc3f7 !important;
          }
          html.dark-mode-loading .stat-label {
            color: #cccccc !important;
          }
          
          html.dark-mode-loading .stats-summary {
            background-color: #3d3d3d !important;
            border-left-color: #4fc3f7 !important;
          }
          
          html.dark-mode-loading .stats-summary h2 {
            color: #ffffff !important;
          }
          
          html.dark-mode-loading .stat-card {
            background-color: #2d2d2d !important;
          }
          
          html.dark-mode-loading .stat-card .stat-value {
            color: #4fc3f7 !important;
          }
          
          html.dark-mode-loading .stat-card .stat-label {
            color: #cccccc !important;
          }
        </style>
      </head>
      <body>
        <button class="dark-mode-toggle" id="darkModeToggle">🌙 Dark Mode</button>
        <div class="container">
          <div class="header">
            <h1>Queen City Church - Dream Team Health Report</h1>
            <div class="header-buttons">
              <a href="/dream-teams/pending-removals" class="pending-removals-button">
                <span>View Pending Removals</span>
                <span id="pendingRemovalsCount" style="display: none;"></span>
              </a>
              <button id="refreshButton" class="refresh-button">
                <span>Refresh Data</span>
              </button>
            </div>
          </div>
          
          <p id="lastUpdate"></p>
          
          <div id="dreamTeamStats" class="stats-summary" style="display: none;">
            <h2>Dream Team Overview</h2>
            <div class="stats-grid">
              <div class="stat-card">
                <div class="stat-value" id="totalDreamTeamers">-</div>
                <div class="stat-label">Dream Teamers! 🎉</div>
              </div>
              <div class="stat-card">
                <div class="stat-value" id="inProgressCount">-</div>
                <div class="stat-label">In-Progress</div>
              </div>
              <div class="stat-card">
                <div class="stat-value" id="completedCount">-</div>
                <div class="stat-label">Completed</div>
              </div>
            </div>
          </div>
          
          <div id="loadingContainer" class="loading">
            <p>Loading dream teams data...</p>
          </div>
          
          <div id="errorContainer" class="error" style="display: none;">
            <p id="errorMessage">Failed to load teams data</p>
          </div>
          
          <div id="teamsContainer" class="teams-grid" style="display: none;">
            <!-- Teams will be loaded here -->
          </div>
        </div>

        <script>
          let teamsData = [];
          let favorites = new Set();

          // Load favorites from localStorage
          function loadFavorites() {
            try {
              const savedFavorites = localStorage.getItem('dreamTeamFavorites');
              if (savedFavorites) {
                favorites = new Set(JSON.parse(savedFavorites));
              }
            } catch (error) {
              console.error('Error loading favorites from localStorage:', error);
              favorites = new Set();
            }
          }

          // Save favorites to localStorage
          function saveFavorites() {
            try {
              localStorage.setItem('dreamTeamFavorites', JSON.stringify([...favorites]));
            } catch (error) {
              console.error('Error saving favorites to localStorage:', error);
            }
          }

          function toggleFavorite(event, teamId, teamName) {
            event.stopPropagation(); // Prevent opening the team page
            
            const button = event.target;
            const isFavorited = favorites.has(teamId);
            
            if (isFavorited) {
              favorites.delete(teamId);
            } else {
              favorites.add(teamId);
            }
            
            // Update UI
            button.classList.toggle('favorited', !isFavorited);
            button.textContent = !isFavorited ? '★' : '☆';
            
            // Save to localStorage
            saveFavorites();
            
            // Re-sort teams to move favorites to top
            displayTeams();
          }

          // Format timestamp for display
          function formatLastUpdateTime(timestamp) {
            if (!timestamp) return '';
            const date = new Date(timestamp);
            return date.toLocaleString('en-US', { 
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              year: 'numeric',
              hour: 'numeric',
              minute: 'numeric',
              hour12: true
            });
          }

          // Update the last update time display
          async function updateLastUpdateTime() {
            try {
              const response = await fetch('/api/dream-teams/cache-info');
              if (!response.ok) throw new Error('Failed to fetch cache info');
              const { timestamp } = await response.json();
              const lastUpdate = document.getElementById('lastUpdate');
              if (timestamp) {
                lastUpdate.textContent = 'Last updated: ' + formatLastUpdateTime(timestamp);
                lastUpdate.style.display = 'block';
              }
            } catch (error) {
              console.error('Error fetching cache info:', error);
            }
          }

          async function loadTeams(forceRefresh = false) {
            const loadingContainer = document.getElementById('loadingContainer');
            const errorContainer = document.getElementById('errorContainer');
            const teamsContainer = document.getElementById('teamsContainer');
            const dreamTeamStats = document.getElementById('dreamTeamStats');
            const refreshButton = document.getElementById('refreshButton');

            // Show loading state
            loadingContainer.style.display = 'block';
            errorContainer.style.display = 'none';
            teamsContainer.style.display = 'none';
            dreamTeamStats.style.display = 'none';
            refreshButton.disabled = true;

            try {
              const response = await fetch(\`/api/dream-teams?forceRefresh=\${forceRefresh}\`);
              const result = await response.json();

              if (!result.success) {
                throw new Error(result.error || 'Failed to fetch teams');
              }

              teamsData = result.data;
              
              // Load favorites from localStorage
              loadFavorites();
              displayTeams();

              // Hide loading, show teams
              loadingContainer.style.display = 'none';
              teamsContainer.style.display = 'grid';
              
              // Calculate and display Dream Team statistics
              calculateDreamTeamStats();
              
              // Update the last update timestamp
              updateLastUpdateTime();

            } catch (error) {
              console.error('Error loading teams:', error);
              document.getElementById('errorMessage').textContent = error.message;
              loadingContainer.style.display = 'none';
              errorContainer.style.display = 'block';
            } finally {
              refreshButton.disabled = false;
            }
          }

          function calculateDreamTeamStats() {
            if (teamsData.length === 0) return;
            
            const uniquePeople = new Map(); // personId -> { status, teams }
            let totalInProgress = 0;
            let totalCompleted = 0;
            let totalPendingRemovals = 0;
            
            // Process each team's roster
            teamsData.forEach(team => {
              // Count pending removals across all teams
              if (team.pendingRemovals) {
                totalPendingRemovals += team.pendingRemovals;
              }
              
              if (team.roster && team.roster.length > 0) {
                team.roster.forEach(member => {
                  const personId = member.personId;
                  const status = member.stage;
                  
                  if (!uniquePeople.has(personId)) {
                    uniquePeople.set(personId, {
                      statuses: new Set(),
                      teams: new Set()
                    });
                  }
                  
                  const person = uniquePeople.get(personId);
                  person.statuses.add(status);
                  person.teams.add(team.name);
                });
              }
            });
            
            // Count unique people and determine their final status
            uniquePeople.forEach((person, personId) => {
              // If someone is both in-progress and completed, prioritize completed
              if (person.statuses.has('completed')) {
                totalCompleted++;
              } else if (person.statuses.has('in_process') || person.statuses.has('ready')) {
                totalInProgress++;
              }
              // Note: We're excluding 'removed' status as per requirements
            });
            
            const totalDreamTeamers = totalInProgress + totalCompleted;
            
            // Update the UI
            document.getElementById('totalDreamTeamers').textContent = totalDreamTeamers;
            document.getElementById('inProgressCount').textContent = totalInProgress;
            document.getElementById('completedCount').textContent = totalCompleted;
            
            // Update pending removals count on button
            const pendingRemovalsCountSpan = document.getElementById('pendingRemovalsCount');
            if (totalPendingRemovals > 0) {
              pendingRemovalsCountSpan.textContent = totalPendingRemovals;
              pendingRemovalsCountSpan.style.display = 'inline';
            } else {
              pendingRemovalsCountSpan.style.display = 'none';
            }
            
            // Show the stats section
            document.getElementById('dreamTeamStats').style.display = 'block';
          }

          function displayTeams() {
            const container = document.getElementById('teamsContainer');
            
            if (teamsData.length === 0) {
              container.innerHTML = '<p style="text-align: center; color: #666; grid-column: 1 / -1;">No dream teams found</p>';
              return;
            }

            // Sort teams: favorites first, then by status and name
            const sortedTeams = [...teamsData].sort((a, b) => {
              const aFavorited = favorites.has(a.id);
              const bFavorited = favorites.has(b.id);
              
              // First sort by favorite status
              if (aFavorited && !bFavorited) return -1;
              if (!aFavorited && bFavorited) return 1;
              
              // Then by name
              return a.name.localeCompare(b.name);
            });

            container.innerHTML = sortedTeams.map(team => {
              // Determine status based on actual review data
              let statusClass = 'old';
              let statusText = 'Never reviewed';
              
              if (team.lastReviewed) {
                // Parse the review date (YYYY-MM-DD format)
                const dateParts = team.lastReviewed.split('-');
                const lastReviewed = new Date(parseInt(dateParts[0]), parseInt(dateParts[1]) - 1, parseInt(dateParts[2]));
                const now = new Date();
                
                // Calculate the next 15th after the review date
                let next15th = new Date(lastReviewed.getFullYear(), lastReviewed.getMonth(), 15);
                
                // If the review date is on or after the 15th of that month, move to the 15th of next month
                if (lastReviewed.getDate() >= 15) {
                  next15th = new Date(lastReviewed.getFullYear(), lastReviewed.getMonth() + 1, 15);
                }
                
                // Compare today with the next 15th
                if (now < next15th) {
                  // Still green - before the next 15th
                  statusClass = 'fresh';
                  statusText = 'Recently reviewed';
                } else {
                  // Turn red - on or after the next 15th
                  statusClass = 'old';
                  statusText = 'Needs review';
                }
              }
              
              // Show pending removals if any
              if (team.pendingRemovals > 0) {
                statusText += ' (' + team.pendingRemovals + ' pending)';
              }

              // Check if team is favorited
              const isFavorited = favorites.has(team.id);

              return \`
                <div class="team-card \${statusClass}" data-team-id="\${team.id}" data-team-name="\${team.name}" onclick="openTeam('\${team.id}', '\${team.name}')">
                  <button style="font-size: 32px;" class="star-button \${isFavorited ? 'favorited' : ''}" onclick="toggleFavorite(event, '\${team.id}', '\${team.name}')">
                    \${isFavorited ? '★' : '☆'}
                  </button>
                  <div class="team-name">
                    <span class="status-indicator status-\${statusClass}"></span>
                    \${team.name}
                    <span class="member-count">\${team.roster.length}</span>
                  </div>
                  
                  <div class="team-stats">
                    <div class="stat">
                      <div class="stat-value">\${team.readyCards}</div>
                      <div class="stat-label">In-Progress</div>
                    </div>
                    <div class="stat">
                      <div class="stat-value">\${team.completedCards}</div>
                      <div class="stat-label">Completed</div>
                    </div>
                  </div>
                  
                  <div class="last-updated">
                    <strong>Status:</strong> \${statusText}<br>
                    <strong>Last Reviewed:</strong> \${team.lastReviewed ? (() => {
                      const dateParts = team.lastReviewed.split('-');
                      const localDate = new Date(parseInt(dateParts[0]), parseInt(dateParts[1]) - 1, parseInt(dateParts[2]));
                      return localDate.toLocaleDateString();
                    })() : 'Never'}
                    \${team.lastReviewer ? '<br><strong>Reviewed by:</strong> ' + team.lastReviewer : ''}
                  </div>
                </div>
              \`;
            }).join('');
          }

          function openTeam(teamId, teamName) {
            window.location.href = \`/dream-teams/\${teamId}\`;
          }

          // Event listeners
          document.getElementById('refreshButton').addEventListener('click', () => {
            loadTeams(true);
          });

          // Load teams on page load
          loadTeams();
          
          // Dark mode toggle functionality
          const darkModeToggle = document.getElementById('darkModeToggle');
          const body = document.body;
          
          // Check for saved dark mode preference or default to light mode
          const isDarkMode = localStorage.getItem('darkMode') === 'true';
          
          // Clean up temporary loading class and apply proper dark mode
          document.documentElement.classList.remove('dark-mode-loading');
          if (isDarkMode) {
            body.classList.add('dark-mode');
            darkModeToggle.innerHTML = '☀️ Light Mode';
            // Update group link colors
            document.querySelectorAll('.group-item a').forEach(link => {
              link.style.color = '#87ceeb';
            });
          }
          
          // Toggle dark mode
          darkModeToggle.addEventListener('click', function() {
            body.classList.toggle('dark-mode');
            const isCurrentlyDark = body.classList.contains('dark-mode');
            
            // Update button text and icon
            if (isCurrentlyDark) {
              darkModeToggle.innerHTML = '☀️ Light Mode';
              localStorage.setItem('darkMode', 'true');
            } else {
              darkModeToggle.innerHTML = '🌙 Dark Mode';
              localStorage.setItem('darkMode', 'false');
            }

            // Update group link colors
            document.querySelectorAll('.group-item a').forEach(link => {
              link.style.color = isCurrentlyDark ? '#87ceeb' : '#007bff';
            });
          });
        </script>
      </body>
      </html>
    `;
    
    res.send(html);
  } catch (error) {
    console.error('Error rendering dream teams page:', error);
    res.status(500).send('Error loading page');
  }
});

// Individual Dream Team roster management page
// Dream Teamer Email Export Page (only enabled when ENABLE_EMAIL_EXPORT=true)
app.get('/dream-teams/export-emails', async (req, res) => {
  // Check if email export is enabled via environment variable
  if (process.env.ENABLE_EMAIL_EXPORT !== 'true') {
    return res.status(404).send('Not Found');
  }
  
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>QCC Hub - DTHR - Email Export</title>
      <link rel="icon" type="image/x-icon" href="https://www.queencitypeople.com/favicon.ico">
      <style>
        body {
          font-family: Arial, sans-serif;
          margin: 20px;
          background-color: #f5f5f5;
          transition: background-color 0.3s ease;
        }
        
        .container {
          max-width: 1200px;
          margin: 0 auto;
          padding: 20px;
          background-color: white;
          border-radius: 10px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        
        .header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 30px;
          padding-bottom: 20px;
          border-bottom: 2px solid #e9ecef;
        }
        
        h1 {
          color: #333;
          margin: 0;
          font-size: 1.8em;
        }
        
        .back-button {
          background-color: #6c757d;
          color: white;
          border: none;
          padding: 10px 20px;
          border-radius: 6px;
          text-decoration: none;
          font-size: 14px;
          cursor: pointer;
          transition: background-color 0.3s ease;
        }
        
        .back-button:hover {
          background-color: #5a6268;
        }
        
        .load-button {
          background-color: #007bff;
          color: white;
          border: none;
          padding: 12px 24px;
          border-radius: 6px;
          font-size: 16px;
          cursor: pointer;
          transition: background-color 0.3s ease;
        }
        
        .load-button:hover {
          background-color: #0056b3;
        }
        
        .load-button:disabled {
          background-color: #6c757d;
          cursor: not-allowed;
        }
        
        .loading {
          text-align: center;
          padding: 40px;
          color: #666;
        }
        
        .error {
          background-color: #f8d7da;
          border: 1px solid #f5c6cb;
          color: #721c24;
          padding: 15px;
          border-radius: 6px;
          margin-bottom: 20px;
        }
        
        .summary {
          background-color: #d1ecf1;
          border: 1px solid #bee5eb;
          border-radius: 6px;
          padding: 15px;
          margin-bottom: 20px;
        }
        
        .summary h3 {
          margin: 0 0 10px 0;
          color: #0c5460;
        }
        
        .copy-buttons {
          display: flex;
          gap: 10px;
          margin: 20px 0;
        }
        
        .copy-btn {
          padding: 10px 20px;
          background-color: #28a745;
          color: white;
          border: none;
          border-radius: 6px;
          cursor: pointer;
          font-size: 14px;
          transition: background-color 0.3s ease;
        }
        
        .copy-btn:hover {
          background-color: #218838;
        }
        
        .copy-btn.copied {
          background-color: #17a2b8;
        }
        
        .email-list {
          background-color: #f8f9fa;
          border: 1px solid #dee2e6;
          border-radius: 6px;
          padding: 15px;
          margin: 20px 0;
        }
        
        .person-item {
          padding: 12px;
          border-bottom: 1px solid #e9ecef;
          display: grid;
          grid-template-columns: 200px 1fr 300px;
          gap: 15px;
          align-items: center;
        }
        
        .person-item:last-child {
          border-bottom: none;
        }
        
        .person-name {
          font-weight: 600;
          color: #333;
        }
        
        .person-emails {
          color: #007bff;
          font-size: 0.9em;
        }
        
        .person-teams {
          color: #666;
          font-size: 0.85em;
        }
        
        @media (max-width: 768px) {
          .person-item {
            grid-template-columns: 1fr;
            gap: 8px;
          }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Dream Teamer Email Export</h1>
          <a href="/dream-teams" class="back-button">
            <span><strong>⟵</strong></span>
            <span>Back to Teams</span>
          </a>
        </div>
        
        <div id="initialState">
          <p>Click the button below to load all Dream Teamer email addresses. This may take a moment as it fetches data from Planning Center.</p>
          <button id="loadButton" class="load-button">Load Email Addresses</button>
        </div>
        
        <div id="loadingMessage" class="loading" style="display: none;">
          Loading email addresses... This may take a minute.
        </div>
        
        <div id="errorMessage" class="error" style="display: none;"></div>
        
        <div id="resultsContainer" style="display: none;">
          <div class="summary">
            <h3>Export Summary</h3>
            <p id="summaryText"></p>
          </div>
          
          <div class="copy-buttons">
            <button class="copy-btn" id="copyEmailsBtn">Copy All Emails (Comma Separated)</button>
            <button class="copy-btn" id="copyListBtn">Copy Full List</button>
          </div>
          
          <div class="email-list" id="emailList">
            <!-- Email list will be populated here -->
          </div>
        </div>
      </div>

      <script>
        let emailData = [];

        document.getElementById('loadButton').addEventListener('click', async () => {
          const loadButton = document.getElementById('loadButton');
          const initialState = document.getElementById('initialState');
          const loadingMessage = document.getElementById('loadingMessage');
          const errorMessage = document.getElementById('errorMessage');
          const resultsContainer = document.getElementById('resultsContainer');
          
          try {
            loadButton.disabled = true;
            initialState.style.display = 'none';
            loadingMessage.style.display = 'block';
            errorMessage.style.display = 'none';
            resultsContainer.style.display = 'none';
            
            const response = await fetch('/api/dream-teams/export-emails?forceRefresh=true');
            const result = await response.json();
            
            if (!result.success) {
              throw new Error(result.error || 'Failed to fetch email addresses');
            }
            
            emailData = result.data.dreamTeamers;
            displayResults();
            
            loadingMessage.style.display = 'none';
            resultsContainer.style.display = 'block';
            
          } catch (error) {
            console.error('Error loading emails:', error);
            errorMessage.textContent = 'Error: ' + error.message;
            errorMessage.style.display = 'block';
            loadingMessage.style.display = 'none';
            initialState.style.display = 'block';
            loadButton.disabled = false;
          }
        });

        function displayResults() {
          const summaryText = document.getElementById('summaryText');
          const emailList = document.getElementById('emailList');
          
          const totalPeople = emailData.length;
          const peopleWithEmails = emailData.filter(p => p.emails.length > 0).length;
          const totalEmails = emailData.reduce((sum, p) => sum + p.emails.length, 0);
          
          summaryText.textContent = \`Found \${totalPeople} Dream Teamers with \${totalEmails} total email addresses. \${peopleWithEmails} people have at least one email.\`;
          
          emailList.innerHTML = emailData.map(person => {
            const emailsDisplay = person.emails.length > 0 
              ? person.emails.join(', ') 
              : '<em>No email on file</em>';
            const teamsDisplay = person.teams.join(', ');
            
            return \`
              <div class="person-item">
                <div class="person-name">\${person.firstName} \${person.lastName}</div>
                <div class="person-emails">\${emailsDisplay}</div>
                <div class="person-teams">\${teamsDisplay}</div>
              </div>
            \`;
          }).join('');
        }

        document.getElementById('copyEmailsBtn').addEventListener('click', async () => {
          const allEmails = emailData
            .flatMap(p => p.emails)
            .filter(email => email)
            .join(', ');
          
          try {
            await navigator.clipboard.writeText(allEmails);
            const btn = document.getElementById('copyEmailsBtn');
            const originalText = btn.textContent;
            btn.textContent = '✓ Copied!';
            btn.classList.add('copied');
            
            setTimeout(() => {
              btn.textContent = originalText;
              btn.classList.remove('copied');
            }, 2000);
          } catch (err) {
            alert('Failed to copy to clipboard');
          }
        });

        document.getElementById('copyListBtn').addEventListener('click', async () => {
          const fullList = emailData.map(person => {
            const emails = person.emails.join(', ') || 'No email';
            return \`\${person.firstName} \${person.lastName} - \${emails} - Teams: \${person.teams.join(', ')}\`;
          }).join('\\n');
          
          try {
            await navigator.clipboard.writeText(fullList);
            const btn = document.getElementById('copyListBtn');
            const originalText = btn.textContent;
            btn.textContent = '✓ Copied!';
            btn.classList.add('copied');
            
            setTimeout(() => {
              btn.textContent = originalText;
              btn.classList.remove('copied');
            }, 2000);
          } catch (err) {
            alert('Failed to copy to clipboard');
          }
        });
      </script>
    </body>
    </html>
  `);
});

// Pending removals page (for admin review)
app.get('/dream-teams/pending-removals', async (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>QCC Hub - DTHR - Pending Removals</title>
      <link rel="icon" type="image/x-icon" href="https://www.queencitypeople.com/favicon.ico">
      <style>
        body {
          font-family: Arial, sans-serif;
          margin: 20px;
          background-color: #f5f5f5;
          transition: background-color 0.3s ease;
        }
        
        /* Dark mode styles */
        body.dark-mode {
          background-color: #1a1a1a;
          color: #ffffff;
        }
        
        body.dark-mode .container {
          background-color: #2d2d2d;
          color: #ffffff;
        }
        
        body.dark-mode h1 {
          color: #ffffff;
        }
        
        body.dark-mode .header {
          border-bottom-color: #555;
        }
        
        body.dark-mode .back-button {
          background-color: #495057;
          color: #ffffff;
        }
        
        body.dark-mode .back-button:hover {
          background-color: #6c757d;
        }
        
        body.dark-mode .summary {
          background-color: #0c3544;
          border-color: #1d6f7e;
          color: #b8daff;
        }
        
        body.dark-mode .summary h3 {
          color: #b8daff;
        }
        
        body.dark-mode .summary p {
          color: #b8daff;
        }
        
        body.dark-mode .team-section {
          border-color: #555;
        }
        
        body.dark-mode .team-header {
          background-color: #3d3d3d;
          color: #ffffff;
          border-color: #ffc107;
        }
        
        body.dark-mode .pco-link {
          color: #4fc3f7;
        }
        
        body.dark-mode .pco-link:hover {
          color: #81d4fa;
        }
        
        body.dark-mode .removal-item {
          border-bottom-color: #555;
        }
        
        body.dark-mode .member-name {
          color: #ffffff;
        }
        
        body.dark-mode .removal-details {
          color: #cccccc;
        }
        
        body.dark-mode .removal-date {
          color: #cccccc;
        }
        
        body.dark-mode .reviewer-name {
          color: #cccccc;
        }
        
        
        body.dark-mode .empty-state {
          color: #cccccc;
        }
        
        body.dark-mode .empty-state h3 {
          color: #4caf50;
        }
        
        body.dark-mode .loading {
          color: #cccccc;
        }
        
        body.dark-mode .error {
          background-color: #721c24;
          border-color: #a94442;
          color: #f8d7da;
        }
        
        /* FOUC Prevention - Temporary loading styles */
        html.dark-mode-loading {
          background-color: #1a1a1a !important;
        }
        
        html.dark-mode-loading body {
          background-color: #1a1a1a !important;
          color: #ffffff !important;
        }
        
        html.dark-mode-loading .container {
          background-color: #2d2d2d !important;
          color: #ffffff !important;
        }
        
        html.dark-mode-loading h1 {
          color: #ffffff !important;
        }
        .container {
          max-width: 1200px;
          margin: 0 auto;
          padding: 20px;
          background-color: white;
          border-radius: 10px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 30px;
          padding-bottom: 20px;
          border-bottom: 2px solid #e9ecef;
        }
        .header-buttons {
          display: flex;
          gap: 15px;
          align-items: center;
        }
        h1 {
          color: #333;
          margin: 0;
          font-size: 1.8em;
        }
        .back-button {
          background-color: #6c757d;
          color: white;
          border: none;
          padding: 10px 16px;
          border-radius: 4px;
          text-decoration: none;
          font-size: 14px;
          cursor: pointer;
          transition: background-color 0.3s ease;
        }
        .back-button:hover {
          background-color: #5a6268;
        }
        .refresh-button {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 10px 16px;
          background-color: #007bff;
          color: white;
          border: none;
          border-radius: 4px;
          font-size: 14px;
          cursor: pointer;
          transition: background-color 0.3s ease;
        }
        .refresh-button:hover {
          background-color: #0056b3;
        }
        .admin-tools-button {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 10px 16px;
          background-color: #6f42c1;
          color: white;
          border: none;
          border-radius: 4px;
          font-size: 14px;
          cursor: pointer;
          text-decoration: none;
          transition: background-color 0.3s ease;
        }
        .admin-tools-button:hover {
          background-color: #5a32a3;
        }
        .refresh-button:disabled {
          background-color: #007bff !important;
          cursor: not-allowed;
          opacity: 0.7;
        }
        .summary {
          background-color: #d1ecf1;
          border: 1px solid #bee5eb;
          border-radius: 6px;
          padding: 15px;
          margin-bottom: 30px;
        }
        .summary h3 {
          margin: 0 0 10px 0;
          color: #0c5460;
        }
        .summary p {
          margin: 0;
          color: #0c5460;
        }
        .removals-list {
          display: grid;
          gap: 20px;
        }
        .team-section {
          border: 1px solid #dee2e6;
          border-radius: 8px;
          overflow: hidden;
        }
        .team-header {
          background-color: transparent;
          color: #333;
          border: 5px solid #ffc107;
          padding: 15px 20px;
          font-weight: 600;
          font-size: 1.1em;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 15px;
        }
        .team-header-title {
          flex: 1;
        }
        .pco-link {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          color: #007bff;
          text-decoration: none;
          font-size: 0.85em;
          font-weight: 500;
          white-space: nowrap;
        }
        .pco-link:hover {
          color: #0056b3;
          text-decoration: underline;
        }
        .removal-item {
          padding: 15px 20px;
          border-bottom: 1px solid #f1f1f1;
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 20px;
        }
        .removal-item:last-child {
          border-bottom: none;
        }
        .member-info {
          flex: 1;
        }
        .member-name {
          font-weight: 600;
          color: #333;
          margin-bottom: 5px;
        }
        .removal-details {
          color: #666;
          font-size: 0.9em;
          line-height: 1.4;
        }
        .removal-date {
          color: #666;
          font-size: 0.9em;
          line-height: 1.4;
        }
        .reviewer-name {
          color: #666;
          font-size: 0.85em;
          font-weight: 500;
          margin-top: 4px;
        }

        .empty-state {
          text-align: center;
          padding: 60px 20px;
          color: #666;
        }
        .empty-state h3 {
          color: #28a745;
          margin-bottom: 10px;
        }
        .loading {
          text-align: center;
          padding: 40px;
          color: #666;
        }
        .error {
          background-color: #f8d7da;
          border: 1px solid #f5c6cb;
          color: #721c24;
          padding: 15px;
          border-radius: 6px;
          margin-bottom: 20px;
        }
        #lastUpdate {
          margin: 10px 0;
          color: #666;
          font-size: 14px;
          display: none;
        }
        body.dark-mode #lastUpdate {
          color: #e0e0e0;
        }
      </style>
      <script>
        // Apply dark mode immediately to prevent flash
        if (localStorage.getItem('darkMode') === 'true') {
          document.documentElement.classList.add('dark-mode-loading');
        }
      </script>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Pending Dream Team Removals</h1>
          <div class="header-buttons">
            <button id="refreshButton" class="refresh-button">
              <span>Refresh Data</span>
            </button>
            <a href="/dream-teams/admin-tools" class="admin-tools-button">
              <span>Admin Tools</span>
            </a>
            <a href="/dream-teams" class="back-button">
              <span><strong>⟵</strong></span>
              <span>Back to Teams</span>
            </a>
          </div>
        </div>
        
        <p id="lastUpdate"></p>
        
        <div id="summary" class="summary" style="display: none;">
          <h3>Removal Summary</h3>
          <p id="summaryText">Loading...</p>
        </div>
        
        <div id="errorMessage" class="error" style="display: none;"></div>
        <div id="loadingMessage" class="loading">Loading dream teams data...</div>
        <div id="removalsList" class="removals-list"></div>
      </div>

      <script>
        let pendingRemovalsData = [];

        // Format timestamp for display
        function formatLastUpdateTime(timestamp) {
          if (!timestamp) return '';
          const date = new Date(timestamp);
          return date.toLocaleString('en-US', { 
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            hour12: true
          });
        }

        // Update the last update time display
        async function updateLastUpdateTime() {
          try {
            const response = await fetch('/api/dream-teams/cache-info');
            if (!response.ok) throw new Error('Failed to fetch cache info');
            const { timestamp } = await response.json();
            const lastUpdate = document.getElementById('lastUpdate');
            if (timestamp) {
              lastUpdate.textContent = 'Last updated: ' + formatLastUpdateTime(timestamp);
              lastUpdate.style.display = 'block';
            }
          } catch (error) {
            console.error('Error fetching cache info:', error);
          }
        }

        // Dark mode functionality
        document.addEventListener('DOMContentLoaded', function() {
          // Remove temporary dark mode loading class
          document.documentElement.classList.remove('dark-mode-loading');
          
          // Initialize dark mode state from localStorage
          const isDarkMode = localStorage.getItem('darkMode') === 'true';
          
          if (isDarkMode) {
            document.body.classList.add('dark-mode');
          }
        });

        async function loadPendingRemovals(forceRefresh = false) {
          const loadingMessage = document.getElementById('loadingMessage');
          const refreshButton = document.getElementById('refreshButton');
          const errorMessage = document.getElementById('errorMessage');
          const removalsList = document.getElementById('removalsList');
          const summary = document.getElementById('summary');
          
          try {
            // Show loading state
            loadingMessage.style.display = 'block';
            errorMessage.style.display = 'none';
            removalsList.style.display = 'none';
            summary.style.display = 'none';
            refreshButton.disabled = true;
            
            const response = await fetch('/api/dream-teams/pending-removals?forceRefresh=' + forceRefresh);
            const result = await response.json();
            
            if (result.success) {
              pendingRemovalsData = result.data.pendingRemovals;
              displayPendingRemovals(pendingRemovalsData);
              updateSummary(result.data.totalCount);
              removalsList.style.display = 'grid';
              
              // Update the last update timestamp
              updateLastUpdateTime();
            } else {
              showError('Failed to load pending removals: ' + result.error);
            }
          } catch (error) {
            console.error('Error loading pending removals:', error);
            showError('Failed to load pending removals. Please try again.');
          } finally {
            loadingMessage.style.display = 'none';
            refreshButton.disabled = false;
          }
        }

        function displayPendingRemovals(removals) {
          const removalsList = document.getElementById('removalsList');
          
          if (removals.length === 0) {
            removalsList.innerHTML = 
              '<div class="empty-state">' +
                '<h3>🎉 All caught up!</h3>' +
                '<p>No pending removals at this time.</p>' +
              '</div>';
            return;
          }

          // Group removals by team
          const groupedRemovals = {};
          removals.forEach(function(removal) {
            if (!groupedRemovals[removal.workflowName]) {
              groupedRemovals[removal.workflowName] = {
                workflowId: removal.workflowId,
                removals: []
              };
            }
            groupedRemovals[removal.workflowName].removals.push(removal);
          });

          // Build HTML
          let html = '';
          Object.keys(groupedRemovals).sort().forEach(function(teamName) {
            const teamData = groupedRemovals[teamName];
            const teamRemovals = teamData.removals;
            const workflowId = teamData.workflowId;
            
            html += '<div class="team-section">';
            html += '<div class="team-header">';
            html += '<div class="team-header-title">' + teamName + ' (' + teamRemovals.length + ' removal' + (teamRemovals.length === 1 ? '' : 's') + ')</div>';
            html += '<a href="https://people.planningcenteronline.com/workflows/' + workflowId + '" target="_blank" class="pco-link">🔗 View in PCO</a>';
            html += '</div>';
            
            teamRemovals.forEach(function(removal) {
              const removalDate = new Date(removal.removalDate).toLocaleDateString();
              const reason = removal.reason || '&lt;No reason provided&gt;';
              const reviewerName = removal.reviewerName || 'Unknown';
              
              html += '<div class="removal-item">';
              html += '<div class="member-info">';
              html += '<div class="member-name">' + removal.firstName + ' ' + removal.lastName + '</div>';
              html += '<div class="removal-details">Reason: ' + reason + '</div>';
              html += '<div class="removal-date">Marked for removal: ' + removalDate + '</div>';
              html += '<div class="reviewer-name">Requested by: ' + reviewerName + '</div>';
              html += '</div>';
              html += '</div>';
            });
            
            html += '</div>';
          });

          removalsList.innerHTML = html;
        }

        function updateSummary(totalCount) {
          const summary = document.getElementById('summary');
          const summaryText = document.getElementById('summaryText');
          
          if (totalCount > 0) {
            summaryText.textContent = 'There ' + (totalCount === 1 ? 'is' : 'are') + ' ' + totalCount + ' member' + (totalCount === 1 ? '' : 's') + ' marked for removal who ' + (totalCount === 1 ? 'is' : 'are') + ' still in-progress in PCO. The Admin Team will remove them from the workflows in Planning Center Online, then refresh this page.';
            summary.style.display = 'block';
          } else {
            summary.style.display = 'none';
          }
        }



        function showError(message) {
          const errorDiv = document.getElementById('errorMessage');
          errorDiv.textContent = message;
          errorDiv.style.display = 'block';
        }

        // Refresh button event listener
        document.getElementById('refreshButton').addEventListener('click', () => {
          loadPendingRemovals(true);
        });

        // Load data on page load
        loadPendingRemovals();
      </script>
    </body>
    </html>
  `);
});

// Dream Teams admin tools page
// IMPORTANT: This must be defined BEFORE the :workflowId route
app.get('/dream-teams/admin-tools', async (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>QCC Hub - DTHR - Admin Tools</title>
      <link rel="icon" type="image/x-icon" href="https://www.queencitypeople.com/favicon.ico">
      <style>
        body {
          font-family: Arial, sans-serif;
          margin: 20px;
          background-color: #f5f5f5;
          transition: background-color 0.3s ease;
        }
        body.dark-mode {
          background-color: #1a1a1a;
          color: #ffffff;
        }
        body.dark-mode .container {
          background-color: #2d2d2d;
          color: #ffffff;
        }
        body.dark-mode .header {
          border-bottom-color: #555;
        }
        body.dark-mode .header h1 {
          color: #ffffff;
        }
        body.dark-mode .card {
          background-color: #3d3d3d;
          border-color: #555;
        }
        body.dark-mode .card h2 {
          color: #ffffff;
        }
        body.dark-mode .card p {
          color: #cccccc;
        }
        body.dark-mode .back-button {
          background-color: #495057;
          color: #ffffff;
        }
        body.dark-mode .back-button:hover {
          background-color: #6c757d;
        }
        body.dark-mode .action-button {
          background-color: #c82333;
        }
        body.dark-mode .action-button:hover {
          background-color: #b21f2d;
        }
        
        /* FOUC Prevention - Temporary loading styles */
        html.dark-mode-loading {
          background-color: #1a1a1a !important;
        }
        html.dark-mode-loading body {
          background-color: #1a1a1a !important;
          color: #ffffff !important;
        }
        html.dark-mode-loading .container {
          background-color: #2d2d2d !important;
          color: #ffffff !important;
        }
        html.dark-mode-loading h1 {
          color: #ffffff !important;
        }
        body.dark-mode .result {
          background-color: #0c3544;
          border-color: #1d6f7e;
          color: #b8daff;
        }
        body.dark-mode .error {
          background-color: #721c24;
          border-color: #a94442;
          color: #f8d7da;
        }
        .container {
          max-width: 900px;
          margin: 0 auto;
          padding: 20px;
          background-color: white;
          border-radius: 10px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 24px;
          padding-bottom: 16px;
          border-bottom: 2px solid #e9ecef;
        }
        .header h1 {
          margin: 0;
          font-size: 1.6em;
          color: #333;
        }
        .back-button {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          background-color: #6c757d;
          color: white;
          border: none;
          padding: 10px 16px;
          border-radius: 4px;
          text-decoration: none;
          font-size: 14px;
          transition: background-color 0.3s ease;
        }
        .back-button:hover {
          background-color: #5a6268;
        }
        .card {
          border: 1px solid #dee2e6;
          border-radius: 8px;
          padding: 20px;
          background-color: #fff;
        }
        .card h2 {
          margin-top: 0;
          margin-bottom: 10px;
          font-size: 1.2em;
        }
        .card p {
          margin: 0 0 16px 0;
          color: #666;
        }
        .action-button {
          background-color: #dc3545;
          color: white;
          border: none;
          border-radius: 4px;
          padding: 10px 16px;
          font-size: 14px;
          cursor: pointer;
          transition: background-color 0.3s ease;
        }
        .action-button:hover {
          background-color: #c82333;
        }
        .action-button:disabled {
          cursor: not-allowed;
          opacity: 0.7;
        }
        .result, .error {
          margin-top: 16px;
          padding: 12px;
          border-radius: 6px;
          border: 1px solid;
          display: none;
          white-space: pre-wrap;
        }
        .result {
          background-color: #d1ecf1;
          border-color: #bee5eb;
          color: #0c5460;
        }
        .error {
          background-color: #f8d7da;
          border-color: #f5c6cb;
          color: #721c24;
        }
      </style>
      <script>
        if (localStorage.getItem('darkMode') === 'true') {
          document.documentElement.classList.add('dark-mode-loading');
        }
      </script>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Admin Tools</h1>
          <a href="/dream-teams/pending-removals" class="back-button">Back to Pending Removals</a>
        </div>

        <div class="card">
          <h2>Resend Check-In Emails</h2>
          <p>Re-run today's Dream Team check-in notification process to resend any emails that may have been missed.</p>
          <button id="resendButton" class="action-button">Resend Check-In Emails</button>
          <div id="resultMessage" class="result"></div>
          <div id="errorMessage" class="error"></div>
        </div>
      </div>

      <script>
        document.addEventListener('DOMContentLoaded', function() {
          document.documentElement.classList.remove('dark-mode-loading');
          if (localStorage.getItem('darkMode') === 'true') {
            document.body.classList.add('dark-mode');
          }
        });

        const resendButton = document.getElementById('resendButton');
        const resultMessage = document.getElementById('resultMessage');
        const errorMessage = document.getElementById('errorMessage');

        resendButton.addEventListener('click', async () => {
          const confirmed = window.confirm('Confirm resend of check-in emails due today?');
          if (!confirmed) return;

          resendButton.disabled = true;
          const originalText = resendButton.textContent;
          resendButton.textContent = 'Resending...';
          resultMessage.style.display = 'none';
          errorMessage.style.display = 'none';

          try {
            const response = await fetch('/api/dream-teams/resend-checkin-emails', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' }
            });
            const result = await response.json();

            if (!response.ok || !result.success) {
              throw new Error(result.error || 'Failed to resend check-in emails');
            }

            const summary = [
              'Check-in email resend completed.',
              'Notifications sent: ' + (result.notificationsSent || 0),
              'Check-ins due: ' + (result.checkInsDue || 0),
              'Teams notified: ' + (result.teamsNotified || 0),
              result.skipped ? ('Status: ' + result.skipped) : ''
            ].filter(Boolean).join('\\n');

            resultMessage.textContent = summary;
            resultMessage.style.display = 'block';
          } catch (error) {
            errorMessage.textContent = error instanceof Error ? error.message : 'Unknown error';
            errorMessage.style.display = 'block';
          } finally {
            resendButton.disabled = false;
            resendButton.textContent = originalText;
          }
        });
      </script>
    </body>
    </html>
  `);
});

app.get('/dream-teams/:workflowId', async (req, res) => {
  try {
    const { workflowId } = req.params;
    
    // Get the workflow data to get the team name
    const dreamTeams = await getDreamTeamWorkflows();
    const team = dreamTeams.find(t => t.id === workflowId);
    const teamName = team ? team.name : 'Unknown Team';
    
    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>QCC Hub - DTHR - ${teamName}</title>
        <link rel="icon" type="image/x-icon" href="https://www.queencitypeople.com/favicon.ico">
        <style>
          body {
            font-family: Arial, sans-serif;
            margin: 20px;
            background-color: #f5f5f5;
            transition: background-color 0.3s ease;
          }
          
          /* Dark mode styles */
          body.dark-mode {
            background-color: #1a1a1a;
            color: #ffffff;
          }
          
          body.dark-mode .container {
            background-color: #2d2d2d;
            color: #ffffff;
          }
          
          body.dark-mode h1 {
            color: #ffffff;
          }
          
          body.dark-mode .team-info h1 {
            color: #ffffff;
          }
          
          body.dark-mode .pco-link {
            color: #4fc3f7;
          }
          
          body.dark-mode .pco-link:hover {
            color: #81d4fa;
          }

          body.dark-mode .page-instructions {
            color: #e3f2fd;
            background-color: #2d3436;
          }
          
          body.dark-mode .pending-count {
            background-color: #856404;
            color: #fff3cd;
            border-color: #ffeaa7;
          }
          
          body.dark-mode .last-updated {
            color: #cccccc;
          }
          
          body.dark-mode .back-button {
            background-color: #495057;
            color: #ffffff;
          }
          
          body.dark-mode .back-button:hover {
            background-color: #6c757d;
          }
          
          body.dark-mode .loading {
            color: #cccccc;
          }
          
          body.dark-mode .error {
            background-color: #721c24;
            color: #f8d7da;
            border-color: #a94442;
          }
          
          body.dark-mode .roster-section h2 {
            color: #ffffff;
          }
          
          body.dark-mode .sort-controls label {
            color: #cccccc;
          }
          
          body.dark-mode .sort-controls select {
            background-color: #2d2d2d;
            color: #ffffff;
            border-color: #555;
          }
          
          body.dark-mode .member-count {
            background-color: #0056b3;
          }
          
          body.dark-mode .member-item {
            background-color: #3d3d3d;
            border-color: #555;
          }
          
          body.dark-mode .member-item:hover {
            background-color: #4d4d4d;
          }
          
          body.dark-mode .member-name {
            color: #ffffff;
          }
          
          body.dark-mode .pending-removal-indicator {
            background-color: #4e1f1b;
            color: #ffa39e;
            border-color: #ff7875;
          }
          
          body.dark-mode .join-date {
            color: #cccccc;
          }
          
          body.dark-mode .new-member-indicator {
            background-color: #1e7e34;
            color: #d4edda;
            border-color: #28a745;
          }
          
          body.dark-mode .incomplete-indicator {
            background-color: #856404;
            color: #fff3cd;
            border-color: #ffd700;
          }
          
          body.dark-mode .add-member-button {
            background-color: #1e7e34;
            color: #d4edda;
            border-color: #28a745;
          }
          
          body.dark-mode .add-member-button:hover {
            background-color: #218838;
          }
          
          body.dark-mode .add-member-info {
            background-color: #1a3547;
            border-color: #2a4e6a;
            border-left-color: #0d6efd;
            color: #e3f2fd;
          }
          
          body.dark-mode .add-member-info h3 {
            color: #4fc3f7;
          }
          
          body.dark-mode .add-member-info p {
            color: #e3f2fd;
          }
          
          body.dark-mode .add-member-info a {
            color: #4fc3f7;
          }
          
          body.dark-mode .add-member-info a:hover {
            color: #81d4fa;
          }
          
          body.dark-mode .add-member-info .link-description {
            color: #b3e5fc;
          }
          
          body.dark-mode .copy-link-btn {
            background-color: #2a4e6a;
            color: #e3f2fd;
            border-color: #3d6c94;
          }
          
          body.dark-mode .copy-link-btn:hover {
            background-color: #3d6c94;
          }
          
          body.dark-mode .copy-link-btn.copied {
            background-color: #0d6efd;
            border-color: #0a58ca;
          }
          
          body.dark-mode .past-members h3 {
            color: #cccccc;
          }
          
          body.dark-mode .past-member-item {
            background-color: #3d3d3d;
            color: #cccccc;
          }
          
          body.dark-mode .modal-content {
            background-color: #2d2d2d;
            color: #ffffff;
          }
          
          body.dark-mode .modal h3 {
            color: #ffffff;
          }
          
          body.dark-mode .modal textarea {
            background-color: #3d3d3d;
            color: #ffffff;
            border-color: #555;
          }
          
          body.dark-mode .reviewer-input label {
            color: #ffffff;
          }
          
          body.dark-mode .reviewer-input input {
            background-color: #3d3d3d;
            color: #ffffff;
            border-color: #555;
          }

          @media (max-width: 600px) {
            body.dark-mode .reviewer-input:focus-within {
              background-color: #2d2d2d;
              box-shadow: 0 2px 10px rgba(0,0,0,0.3);
            }
            body.dark-mode .reviewer-input input {
              background-color: #3d3d3d;
            }
            body.dark-mode .reviewer-input input:focus {
              background-color: #3d3d3d;
              border-color: #4fc3f7;
              box-shadow: 0 0 0 2px rgba(79, 195, 247, 0.25);
            }
          }
          
          /* FOUC Prevention - Temporary loading styles */
          html.dark-mode-loading {
            background-color: #1a1a1a !important;
          }
          
          html.dark-mode-loading body {
            background-color: #1a1a1a !important;
            color: #ffffff !important;
          }
          
          html.dark-mode-loading .container {
            background-color: #2d2d2d !important;
            color: #ffffff !important;
          }
          
          html.dark-mode-loading h1 {
            color: #ffffff !important;
          }
          .container {
            max-width: 900px;
            margin: 0 auto;
            background-color: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          .header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            margin-bottom: 30px;
            border-bottom: 2px solid #e9ecef;
            padding-bottom: 20px;
            flex-wrap: wrap;
            gap: 15px;
          }
          
          @media (max-width: 600px) {
            .header {
              flex-direction: column;
            }
            .header .team-info {
              width: 100%;
              margin-bottom: 15px;
            }
            .header .back-button {
              align-self: flex-start;
            }
          }
          
          .team-info h1 {
            color: #333;
            margin-bottom: 8px;
          }
          
          .pco-link {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            color: #007bff;
            text-decoration: none;
            font-size: 0.9em;
            margin-bottom: 12px;
          }
          
          .pco-link:hover {
            color: #0056b3;
            text-decoration: underline;
          }
          .page-instructions {
            color: #495057;
            font-size: 0.95em;
            margin-bottom: 20px;
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 12px 16px;
            background-color: #f8f9fa;
            border-radius: 6px;
          }
          .pending-count {
            color: #856404;
            background-color: #fff3cd;
            border: 1px solid #ffeaa7;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 0.85em;
            font-weight: 500;
            margin-bottom: 12px;
            display: inline-block;
          }
          .last-updated {
            color: #666;
            font-size: 0.9em;
          }
          .back-button {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 10px 16px;
            background-color: #6c757d;
            color: white;
            text-decoration: none;
            border-radius: 4px;
            font-size: 14px;
            transition: background-color 0.3s ease;
          }
          .back-button:hover {
            background-color: #5a6268;
          }
          .loading {
            text-align: center;
            padding: 40px;
            color: #666;
          }
          .error {
            text-align: center;
            padding: 40px;
            color: #dc3545;
            background-color: #f8d7da;
            border: 1px solid #f5c6cb;
            border-radius: 8px;
            margin: 20px 0;
          }
          .roster-section {
            margin-bottom: 40px;
          }
          .roster-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            flex-wrap: wrap;
            gap: 15px;
          }
          .roster-section h2 {
            color: #333;
            margin: 0;
            font-size: 1.4em;
            display: flex;
            align-items: center;
            gap: 10px;
          }
          .sort-controls {
            display: flex;
            align-items: center;
            gap: 8px;
          }
          .sort-controls label {
            font-size: 14px;
            color: #666;
            font-weight: 500;
          }
          .sort-controls select {
            padding: 6px 10px;
            border: 1px solid #ced4da;
            border-radius: 4px;
            font-size: 14px;
            background-color: white;
            cursor: pointer;
          }
          .sort-controls select:focus {
            outline: none;
            border-color: #007bff;
            box-shadow: 0 0 0 2px rgba(0, 123, 255, 0.25);
          }
          .member-count {
            background-color: #007bff;
            color: white;
            padding: 4px 8px;
            border-radius: 12px;
            font-size: 0.8em;
            font-weight: normal;
          }
          .member-list {
            display: grid;
            gap: 10px;
          }
          .member-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 15px;
            border: 1px solid #e9ecef;
            border-radius: 8px;
            transition: background-color 0.2s ease;
          }
          
          @media (max-width: 600px) {
            .member-item {
              padding: 12px;
              gap: 12px;
              min-height: 70px;
              display: grid;
              grid-template-columns: 1fr 60px; /* Fixed width for button column */
            }
            .member-item .remove-checkbox,
            .member-item .undo-button {
              align-self: center;
              justify-self: center;
              width: 100%;
              text-align: center;
            }
          }
          
          @media (max-width: 600px) {
            .member-item {
              flex-direction: column;
              align-items: flex-start;
              gap: 10px;
            }
            .member-info {
              width: 100%;
            }
            .join-date {
              display: flex;
              flex-wrap: wrap;
              gap: 6px;
              align-items: center;
            }
            .remove-checkbox, .undo-button {
              align-self: flex-end;
              margin-top: -30px;
            }
          }
          .member-item:hover {
            background-color: #f8f9fa;
          }
          .member-info {
            display: flex;
            flex-direction: column;
            gap: 4px;
            flex: 1;
          }
          .member-name-row {
            display: flex;
            align-items: center;
            gap: 10px;
            flex-wrap: wrap;
          }
          .member-name {
            font-weight: 500;
            color: #333;
          }
          
          @media (max-width: 600px) {
            .member-name {
              white-space: nowrap;
              overflow: hidden;
              text-overflow: ellipsis;
              max-width: 200px;
            }
          }
          .pending-removal-indicator {
            background-color: #ffe5e3;
            color: #cd4631;
            border: 1px solid #ffccc7;
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 0.75em;
            font-weight: 600;
            margin-left: 8px;
            cursor: help;
          }
          
          @media (max-width: 600px) {
            .new-member-indicator,
            .incomplete-indicator,
            .pending-removal-indicator {
              font-size: 0.7em;
              padding: 1px 4px;
            }
          }
          .join-date {
            color: #666;
            font-size: 0.85em;
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 4px;
          }
          
          .date-label {
            color: #888;
          }
          
          body.dark-mode .date-label {
            color: #999;
          }
          
          .date-separator {
            color: #ccc;
            margin: 0 4px;
          }
          
          body.dark-mode .date-separator {
            color: #555;
          }
          
          .date-group {
            display: inline;
          }
          
          .badges-container {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-left: 8px;
          }
          
          /* Check-in status indicator (at a glance) */
          .checkin-status {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            font-size: 0.85em;
            font-weight: 500;
            color: #666;
            cursor: pointer;
            padding: 4px 10px;
            border-radius: 4px;
            background-color: #f0f0f0;
            transition: background-color 0.2s ease;
          }
          
          .checkin-status:hover {
            background-color: #e0e0e0;
          }
          
          body.dark-mode .checkin-status {
            background-color: #4a4a4a;
            color: #e0e0e0;
            border: 1px solid #666;
          }
          
          body.dark-mode .checkin-status:hover {
            background-color: #5a5a5a;
          }
          
          .checkin-status .status-done {
            color: #28a745;
            font-weight: bold;
          }
          
          body.dark-mode .checkin-status .status-done {
            color: #5dd879;
          }
          
          .checkin-status .status-pending {
            color: #dc3545;
            font-weight: bold;
          }
          
          body.dark-mode .checkin-status .status-pending {
            color: #ff6b6b;
          }
          
          .checkin-status .expand-icon {
            font-size: 0.8em;
            color: #999;
            transition: transform 0.2s ease;
          }
          
          .checkin-status.expanded .expand-icon {
            transform: rotate(180deg);
          }
          
          @media (max-width: 600px) {
            .join-date {
              flex-direction: column;
              align-items: flex-start;
              gap: 2px;
            }
            .date-group {
              display: block;
            }
            .date-separator {
              display: none;
            }
            .badges-container {
              margin-left: 0;
              margin-top: 4px;
            }
          }
          .new-member-indicator {
            background-color: #d4edda;
            color: #155724;
            border: 1px solid #c3e6cb;
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 0.75em;
            font-weight: 600;
            margin-left: 8px;
            cursor: help;
          }
          
          .incomplete-indicator {
            background-color: #fff3cd;
            color: #856404;
            border: 1px solid #ffeeba;
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 0.75em;
            font-weight: 600;
            margin-left: 8px;
            cursor: help;
          }
          
          .checkin-needed-indicator {
            background-color: #e7f1ff;
            color: #0958d9;
            border: 1px solid #91caff;
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 0.75em;
            font-weight: 600;
            margin-left: 8px;
            cursor: help;
          }
          
          body.dark-mode .checkin-needed-indicator {
            background-color: #1a3a5c;
            color: #8fcdff;
            border-color: #2d6aa8;
          }
          
          /* Dream Team Check-Ins Styles */
          .checkins-section {
            margin-top: 8px;
            padding: 8px 12px;
            background-color: #f8f9fa;
            border-radius: 4px;
            display: none;
          }
          
          .checkins-section.visible {
            display: block;
          }
          
          body.dark-mode .checkins-section {
            background-color: #2d2d2d;
          }
          
          .checkin-item {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 4px 0;
          }
          
          .checkin-item + .checkin-item {
            padding-top: 2px;
          }
          
          .checkin-checkbox {
            width: 14px;
            height: 14px;
            cursor: pointer;
            accent-color: #28a745;
          }
          
          .checkin-checkbox:disabled {
            cursor: default;
          }
          
          .checkin-label {
            font-size: 0.8em;
            color: #666;
          }
          
          body.dark-mode .checkin-label {
            color: #b0b0b0;
          }
          
          .checkin-label.completed {
            color: #28a745;
          }
          
          body.dark-mode .checkin-label.completed {
            color: #81c784;
          }
          
          .checkin-label.needed {
            color: #856404;
          }
          
          body.dark-mode .checkin-label.needed {
            color: #ffd54f;
          }
          
          .checkin-completed-info {
            font-size: 0.75em;
            color: #999;
          }
          
          body.dark-mode .checkin-completed-info {
            color: #888;
          }
          
          .checkin-form {
            display: none;
            margin-top: 4px;
            margin-left: 22px;
          }
          
          .checkin-form.visible {
            display: flex;
            align-items: center;
            gap: 8px;
          }
          
          .checkin-form input {
            padding: 4px 8px;
            border: 1px solid #ced4da;
            border-radius: 3px;
            font-size: 12px;
            width: 120px;
          }
          
          body.dark-mode .checkin-form input {
            background-color: #2d2d2d;
            color: #ffffff;
            border-color: #555;
          }
          
          .checkin-form button {
            padding: 4px 10px;
            background-color: #28a745;
            color: white;
            border: none;
            border-radius: 3px;
            font-size: 12px;
            cursor: pointer;
            transition: background-color 0.2s ease;
          }
          
          .checkin-form button:hover {
            background-color: #218838;
          }
          
          .checkin-form button:disabled {
            background-color: #6c757d;
            cursor: not-allowed;
          }
          
          .checkin-form .cancel-btn {
            background-color: transparent;
            color: #6c757d;
            padding: 4px 6px;
          }
          
          .checkin-form .cancel-btn:hover {
            color: #495057;
            background-color: transparent;
          }
          
          body.dark-mode .checkin-form .cancel-btn {
            color: #999;
          }
          
          body.dark-mode .checkin-form .cancel-btn:hover {
            color: #ccc;
          }
          
          @media (max-width: 600px) {
            .checkin-form.visible {
              flex-wrap: wrap;
            }
            
            .checkin-form input {
              width: 100px;
            }
          }
          
          .add-member-button {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 8px 16px;
            background-color: #28a745;
            color: white;
            border: none;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s ease;
            margin-bottom: 20px;
          }
          .add-member-button:hover {
            background-color: #218838;
            transform: translateY(-1px);
          }
          .add-member-button:active {
            transform: translateY(0);
          }
          .add-member-info {
            display: none;
            background-color: #d1ecf1;
            border: 1px solid #bee5eb;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 25px;
            border-left: 4px solid #17a2b8;
            animation: slideDown 0.3s ease;
          }
          .add-member-info.visible {
            display: block;
          }
          @keyframes slideDown {
            from {
              opacity: 0;
              transform: translateY(-10px);
            }
            to {
              opacity: 1;
              transform: translateY(0);
            }
          }
          .add-member-info h3 {
            margin: 0 0 12px 0;
            color: #0c5460;
            font-size: 1.2em;
            display: flex;
            align-items: center;
            gap: 8px;
          }
          .add-member-info p {
            margin: 0 0 15px 0;
            color: #0c5460;
            line-height: 1.5;
          }
          .add-member-info .links {
            display: flex;
            flex-direction: column;
            gap: 8px;
          }
          .add-member-info a {
            color: #007bff;
            text-decoration: none;
            font-weight: 500;
            display: inline-flex;
            align-items: center;
            gap: 6px;
          }
          .add-member-info a:hover {
            text-decoration: underline;
            color: #0056b3;
          }
          .add-member-info .link-description {
            font-size: 0.9em;
            color: #6c757d;
            margin-left: 20px;
          }
          .add-member-info .link-row {
            display: flex;
            align-items: center;
            gap: 8px;
          }
          .copy-link-btn {
            padding: 4px 8px;
            font-size: 12px;
            background-color: #e9ecef;
            border: 1px solid #ced4da;
            border-radius: 4px;
            color: #495057;
            cursor: pointer;
            transition: all 0.2s ease;
            display: inline-flex;
            align-items: center;
            gap: 4px;
          }
          .copy-link-btn:hover {
            background-color: #dee2e6;
          }
          .copy-link-btn.copied {
            background-color: #28a745;
            border-color: #28a745;
            color: white;
          }
          .remove-checkbox {
            width: 24px;
            height: 24px;
            background-color: #dc3545;
            color: white;
            border: 2px solid #dc3545;
            border-radius: 4px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
            font-size: 14px;
            transition: all 0.2s ease;
          }
          .remove-checkbox:hover {
            background-color: #c82333;
            border-color: #c82333;
          }
          .remove-checkbox.selected {
            background-color: white;
            border-color: #dc3545;
            color: #dc3545;
          }
          .remove-checkbox.disabled {
            background-color: #6c757d;
            border-color: #6c757d;
            color: white;
            cursor: not-allowed;
            opacity: 0.7;
          }
          .remove-checkbox.disabled:hover {
            background-color: #6c757d;
            border-color: #6c757d;
          }
          .undo-button {
            background-color: #28a745;
            color: white;
            border: none;
            border-radius: 4px;
            padding: 4px 8px;
            font-size: 16px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s ease;
            min-width: 50px;
            height: 24px;
            display: flex;
            align-items: center;
            justify-content: center;
          }
          .undo-button:hover {
            background-color: #218838;
            transform: translateY(-1px);
          }
          .undo-button:active {
            transform: translateY(0);
          }
          .remove-checkbox.selected + .member-item {
            background-color: #f8d7da;
            border-color: #f5c6cb;
          }
          .action-section {
            margin-top: 30px;
            padding-top: 30px;
            border-top: 2px solid #e9ecef;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 20px;
            flex-wrap: wrap;
          }
          .reviewer-input {
            display: flex;
            align-items: center;
            gap: 8px;
            position: relative;
            z-index: 2;
          }
          .reviewer-input label {
            font-weight: 500;
            color: #333;
            white-space: nowrap;
          }
          .reviewer-input input {
            width: 200px;
            padding: 8px 12px;
            border: 1px solid #ced4da;
            border-radius: 4px;
            font-size: 16px;
            box-sizing: border-box;
            background: white;
          }
          .reviewer-input input:focus {
            outline: none;
            border-color: #007bff;
            box-shadow: 0 0 0 2px rgba(0, 123, 255, 0.25);
          }
          @media (max-width: 600px) {
            .reviewer-input {
              flex-direction: column;
              align-items: flex-start;
              width: 100%;
              padding: 15px 0;
            }
            .reviewer-input input {
              width: 100%;
            }
            .reviewer-input:focus-within {
              background: white;
              margin: 0 -12px;
              padding: 15px 12px;
              box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            }
          }
          .action-buttons {
            display: flex;
            gap: 15px;
          }
          .action-button {
            padding: 12px 24px;
            border: none;
            border-radius: 6px;
            font-size: 16px;
            font-weight: 500;
            cursor: pointer;
            transition: background-color 0.3s ease;
          }
          .no-changes-btn {
            background-color: #28a745;
            color: white;
          }
          .no-changes-btn:hover {
            background-color: #218838;
          }
          .confirm-changes-btn {
            background-color: #dc3545;
            color: white;
            display: none;
          }
          .confirm-changes-btn:hover {
            background-color: #c82333;
          }
          .confirm-changes-btn.visible {
            display: inline-block;
          }
          .past-members {
            margin-top: 40px;
            padding-top: 30px;
            border-top: 2px solid #e9ecef;
          }
          .past-members h3 {
            color: #666;
            font-size: 1.2em;
            margin-bottom: 15px;
          }
          .past-member-item {
            padding: 10px 15px;
            background-color: #f8f9fa;
            border-radius: 6px;
            margin-bottom: 8px;
            color: #666;
          }
          
          /* Reason popup modal */
          .modal {
            display: none;
            position: fixed;
            z-index: 1000;
            left: 0;
            top: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0,0,0,0.5);
          }
          .modal-content {
            background-color: white;
            margin: 10% auto;
            padding: 20px;
            border-radius: 8px;
            width: 95%;
            max-width: 450px;
            box-sizing: border-box;
            max-height: 80vh;
            overflow-y: auto;
          }
          .modal h3 {
            margin-top: 0;
            color: #333;
          }
          .modal textarea {
            width: 100%;
            height: 100px;
            padding: 10px;
            border: 1px solid #ddd;
            border-radius: 4px;
            resize: vertical;
            font-family: inherit;
            box-sizing: border-box;
          }
          .modal-buttons {
            display: flex;
            gap: 10px;
            justify-content: flex-end;
            margin-top: 15px;
          }
          .modal-btn {
            padding: 8px 16px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
          }
          .modal-btn.cancel {
            background-color: #6c757d;
            color: white;
          }
          .modal-btn.confirm {
            background-color: #dc3545;
            color: white;
          }
          .modal-btn.confirm:disabled {
            background-color: #ccc;
            cursor: not-allowed;
            opacity: 0.6;
          }
          .modal-btn.undo-confirm {
            background-color: #28a745;
            color: white;
          }
          .modal-btn.undo-confirm:hover {
            background-color: #218838;
          }
          
          /* Team Leadership Section */
          .leadership-section {
            background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%);
            border: 1px solid #dee2e6;
            border-radius: 10px;
            padding: 16px 20px;
            margin-bottom: 20px;
          }
          
          body.dark-mode .leadership-section {
            background: linear-gradient(135deg, #2d2d2d 0%, #3d3d3d 100%);
            border-color: #444;
          }
          
          .leadership-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
          }
          
          .leadership-header h3 {
            margin: 0;
            font-size: 1em;
            color: #495057;
            font-weight: 600;
          }
          
          body.dark-mode .leadership-header h3 {
            color: #ccc;
          }
          
          .edit-leadership-btn {
            background: none;
            border: 1px solid #6c757d;
            color: #6c757d;
            padding: 4px 10px;
            border-radius: 4px;
            font-size: 0.8em;
            cursor: pointer;
            transition: all 0.2s ease;
          }
          
          .edit-leadership-btn:hover {
            background-color: #6c757d;
            color: white;
          }
          
          body.dark-mode .edit-leadership-btn {
            border-color: #888;
            color: #888;
          }
          
          body.dark-mode .edit-leadership-btn:hover {
            background-color: #888;
            color: #1a1a1a;
          }
          
          .leadership-content {
            display: flex;
            gap: 30px;
            flex-wrap: wrap;
          }
          
          .leadership-group {
            flex: 1;
            min-width: 150px;
          }
          
          .leadership-group h4 {
            margin: 0 0 6px 0;
            font-size: 0.75em;
            color: #868e96;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            font-weight: 600;
          }
          
          body.dark-mode .leadership-group h4 {
            color: #aaa;
          }
          
          .leader-list {
            display: flex;
            flex-direction: column;
            gap: 4px;
          }
          
          .leader-item {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 0.95em;
            color: #333;
          }
          
          body.dark-mode .leader-item {
            color: #e0e0e0;
          }
          
          .leader-item .remove-leader {
            display: none;
            background: none;
            border: none;
            color: #dc3545;
            cursor: pointer;
            padding: 0;
            font-size: 1em;
            line-height: 1;
          }
          
          .leadership-section.editing .leader-item .remove-leader {
            display: inline;
          }
          
          .no-leaders {
            color: #868e96;
            font-style: italic;
            font-size: 0.9em;
          }
          
          body.dark-mode .no-leaders {
            color: #888;
          }
          
          .add-leader-form {
            display: none;
            margin-top: 12px;
            padding-top: 12px;
            border-top: 1px solid #dee2e6;
          }
          
          body.dark-mode .add-leader-form {
            border-top-color: #444;
          }
          
          .leadership-section.editing .add-leader-form {
            display: block;
          }
          
          .add-leader-row {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
            align-items: flex-end;
          }
          
          .add-leader-row .form-group {
            flex: 1;
            min-width: 150px;
          }
          
          .add-leader-row label {
            display: block;
            font-size: 0.8em;
            color: #6c757d;
            margin-bottom: 4px;
          }
          
          body.dark-mode .add-leader-row label {
            color: #aaa;
          }
          
          .add-leader-row input,
          .add-leader-row select {
            width: 100%;
            padding: 8px 10px;
            border: 1px solid #ced4da;
            border-radius: 4px;
            font-size: 0.9em;
            box-sizing: border-box;
          }
          
          body.dark-mode .add-leader-row input,
          body.dark-mode .add-leader-row select {
            background-color: #2d2d2d;
            border-color: #555;
            color: #fff;
          }
          
          .add-leader-btn {
            background-color: #007bff;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            font-size: 0.9em;
            cursor: pointer;
            white-space: nowrap;
          }
          
          .add-leader-btn:hover {
            background-color: #0056b3;
          }
          
          .add-leader-btn:disabled {
            background-color: #6c757d;
            cursor: not-allowed;
          }
          
          .person-search-results {
            position: absolute;
            top: 100%;
            left: 0;
            right: 0;
            background: white;
            border: 1px solid #ced4da;
            border-radius: 4px;
            max-height: 200px;
            overflow-y: auto;
            z-index: 100;
            box-shadow: 0 4px 8px rgba(0,0,0,0.1);
            display: none;
          }
          
          body.dark-mode .person-search-results {
            background: #2d2d2d;
            border-color: #555;
          }
          
          .person-search-results.visible {
            display: block;
          }
          
          .person-search-result {
            padding: 8px 12px;
            cursor: pointer;
            border-bottom: 1px solid #eee;
          }
          
          body.dark-mode .person-search-result {
            border-bottom-color: #444;
          }
          
          .person-search-result:last-child {
            border-bottom: none;
          }
          
          .person-search-result:hover {
            background-color: #f0f0f0;
          }
          
          body.dark-mode .person-search-result:hover {
            background-color: #3d3d3d;
          }
          
          .person-search-wrapper {
            position: relative;
          }
          
          @media (max-width: 600px) {
            .leadership-content {
              flex-direction: column;
              gap: 15px;
            }
            
            .add-leader-row {
              flex-direction: column;
            }
            
            .add-leader-row .form-group {
              width: 100%;
            }
            
            .add-leader-btn {
              width: 100%;
            }
          }
        </style>
        <script>
          // Apply dark mode immediately to prevent flash
          if (localStorage.getItem('darkMode') === 'true') {
            document.documentElement.classList.add('dark-mode-loading');
          }
        </script>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="team-info">
              <h1 id="teamName">Loading...</h1>
              <a href="https://people.planningcenteronline.com/workflows/${workflowId}" target="_blank" class="pco-link">
                🔗 View in Planning Center
              </a>
              <div id="pendingCount" class="pending-count" style="display: none;"></div>
              <div class="last-updated" id="lastUpdated">Last Updated: Loading...</div>
            </div>
            <a href="/dream-teams" class="back-button">
            <span><strong>⟵</strong></span>
              <span>Back to Teams</span>
            </a>
          </div>
          
          <div id="leadershipSection" class="leadership-section" style="display: none;">
            <div class="leadership-header">
              <h3>Team Leadership</h3>
              <button class="edit-leadership-btn" onclick="toggleLeadershipEdit()">Edit</button>
            </div>
            <div class="leadership-content">
              <div class="leadership-group">
                <h4>Director</h4>
                <div id="directorsList" class="leader-list">
                  <span class="no-leaders">None assigned</span>
                </div>
              </div>
              <div class="leadership-group">
                <h4>Team Leader</h4>
                <div id="teamLeadersList" class="leader-list">
                  <span class="no-leaders">None assigned</span>
                </div>
              </div>
            </div>
            <div class="add-leader-form">
              <div class="add-leader-row">
                <div class="form-group person-search-wrapper">
                  <label>Search for person</label>
                  <input type="text" id="leaderSearchInput" placeholder="Type a name..." autocomplete="off">
                  <div id="personSearchResults" class="person-search-results"></div>
                </div>
                <div class="form-group" style="min-width: 120px; flex: 0.5;">
                  <label>Role</label>
                  <select id="leaderRoleSelect">
                    <option value="team_leader">Team Leader</option>
                    <option value="director">Director</option>
                  </select>
                </div>
                <button class="add-leader-btn" id="addLeaderBtn" onclick="addLeader()" disabled>Add</button>
              </div>
            </div>
          </div>
          
          <div id="loadingContainer" class="loading">
            <p>Loading team roster...</p>
          </div>
          
          <div id="errorContainer" class="error" style="display: none;">
            <p id="errorMessage">Failed to load team roster</p>
          </div>
          
          <div id="rosterContainer" style="display: none;">
            <div class="page-instructions">
              Review your team roster below, mark members for removal if needed, and the Admin Team will make changes before next month's review
            </div>
            <div class="roster-section">
              <div class="roster-header">
                <h2>Current Members <span class="member-count" id="memberCount">0</span></h2>
                <div class="sort-controls">
                  <label for="sortSelect">Sort by:</label>
                  <select id="sortSelect">
                    <option value="name-asc">Name (A-Z)</option>
                    <option value="name-desc">Name (Z-A)</option>
                    <option value="date-asc">Date (Oldest First)</option>
                    <option value="date-desc">Date (Newest First)</option>
                  </select>
                </div>
              </div>
              
              <!-- Add Member Button & Info Box -->
              <button class="add-member-button" id="addMemberBtn">
                Add A Member
              </button>
              <div class="add-member-info" id="addMemberInfo">
                <h3>
                  Add A Member
                </h3>
                <p>Want to add someone to this team? Here's what we recommend!</p>
                <div class="links">
                  <div>
                    <div class="link-row">
                      <a href="https://queencitypeople-forms.churchcenter.com/people/forms/69044" target="_blank">
                        Join A Team Form
                      </a>
                      <button class="copy-link-btn" data-link="https://queencitypeople-forms.churchcenter.com/people/forms/69044">
                        Copy Link
                      </button>
                    </div>
                    <div class="link-description">Send this link to anyone who wants to join the team</div>
                  </div>
                  <div>
                    <div class="link-row">
                      <a href="https://queencitypeople.com/dreamteam" target="_blank">
                        Queen City People Website Dream Team Page
                      </a>
                      <button class="copy-link-btn" data-link="https://queencitypeople.com/dreamteam">
                        Copy Link
                      </button>
                    </div>
                    <div class="link-description">General information about joining Dream Teams</div>
                  </div>
                </div>
              </div>
              
              <div class="member-list" id="memberList">
                <!-- Members will be loaded here -->
              </div>
            </div>
            
            <div class="action-section">
              <div class="reviewer-input">
                <label for="reviewerName">Your Name:</label>
                <input type="text" id="reviewerName" placeholder="Enter your name" required
                  onfocus="setTimeout(() => { this.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 200)">
              </div>
              <div class="action-buttons">
                <button class="action-button no-changes-btn" id="noChangesBtn">No Changes</button>
                <button class="action-button confirm-changes-btn" id="confirmChangesBtn">Confirm Changes</button>
              </div>
            </div>
            
            <div class="past-members">
              <h3>Past Members</h3>
              <div id="pastMembersList">
                <!-- Past members will be loaded here -->
              </div>
            </div>
          </div>
        </div>

        <!-- Reason Modal -->
        <div id="reasonModal" class="modal">
          <div class="modal-content">
            <h3>Reason for Removal</h3>
            <p>Please provide a reason for removing this member (required):</p>
            <textarea id="removalReason" placeholder="e.g., Moved to different team, No longer attending, etc." required></textarea>
            <div class="modal-buttons">
              <button class="modal-btn cancel" id="cancelRemoval">Cancel</button>
              <button class="modal-btn confirm" id="confirmRemoval">Confirm Removal</button>
            </div>
          </div>
        </div>

        <!-- Undo Confirmation Modal -->
        <div id="undoModal" class="modal">
          <div class="modal-content">
            <h3>Undo Removal</h3>
            <p id="undoMessage">Are you sure you want to undo the removal of this member?</p>
            <div class="modal-buttons">
              <button class="modal-btn cancel" id="cancelUndo">Cancel</button>
              <button class="modal-btn confirm undo-confirm" id="confirmUndo">Yes, Undo Removal</button>
            </div>
          </div>
        </div>

        <!-- Generic Alert Modal -->
        <div id="alertModal" class="modal">
          <div class="modal-content">
            <h3 id="alertTitle">Alert</h3>
            <p id="alertMessage">Message goes here</p>
            <div class="modal-buttons">
              <button class="modal-btn confirm" id="alertOk">OK</button>
            </div>
          </div>
        </div>

        <!-- Generic Confirmation Modal -->
        <div id="confirmModal" class="modal">
          <div class="modal-content">
            <h3 id="confirmTitle">Confirm</h3>
            <p id="confirmMessage">Are you sure?</p>
            <div class="modal-buttons">
              <button class="modal-btn cancel" id="confirmCancel">Cancel</button>
              <button class="modal-btn confirm" id="confirmOk">OK</button>
            </div>
          </div>
        </div>

        <script>
          const workflowId = '${workflowId}';
          let teamData = null;
          let pendingRemovals = [];
          let currentMemberForRemoval = null;
          let currentMemberForUndo = null;
          let currentConfirmCallback = null;
          
          // Leadership state
          let selectedPerson = null;
          let searchTimeout = null;
          let isLeadershipEditMode = false;

          // Dark mode functionality
          document.addEventListener('DOMContentLoaded', function() {
            // Remove temporary dark mode loading class
            document.documentElement.classList.remove('dark-mode-loading');
            
            // Initialize dark mode state from localStorage
            const isDarkMode = localStorage.getItem('darkMode') === 'true';
            
            if (isDarkMode) {
              document.body.classList.add('dark-mode');
            }
          });

          // Handle clicking outside modals to close them
          window.addEventListener('click', function(event) {
            const modals = document.querySelectorAll('.modal');
            modals.forEach(function(modal) {
              if (event.target === modal) {
                modal.style.display = 'none';
                // Reset any current member selections
                currentMemberForRemoval = null;
                currentMemberForUndo = null;
                document.getElementById('removalReason').value = '';
              }
            });
          });

          // Custom modal functions to replace native browser dialogs
          function showAlert(title, message) {
            document.getElementById('alertTitle').textContent = title;
            document.getElementById('alertMessage').textContent = message;
            document.getElementById('alertModal').style.display = 'block';
          }

          function showConfirm(title, message, callback) {
            document.getElementById('confirmTitle').textContent = title;
            document.getElementById('confirmMessage').textContent = message;
            currentConfirmCallback = callback;
            document.getElementById('confirmModal').style.display = 'block';
          }
          
          // Leadership functions
          async function loadTeamLeaders() {
            try {
              const response = await fetch('/api/dream-teams/' + workflowId + '/leaders');
              const result = await response.json();
              
              if (result.success) {
                renderLeaders(result.data.directors, result.data.teamLeaders);
                document.getElementById('leadershipSection').style.display = 'block';
              }
            } catch (error) {
              console.error('Failed to load team leaders:', error);
            }
          }
          
          function renderLeaders(directors, teamLeaders) {
            const directorsList = document.getElementById('directorsList');
            const teamLeadersList = document.getElementById('teamLeadersList');
            
            // Update labels based on count
            const directorLabel = directorsList.parentElement.querySelector('h4');
            const teamLeaderLabel = teamLeadersList.parentElement.querySelector('h4');
            directorLabel.textContent = directors.length >= 2 ? 'Directors' : 'Director';
            teamLeaderLabel.textContent = teamLeaders.length >= 2 ? 'Team Leaders' : 'Team Leader';
            
            if (directors.length === 0) {
              directorsList.innerHTML = '<span class="no-leaders">None assigned</span>';
            } else {
              directorsList.innerHTML = directors.map(function(d) {
                return '<div class="leader-item" data-person-id="' + d.personId + '" data-role="director">' +
                  '<span>' + escapeHtml(d.personName) + '</span>' +
                  '<button class="remove-leader" onclick="removeLeader(\\'' + d.personId + '\\', \\'director\\', \\'' + escapeHtml(d.personName).replace(/'/g, "\\\\'") + '\\')">✕</button>' +
                '</div>';
              }).join('');
            }
            
            if (teamLeaders.length === 0) {
              teamLeadersList.innerHTML = '<span class="no-leaders">None assigned</span>';
            } else {
              teamLeadersList.innerHTML = teamLeaders.map(function(t) {
                return '<div class="leader-item" data-person-id="' + t.personId + '" data-role="team_leader">' +
                  '<span>' + escapeHtml(t.personName) + '</span>' +
                  '<button class="remove-leader" onclick="removeLeader(\\'' + t.personId + '\\', \\'team_leader\\', \\'' + escapeHtml(t.personName).replace(/'/g, "\\\\'") + '\\')">✕</button>' +
                '</div>';
              }).join('');
            }
          }
          
          function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
          }
          
          function toggleLeadershipEdit() {
            const section = document.getElementById('leadershipSection');
            const btn = section.querySelector('.edit-leadership-btn');
            isLeadershipEditMode = !isLeadershipEditMode;
            
            if (isLeadershipEditMode) {
              section.classList.add('editing');
              btn.textContent = 'Done';
            } else {
              section.classList.remove('editing');
              btn.textContent = 'Edit';
              // Clear search
              document.getElementById('leaderSearchInput').value = '';
              document.getElementById('personSearchResults').innerHTML = '';
              document.getElementById('personSearchResults').classList.remove('visible');
              selectedPerson = null;
              document.getElementById('addLeaderBtn').disabled = true;
            }
          }
          
          // Person search for adding leaders
          document.addEventListener('DOMContentLoaded', function() {
            const searchInput = document.getElementById('leaderSearchInput');
            const resultsContainer = document.getElementById('personSearchResults');
            
            if (searchInput) {
              searchInput.addEventListener('input', function() {
                const query = this.value.trim();
                
                // Clear previous timeout
                if (searchTimeout) clearTimeout(searchTimeout);
                
                // Reset selection when typing
                selectedPerson = null;
                document.getElementById('addLeaderBtn').disabled = true;
                
                if (query.length < 2) {
                  resultsContainer.innerHTML = '';
                  resultsContainer.classList.remove('visible');
                  return;
                }
                
                // Debounce search
                searchTimeout = setTimeout(async function() {
                  try {
                    const response = await fetch('/api/dream-teams/search-people?q=' + encodeURIComponent(query));
                    const result = await response.json();
                    
                    if (result.success && result.data.length > 0) {
                      resultsContainer.innerHTML = result.data.map(function(person) {
                        return '<div class="person-search-result" data-id="' + person.id + '" data-name="' + escapeHtml(person.name) + '">' +
                          escapeHtml(person.name) +
                        '</div>';
                      }).join('');
                      resultsContainer.classList.add('visible');
                      
                      // Add click handlers
                      resultsContainer.querySelectorAll('.person-search-result').forEach(function(el) {
                        el.addEventListener('click', function() {
                          selectedPerson = {
                            id: this.getAttribute('data-id'),
                            name: this.getAttribute('data-name')
                          };
                          searchInput.value = selectedPerson.name;
                          resultsContainer.classList.remove('visible');
                          document.getElementById('addLeaderBtn').disabled = false;
                        });
                      });
                    } else {
                      resultsContainer.innerHTML = '<div class="person-search-result" style="color: #888; cursor: default;">No results found</div>';
                      resultsContainer.classList.add('visible');
                    }
                  } catch (error) {
                    console.error('Search error:', error);
                  }
                }, 300);
              });
              
              // Close results when clicking outside
              document.addEventListener('click', function(e) {
                if (!searchInput.contains(e.target) && !resultsContainer.contains(e.target)) {
                  resultsContainer.classList.remove('visible');
                }
              });
            }
          });
          
          async function addLeader() {
            if (!selectedPerson) return;
            
            const role = document.getElementById('leaderRoleSelect').value;
            const btn = document.getElementById('addLeaderBtn');
            
            btn.disabled = true;
            btn.textContent = 'Adding...';
            
            try {
              const response = await fetch('/api/dream-teams/' + workflowId + '/leaders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  personId: selectedPerson.id,
                  personName: selectedPerson.name,
                  role: role
                })
              });
              
              const result = await response.json();
              
              if (result.success) {
                // Reload leaders
                await loadTeamLeaders();
                
                // Clear form
                document.getElementById('leaderSearchInput').value = '';
                selectedPerson = null;
              } else {
                showAlert('Error', result.error || 'Failed to add leader');
              }
            } catch (error) {
              console.error('Error adding leader:', error);
              showAlert('Error', 'Failed to add leader');
            }
            
            btn.textContent = 'Add';
            btn.disabled = true;
          }
          
          async function removeLeader(personId, role, personName) {
            showConfirm(
              'Remove Leader',
              'Are you sure you want to remove ' + personName + ' as a ' + (role === 'director' ? 'Director' : 'Team Leader') + '?',
              async function() {
                try {
                  const response = await fetch('/api/dream-teams/' + workflowId + '/leaders/' + personId + '?role=' + role, {
                    method: 'DELETE'
                  });
                  
                  const result = await response.json();
                  
                  if (result.success) {
                    await loadTeamLeaders();
                  } else {
                    showAlert('Error', result.error || 'Failed to remove leader');
                  }
                } catch (error) {
                  console.error('Error removing leader:', error);
                  showAlert('Error', 'Failed to remove leader');
                }
              }
            );
          }

          async function loadTeamRoster() {
            const loadingContainer = document.getElementById('loadingContainer');
            const errorContainer = document.getElementById('errorContainer');
            const rosterContainer = document.getElementById('rosterContainer');

            try {
              loadingContainer.style.display = 'block';
              errorContainer.style.display = 'none';
              rosterContainer.style.display = 'none';

              const response = await fetch('/api/dream-teams/' + workflowId);
              const result = await response.json();

              if (!result.success) {
                throw new Error(result.error || 'Failed to fetch team roster');
              }

              teamData = result.data;
              displayTeamRoster();

              loadingContainer.style.display = 'none';
              rosterContainer.style.display = 'block';

            } catch (error) {
              console.error('Error loading team roster:', error);
              document.getElementById('errorMessage').textContent = error.message;
              loadingContainer.style.display = 'none';
              errorContainer.style.display = 'block';
            }
          }

          function sortMembers(members, sortBy) {
            const sorted = [...members]; // Create a copy to avoid mutating original
            
            switch(sortBy) {
              case 'name-asc':
                return sorted.sort(function(a, b) {
                  return a.firstName.localeCompare(b.firstName);
                });
              case 'name-desc':
                return sorted.sort(function(a, b) {
                  return b.firstName.localeCompare(a.firstName);
                });
              case 'date-asc':
                return sorted.sort(function(a, b) {
                  return new Date(a.joinedAt) - new Date(b.joinedAt);
                });
              case 'date-desc':
                return sorted.sort(function(a, b) {
                  return new Date(b.joinedAt) - new Date(a.joinedAt);
                });
              default:
                return sorted.sort(function(a, b) {
                  return a.firstName.localeCompare(b.firstName);
                });
            }
          }

          function displaySortedMembers() {
            const sortSelect = document.getElementById('sortSelect');
            const sortBy = sortSelect.value;
            const sortedMembers = sortMembers(teamData.roster, sortBy);
            
            const memberList = document.getElementById('memberList');
            memberList.innerHTML = sortedMembers.map(function(member) {
              // Format dates
              const startedDate = new Date(member.joinedAt).toLocaleDateString('en-US', {
                month: 'numeric',
                day: 'numeric',
                year: 'numeric'
              });
              
              // Active date is when they completed onboarding (movedToStepAt), or same as started if not completed
              const hasActiveDate = member.stage === 'completed' && member.movedToStepAt && member.movedToStepAt !== member.joinedAt;
              const activeDate = hasActiveDate ? new Date(member.movedToStepAt).toLocaleDateString('en-US', {
                month: 'numeric',
                day: 'numeric',
                year: 'numeric'
              }) : null;
              
              // Build date display
              let dateDisplay = '';
              if (member.stage === 'completed') {
                // Completed members: show both dates (use startedDate for completed if no movedToStepAt)
                const completedDate = activeDate || startedDate;
                dateDisplay = '<span class="date-group"><span class="date-label">Joined:</span> ' + startedDate + '</span>' + 
                              '<span class="date-separator">•</span>' +
                              '<span class="date-group"><span class="date-label">Completed:</span> ' + completedDate + '</span>';
              } else {
                // In-progress members: just show joined date
                dateDisplay = '<span class="date-group"><span class="date-label">Joined:</span> ' + startedDate + '</span>';
              }
              
              // Check if member joined within last 30 days (based on when they first joined/started onboarding)
              const thirtyDaysAgo = new Date();
              thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
              const memberJoinDate = new Date(member.joinedAt);
              const isNewMember = memberJoinDate >= thirtyDaysAgo;
              
              const pendingIndicator = member.markedForRemoval ? 
                '<span class="pending-removal-indicator" title="Pending removal: ' + (member.removalReason || '<No reason provided>') + '">Pending Removal</span>' : '';
              
              const newMemberIndicator = isNewMember ? 
                '<span class="new-member-indicator" title="Joined within the last 30 days">New Member</span>' : '';
                
              const incompleteIndicator = member.stage !== 'completed' ? 
                '<span class="incomplete-indicator" title="Onboarding process not yet completed">In-Progress</span>' : '';
              
              // Check if any check-in is needed
              const hasCheckInNeeded = member.checkIns && (
                (member.checkIns.twoMonth && member.checkIns.twoMonth.needed) ||
                (member.checkIns.sixMonth && member.checkIns.sixMonth.needed)
              );
              const checkInNeededIndicator = hasCheckInNeeded ? 
                '<span class="checkin-needed-indicator" title="This member has a check-in due">Time to Check-In!</span>' : '';
              
              const removeButton = member.markedForRemoval ? 
                '<div class="undo-button" data-member-id="' + member.personId + '" data-member-name="' + member.firstName + ' ' + member.lastName + '" title="Click to undo removal">Undo</div>' :
                '<div class="remove-checkbox" data-member-id="' + member.personId + '" data-member-name="' + member.firstName + ' ' + member.lastName + '">✗</div>';
              
              // Build check-ins section - only show if there are check-ins that are due or completed
              let checkInsHtml = '';
              if (member.checkIns) {
                let checkInItems = '';
                
                // Helper to format date as M/D/YYYY
                function formatCheckInDate(dateStr) {
                  if (!dateStr) return '';
                  const parts = dateStr.split('-');
                  if (parts.length === 3) {
                    return parseInt(parts[1]) + '/' + parseInt(parts[2]) + '/' + parts[0];
                  }
                  return dateStr;
                }
                
                // 2-month check-in - only show if needed or completed (not if member < 2 months)
                if (member.checkIns.twoMonth) {
                  const twoMonth = member.checkIns.twoMonth;
                  if (twoMonth.completed) {
                    if (twoMonth.isLegacy) {
                      // Legacy check-in - just show checkmark, no details
                      checkInItems += '<div class="checkin-item">' +
                        '<input type="checkbox" class="checkin-checkbox" checked disabled>' +
                        '<span class="checkin-label completed">2-Month Check-In ✓</span>' +
                      '</div>';
                    } else {
                      // Regular completed check-in with details
                      const completedInfo = formatCheckInDate(twoMonth.completedDate) + ' by ' + (twoMonth.completedBy || '');
                      checkInItems += '<div class="checkin-item">' +
                        '<input type="checkbox" class="checkin-checkbox" checked disabled>' +
                        '<span class="checkin-label completed">2-Month Check-In ✓</span>' +
                        '<span class="checkin-completed-info">' + completedInfo + '</span>' +
                      '</div>';
                    }
                  } else if (twoMonth.needed) {
                    // Needs completion
                    checkInItems += '<div class="checkin-item" data-checkin-type="2-month" data-person-id="' + member.personId + '">' +
                      '<input type="checkbox" class="checkin-checkbox checkin-trigger">' +
                      '<span class="checkin-label needed">2-Month Check-In</span>' +
                    '</div>' +
                    '<div class="checkin-form" data-checkin-type="2-month" data-person-id="' + member.personId + '">' +
                      '<input type="text" class="checkin-completed-by" placeholder="Your name">' +
                      '<button type="button" class="checkin-submit-btn">Save</button>' +
                      '<button type="button" class="cancel-btn checkin-cancel-btn">✕</button>' +
                    '</div>';
                  }
                }
                
                // 6-month check-in - only show if needed or completed (hide "not yet due")
                if (member.checkIns.sixMonth) {
                  const sixMonth = member.checkIns.sixMonth;
                  if (sixMonth.completed) {
                    if (sixMonth.isLegacy) {
                      // Legacy check-in - just show checkmark, no details
                      checkInItems += '<div class="checkin-item">' +
                        '<input type="checkbox" class="checkin-checkbox" checked disabled>' +
                        '<span class="checkin-label completed">6-Month Check-In ✓</span>' +
                      '</div>';
                    } else {
                      // Regular completed check-in with details
                      const completedInfo = formatCheckInDate(sixMonth.completedDate) + ' by ' + (sixMonth.completedBy || '');
                      checkInItems += '<div class="checkin-item">' +
                        '<input type="checkbox" class="checkin-checkbox" checked disabled>' +
                        '<span class="checkin-label completed">6-Month Check-In ✓</span>' +
                        '<span class="checkin-completed-info">' + completedInfo + '</span>' +
                      '</div>';
                    }
                  } else if (sixMonth.needed) {
                    // Needs completion (6 months reached)
                    checkInItems += '<div class="checkin-item" data-checkin-type="6-month" data-person-id="' + member.personId + '">' +
                      '<input type="checkbox" class="checkin-checkbox checkin-trigger">' +
                      '<span class="checkin-label needed">6-Month Check-In</span>' +
                    '</div>' +
                    '<div class="checkin-form" data-checkin-type="6-month" data-person-id="' + member.personId + '">' +
                      '<input type="text" class="checkin-completed-by" placeholder="Your name">' +
                      '<button type="button" class="checkin-submit-btn">Save</button>' +
                      '<button type="button" class="cancel-btn checkin-cancel-btn">✕</button>' +
                    '</div>';
                  }
                  // Don't show anything if not yet due
                }
                
                // Only add the section wrapper if there are items to show
                if (checkInItems) {
                  checkInsHtml = '<div class="checkins-section" data-person-id="' + member.personId + '">' + checkInItems + '</div>';
                }
              }
              
              // Build at-a-glance check-in status indicator
              let checkInStatusHtml = '';
              if (member.checkIns && (member.checkIns.twoMonth || member.checkIns.sixMonth)) {
                const twoMonth = member.checkIns.twoMonth;
                const sixMonth = member.checkIns.sixMonth;
                
                // Determine 2-month status
                let twoMonthStatus = '';
                if (twoMonth) {
                  if (twoMonth.completed) {
                    twoMonthStatus = '<span class="status-done">2✓</span>';
                  } else if (twoMonth.needed) {
                    twoMonthStatus = '<span class="status-pending">2✗</span>';
                  }
                }
                
                // Determine 6-month status
                let sixMonthStatus = '';
                if (sixMonth) {
                  if (sixMonth.completed) {
                    sixMonthStatus = '<span class="status-done">6✓</span>';
                  } else if (sixMonth.needed) {
                    sixMonthStatus = '<span class="status-pending">6✗</span>';
                  }
                  // Don't show anything if not yet due
                }
                
                // Only show indicator if there's something to show
                if (twoMonthStatus || sixMonthStatus) {
                  checkInStatusHtml = '<span class="checkin-status" data-person-id="' + member.personId + '" title="Click to view check-in details">' +
                    twoMonthStatus + sixMonthStatus +
                    '<span class="expand-icon">▼</span>' +
                  '</span>';
                }
              }
              
              return '<div class="member-item" data-member-id="' + member.personId + '">' +
                       '<div class="member-info">' +
                         '<div class="member-name-row">' +
                           '<div class="member-name">' + member.firstName + ' ' + member.lastName + '</div>' +
                           checkInStatusHtml +
                         '</div>' +
                         '<div class="join-date">' + 
                           '<span class="date">' + dateDisplay + '</span>' +
                           '<div class="badges-container">' +
                             (newMemberIndicator || incompleteIndicator || pendingIndicator || checkInNeededIndicator ? 
                               [newMemberIndicator, incompleteIndicator, checkInNeededIndicator, pendingIndicator].filter(Boolean).join('') : '') +
                           '</div>' +
                         '</div>' +
                         checkInsHtml +
                       '</div>' +
                       removeButton +
                     '</div>';
            }).join('');
            
            // Re-setup checkbox listeners after updating the HTML
            setupCheckboxListeners();
            
            // Setup check-in listeners
            setupCheckInListeners();
          }

          function displayTeamRoster() {
            // Update team header info
            document.getElementById('teamName').textContent = teamData.workflowName + ' Team Roster';
            
            // Update pending removal count in separate div
            const pendingCountDiv = document.getElementById('pendingCount');
            if (teamData.pendingRemovalsCount > 0) {
              pendingCountDiv.textContent = '(' + teamData.pendingRemovalsCount + ' pending removal' + (teamData.pendingRemovalsCount === 1 ? '' : 's') + ')';
              pendingCountDiv.style.display = 'block';
            } else {
              pendingCountDiv.style.display = 'none';
            }
            
            let lastReviewedText;
            if (teamData.lastReviewed) {
              // Fix: Parse date as local time, not UTC
              // "2025-08-14" -> treat as local date, not UTC midnight
              const dateParts = teamData.lastReviewed.split('-');
              const localDate = new Date(parseInt(dateParts[0]), parseInt(dateParts[1]) - 1, parseInt(dateParts[2]));
              lastReviewedText = 'Last Reviewed: ' + localDate.toLocaleDateString();
            } else {
              lastReviewedText = 'Last Reviewed: Never';
            }
            
            if (teamData.lastReviewer) {
              lastReviewedText += ' by ' + teamData.lastReviewer;
            }
            
            document.getElementById('lastUpdated').textContent = lastReviewedText;
            
            // Update member count
            document.getElementById('memberCount').textContent = teamData.roster.length;
            
            // Display current members
            displaySortedMembers();
            
            // Setup sort change listener
            document.getElementById('sortSelect').addEventListener('change', function() {
              displaySortedMembers();
            });
            
            // Display past members
            displayPastMembers();
          }
          
          function displayPastMembers() {
            const pastMembersList = document.getElementById('pastMembersList');
            
            if (teamData.pastMembers && teamData.pastMembers.length > 0) {
              // Sort past members by removal date, descending (most recent first)
              const sortedPastMembers = teamData.pastMembers.slice().sort(function(a, b) {
                return new Date(b.removalDate).getTime() - new Date(a.removalDate).getTime();
              });
              
              pastMembersList.innerHTML = sortedPastMembers.map(function(member) {
                const removalDate = new Date(member.removalDate).toLocaleDateString('en-US', {
                  month: 'numeric',
                  day: 'numeric',
                  year: 'numeric'
                });
                
                return '<div class="past-member-item">' +
                         member.firstName + ' ' + member.lastName + ' - Removed ' + removalDate +
                         ' by ' + member.reviewerName + 
                         (member.reason ? ' (' + member.reason + ')' : '') +
                       '</div>';
              }).join('');
            } else {
              pastMembersList.innerHTML = '<div class="past-member-item">No past members</div>';
            }
          }

          function setupCheckboxListeners() {
            const checkboxes = document.querySelectorAll('.remove-checkbox');
            checkboxes.forEach(function(checkbox) {
              checkbox.addEventListener('click', function() {
                // Ignore clicks on disabled buttons
                if (this.classList.contains('disabled')) {
                  return;
                }
                
                if (this.classList.contains('selected')) {
                  // Already selected, unselect it
                  this.classList.remove('selected');
                  // Remove from pending removals
                  pendingRemovals = pendingRemovals.filter(function(removal) {
                    return removal.memberId !== checkbox.dataset.memberId;
                  });
                  updateActionButtons();
                } else {
                  // Not selected, show reason modal
                  currentMemberForRemoval = {
                    id: this.dataset.memberId,
                    name: this.dataset.memberName,
                    checkbox: this
                  };
                  document.getElementById('reasonModal').style.display = 'block';
                  // Disable confirm button initially
                  document.getElementById('confirmRemoval').disabled = true;
                  // Clear textarea
                  document.getElementById('removalReason').value = '';
                }
              });
            });
            
            // Setup undo button listeners
            const undoButtons = document.querySelectorAll('.undo-button');
            undoButtons.forEach(function(undoButton) {
              undoButton.addEventListener('click', function() {
                const memberId = this.dataset.memberId;
                const memberName = this.dataset.memberName;
                
                // Store current member for undo and show custom modal
                currentMemberForUndo = {
                  id: memberId,
                  name: memberName
                };
                
                document.getElementById('undoMessage').textContent = 
                  'Are you sure you want to undo the removal of ' + memberName + '?';
                document.getElementById('undoModal').style.display = 'block';
              });
            });
          }

          function setupCheckInListeners() {
            // Handle status indicator clicks to toggle check-in section
            const statusIndicators = document.querySelectorAll('.checkin-status');
            statusIndicators.forEach(function(indicator) {
              indicator.addEventListener('click', function(e) {
                e.stopPropagation(); // Prevent event bubbling
                const personId = this.dataset.personId;
                const section = document.querySelector('.checkins-section[data-person-id="' + personId + '"]');
                
                if (section) {
                  // Simply toggle this section (allow multiple open)
                  section.classList.toggle('visible');
                  this.classList.toggle('expanded');
                }
              });
            });
            
            // Handle checkbox clicks to show the form
            const checkInTriggers = document.querySelectorAll('.checkin-trigger');
            checkInTriggers.forEach(function(checkbox) {
              checkbox.addEventListener('change', function() {
                const checkinItem = this.closest('.checkin-item');
                const personId = checkinItem.dataset.personId;
                const checkInType = checkinItem.dataset.checkinType;
                
                // Find the corresponding form
                const form = document.querySelector('.checkin-form[data-person-id="' + personId + '"][data-checkin-type="' + checkInType + '"]');
                
                if (this.checked) {
                  form.classList.add('visible');
                  form.querySelector('.checkin-completed-by').focus();
                } else {
                  form.classList.remove('visible');
                  form.querySelector('.checkin-completed-by').value = '';
                }
              });
            });
            
            // Handle form submission
            const submitButtons = document.querySelectorAll('.checkin-submit-btn');
            submitButtons.forEach(function(button) {
              button.addEventListener('click', async function() {
                const form = this.closest('.checkin-form');
                const personId = form.dataset.personId;
                const checkInType = form.dataset.checkinType;
                const completedByInput = form.querySelector('.checkin-completed-by');
                const completedBy = completedByInput.value.trim();
                
                if (!completedBy) {
                  showAlert('Required Field', 'Please enter your name to complete this check-in.');
                  completedByInput.focus();
                  return;
                }
                
                // Disable the button while submitting
                button.disabled = true;
                button.textContent = 'Saving...';
                
                try {
                  const response = await fetch('/api/dream-teams/' + workflowId + '/checkin', {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                      personId: personId,
                      checkInType: checkInType,
                      completedBy: completedBy
                    })
                  });
                  
                  const result = await response.json();
                  
                  if (result.success) {
                    // Refresh the team roster to show updated state
                    loadTeamRoster();
                  } else {
                    showAlert('Error', 'Failed to save check-in: ' + (result.error || 'Unknown error'));
                    button.disabled = false;
                    button.textContent = 'Submit';
                  }
                } catch (error) {
                  console.error('Error saving check-in:', error);
                  showAlert('Error', 'Failed to save check-in. Please try again.');
                  button.disabled = false;
                  button.textContent = 'Submit';
                }
              });
            });
            
            // Handle cancel button
            const cancelButtons = document.querySelectorAll('.checkin-cancel-btn');
            cancelButtons.forEach(function(button) {
              button.addEventListener('click', function() {
                const form = this.closest('.checkin-form');
                const personId = form.dataset.personId;
                const checkInType = form.dataset.checkinType;
                
                // Find the corresponding checkbox and uncheck it
                const checkinItem = document.querySelector('.checkin-item[data-person-id="' + personId + '"][data-checkin-type="' + checkInType + '"]');
                const checkbox = checkinItem.querySelector('.checkin-checkbox');
                checkbox.checked = false;
                
                // Hide the form and clear input
                form.classList.remove('visible');
                form.querySelector('.checkin-completed-by').value = '';
              });
            });
          }

          function updateActionButtons() {
            const noChangesBtn = document.getElementById('noChangesBtn');
            const confirmChangesBtn = document.getElementById('confirmChangesBtn');
            
            if (pendingRemovals.length > 0) {
              noChangesBtn.style.display = 'none';
              confirmChangesBtn.classList.add('visible');
              confirmChangesBtn.textContent = 'Confirm Changes (' + pendingRemovals.length + ' removal' + 
                                              (pendingRemovals.length > 1 ? 's' : '') + ')';
            } else {
              noChangesBtn.style.display = 'inline-block';
              confirmChangesBtn.classList.remove('visible');
            }
          }

          function undoRemoval(memberId, memberName) {
            fetch('/api/dream-teams/' + workflowId + '/undo-removal', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                memberId: memberId
              })
            })
            .then(function(response) {
              return response.json();
            })
            .then(function(result) {
              if (result.success) {
                // Refresh the team roster to show updated state
                loadTeamRoster();
              } else {
                showAlert('Error', 'Failed to undo removal: ' + (result.error || 'Unknown error'));
              }
            })
            .catch(function(error) {
              console.error('Error undoing removal:', error);
              showAlert('Error', 'Failed to undo removal. Please try again.');
            });
          }

          // Modal event listeners
          // Enable/disable confirm button based on textarea input
          document.getElementById('removalReason').addEventListener('input', function() {
            const confirmButton = document.getElementById('confirmRemoval');
            confirmButton.disabled = this.value.trim() === '';
          });

          document.getElementById('cancelRemoval').addEventListener('click', function() {
            if (currentMemberForRemoval) {
              currentMemberForRemoval.checkbox.classList.remove('selected');
              currentMemberForRemoval = null;
            }
            document.getElementById('reasonModal').style.display = 'none';
            document.getElementById('removalReason').value = '';
          });

          document.getElementById('confirmRemoval').addEventListener('click', function() {
            if (currentMemberForRemoval) {
              const reason = document.getElementById('removalReason').value.trim();
              
              pendingRemovals.push({
                memberId: currentMemberForRemoval.id,
                memberName: currentMemberForRemoval.name,
                reason: reason
              });
              
              // Mark the checkbox as selected
              currentMemberForRemoval.checkbox.classList.add('selected');
              
              updateActionButtons();
              currentMemberForRemoval = null;
            }
            document.getElementById('reasonModal').style.display = 'none';
            document.getElementById('removalReason').value = '';
          });

          // Undo modal event listeners
          document.getElementById('cancelUndo').addEventListener('click', function() {
            currentMemberForUndo = null;
            document.getElementById('undoModal').style.display = 'none';
          });

          document.getElementById('confirmUndo').addEventListener('click', function() {
            if (currentMemberForUndo) {
              undoRemoval(currentMemberForUndo.id, currentMemberForUndo.name);
              currentMemberForUndo = null;
            }
            document.getElementById('undoModal').style.display = 'none';
          });

          // Generic alert modal event listeners
          document.getElementById('alertOk').addEventListener('click', function() {
            document.getElementById('alertModal').style.display = 'none';
          });

          // Generic confirmation modal event listeners
          document.getElementById('confirmCancel').addEventListener('click', function() {
            currentConfirmCallback = null;
            document.getElementById('confirmModal').style.display = 'none';
          });

          document.getElementById('confirmOk').addEventListener('click', function() {
            if (currentConfirmCallback) {
              currentConfirmCallback();
              currentConfirmCallback = null;
            }
            document.getElementById('confirmModal').style.display = 'none';
          });

          // Action button listeners
          document.getElementById('noChangesBtn').addEventListener('click', async function() {
            try {
              const reviewerName = document.getElementById('reviewerName').value.trim();
              
              if (!reviewerName) {
                showAlert('Required Field', 'Please enter your name before proceeding.');
                return;
              }
              
              this.disabled = true;
              this.textContent = 'Recording...';
              
              const response = await fetch('/api/dream-teams/' + workflowId + '/review', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  workflowName: teamData.workflowName,
                  reviewerName: reviewerName,
                  notes: 'No changes needed'
                })
              });
              
              const result = await response.json();
              
              if (result.success) {
                // Refresh the page to show updated last reviewed date
                window.location.reload();
              } else {
                showAlert('Error', result.error);
              }
            } catch (error) {
              console.error('Error recording review:', error);
              showAlert('Error', 'Failed to record review');
            } finally {
              this.disabled = false;
              this.textContent = 'No Changes';
            }
          });

          document.getElementById('confirmChangesBtn').addEventListener('click', async function() {
            try {
              const reviewerName = document.getElementById('reviewerName').value.trim();
              
              if (!reviewerName) {
                showAlert('Required Field', 'Please enter your name before proceeding.');
                return;
              }
              
              if (pendingRemovals.length === 0) {
                showAlert('No Selection', 'No removals selected. Please select members to remove or click "No Changes".');
                return;
              }
              
              this.disabled = true;
              this.textContent = 'Processing...';
              
              const response = await fetch('/api/dream-teams/' + workflowId + '/removals', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  workflowName: teamData.workflowName,
                  reviewerName: reviewerName,
                  removals: pendingRemovals.map(function(r) {
                    return {
                      personId: r.memberId,
                      firstName: r.memberName.split(' ')[0],
                      lastName: r.memberName.split(' ').slice(1).join(' '),
                      reason: r.reason
                    };
                  })
                })
              });
              
              const result = await response.json();
              
              if (result.success) {
                // Refresh the page to show updated data
                window.location.reload();
              } else {
                showAlert('Error', result.error);
              }
            } catch (error) {
              console.error('Error recording removals:', error);
              showAlert('Error', 'Failed to record removals');
            } finally {
              this.disabled = false;
              this.textContent = 'Confirm Changes';
            }
          });

          // Add Member Info Box toggle functionality
          document.getElementById('addMemberBtn').addEventListener('click', function() {
            const infoBox = document.getElementById('addMemberInfo');
            infoBox.classList.toggle('visible');
            
            // Change button text based on state
            if (infoBox.classList.contains('visible')) {
              this.innerHTML = 'Hide';
            } else {
              this.innerHTML = 'Add A Member';
            }
          });

          // Copy link button functionality
          document.querySelectorAll('.copy-link-btn').forEach(button => {
            button.addEventListener('click', async function() {
              const link = this.dataset.link;
              try {
                await navigator.clipboard.writeText(link);
                
                // Visual feedback
                const originalText = this.innerHTML;
                this.innerHTML = '<span>✓</span>Copied!';
                this.classList.add('copied');
                
                // Reset after 2 seconds
                setTimeout(() => {
                  this.innerHTML = originalText;
                  this.classList.remove('copied');
                }, 2000);
              } catch (err) {
                console.error('Failed to copy link:', err);
                alert('Failed to copy link. Please try again.');
              }
            });
          });

          // Load team roster and leaders on page load
          loadTeamRoster();
          loadTeamLeaders();
        </script>
      </body>
      </html>
    `;
    
    res.send(html);
  } catch (error) {
    console.error('Error rendering team roster page:', error);
    res.status(500).send('Error loading page');
  }
});

// ==================== REPLENISHMENT REQUESTS API ENDPOINTS ====================

// Get all departments
app.get('/api/replenishment/departments', async (req, res) => {
  try {
    const departments = replenishmentRequests.getDepartments();
    res.json(departments);
  } catch (error) {
    console.error('Error fetching departments:', error);
    res.status(500).json({ error: 'Failed to fetch departments' });
  }
});

// Get all items (with department info)
app.get('/api/replenishment/items', async (req, res) => {
  try {
    const items = replenishmentRequests.getAllItems();
    res.json(items);
  } catch (error) {
    console.error('Error fetching items:', error);
    res.status(500).json({ error: 'Failed to fetch items' });
  }
});

// Get items for a specific department
app.get('/api/replenishment/departments/:departmentId/items', async (req, res) => {
  try {
    const { departmentId } = req.params;
    const items = replenishmentRequests.getItemsByDepartment(parseInt(departmentId));
    res.json(items);
  } catch (error) {
    console.error('Error fetching department items:', error);
    res.status(500).json({ error: 'Failed to fetch department items' });
  }
});

// Get all requests
app.get('/api/replenishment/requests', async (req, res) => {
  try {
    const { status } = req.query;
    
    if (status && typeof status === 'string') {
      const requests = replenishmentRequests.getRequestsByStatus(status);
      res.json(requests);
    } else {
      const requests = replenishmentRequests.getAllRequests();
      res.json(requests);
    }
  } catch (error) {
    console.error('Error fetching requests:', error);
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
});

// Create a new request
app.post('/api/replenishment/requests', async (req, res) => {
  try {
    const { itemId, departmentId, quantityRequested, requestedByPersonId, requestedByName, orderContacts, notes } = req.body;
    
    if (!itemId || !departmentId || !quantityRequested) {
      return res.status(400).json({ 
        error: 'Missing required fields: itemId, departmentId, quantityRequested' 
      });
    }
    
    if (
      requestedByPersonId === undefined ||
      requestedByPersonId === null ||
      String(requestedByPersonId).trim() === '' ||
      requestedByName === undefined ||
      requestedByName === null ||
      String(requestedByName).trim() === ''
    ) {
      return res.status(400).json({
        error: 'Requester must be selected from Planning Center (your profile).'
      });
    }
    
    if (!Array.isArray(orderContacts) || orderContacts.length === 0) {
      return res.status(400).json({
        error: 'Add at least one person who should order or be notified about this request.'
      });
    }
    
    const normalizedContacts: Array<{ personId: string; personName: string }> = [];
    const seenIds = new Set<string>();
    for (const c of orderContacts) {
      if (!c || typeof c !== 'object') continue;
      const pid = String((c as { personId?: unknown }).personId ?? '').trim();
      const pname = String((c as { personName?: unknown }).personName ?? '').trim();
      if (!pid || !pname || seenIds.has(pid)) continue;
      seenIds.add(pid);
      normalizedContacts.push({ personId: pid, personName: pname });
    }
    
    if (normalizedContacts.length === 0) {
      return res.status(400).json({
        error: 'Add at least one valid person who should order or be notified about this request.'
      });
    }
    
    const requestId = replenishmentRequests.createRequest(
      parseInt(itemId),
      parseInt(departmentId),
      parseInt(quantityRequested),
      String(requestedByPersonId).trim(),
      String(requestedByName).trim(),
      normalizedContacts,
      notes
    );

    // Best effort: send notification email(s) to the selected order contacts.
    // Request creation should still succeed if email fails.
    try {
      const notificationResult = await sendReplenishmentRequestNotifications({
        requestId,
        itemId: parseInt(itemId),
        departmentId: parseInt(departmentId),
        quantityRequested: parseInt(quantityRequested),
        requestedByPersonId: String(requestedByPersonId).trim(),
        requestedByName: String(requestedByName).trim(),
        orderContacts: normalizedContacts,
        notes: typeof notes === 'string' ? notes : ''
      });
      console.log('Replenishment notification result:', notificationResult);
    } catch (notificationError) {
      console.error(`Non-fatal: failed to send replenishment notifications for request ${requestId}:`, notificationError);
    }
    
    res.json({ 
      success: true, 
      requestId,
      message: 'Request created successfully' 
    });
  } catch (error) {
    console.error('Error creating request:', error);
    res.status(500).json({ error: 'Failed to create request' });
  }
});

// Update request status
app.post('/api/replenishment/requests/:requestId/status', async (req, res) => {
  try {
    const { requestId } = req.params;
    const { status, changedBy, changedByPersonId, sendEmailNotification, notes } = req.body;
    
    // Validate required fields
    if (!status || !changedBy) {
      return res.status(400).json({ 
        error: 'Missing required fields: status, changedBy' 
      });
    }
    
    // Validate status
    const validStatuses = ['requested', 'ordered', 'delivered', 'stocked'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ 
        error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` 
      });
    }

    if ((status === 'ordered' || status === 'delivered' || status === 'stocked') && (!changedByPersonId || String(changedByPersonId).trim() === '')) {
      return res.status(400).json({
        error: 'Changed by user must be selected from Planning Center for ordered, delivered, and stocked updates.'
      });
    }
    
    const requestIdNum = parseInt(requestId);
    replenishmentRequests.updateRequestStatus(
      requestIdNum,
      status,
      changedBy,
      notes
    );

    if ((status === 'ordered' || status === 'delivered') ? sendEmailNotification === true : status === 'stocked') {
      try {
        const requestData = replenishmentRequests.getAllRequests().find((r) => r.id === requestIdNum);
        if (requestData) {
          const result = await sendReplenishmentStatusNotifications({
            requestId: requestData.id,
            itemName: requestData.item_name,
            departmentName: requestData.department_name,
            quantityRequested: requestData.quantity_requested,
            unit: requestData.unit,
            requestedByName: requestData.requested_by,
            requestedByPersonId: requestData.requested_by_person_id || null,
            orderContacts: requestData.order_contact_people || [],
            newStatus: status,
            changedByName: String(changedBy).trim(),
            currentStockTotal: requestData.current_stock
          });
          console.log(`Replenishment status notification result for request ${requestIdNum}:`, result);
        }
      } catch (notificationError) {
        console.error(`Non-fatal: failed sending replenishment status notifications for request ${requestIdNum}:`, notificationError);
      }
    }
    
    res.json({ 
      success: true, 
      message: `Request status updated to ${status}` 
    });
  } catch (error) {
    console.error('Error updating request status:', error);
    res.status(500).json({ error: 'Failed to update request status' });
  }
});

// Delete request
app.delete('/api/replenishment/requests/:requestId', async (req, res) => {
  try {
    const { requestId } = req.params;
    const { reason } = req.body;
    
    replenishmentRequests.deleteRequest(
      parseInt(requestId),
      reason || null
    );
    
    res.json({ 
      success: true, 
      message: 'Request deleted successfully' 
    });
  } catch (error) {
    console.error('Error deleting request:', error);
    res.status(500).json({ error: 'Failed to delete request' });
  }
});

// Get request history (audit log)
app.get('/api/replenishment/requests/:requestId/history', async (req, res) => {
  try {
    const { requestId } = req.params;
    const history = replenishmentRequests.getRequestHistory(parseInt(requestId));
    res.json(history);
  } catch (error) {
    console.error('Error fetching request history:', error);
    res.status(500).json({ error: 'Failed to fetch request history' });
  }
});

// Update item stock manually
app.post('/api/replenishment/items/:itemId/stock', async (req, res) => {
  try {
    const { itemId } = req.params;
    const { stock } = req.body;
    
    if (stock === undefined || stock === null) {
      return res.status(400).json({ 
        error: 'Missing required field: stock' 
      });
    }
    
    replenishmentRequests.updateItemStock(parseInt(itemId), parseInt(stock));
    
    res.json({ 
      success: true, 
      message: 'Item stock updated successfully' 
    });
  } catch (error) {
    console.error('Error updating item stock:', error);
    res.status(500).json({ error: 'Failed to update item stock' });
  }
});

// ===== DEPARTMENT MANAGEMENT ENDPOINTS =====

// Create a new department
app.post('/api/replenishment/departments', async (req, res) => {
  try {
    const { name } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Serve Area name is required' });
    }
    
    const departmentId = replenishmentRequests.createDepartment(name);
    res.json({ success: true, departmentId });
  } catch (error) {
    console.error('Error creating department:', error);
    res.status(500).json({ error: 'Failed to create department' });
  }
});

// Update a department
app.put('/api/replenishment/departments/:departmentId', async (req, res) => {
  try {
    const { departmentId } = req.params;
    const { name } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Serve Area name is required' });
    }
    
    replenishmentRequests.updateDepartment(parseInt(departmentId), name);
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating department:', error);
    res.status(500).json({ error: 'Failed to update department' });
  }
});

// Delete a department
app.delete('/api/replenishment/departments/:departmentId', async (req, res) => {
  try {
    const { departmentId } = req.params;
    
    replenishmentRequests.deleteDepartment(parseInt(departmentId));
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting department:', error);
    res.status(500).json({ error: 'Failed to delete department' });
  }
});

// ===== ITEM MANAGEMENT ENDPOINTS =====

// Create a new item
app.post('/api/replenishment/items', async (req, res) => {
  try {
    const { departmentId, name, description, location, url, currentStock, minThreshold, unit, lastUpdatedStock } = req.body;

    if (!departmentId || !name || currentStock === undefined || minThreshold === undefined || !unit) {
      return res.status(400).json({
        error: 'Missing required fields: departmentId, name, currentStock, minThreshold, unit'
      });
    }

    const itemId = replenishmentRequests.createItem(
      parseInt(departmentId),
      name,
      description || '',
      location || '',
      url || '',
      parseInt(currentStock),
      parseInt(minThreshold),
      unit,
      lastUpdatedStock || Date.now()
    );
    res.json({ success: true, itemId });
  } catch (error: any) {
    // Check if it's a duplicate name error (user-facing error, don't log)
    if (error.isDuplicateError) {
      return res.status(409).json({
        error: error.message
      });
    }

    // Unexpected error - log it
    console.error('Error creating item:', error);
    res.status(500).json({ error: 'Failed to create item' });
  }
});

// Update an item
app.put('/api/replenishment/items/:itemId', async (req, res) => {
  try {
    const { itemId } = req.params;
    const { name, description, location, url, currentStock, minThreshold, unit, lastUpdatedStock } = req.body;

    if (!name || currentStock === undefined || minThreshold === undefined || !unit) {
      return res.status(400).json({
        error: 'Missing required fields: name, currentStock, minThreshold, unit'
      });
    }

    replenishmentRequests.updateItem(
      parseInt(itemId),
      name,
      description || '',
      location || '',
      url || '',
      parseInt(currentStock),
      parseInt(minThreshold),
      unit,
      lastUpdatedStock || Date.now()
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating item:', error);
    res.status(500).json({ error: 'Failed to update item' });
  }
});

// Delete an item
app.delete('/api/replenishment/items/:itemId', async (req, res) => {
  try {
    const { itemId } = req.params;
    
    replenishmentRequests.deleteItem(parseInt(itemId));
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting item:', error);
    res.status(500).json({ error: 'Failed to delete item' });
  }
});

// ==================== REPLENISHMENT REQUESTS UI ====================

// Replenishment Requests - Main dashboard
app.get('/replenishment-requests', async (req, res) => {
  try {
    // Fetch initial data
    const departments = replenishmentRequests.getDepartments();
    const items = replenishmentRequests.getAllItems();
    const allRequests = replenishmentRequests.getAllRequests();
    
    // Calculate stats
    const requestedCount = allRequests.filter(r => r.status === 'requested').length;
    const orderedCount = allRequests.filter(r => r.status === 'ordered').length;
    const deliveredCount = allRequests.filter(r => r.status === 'delivered').length;
    const stockedThisMonth = allRequests.filter(r => {
      if (r.status !== 'stocked' || !r.stocked_date) return false;
      const stockedDate = new Date(r.stocked_date);
      const now = new Date();
      return stockedDate.getMonth() === now.getMonth() && 
             stockedDate.getFullYear() === now.getFullYear();
    }).length;
    
    const lowStockItems = items.filter(item => item.needs_replenishment);
    
    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>QCC Hub - Replenishment Requests</title>
        <link rel="icon" type="image/x-icon" href="https://www.queencitypeople.com/favicon.ico">
        <style>
          body {
            font-family: Arial, sans-serif;
            margin: 20px;
            background-color: #f5f5f5;
            transition: background-color 0.3s ease;
          }
          
          /* Dark mode styles */
          body.dark-mode {
            background-color: #1a1a1a;
          }
          
          body.dark-mode .container {
            background-color: #2d2d2d;
            color: #ffffff;
          }
          
          body.dark-mode h1 {
            color: #ffffff;
          }
          
          body.dark-mode h2 {
            color: #ffffff;
          }
          
          body.dark-mode .header {
            border-bottom-color: #555;
          }
          
          body.dark-mode .info-card {
            background-color: #3d3d3d;
            border-color: #555;
            color: #ffffff;
          }
          
          body.dark-mode .info-card h3 {
            color: #ffffff;
          }
          
          body.dark-mode .info-card p {
            color: #cccccc;
          }
          
          body.dark-mode .new-request-button {
            background-color: #6f42c1;
          }
          
          body.dark-mode .new-request-button:hover {
            background-color: #5a32a3;
          }
          
          body.dark-mode .refresh-button {
            background-color: #007bff;
          }
          
          body.dark-mode .refresh-button:hover {
            background-color: #0056b3;
          }
          
          body.dark-mode .coming-soon-message {
            background-color: #3d3d3d;
            border-color: #6f42c1;
            color: #ffffff;
          }
          
          body.dark-mode .tabs {
            border-bottom-color: #555;
          }
          
          body.dark-mode .tab-button {
            background-color: #2d2d2d;
            color: #cccccc;
            border-color: #555;
          }
          
          body.dark-mode .tab-button:hover {
            background-color: #3d3d3d;
          }
          
          body.dark-mode .tab-button.active {
            background-color: #6f42c1;
            color: #ffffff;
            border-bottom-color: #6f42c1;
          }
          
          body.dark-mode .tab-content {
            background-color: #2d2d2d;
          }
          
          body.dark-mode .request-card {
            background-color: #3d3d3d;
            border-color: #555;
          }
          
          body.dark-mode .status-header {
            color: #ffffff;
            border-bottom-color: #555;
          }
          
          body.dark-mode .status-header:hover {
            background-color: #3d3d3d;
          }
          
          body.dark-mode .inventory-section h3:hover {
            background-color: #3d3d3d;
          }
          
          body.dark-mode .serve-area-star {
            color: #e0e0e0;
          }
          
          body.dark-mode .serve-area-star.favorited {
            color: #ffc107;
            text-shadow: 0 0 3px rgba(0,0,0,0.4);
          }
          
          body.dark-mode .edit-mode-toggle {
            background-color: #495057;
          }
          
          body.dark-mode .edit-mode-toggle:hover {
            background-color: #3d4349;
          }
          
          body.dark-mode .edit-mode-toggle.active {
            background-color: #9d7bd8;
          }
          
          body.dark-mode .edit-mode-toggle.active:hover {
            background-color: #8a6bc4;
          }
          
          body.dark-mode .add-serve-area-btn {
            background-color: #2d8a3e;
          }
          
          body.dark-mode .add-serve-area-btn:hover {
            background-color: #256d32;
          }
          
          body.dark-mode .add-item-btn {
            background-color: #2d8a3e;
          }
          
          body.dark-mode .add-item-btn:hover {
            background-color: #256d32;
          }
          
          body.dark-mode .form-container {
            background-color: #3d3d3d;
          }
          
          body.dark-mode input,
          body.dark-mode select,
          body.dark-mode textarea {
            background-color: #2d2d2d;
            color: #ffffff;
            border-color: #555;
          }
          
          body.dark-mode .inventory-card {
            background-color: #3d3d3d;
            border-color: #555;
          }
          
          body.dark-mode .inventory-card.low-stock {
            border-color: #ff9800;
            background-color: #4a3520;
          }
          
          body.dark-mode .history-card {
            background-color: #3d3d3d;
            border-color: #555;
          }
          
          body.dark-mode .low-stock-alert {
            background-color: #4a3520;
            border-color: #ff9800;
          }
          
          body.dark-mode .low-stock-alert h3 {
            color: #ffc107;
          }
          
          body.dark-mode .low-stock-item {
            background-color: #3d3d3d;
          }
          
          body.dark-mode .empty-state {
            color: #aaa;
          }
          
          body.dark-mode .detail-row .label {
            color: #bbb;
          }
          
          body.dark-mode .detail-row {
            color: #ddd;
          }
          
          body.dark-mode .form-group label {
            color: #ddd;
          }
          
          body.dark-mode .inventory-threshold {
            color: #bbb;
          }

          body.dark-mode .inventory-description {
            color: #999;
          }

          body.dark-mode .inventory-last-updated {
            color: #aaa;
          }

          body.dark-mode .stock-unit {
            color: #bbb;
          }
          
          body.dark-mode .inventory-section h3 {
            color: #9d7bd8;
          }
          
          body.dark-mode .stock-number {
            color: #9d7bd8;
          }
          
          body.dark-mode .modal-content p {
            color: #bbb !important;
          }
          
          body.dark-mode #editCurrentStock {
            color: #bbb !important;
          }
          
          body.dark-mode #editItemName {
            color: #fff;
          }
          
          body.dark-mode .badge {
            color: #333;
          }
          
          body.dark-mode .collapse-icon {
            color: #ddd;
          }
          
          body.dark-mode .collapse-icon.collapsed {
            color: #9d7bd8;
          }
          
          .container {
            max-width: 1200px;
            margin: 0 auto;
            background-color: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          
          .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 30px;
            border-bottom: 2px solid #e9ecef;
            padding-bottom: 20px;
          }
          
          h1 {
            color: #333;
            margin-bottom: 10px;
          }
          
          .dark-mode-toggle {
            position: absolute;
            top: 20px;
            right: 20px;
            background-color: #007bff;
            color: white;
            border: none;
            border-radius: 50px;
            padding: 8px 16px;
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.3s ease;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            z-index: 1000;
          }
          
          .dark-mode-toggle:hover {
            background-color: #0056b3;
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
          }
          
          body.dark-mode .dark-mode-toggle {
            background-color: #ffc107;
            color: #212529;
          }
          
          body.dark-mode .dark-mode-toggle:hover {
            background-color: #e0a800;
          }
          
          .action-buttons {
            display: flex;
            gap: 10px;
            align-items: center;
          }
          
          .new-request-button {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 12px 20px;
            background-color: #6f42c1;
            color: white;
            border: none;
            border-radius: 4px;
            font-size: 16px;
            font-weight: 500;
            cursor: pointer;
            text-decoration: none;
            transition: background-color 0.3s ease;
          }
          
          .new-request-button:hover {
            background-color: #5a32a3;
          }
          
          .refresh-button {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 10px 16px;
            background-color: #007bff;
            color: white;
            border: none;
            border-radius: 4px;
            font-size: 14px;
            cursor: pointer;
            transition: background-color 0.3s ease;
          }
          
          .refresh-button:hover {
            background-color: #0056b3;
          }
          
          .refresh-button:disabled {
            background-color: #007bff !important;
            cursor: not-allowed;
            opacity: 0.7;
          }
          
          .info-section {
            margin-top: 30px;
          }
          
          .info-cards {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
            margin-top: 20px;
          }
          
          .info-card {
            background-color: white;
            border: 1px solid #e9ecef;
            border-radius: 8px;
            padding: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.05);
          }
          
          .info-card h3 {
            color: #6f42c1;
            margin-top: 0;
            margin-bottom: 15px;
            font-size: 1.2em;
          }
          
          .info-card p {
            color: #666;
            line-height: 1.6;
            margin: 10px 0;
          }
          
          .info-card ul {
            margin: 10px 0;
            padding-left: 20px;
          }
          
          .info-card li {
            color: #666;
            margin: 5px 0;
          }
          
          body.dark-mode .info-card ul {
            color: #cccccc;
          }
          
          body.dark-mode .info-card li {
            color: #cccccc;
          }
          
          .coming-soon-message {
            background-color: #f8f9fa;
            border: 2px solid #6f42c1;
            border-radius: 8px;
            padding: 30px;
            text-align: center;
            margin: 30px 0;
          }
          
          .coming-soon-message h2 {
            color: #6f42c1;
            margin-top: 0;
            margin-bottom: 15px;
          }
          
          .coming-soon-message p {
            color: #666;
            font-size: 1.1em;
            line-height: 1.6;
          }
          
          body.dark-mode .coming-soon-message h2 {
            color: #9d7bd8;
          }
          
          body.dark-mode .coming-soon-message p {
            color: #cccccc;
          }
          
          .feature-icon {
            font-size: 2em;
            margin-bottom: 10px;
          }
          
          /* Low stock alert */
          .low-stock-alert {
            background-color: #fff3cd;
            border: 2px solid #ff9800;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 20px;
          }
          
          .low-stock-alert h3 {
            margin-top: 0;
            color: #856404;
            cursor: pointer;
            user-select: none;
            display: flex;
            justify-content: space-between;
            align-items: center;
          }

          .low-stock-collapse-icon {
            font-size: 0.8em;
            transition: transform 0.3s ease, color 0.3s ease;
            color: #6c757d;
          }

          .low-stock-collapse-icon.collapsed {
            transform: rotate(-90deg);
            color: #ff9800;
          }
          
          .low-stock-items {
            display: grid;
            gap: 10px;
          }
          
          .low-stock-item {
            padding: 10px;
            background-color: white;
            border-radius: 4px;
            border-left: 3px solid #ff9800;
          }
          
          .stock-level {
            color: #ff9800;
            font-weight: 600;
          }
          
          /* Tabs */
          .tabs {
            display: flex;
            gap: 10px;
            border-bottom: 2px solid #e9ecef;
            margin: 20px 0;
          }
          
          .tab-button {
            padding: 12px 24px;
            background-color: transparent;
            border: none;
            border-bottom: 3px solid transparent;
            cursor: pointer;
            font-size: 16px;
            font-weight: 500;
            color: #666;
            transition: all 0.3s ease;
          }
          
          .tab-button:hover {
            color: #6f42c1;
            background-color: #f8f9fa;
          }
          
          .tab-button.active {
            color: #6f42c1;
            border-bottom-color: #6f42c1;
          }
          
          .tab-content {
            display: none;
            padding: 20px 0;
          }
          
          .tab-content.active {
            display: block;
          }
          
          /* Request cards in columns */
          .requests-by-status {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 20px;
            margin-top: 20px;
          }
          
          .status-column {
            min-width: 0;
          }
          
          .status-header {
            font-size: 1.1em;
            font-weight: 600;
            padding: 12px;
            border-bottom: 2px solid #e9ecef;
            margin-bottom: 15px;
            cursor: pointer;
            user-select: none;
            display: flex;
            justify-content: space-between;
            align-items: center;
            transition: background-color 0.2s ease;
          }
          
          .status-header:hover {
            background-color: #f8f9fa;
          }
          
          .status-header.requested {
            color: #007bff;
          }
          
          .status-header.ordered {
            color: #6f42c1;
          }
          
          .status-header.delivered {
            color: #28a745;
          }
          
          .collapse-icon {
            font-size: 0.8em;
            transition: transform 0.3s ease, color 0.3s ease;
            color: #6f42c1;
          }
          
          .collapse-icon.collapsed {
            transform: rotate(-90deg);
            color: #495057;
          }
          
          .request-cards {
            display: flex;
            flex-direction: column;
            gap: 10px;
          }
          
          .request-card {
            background-color: white;
            border: 1px solid #e9ecef;
            border-radius: 8px;
            padding: 15px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.05);
          }
          
          .request-details {
            display: flex;
            flex-direction: column;
            gap: 8px;
            margin-bottom: 12px;
          }
          
          .detail-row {
            display: flex;
            justify-content: space-between;
            gap: 10px;
            font-size: 14px;
          }
          
          .detail-row .label {
            color: #666;
            font-weight: 500;
          }
          
          .badge {
            background-color: #e9ecef;
            padding: 4px 8px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 600;
          }
          
          .badge.success {
            background-color: #d4edda;
            color: #155724;
          }
          
          .status-button {
            width: 100%;
            padding: 8px 12px;
            background-color: #007bff;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            transition: background-color 0.3s ease;
          }
          
          .request-button-row .status-button {
            width: auto;
            flex: 1;
          }
          
          .status-button-delivered {
            background-color: #6f42c1;
          }
          
          .status-button-stocked {
            background-color: #28a745;
          }
          
          .status-button:hover {
            background-color: #0056b3;
          }
          
          .status-button-delivered:hover {
            background-color: #5a32a3;
          }
          
          .status-button-stocked:hover {
            background-color: #198754;
          }
          
          .request-button-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 8px;
          }
          
          .order-link-btn-small {
            padding: 8px 12px;
            background-color: white;
            color: #007bff;
            border: 2px solid #007bff;
            border-radius: 4px;
            text-decoration: none;
            font-size: 13px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s ease;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            white-space: nowrap;
          }
          
          .order-link-btn-small:hover {
            background-color: #007bff;
            color: white;
          }
          
          body.dark-mode .order-link-btn-small {
            background-color: #2d2d2d;
            color: white !important;
            border-color: #007bff;
          }
          
          body.dark-mode .order-link-btn-small:hover {
            background-color: #007bff;
          }
          
          .delete-icon {
            width: 24px;
            height: 24px;
            background-color: #dc3545;
            color: white;
            border: 2px solid #dc3545;
            border-radius: 4px;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
            font-size: 14px;
            transition: all 0.2s ease;
            margin-left: 8px;
            user-select: none;
          }
          
          .delete-icon:hover {
            background-color: #c82333;
            border-color: #c82333;
          }
          
          .request-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
            gap: 8px;
          }
          
          .request-header-right {
            display: flex;
            align-items: center;
            gap: 4px;
          }
          
          .empty-state {
            text-align: center;
            color: #999;
            padding: 20px;
            font-style: italic;
          }
          
          /* Form styles */
          .form-container {
            max-width: 600px;
            margin: 0 auto;
            background-color: white;
            padding: 30px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          
          .form-group {
            margin-bottom: 20px;
          }
          
          .form-group label {
            display: block;
            margin-bottom: 8px;
            font-weight: 600;
            color: #333;
          }
          
          .form-group input,
          .form-group select,
          .form-group textarea {
            width: 100%;
            padding: 10px;
            border: 1px solid #ddd;
            border-radius: 4px;
            font-size: 14px;
            box-sizing: border-box;
          }
          
          .form-group input:focus,
          .form-group select:focus,
          .form-group textarea:focus {
            outline: none;
            border-color: #6f42c1;
          }
          
          #newRequestModal .person-search-wrapper,
          #statusUpdateModal .person-search-wrapper {
            position: relative;
          }
          
          #newRequestModal .person-search-results,
          #statusUpdateModal .person-search-results {
            position: absolute;
            top: 100%;
            left: 0;
            right: 0;
            background: white;
            border: 1px solid #ced4da;
            border-radius: 4px;
            max-height: 200px;
            overflow-y: auto;
            z-index: 3000;
            box-shadow: 0 4px 8px rgba(0,0,0,0.1);
            display: none;
          }
          
          body.dark-mode #newRequestModal .person-search-results,
          body.dark-mode #statusUpdateModal .person-search-results {
            background: #2d2d2d;
            border-color: #555;
          }
          
          #newRequestModal .person-search-results.visible,
          #statusUpdateModal .person-search-results.visible {
            display: block;
          }
          
          #newRequestModal .person-search-result,
          #statusUpdateModal .person-search-result {
            padding: 8px 12px;
            cursor: pointer;
            border-bottom: 1px solid #eee;
          }
          
          body.dark-mode #newRequestModal .person-search-result,
          body.dark-mode #statusUpdateModal .person-search-result {
            border-bottom-color: #444;
          }
          
          #newRequestModal .person-search-result:last-child,
          #statusUpdateModal .person-search-result:last-child {
            border-bottom: none;
          }
          
          #newRequestModal .person-search-result:hover,
          #statusUpdateModal .person-search-result:hover {
            background-color: #f0f0f0;
          }
          
          body.dark-mode #newRequestModal .person-search-result:hover,
          body.dark-mode #statusUpdateModal .person-search-result:hover {
            background-color: #3d3d3d;
          }

          #statusUpdateModal .status-email-row {
            margin-top: 10px;
          }

          #statusUpdateModal .status-email-checkbox-label {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            margin: 0;
            font-weight: 500;
            cursor: pointer;
          }

          #statusUpdateModal .status-email-checkbox-label input[type="checkbox"] {
            width: auto;
            min-width: 16px;
            height: 16px;
            margin: 0;
            padding: 0;
            border-radius: 3px;
            accent-color: #6f42c1;
          }
          
          .order-contact-chips {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-bottom: 10px;
            min-height: 8px;
          }
          
          .order-contact-chip {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            background: #e9ecef;
            padding: 4px 10px;
            border-radius: 16px;
            font-size: 13px;
          }
          
          body.dark-mode .order-contact-chip {
            background: #3d3d3d;
            color: #eee;
          }
          
          .order-contact-chip button {
            background: none;
            border: none;
            color: #dc3545;
            cursor: pointer;
            font-size: 14px;
            line-height: 1;
            padding: 0 2px;
          }
          
          .add-order-contact-row {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
            align-items: flex-end;
          }
          
          .add-order-contact-row .order-contact-search-wrap {
            flex: 1;
            min-width: 160px;
          }
          
          .add-order-contact-btn {
            padding: 10px 16px;
            background-color: #007bff;
            color: white;
            border: none;
            border-radius: 4px;
            font-size: 14px;
            cursor: pointer;
            white-space: nowrap;
          }
          
          .add-order-contact-btn:hover {
            background-color: #0056b3;
          }
          
          .add-order-contact-btn:disabled {
            background-color: #6c757d;
            cursor: not-allowed;
          }
          
          body.dark-mode .add-order-contact-btn:disabled {
            background-color: #555;
          }
          
          .submit-button {
            width: 100%;
            padding: 12px 20px;
            background-color: #6f42c1;
            color: white;
            border: none;
            border-radius: 4px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: background-color 0.3s ease;
          }
          
          .submit-button:hover {
            background-color: #5a32a3;
          }
          
          /* Inventory grid */
          .inventory-section {
            margin-bottom: 30px;
          }
          
          .inventory-section h3 {
            margin-bottom: 15px;
            color: #6f42c1;
            cursor: pointer;
            user-select: none;
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 12px;
            border-radius: 4px;
            transition: background-color 0.2s ease;
          }
          
          .inventory-section h3:hover {
            background-color: #f8f9fa;
          }
          
          .serve-area-star {
            font-size: 20px;
            color: #ccc;
            cursor: pointer;
            transition: all 0.2s ease;
            line-height: 1;
            display: inline-flex;
            align-items: center;
          }
          
          .serve-area-star:hover {
            transform: scale(1.2);
          }
          
          .serve-area-star.favorited {
            color: #ffc107;
            text-shadow: 0 0 3px rgba(0,0,0,0.2);
          }
          
          /* Edit Mode Styles */
          .edit-mode-toggle {
            background-color: #6c757d;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            margin-bottom: 15px;
            transition: all 0.2s ease;
          }
          
          .edit-mode-toggle:hover {
            background-color: #5a6268;
          }
          
          .edit-mode-toggle.active {
            background-color: #9d7bd8;
          }
          
          .edit-mode-toggle.active:hover {
            background-color: #8a6bc4;
          }
          
          .edit-controls {
            display: none;
            align-items: center;
            gap: 8px;
          }
          
          .edit-mode .edit-controls {
            display: flex;
          }
          
          .edit-icon, .add-icon {
            cursor: pointer;
            font-size: 16px;
            padding: 4px 6px;
            border-radius: 4px;
            transition: all 0.2s ease;
            display: inline-flex;
            align-items: center;
            justify-content: center;
          }
          
          .edit-icon {
            color: #007bff;
            width: 28px;
            height: 28px;
            border: 2px solid #007bff;
            background-color: white;
            z-index: 10;
          }

          .edit-icon:hover {
            background-color: #007bff;
            color: white;
            transform: scale(1.05);
          }

          .add-icon {
            color: #28a745;
            font-size: 18px;
          }

          .add-icon:hover {
            background-color: rgba(40, 167, 69, 0.1);
            transform: scale(1.1);
          }

          .dept-delete-icon {
            cursor: pointer;
            font-size: 16px;
            color: #dc3545;
            width: 28px;
            height: 28px;
            border: 2px solid #dc3545;
            background-color: white;
            padding: 4px 6px;
            border-radius: 4px;
            transition: all 0.2s ease;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            z-index: 10;
          }

          .dept-delete-icon:hover {
            background-color: #dc3545;
            color: white;
            transform: scale(1.05);
          }
          
          body.dark-mode .edit-icon,
          body.dark-mode .dept-delete-icon {
            background-color: #2d2d2d;
          }
          
          body.dark-mode .edit-icon:hover {
            background-color: #0d6efd;
            border-color: #0d6efd;
            color: white;
          }
          
          body.dark-mode .dept-delete-icon:hover {
            background-color: #dc3545;
            border-color: #dc3545;
            color: white;
          }
          
          .item-edit-icon, .item-delete-icon, .item-copy-icon {
            position: absolute;
            top: 8px;
            font-size: 18px;
            width: 32px;
            height: 32px;
            border: 2px solid;
            border-radius: 6px;
            cursor: pointer;
            transition: all 0.2s ease;
            display: none;
            background-color: white;
            z-index: 10;
          }

          .edit-mode .item-edit-icon, .edit-mode .item-delete-icon, .edit-mode .item-copy-icon {
            display: inline-flex;
            align-items: center;
            justify-content: center;
          }

          .item-edit-icon {
            right: 82px;
            color: #007bff;
            border-color: #007bff;
          }
          
          .item-edit-icon:hover {
            background-color: #007bff;
            color: white;
            transform: scale(1.05);
          }

          .item-copy-icon {
            right: 45px;
            color: #28a745;
            border-color: #28a745;
          }
          
          .item-copy-icon:hover {
            background-color: #28a745;
            color: white;
            transform: scale(1.05);
          }
          
          .item-delete-icon {
            right: 8px;
            color: #dc3545;
            border-color: #dc3545;
          }
          
          .item-delete-icon:hover {
            background-color: #dc3545;
            color: white;
            transform: scale(1.05);
          }

          body.dark-mode .item-edit-icon,
          body.dark-mode .item-delete-icon,
          body.dark-mode .item-copy-icon {
            background-color: #2d2d2d;
          }

          body.dark-mode .item-edit-icon:hover {
            background-color: #0d6efd;
            border-color: #0d6efd;
          }

          body.dark-mode .item-copy-icon:hover {
            background-color: #28a745;
            border-color: #28a745;
          }

          body.dark-mode .item-delete-icon:hover {
            background-color: #dc3545;
            border-color: #dc3545;
          }
          
          .add-serve-area-btn {
            background-color: #28a745;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            margin-bottom: 15px;
            margin-left: 10px;
            transition: all 0.2s ease;
            display: none;
          }
          
          .edit-mode .add-serve-area-btn {
            display: inline-block;
          }
          
          .add-serve-area-btn:hover {
            background-color: #218838;
          }
          
          .add-item-section {
            display: none;
            margin-bottom: 15px;
          }
          
          .edit-mode .add-item-section:not(.section-collapsed) {
            display: block;
          }
          
          .add-item-btn {
            background-color: #28a745;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 13px;
            transition: all 0.2s ease;
            width: 100%;
          }
          
          .add-item-btn:hover {
            background-color: #218838;
          }
          
          .inventory-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
            gap: 15px;
          }
          
          .inventory-card {
            background-color: white;
            border: 2px solid #e9ecef;
            border-radius: 8px;
            padding: 15px;
            text-align: center;
            transition: all 0.3s ease;
            position: relative;
            display: flex;
            flex-direction: column;
            min-height: 200px;
            cursor: pointer;
          }
          
          .inventory-card:hover {
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
            transform: translateY(-2px);
          }
          
          .edit-mode .inventory-card {
            padding-top: 50px;
          }
          
          .edit-mode .inventory-card:hover {
            transform: none;
          }
          
          .inventory-card.low-stock {
            border-color: #ff9800;
            background-color: #fff3cd;
          }
          
          .inventory-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
            font-size: 14px;
            font-weight: 600;
          }
          
          .warning-badge {
            background-color: #ff9800;
            color: white;
            padding: 2px 6px;
            border-radius: 8px;
            font-size: 11px;
          }
          
          .edit-mode .warning-badge {
            display: none;
          }
          
          .inventory-stock {
            margin: 15px 0;
          }
          
          .stock-number {
            font-size: 2em;
            font-weight: bold;
            color: #6f42c1;
          }
          
          .stock-unit {
            display: block;
            color: #666;
            font-size: 14px;
            margin-top: 5px;
          }
          
          .inventory-threshold {
            color: #666;
            font-size: 12px;
            margin-top: 10px;
          }

          .inventory-last-updated {
            color: #888;
            font-size: 12px;
            margin-top: 4px;
          }
          
          .inventory-description {
            color: #888;
            font-size: 12px;
            margin-top: 8px;
            margin-bottom: 8px;
            font-style: italic;
          }
          
          .edit-stock-button {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: 8px 12px;
            background-color: #6f42c1;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
            transition: background-color 0.3s ease;
            flex: 1;
            height: 37px;
            box-sizing: border-box;
          }

          .edit-stock-button:hover {
            background-color: #5a32a3;
          }

          .inventory-buttons {
            display: flex;
            gap: 8px;
            margin-top: auto;
            padding-top: 8px;
            width: 100%;
          }

          .order-link-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: 8px 12px;
            background-color: white;
            color: #007bff !important;
            text-decoration: none;
            border: 2px solid #007bff;
            border-radius: 4px;
            font-size: 13px;
            font-weight: 500;
            transition: all 0.3s ease;
            flex: 1;
            height: 37px;
            box-sizing: border-box;
          }

          .order-link-btn:hover {
            background-color: #007bff;
            color: white !important;
          }

          body.dark-mode .order-link-btn {
            background-color: #3d3d3d;
            color: white !important;
            border-color: #0d6efd;
          }

          body.dark-mode .order-link-btn:hover {
            background-color: #0d6efd;
            color: white !important;
          }

          /* Modal styles */
          .modal {
            display: none;
            position: fixed;
            z-index: 2000;
            left: 0;
            top: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0,0,0,0.5);
            animation: fadeIn 0.3s;
          }
          
          @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
          }
          
          .modal.show {
            display: flex;
            justify-content: center;
            align-items: center;
          }
          
          .modal-content {
            background-color: white;
            padding: 30px;
            border-radius: 8px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.3);
            max-width: 500px;
            width: 90%;
            animation: slideDown 0.3s;
            position: relative;
          }
          
          @keyframes slideDown {
            from {
              transform: translateY(-50px);
              opacity: 0;
            }
            to {
              transform: translateY(0);
              opacity: 1;
            }
          }
          
          body.dark-mode .modal-content {
            background-color: #2d2d2d;
            color: #ffffff;
          }
          
          body.dark-mode .modal-content p {
            color: #cccccc;
          }
          
          body.dark-mode .modal-content h2 {
            color: #ffffff;
          }
          
          .close-modal {
            position: absolute;
            top: 15px;
            right: 20px;
            font-size: 28px;
            font-weight: bold;
            color: #999;
            cursor: pointer;
            transition: color 0.3s ease;
          }
          
          .close-modal:hover {
            color: #333;
          }
          
          body.dark-mode .close-modal {
            color: #cccccc;
          }
          
          body.dark-mode .close-modal:hover {
            color: #ffffff;
          }
          
          .modal-actions {
            display: flex;
            gap: 10px;
            margin-top: 20px;
          }
          
          .cancel-button {
            flex: 1;
            padding: 10px 20px;
            background-color: #6c757d;
            color: white;
            border: none;
            border-radius: 4px;
            font-size: 14px;
            cursor: pointer;
            transition: background-color 0.3s ease;
          }
          
          .cancel-button:hover {
            background-color: #5a6268;
          }
          
          /* History list */
          .history-list {
            display: flex;
            flex-direction: column;
            gap: 15px;
          }
          
          .history-card {
            background-color: white;
            border: 1px solid #e9ecef;
            border-radius: 8px;
            padding: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.05);
          }
          
          .history-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
            padding-bottom: 10px;
            border-bottom: 1px solid #e9ecef;
          }
          
          .history-details {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 10px;
          }
          
          .pagination-controls {
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 20px;
            margin-top: 30px;
            padding: 20px 0;
          }
          
          .pagination-btn {
            padding: 10px 20px;
            background-color: #007bff;
            color: white;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            transition: all 0.2s ease;
          }
          
          .pagination-btn:hover:not(:disabled) {
            background-color: #0056b3;
            transform: translateY(-1px);
          }
          
          .pagination-btn:disabled {
            background-color: #ccc;
            cursor: not-allowed;
            opacity: 0.6;
          }
          
          .pagination-info {
            font-size: 15px;
            font-weight: 500;
            color: #495057;
          }
          
          body.dark-mode .pagination-btn {
            background-color: #0d6efd;
          }
          
          body.dark-mode .pagination-btn:hover:not(:disabled) {
            background-color: #0b5ed7;
          }
          
          body.dark-mode .pagination-btn:disabled {
            background-color: #555;
          }
          
          body.dark-mode .pagination-info {
            color: #ccc;
          }
          
          /* Responsive design */
          @media (max-width: 1024px) {
            .requests-by-status {
              grid-template-columns: 1fr;
            }
            
            .history-details {
              grid-template-columns: 1fr;
            }
          }
          
          @media (max-width: 768px) {
            .inventory-grid {
              grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
            }
          }
        </style>
        <script>
          // Apply dark mode immediately to prevent flash
          if (localStorage.getItem('darkMode') === 'true') {
            document.documentElement.classList.add('dark-mode-loading');
          }
        </script>
        <style>
          /* Temporary class to apply dark mode before body loads */
          html.dark-mode-loading body {
            background-color: #1a1a1a !important;
          }
          html.dark-mode-loading .container {
            background-color: #2d2d2d !important;
            color: #ffffff !important;
          }
          html.dark-mode-loading h1 {
            color: #ffffff !important;
          }
        </style>
      </head>
      <body>
        <button class="dark-mode-toggle" id="darkModeToggle">🌙 Dark Mode</button>
        
        <div class="container">
          <div class="header">
            <div>
              <h1>Queen City Church - Replenishment Requests</h1>
            </div>
            <div class="action-buttons">
              <button class="new-request-button">
                New Request
              </button>
            </div>
          </div>
          
          ${lowStockItems.length > 0 ? `
          <div class="low-stock-alert">
            <h3 onclick="toggleLowStockItems()">
              <span>⚠️ Low Stock Items (${lowStockItems.length})</span>
              <span class="low-stock-collapse-icon collapsed" id="low-stock-icon">▼</span>
            </h3>
            <div class="low-stock-items" id="low-stock-items" style="display: none;">
              ${lowStockItems.map(item => `
                <div class="low-stock-item">
                  <strong>${item.department_name}</strong>: ${item.name} 
                  <span class="stock-level">(${item.current_stock} ${item.unit} remaining)</span>
                </div>
              `).join('')}
            </div>
          </div>
          ` : ''}
          
          <!-- Tab Navigation -->
          <div class="tabs">
            <button class="tab-button active" data-tab="requests">Active Requests</button>
            <button class="tab-button" data-tab="inventory">Inventory</button>
            <button class="tab-button" data-tab="history">History</button>
          </div>
          
          <!-- Active Requests Tab -->
          <div id="requests-tab" class="tab-content active">
            <h2 style="margin-bottom: 20px;">Active Requests</h2>
            <div class="requests-by-status">
              <div class="status-column">
                <h3 class="status-header requested" onclick="toggleStatusColumn('requested')">
                  <span>📝 Requested (${requestedCount})</span>
                  <span class="collapse-icon" id="requested-icon">▼</span>
                </h3>
                <div class="request-cards" id="requested-cards">
                  ${allRequests.filter(r => r.status === 'requested').map(req => `
                    <div class="request-card" data-request-id="${req.id}">
                      <div class="request-header">
                        <strong>${req.item_name}</strong>
                        <div class="request-header-right">
                          <span class="badge">${req.quantity_requested} ${req.unit}</span>
                          <span class="delete-icon" onclick="deleteRequest(${req.id}, '${req.status}', '${req.item_name}')" title="Delete request">✗</span>
                        </div>
                      </div>
                      <div class="request-details">
                        <div class="detail-row">
                          <span class="label">Serve Area:</span>
                          <span>${req.department_name}</span>
                        </div>
                        <div class="detail-row">
                          <span class="label">Requested by:</span>
                          <span>${req.requested_by}</span>
                        </div>
                        <div class="detail-row">
                          <span class="label">Who should order:</span>
                          <span>${req.order_contact_people && req.order_contact_people.length ? req.order_contact_people.map((p: { personName: string }) => p.personName).join(', ') : '—'}</span>
                        </div>
                        <div class="detail-row">
                          <span class="label">Date:</span>
                          <span>${req.requested_date}</span>
                        </div>
                        ${req.notes ? `<div class="detail-row"><span class="label">Notes:</span><span>${req.notes}</span></div>` : ''}
                      </div>
                      <div class="request-button-row">
                        <button class="status-button" onclick="updateStatus(${req.id}, 'ordered', '${req.item_name}')">
                          Mark as Ordered ✓
                        </button>
                        ${req.url ? `<a href="${req.url}" target="_blank" class="order-link-btn-small">Get More</a>` : ''}
                      </div>
                    </div>
                  `).join('') || '<p class="empty-state">No requested items</p>'}
                </div>
              </div>
              
              <div class="status-column">
                <h3 class="status-header ordered" onclick="toggleStatusColumn('ordered')">
                  <span>📦 Ordered (${orderedCount})</span>
                  <span class="collapse-icon" id="ordered-icon">▼</span>
                </h3>
                <div class="request-cards" id="ordered-cards">
                  ${allRequests.filter(r => r.status === 'ordered').map(req => `
                    <div class="request-card" data-request-id="${req.id}">
                      <div class="request-header">
                        <strong>${req.item_name}</strong>
                        <div class="request-header-right">
                          <span class="badge">${req.quantity_requested} ${req.unit}</span>
                          <span class="delete-icon" onclick="deleteRequest(${req.id}, '${req.status}', '${req.item_name}')" title="Delete request">✗</span>
                        </div>
                      </div>
                      <div class="request-details">
                        <div class="detail-row">
                          <span class="label">Serve Area:</span>
                          <span>${req.department_name}</span>
                        </div>
                        <div class="detail-row">
                          <span class="label">Ordered by:</span>
                          <span>${req.ordered_by}</span>
                        </div>
                        <div class="detail-row">
                          <span class="label">Who should order:</span>
                          <span>${req.order_contact_people && req.order_contact_people.length ? req.order_contact_people.map((p: { personName: string }) => p.personName).join(', ') : '—'}</span>
                        </div>
                        <div class="detail-row">
                          <span class="label">Date:</span>
                          <span>${req.ordered_date}</span>
                        </div>
                      </div>
                      <button class="status-button status-button-delivered" onclick="updateStatus(${req.id}, 'delivered', '${req.item_name}')">
                        Mark as Delivered ✓
                      </button>
                    </div>
                  `).join('') || '<p class="empty-state">No ordered items</p>'}
                </div>
              </div>
              
              <div class="status-column">
                <h3 class="status-header delivered" onclick="toggleStatusColumn('delivered')">
                  <span>🚚 Delivered (${deliveredCount})</span>
                  <span class="collapse-icon" id="delivered-icon">▼</span>
                </h3>
                <div class="request-cards" id="delivered-cards">
                  ${allRequests.filter(r => r.status === 'delivered').map(req => `
                    <div class="request-card" data-request-id="${req.id}">
                      <div class="request-header">
                        <strong>${req.item_name}</strong>
                        <div class="request-header-right">
                          <span class="badge">${req.quantity_requested} ${req.unit}</span>
                          <span class="delete-icon" onclick="deleteRequest(${req.id}, '${req.status}', '${req.item_name}')" title="Delete request">✗</span>
                        </div>
                      </div>
                      <div class="request-details">
                        <div class="detail-row">
                          <span class="label">Serve Area:</span>
                          <span>${req.department_name}</span>
                        </div>
                        <div class="detail-row">
                          <span class="label">Delivered by:</span>
                          <span>${req.delivered_by}</span>
                        </div>
                        <div class="detail-row">
                          <span class="label">Who should order:</span>
                          <span>${req.order_contact_people && req.order_contact_people.length ? req.order_contact_people.map((p: { personName: string }) => p.personName).join(', ') : '—'}</span>
                        </div>
                        <div class="detail-row">
                          <span class="label">Date:</span>
                          <span>${req.delivered_date}</span>
                        </div>
                      </div>
                      <button class="status-button status-button-stocked" onclick="updateStatus(${req.id}, 'stocked', '${req.item_name}')">
                        Mark as Stocked ✓
                      </button>
                    </div>
                  `).join('') || '<p class="empty-state">No delivered items</p>'}
                </div>
              </div>
            </div>
          </div>
          
          <!-- New Request Modal -->
          <div id="newRequestModal" class="modal">
            <div class="modal-content">
              <span class="close-modal" onclick="closeNewRequestModal()">&times;</span>
              <h2>Submit New Request</h2>
              <form id="newRequestForm">
                <div class="form-group">
                  <label for="requestDepartment">Serve Area *</label>
                  <select id="requestDepartment" required>
                    <option value="">Select a department...</option>
                    ${departments.map(dept => `<option value="${dept.id}">${dept.name}</option>`).join('')}
                  </select>
                </div>
                
                <div class="form-group">
                  <label for="requestItem">Item *</label>
                  <select id="requestItem" required disabled>
                    <option value="">Select a department first...</option>
                  </select>
                </div>
                
                <div class="form-group">
                  <label for="requestQuantity">Quantity *</label>
                  <input type="number" id="requestQuantity" min="1" required>
                </div>
                
                <div class="form-group person-search-wrapper">
                  <label for="requesterSearchInput">Your Name *</label>
                  <input type="text" id="requesterSearchInput" autocomplete="off" placeholder="Type a name, then pick your profile from the list">
                  <div id="requesterSearchResults" class="person-search-results"></div>
                </div>
                
                <div class="form-group">
                  <label for="orderContactSearchInput">Who should order or be notified? *</label>
                  <div id="orderContactChips" class="order-contact-chips"></div>
                  <div class="add-order-contact-row">
                    <div class="person-search-wrapper order-contact-search-wrap">
                      <input type="text" id="orderContactSearchInput" autocomplete="off" placeholder="Type a name...">
                      <div id="orderContactSearchResults" class="person-search-results"></div>
                    </div>
                    <button type="button" class="add-order-contact-btn" id="addOrderContactBtn" style="display: none;">Add another person</button>
                  </div>
                </div>
                
                <div class="form-group">
                  <label for="requestNotes">Notes (Optional)</label>
                  <textarea id="requestNotes" rows="3" placeholder="Any additional information..."></textarea>
                </div>
                
                <div class="modal-actions">
                  <button type="button" class="cancel-button" onclick="closeNewRequestModal()">Cancel</button>
                  <button type="submit" class="submit-button">Submit Request</button>
                </div>
              </form>
            </div>
          </div>
          
          <!-- Inventory Tab -->
          <div id="inventory-tab" class="tab-content">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
              <h2 style="margin: 20;">Current Inventory</h2>
              <div style="display: flex; align-items: center; gap: 10px;">
                <button class="add-serve-area-btn" onclick="openAddServeAreaModal()">Add New Serve Area</button>
                <button class="edit-mode-toggle" onclick="toggleEditMode()">Edit Mode: OFF</button>
              </div>
            </div>
            ${departments.map(dept => {
              const deptItems = items.filter(item => item.department_id === dept.id);
              const deptSlug = dept.name.toLowerCase().replace(/\s+/g, '-');
              return `
                <div class="inventory-section" data-dept-id="${dept.id}" data-dept-name="${dept.name.replace(/"/g, '&quot;')}">
                  <h3 onclick="toggleInventorySection('${deptSlug}')">
                    <div style="display: flex; align-items: center; gap: 8px; flex: 1;">
                      <span>${dept.name}</span>
                      <span class="serve-area-star" onclick="event.stopPropagation(); toggleServeAreaFavorite('${deptSlug}', '${dept.name}')" id="${deptSlug}-star" title="Favorite this serve area">☆</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 8px;">
                      <span class="edit-controls">
                        <span class="edit-icon" onclick="event.stopPropagation(); editServeArea(${dept.id}, '${dept.name.replace(/'/g, "\\'")}')" title="Edit Serve Area">✏️</span>
                        <span class="dept-delete-icon" onclick="event.stopPropagation(); deleteServeArea(${dept.id}, '${dept.name.replace(/'/g, "\\'")}')" title="Delete Serve Area">🗑️</span>
                      </span>
                      <span class="collapse-icon" id="${deptSlug}-icon" onclick="event.stopPropagation(); toggleInventorySection('${deptSlug}')">▼</span>
                    </div>
                  </h3>
                  <div class="add-item-section">
                    <button class="add-item-btn" onclick="openAddItemModal(${dept.id}, '${dept.name.replace(/'/g, "\\'")}')">Add Item to ${dept.name}</button>
                  </div>
                  <div class="inventory-grid" id="${deptSlug}-grid">
                    ${deptItems.map(item => {
                      const lastUpdated = item.last_updated_stock || Date.now();
                      const lastUpdatedDate = new Date(lastUpdated).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' });
                      return `
                      <div class="inventory-card ${item.needs_replenishment ? 'low-stock' : ''}" data-item-id="${item.id}" data-item-name="${item.name.replace(/"/g, '&quot;')}" data-item-desc="${(item.description || '').replace(/"/g, '&quot;')}" data-item-location="${(item.location || '').replace(/"/g, '&quot;')}" data-item-url="${(item.url || '').replace(/"/g, '&quot;')}" data-item-stock="${item.current_stock}" data-item-threshold="${item.min_threshold}" data-item-unit="${item.unit}" data-item-last-updated="${lastUpdated}" data-dept-id="${dept.id}" onclick="handleCardClick(event, ${item.id}, ${dept.id}, '${item.name.replace(/'/g, "\\'")}', '${item.unit}')">
                        <span class="item-edit-icon" onclick="event.stopPropagation(); editItem(${item.id}, ${dept.id}, '${item.name.replace(/'/g, "\\'")}', '${(item.description || '').replace(/'/g, "\\'")}', '${(item.location || '').replace(/'/g, "\\'")}', '${(item.url || '').replace(/'/g, "\\'")}', ${item.current_stock}, ${item.min_threshold}, '${item.unit}', ${lastUpdated})" title="Edit Item">✏️</span>
                        <span class="item-copy-icon" onclick="event.stopPropagation(); copyItem(${dept.id}, '${item.name.replace(/'/g, "\\'")}', '${(item.description || '').replace(/'/g, "\\'")}', '${(item.location || '').replace(/'/g, "\\'")}', '${(item.url || '').replace(/'/g, "\\'")}', ${item.current_stock}, ${item.min_threshold}, '${item.unit}', ${lastUpdated})" title="Copy Item">📑</span>
                        <span class="item-delete-icon" onclick="event.stopPropagation(); deleteItem(${item.id}, '${item.name.replace(/'/g, "\\'")}')" title="Delete Item">🗑️</span>
                        <div class="inventory-header">
                          <strong>${item.name}</strong>
                          ${item.needs_replenishment ? '<span class="warning-badge">⚠️ Low</span>' : ''}
                        </div>
                        <div class="inventory-stock">
                          <span class="stock-number">${item.current_stock}</span>
                          <span class="stock-unit">${item.unit}</span>
                        </div>
                        <div class="inventory-threshold">
                          Min: ${item.min_threshold} ${item.unit}
                        </div>
                        <div class="inventory-last-updated">Last Updated: ${lastUpdatedDate}</div>
                        ${item.location ? `<div class="inventory-description">Location: ${item.location}</div>` : ''}
                        ${item.description ? `<div class="inventory-description">${item.description}</div>` : ''}
                        <div class="inventory-buttons">
                          ${item.url ? `<a href="${item.url}" target="_blank" rel="noopener noreferrer" class="order-link-btn" title="Order Online" onclick="event.stopPropagation()">Get More</a>` : ''}
                          <button class="edit-stock-button" onclick="event.stopPropagation(); editStock(${item.id}, '${item.name.replace(/'/g, "\\'")}', ${item.current_stock}, '${item.unit}')">
                            Edit Stock
                          </button>
                        </div>
                      </div>
                    `;}).join('')}
                  </div>
                </div>
              `;
            }).join('')}
          </div>
          
          <!-- History Tab -->
          <div id="history-tab" class="tab-content">
            <h2 style="margin-bottom: 20px;">Completed & Deleted Requests</h2>
            <div class="history-list" id="history-list">
              ${allRequests.filter(r => r.status === 'stocked' || r.status === 'deleted').map(req => `
                <div class="history-card">
                  <div class="history-header">
                    <strong>${req.item_name}</strong>
                    ${req.status === 'stocked'
                      ? '<span class="badge success">✓ Stocked</span>'
                      : '<span class="badge" style="background-color: #dc3545; color: white;">✗ Deleted</span>'}
                  </div>
                  <div class="history-details">
                    <div class="detail-row">
                      <span class="label">Serve Area:</span>
                      <span>${req.department_name}</span>
                    </div>
                    <div class="detail-row">
                      <span class="label">Quantity:</span>
                      <span>${req.quantity_requested} ${req.unit}</span>
                    </div>
                    <div class="detail-row">
                      <span class="label">Requested by:</span>
                      <span>${req.requested_by} on ${req.requested_date}</span>
                    </div>
                    <div class="detail-row">
                      <span class="label">Who should order:</span>
                      <span>${req.order_contact_people && req.order_contact_people.length ? req.order_contact_people.map((p: { personName: string }) => p.personName).join(', ') : '—'}</span>
                    </div>
                    ${req.status === 'stocked' ? `
                      <div class="detail-row">
                        <span class="label">Completed by:</span>
                        <span>${req.stocked_by} on ${req.stocked_date}</span>
                      </div>
                    ` : ''}
                    ${req.notes && req.notes.includes('[DELETED:') ? `
                      <div class="detail-row">
                        <span class="label">Deletion Reason:</span>
                        <span style="color: #dc3545;">${req.notes.split('[DELETED:')[1]?.split(']')[0]?.trim() || 'No reason provided'}</span>
                      </div>
                    ` : req.notes && req.notes.includes('[DELETED]') ? `
                      <div class="detail-row">
                        <span class="label">Deletion Reason:</span>
                        <span style="color: #dc3545;">No reason provided</span>
                      </div>
                    ` : ''}
                  </div>
                </div>
              `).join('') || '<p class="empty-state">No completed or deleted requests yet</p>'}
            </div>
            <div class="pagination-controls" id="history-pagination" style="display: none;">
              <button class="pagination-btn" id="history-prev-btn" onclick="changeHistoryPage(-1)">← Previous</button>
              <span class="pagination-info" id="history-page-info">Page 1 of 1</span>
              <button class="pagination-btn" id="history-next-btn" onclick="changeHistoryPage(1)">Next →</button>
            </div>
          </div>
          
          <!-- Edit Stock Modal -->
          <div id="editStockModal" class="modal">
            <div class="modal-content">
              <span class="close-modal" onclick="closeEditModal()">&times;</span>
              <h2>Edit Stock</h2>
              <form id="editStockForm">
                <div class="form-group">
                  <label>Item:</label>
                  <p id="editItemName" style="font-weight: bold; margin: 5px 0;"></p>
                </div>
                <div class="form-group">
                  <label for="editCurrentStock">Current Stock:</label>
                  <p id="editCurrentStock" style="margin: 5px 0 15px 0; color: #666;"></p>
                </div>
                <div class="form-group">
                  <label for="editNewStock">New Stock Amount *</label>
                  <input type="number" id="editNewStock" min="0" required>
                </div>
                <div class="modal-actions">
                  <button type="button" class="cancel-button" onclick="closeEditModal()">Cancel</button>
                  <button type="submit" class="submit-button">Update Stock</button>
                </div>
              </form>
            </div>
          </div>
          
          <!-- Name Input Modal (for status updates) -->
          <div id="nameInputModal" class="modal">
            <div class="modal-content">
              <span class="close-modal" onclick="closeNameModal()">&times;</span>
              <h2 id="nameModalTitle">Enter Your Name</h2>
              <p id="nameModalMessage" style="margin-bottom: 20px; color: #666;"></p>
              <form id="nameInputForm">
                <div class="form-group">
                  <label for="nameInput">Your Name *</label>
                  <input type="text" id="nameInput" required placeholder="Enter your name">
                </div>
                <div class="modal-actions">
                  <button type="button" class="cancel-button" onclick="closeNameModal()">Cancel</button>
                  <button type="submit" class="submit-button">Continue</button>
                </div>
              </form>
            </div>
          </div>
          
          <!-- Status Update Modal (ordered/delivered) -->
          <div id="statusUpdateModal" class="modal">
            <div class="modal-content">
              <span class="close-modal" onclick="closeStatusUpdateModal()">&times;</span>
              <h2 id="statusUpdateModalTitle">Confirm Status Update</h2>
              <p id="statusUpdateModalMessage" style="margin-bottom: 20px; color: #666;"></p>
              <form id="statusUpdateForm">
                <div class="form-group person-search-wrapper">
                  <label for="statusChangedBySearchInput">Your Name *</label>
                  <input type="text" id="statusChangedBySearchInput" autocomplete="off" placeholder="Type your name and select your PCO profile">
                  <div id="statusChangedBySearchResults" class="person-search-results"></div>
                </div>
                <div class="form-group status-email-row" id="statusEmailRow">
                  <label class="status-email-checkbox-label">
                    <input type="checkbox" id="statusSendEmailCheckbox">
                    <span>Send email notification?</span>
                  </label>
                </div>
                <div class="modal-actions">
                  <button type="button" class="cancel-button" onclick="closeStatusUpdateModal()">Cancel</button>
                  <button type="submit" class="submit-button">Update Status</button>
                </div>
              </form>
            </div>
          </div>
          
          <!-- Deletion Reason Modal -->
          <div id="deletionReasonModal" class="modal">
            <div class="modal-content">
              <span class="close-modal" onclick="closeDeletionModal()">&times;</span>
              <h2>Delete Request</h2>
              <p id="deletionModalMessage" style="margin-bottom: 20px; color: #666;"></p>
              <form id="deletionReasonForm">
                <div class="form-group">
                  <label for="deletionReason">Reason for Deletion *</label>
                  <textarea id="deletionReason" rows="3" required placeholder="Reason for Deletion"></textarea>
                </div>
                <div class="modal-actions">
                  <button type="button" class="cancel-button" onclick="closeDeletionModal()">Cancel</button>
                  <button type="submit" class="submit-button" style="background-color: #dc3545;">Delete Request</button>
                </div>
              </form>
            </div>
          </div>
          
          <!-- Confirmation Modal -->
          <div id="confirmationModal" class="modal">
            <div class="modal-content">
              <span class="close-modal" onclick="closeConfirmationModal()">&times;</span>
              <h2 id="confirmationModalTitle">Confirm Action</h2>
              <p id="confirmationModalMessage" style="margin-bottom: 20px; color: #666;"></p>
              <div class="modal-actions">
                <button type="button" class="cancel-button" onclick="closeConfirmationModal()">Cancel</button>
                <button type="button" class="submit-button" id="confirmationModalConfirm" style="background-color: #dc3545;">OK</button>
              </div>
            </div>
          </div>
          
          <!-- Alert/Message Modal -->
          <div id="alertModal" class="modal">
            <div class="modal-content">
              <span class="close-modal" onclick="closeAlertModal()">&times;</span>
              <h2 id="alertModalTitle">Message</h2>
              <p id="alertModalMessage" style="margin-bottom: 20px; color: #666;"></p>
              <div class="modal-actions">
                <button type="button" class="submit-button" id="alertModalOk" onclick="closeAlertModal()">OK</button>
              </div>
            </div>
          </div>
          
          <!-- Add/Edit Serve Area Modal -->
          <div id="serveAreaModal" class="modal">
            <div class="modal-content">
              <span class="close-modal" onclick="closeServeAreaModal()">&times;</span>
              <h2 id="serveAreaModalTitle">Add Serve Area</h2>
              <form id="serveAreaForm" onsubmit="submitServeAreaForm(event)">
                <input type="hidden" id="serveAreaId" value="">
                <div class="form-group">
                  <label for="serveAreaName">Serve Area Name *</label>
                  <input type="text" id="serveAreaName" required>
                </div>
                <div class="modal-actions">
                  <button type="button" class="cancel-button" onclick="closeServeAreaModal()">Cancel</button>
                  <button type="submit" class="submit-button">Save</button>
                </div>
              </form>
            </div>
          </div>
          
          <!-- Add/Edit Item Modal -->
          <div id="itemModal" class="modal">
            <div class="modal-content">
              <span class="close-modal" onclick="closeItemModal()">&times;</span>
              <h2 id="itemModalTitle">Add Item</h2>
              <form id="itemForm" onsubmit="submitItemForm(event)">
                <input type="hidden" id="itemId" value="">
                <input type="hidden" id="itemDepartmentId" value="">
                <div class="form-group">
                  <label for="itemName">Item Name *</label>
                  <input type="text" id="itemName" required>
                </div>
                <div class="form-group">
                  <label for="itemDescription">Description</label>
                  <textarea id="itemDescription" rows="2"></textarea>
                </div>
                <div class="form-group">
                  <label for="itemLocation">Location</label>
                  <input type="text" id="itemLocation" placeholder="e.g., Supply Closet A, Shelf 3">
                </div>
                <div class="form-group">
                  <label for="itemUrl">Order URL</label>
                  <input type="url" id="itemUrl" placeholder="e.g., https://www.amazon.com/...">
                </div>
                <div class="form-group">
                  <label for="itemCurrentStock">Current Stock *</label>
                  <input type="number" id="itemCurrentStock" min="0" required>
                </div>
                <div class="form-group">
                  <label for="itemMinThreshold">Low Stock Threshold *</label>
                  <input type="number" id="itemMinThreshold" min="0" required>
                </div>
                <div class="form-group">
                  <label for="itemUnit">Unit *</label>
                  <input type="text" id="itemUnit" placeholder="e.g., units, boxes, cards" required>
                </div>
                <div class="form-group">
                  <label for="itemLastUpdated">Last Updated (Stock Count Date)</label>
                  <input type="date" id="itemLastUpdated">
                </div>
                <div class="modal-actions">
                  <button type="button" class="cancel-button" onclick="closeItemModal()">Cancel</button>
                  <button type="submit" class="submit-button">Save</button>
                </div>
              </form>
            </div>
          </div>
          
          <!-- Confirmation Modal -->
          <div id="confirmModal" class="modal">
            <div class="modal-content" style="max-width: 400px;">
              <h2 id="confirmModalTitle">Confirm Action</h2>
              <p id="confirmModalMessage" style="margin: 20px 0; font-size: 16px;"></p>
              <div class="modal-actions">
                <button type="button" class="cancel-button" onclick="closeConfirmModal(false)">Cancel</button>
                <button type="button" class="submit-button" onclick="closeConfirmModal(true)">Confirm</button>
              </div>
            </div>
          </div>
        </div>
        
        <script>
          // Define global functions first for onclick handlers
          let currentEditItemId = null;
          let pendingStatusUpdate = null;
          let confirmModalResolver = null;
          
          // History pagination variables
          let historyCurrentPage = 1;
          let historyItemsPerPage = 50;
          let allHistoryCards = [];
          
          let replenishmentSelectedRequester = null;
          let replenishmentOrderContacts = [];
          let replenishmentRequesterSearchTimeout = null;
          let replenishmentOrderContactSearchTimeout = null;
          let statusModalSelectedPerson = null;
          let statusModalSearchTimeout = null;
          
          function escapeHtmlReplenishment(text) {
            const div = document.createElement('div');
            div.textContent = text == null ? '' : String(text);
            return div.innerHTML;
          }
          
          function renderOrderContactChips() {
            const el = document.getElementById('orderContactChips');
            if (!el) return;
            el.innerHTML = replenishmentOrderContacts.map(function(c) {
              return '<span class="order-contact-chip"><span>' + escapeHtmlReplenishment(c.name) + '</span>' +
                '<button type="button" class="order-contact-chip-remove" data-person-id="' + escapeHtmlReplenishment(c.id) + '" aria-label="Remove">✕</button></span>';
            }).join('');
          }
          
          function syncOrderContactAddAnotherButton() {
            const addBtn = document.getElementById('addOrderContactBtn');
            if (!addBtn) return;
            addBtn.style.display = replenishmentOrderContacts.length >= 1 ? '' : 'none';
          }
          
          function addOrderContactFromPicker(personId, personName) {
            if (!personId || !personName) return;
            if (replenishmentOrderContacts.some(function(c) { return c.id === personId; })) return;
            replenishmentOrderContacts.push({ id: personId, name: personName });
            const orderInput = document.getElementById('orderContactSearchInput');
            const orderResults = document.getElementById('orderContactSearchResults');
            if (orderInput) orderInput.value = '';
            if (orderResults) {
              orderResults.innerHTML = '';
              orderResults.classList.remove('visible');
            }
            renderOrderContactChips();
            syncOrderContactAddAnotherButton();
          }
          
          function resetReplenishmentPcoFields() {
            replenishmentSelectedRequester = null;
            replenishmentOrderContacts = [];
            const rs = document.getElementById('requesterSearchInput');
            const os = document.getElementById('orderContactSearchInput');
            const rr = document.getElementById('requesterSearchResults');
            const or = document.getElementById('orderContactSearchResults');
            if (rs) rs.value = '';
            if (os) os.value = '';
            if (rr) { rr.innerHTML = ''; rr.classList.remove('visible'); }
            if (or) { or.innerHTML = ''; or.classList.remove('visible'); }
            renderOrderContactChips();
            syncOrderContactAddAnotherButton();
          }
          
          function setupReplenishmentPcoSearch() {
            const requesterInput = document.getElementById('requesterSearchInput');
            const requesterResults = document.getElementById('requesterSearchResults');
            const orderInput = document.getElementById('orderContactSearchInput');
            const orderResults = document.getElementById('orderContactSearchResults');
            const addBtn = document.getElementById('addOrderContactBtn');
            const chipsEl = document.getElementById('orderContactChips');
            if (!requesterInput || !requesterResults || !orderInput || !orderResults || !addBtn) return;
            
            requesterInput.addEventListener('input', function() {
              const query = this.value.trim();
              if (replenishmentRequesterSearchTimeout) clearTimeout(replenishmentRequesterSearchTimeout);
              replenishmentSelectedRequester = null;
              if (query.length < 2) {
                requesterResults.innerHTML = '';
                requesterResults.classList.remove('visible');
                return;
              }
              replenishmentRequesterSearchTimeout = setTimeout(async function() {
                try {
                  const response = await fetch('/api/dream-teams/search-people?q=' + encodeURIComponent(query));
                  const result = await response.json();
                  if (result.success && result.data.length > 0) {
                    requesterResults.innerHTML = result.data.map(function(person) {
                      return '<div class="person-search-result" data-id="' + escapeHtmlReplenishment(person.id) + '" data-name="' + escapeHtmlReplenishment(person.name) + '">' +
                        escapeHtmlReplenishment(person.name) + '</div>';
                    }).join('');
                    requesterResults.classList.add('visible');
                    requesterResults.querySelectorAll('.person-search-result').forEach(function(el) {
                      el.addEventListener('click', function() {
                        replenishmentSelectedRequester = {
                          id: this.getAttribute('data-id'),
                          name: this.getAttribute('data-name')
                        };
                        requesterInput.value = replenishmentSelectedRequester.name;
                        requesterResults.classList.remove('visible');
                      });
                    });
                  } else {
                    requesterResults.innerHTML = '<div class="person-search-result" style="color: #888; cursor: default;">No results found</div>';
                    requesterResults.classList.add('visible');
                  }
                } catch (err) {
                  console.error(err);
                }
              }, 300);
            });
            
            orderInput.addEventListener('input', function() {
              const query = this.value.trim();
              if (replenishmentOrderContactSearchTimeout) clearTimeout(replenishmentOrderContactSearchTimeout);
              if (query.length < 2) {
                orderResults.innerHTML = '';
                orderResults.classList.remove('visible');
                return;
              }
              replenishmentOrderContactSearchTimeout = setTimeout(async function() {
                try {
                  const response = await fetch('/api/dream-teams/search-people?q=' + encodeURIComponent(query));
                  const result = await response.json();
                  if (result.success && result.data.length > 0) {
                    orderResults.innerHTML = result.data.map(function(person) {
                      return '<div class="person-search-result" data-id="' + escapeHtmlReplenishment(person.id) + '" data-name="' + escapeHtmlReplenishment(person.name) + '">' +
                        escapeHtmlReplenishment(person.name) + '</div>';
                    }).join('');
                    orderResults.classList.add('visible');
                    orderResults.querySelectorAll('.person-search-result').forEach(function(el) {
                      el.addEventListener('click', function() {
                        const pid = this.getAttribute('data-id');
                        const pname = this.getAttribute('data-name');
                        addOrderContactFromPicker(pid, pname);
                      });
                    });
                  } else {
                    orderResults.innerHTML = '<div class="person-search-result" style="color: #888; cursor: default;">No results found</div>';
                    orderResults.classList.add('visible');
                  }
                } catch (err) {
                  console.error(err);
                }
              }, 300);
            });
            
            orderInput.addEventListener('keydown', function(e) {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              const pickable = orderResults.querySelectorAll('.person-search-result[data-id][data-name]');
              if (pickable.length === 0) return;
              const first = pickable[0];
              addOrderContactFromPicker(first.getAttribute('data-id'), first.getAttribute('data-name'));
            });
            
            addBtn.addEventListener('click', function() {
              orderInput.focus();
              orderInput.select();
            });
            
            const orderSearchWrap = document.querySelector('#newRequestModal .order-contact-search-wrap');
            document.addEventListener('click', function(e) {
              const t = e.target;
              if (!t) return;
              if (!requesterInput.contains(t) && !requesterResults.contains(t)) {
                requesterResults.classList.remove('visible');
              }
              if (orderSearchWrap && !orderSearchWrap.contains(t)) {
                orderResults.classList.remove('visible');
              }
            });
            
            if (chipsEl) {
              chipsEl.addEventListener('click', function(e) {
                const btn = e.target.closest('.order-contact-chip-remove');
                if (!btn) return;
                const pid = btn.getAttribute('data-person-id');
                replenishmentOrderContacts = replenishmentOrderContacts.filter(function(c) { return c.id !== pid; });
                renderOrderContactChips();
                syncOrderContactAddAnotherButton();
              });
            }
          }

          function showConfirmModal(title, message) {
            return new Promise((resolve) => {
              confirmModalResolver = resolve;
              document.getElementById('confirmModalTitle').textContent = title;
              document.getElementById('confirmModalMessage').textContent = message;
              document.getElementById('confirmModal').classList.add('show');
            });
          }
          
          function closeConfirmModal(confirmed) {
            document.getElementById('confirmModal').classList.remove('show');
            if (confirmModalResolver) {
              confirmModalResolver(confirmed);
              confirmModalResolver = null;
            }
          }
          
          function editStock(itemId, itemName, currentStock, unit) {
            currentEditItemId = itemId;
            document.getElementById('editItemName').textContent = itemName;
            document.getElementById('editCurrentStock').textContent = currentStock + ' ' + unit;
            document.getElementById('editNewStock').value = currentStock;
            document.getElementById('editStockModal').classList.add('show');
          }
          
          function closeEditModal() {
            document.getElementById('editStockModal').classList.remove('show');
            currentEditItemId = null;
          }
          
          function openNewRequestModal(prefilledDeptId = null, prefilledItemId = null) {
            // Turn off Edit Mode when creating a new request
            turnOffEditMode();
            
            // Reset form first
            document.getElementById('newRequestForm').reset();
            resetReplenishmentPcoFields();
            document.getElementById('requestItem').disabled = true;
            document.getElementById('requestItem').innerHTML = '<option value="">Select a department first...</option>';
            
            // If we have prefilled values, populate them
            if (prefilledDeptId && prefilledItemId) {
              document.getElementById('requestDepartment').value = prefilledDeptId;
              
              // Trigger department change to load items
              const deptSelect = document.getElementById('requestDepartment');
              const event = new Event('change');
              deptSelect.dispatchEvent(event);
              
              // Wait a moment for items to load, then select the item
              setTimeout(() => {
                document.getElementById('requestItem').value = prefilledItemId;
                // Focus on quantity field
                document.getElementById('requestQuantity').focus();
              }, 50);
            } else {
              // Focus on the first field
              setTimeout(() => {
                document.getElementById('requestDepartment').focus();
              }, 100);
            }
            
            document.getElementById('newRequestModal').classList.add('show');
          }
          
          async function handleCardClick(event, itemId, deptId, itemName, itemUnit) {
            // Don't open modal if we're in edit mode
            const inventoryTab = document.getElementById('inventory-tab');
            if (inventoryTab && inventoryTab.classList.contains('edit-mode')) {
              return;
            }

            // Ask user if they want to create a request
            const confirmed = await showConfirmModal(
              'Create Request',
              \`Would you like to create a new request for \${itemName}?\`
            );
            
            if (confirmed) {
              openNewRequestModal(deptId, itemId);
            }
          }
          
          function closeNewRequestModal() {
            document.getElementById('newRequestModal').classList.remove('show');
            // Reset form
            document.getElementById('newRequestForm').reset();
            resetReplenishmentPcoFields();
            document.getElementById('requestItem').disabled = true;
            document.getElementById('requestItem').innerHTML = '<option value="">Select a department first...</option>';
          }
          
          function openNameModal(title, message) {
            return new Promise((resolve, reject) => {
              document.getElementById('nameModalTitle').textContent = title;
              document.getElementById('nameModalMessage').textContent = message;
              document.getElementById('nameInput').value = '';
              document.getElementById('nameInputModal').classList.add('show');
              
              // Focus on the input field
              setTimeout(() => {
                document.getElementById('nameInput').focus();
              }, 100);
              
              // Store the promise resolver
              window._nameModalResolve = resolve;
              window._nameModalReject = reject;
            });
          }
          
          function closeNameModal() {
            document.getElementById('nameInputModal').classList.remove('show');
            if (window._nameModalReject) {
              window._nameModalReject('cancelled');
              window._nameModalResolve = null;
              window._nameModalReject = null;
            }
          }

          function setupStatusUpdateModalSearch() {
            const searchInput = document.getElementById('statusChangedBySearchInput');
            const resultsEl = document.getElementById('statusChangedBySearchResults');
            if (!searchInput || !resultsEl) return;

            searchInput.addEventListener('input', function() {
              const query = this.value.trim();
              if (statusModalSearchTimeout) clearTimeout(statusModalSearchTimeout);
              statusModalSelectedPerson = null;
              if (query.length < 2) {
                resultsEl.innerHTML = '';
                resultsEl.classList.remove('visible');
                return;
              }

              statusModalSearchTimeout = setTimeout(async function() {
                try {
                  const response = await fetch('/api/dream-teams/search-people?q=' + encodeURIComponent(query));
                  const result = await response.json();

                  if (result.success && result.data.length > 0) {
                    resultsEl.innerHTML = result.data.map(function(person) {
                      return '<div class="person-search-result" data-id="' + escapeHtmlReplenishment(person.id) + '" data-name="' + escapeHtmlReplenishment(person.name) + '">' +
                        escapeHtmlReplenishment(person.name) + '</div>';
                    }).join('');
                    resultsEl.classList.add('visible');

                    resultsEl.querySelectorAll('.person-search-result').forEach(function(el) {
                      el.addEventListener('click', function() {
                        statusModalSelectedPerson = {
                          id: this.getAttribute('data-id'),
                          name: this.getAttribute('data-name')
                        };
                        searchInput.value = statusModalSelectedPerson.name;
                        resultsEl.classList.remove('visible');
                      });
                    });
                  } else {
                    resultsEl.innerHTML = '<div class="person-search-result" style="color: #888; cursor: default;">No results found</div>';
                    resultsEl.classList.add('visible');
                  }
                } catch (error) {
                  console.error('Status modal search error:', error);
                }
              }, 300);
            });

            document.addEventListener('click', function(e) {
              const t = e.target;
              if (!t) return;
              if (!searchInput.contains(t) && !resultsEl.contains(t)) {
                resultsEl.classList.remove('visible');
              }
            });
          }

          function openStatusUpdateModal(newStatus, itemName) {
            return new Promise((resolve, reject) => {
              statusModalSelectedPerson = null;
              const titleEl = document.getElementById('statusUpdateModalTitle');
              const msgEl = document.getElementById('statusUpdateModalMessage');
              const searchInput = document.getElementById('statusChangedBySearchInput');
              const resultsEl = document.getElementById('statusChangedBySearchResults');
              const checkbox = document.getElementById('statusSendEmailCheckbox');
              const emailRow = document.getElementById('statusEmailRow');
              const modal = document.getElementById('statusUpdateModal');

              titleEl.textContent = 'Confirm Status Update';
              msgEl.textContent = 'Select your Planning Center profile to mark "' + itemName + '" as ' + newStatus + '.';
              searchInput.value = '';
              resultsEl.innerHTML = '';
              resultsEl.classList.remove('visible');
              checkbox.checked = false;
              if (newStatus === 'stocked') {
                emailRow.style.display = 'none';
              } else {
                emailRow.style.display = '';
              }
              modal.classList.add('show');

              setTimeout(() => {
                searchInput.focus();
              }, 100);

              window._statusModalResolve = resolve;
              window._statusModalReject = reject;
            });
          }

          function closeStatusUpdateModal() {
            const modal = document.getElementById('statusUpdateModal');
            if (modal) modal.classList.remove('show');
            statusModalSelectedPerson = null;
            if (window._statusModalReject) {
              window._statusModalReject('cancelled');
              window._statusModalResolve = null;
              window._statusModalReject = null;
            }
          }
          
          // History pagination functions
          function initializeHistoryPagination() {
            const historyList = document.getElementById('history-list');
            allHistoryCards = Array.from(historyList.querySelectorAll('.history-card'));
            
            if (allHistoryCards.length > historyItemsPerPage) {
              document.getElementById('history-pagination').style.display = 'flex';
              displayHistoryPage(1);
            }
          }
          
          function displayHistoryPage(pageNum) {
            historyCurrentPage = pageNum;
            const startIdx = (pageNum - 1) * historyItemsPerPage;
            const endIdx = startIdx + historyItemsPerPage;
            const totalPages = Math.ceil(allHistoryCards.length / historyItemsPerPage);
            
            // Hide all cards
            allHistoryCards.forEach(card => card.style.display = 'none');
            
            // Show cards for current page
            for (let i = startIdx; i < endIdx && i < allHistoryCards.length; i++) {
              allHistoryCards[i].style.display = 'block';
            }
            
            // Update pagination controls
            document.getElementById('history-page-info').textContent = \`Page \${pageNum} of \${totalPages}\`;
            document.getElementById('history-prev-btn').disabled = pageNum === 1;
            document.getElementById('history-next-btn').disabled = pageNum === totalPages;
            
            // Scroll to top of history section
            document.getElementById('history-tab').scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
          
          function changeHistoryPage(direction) {
            const totalPages = Math.ceil(allHistoryCards.length / historyItemsPerPage);
            const newPage = historyCurrentPage + direction;
            
            if (newPage >= 1 && newPage <= totalPages) {
              displayHistoryPage(newPage);
            }
          }
          
          function openDeletionModal(message) {
            return new Promise((resolve, reject) => {
              document.getElementById('deletionModalMessage').textContent = message;
              document.getElementById('deletionReason').value = '';
              document.getElementById('deletionReasonModal').classList.add('show');
              
              // Focus on the textarea
              setTimeout(() => {
                document.getElementById('deletionReason').focus();
              }, 100);
              
              // Store the promise resolver
              window._deletionModalResolve = resolve;
              window._deletionModalReject = reject;
            });
          }
          
          function closeDeletionModal() {
            document.getElementById('deletionReasonModal').classList.remove('show');
            if (window._deletionModalReject) {
              window._deletionModalReject('cancelled');
              window._deletionModalResolve = null;
              window._deletionModalReject = null;
            }
          }
          
          function openConfirmationModal(title, message) {
            return new Promise((resolve, reject) => {
              document.getElementById('confirmationModalTitle').textContent = title;
              document.getElementById('confirmationModalMessage').textContent = message;
              document.getElementById('confirmationModal').classList.add('show');
              
              // Store the promise resolver
              window._confirmationModalResolve = resolve;
              window._confirmationModalReject = reject;
            });
          }
          
          function closeConfirmationModal() {
            document.getElementById('confirmationModal').classList.remove('show');
            if (window._confirmationModalReject) {
              window._confirmationModalReject('cancelled');
              window._confirmationModalResolve = null;
              window._confirmationModalReject = null;
            }
          }
          
          function showAlert(title, message) {
            return new Promise((resolve) => {
              document.getElementById('alertModalTitle').textContent = title;
              document.getElementById('alertModalMessage').textContent = message;
              document.getElementById('alertModal').classList.add('show');
              
              // Store the promise resolver
              window._alertModalResolve = resolve;
            });
          }
          
          function closeAlertModal() {
            document.getElementById('alertModal').classList.remove('show');
            if (window._alertModalResolve) {
              window._alertModalResolve(true);
              window._alertModalResolve = null;
            }
          }
          
          // ===== EDIT MODE FUNCTIONALITY =====
          
          let isEditMode = false;
          
          function toggleEditMode() {
            isEditMode = !isEditMode;
            const toggleBtn = document.querySelector('.edit-mode-toggle');
            const inventoryTab = document.getElementById('inventory-tab');
            
            if (isEditMode) {
              toggleBtn.textContent = 'Edit Mode: ON';
              toggleBtn.classList.add('active');
              inventoryTab.classList.add('edit-mode');
            } else {
              toggleBtn.textContent = 'Edit Mode: OFF';
              toggleBtn.classList.remove('active');
              inventoryTab.classList.remove('edit-mode');
            }
          }
          
          // Turn off Edit Mode when user navigates away
          function turnOffEditMode() {
            if (isEditMode) {
              toggleEditMode();
            }
          }
          
          // ===== SERVE AREA (DEPARTMENT) CRUD =====
          
          let currentServeAreaId = null;
          
          function openAddServeAreaModal() {
            currentServeAreaId = null;
            document.getElementById('serveAreaModalTitle').textContent = 'Add New Serve Area';
            document.getElementById('serveAreaId').value = '';
            document.getElementById('serveAreaName').value = '';
            document.getElementById('serveAreaModal').classList.add('show');
          }
          
          function editServeArea(deptId, deptName) {
            currentServeAreaId = deptId;
            document.getElementById('serveAreaModalTitle').textContent = 'Edit Serve Area';
            document.getElementById('serveAreaId').value = deptId;
            document.getElementById('serveAreaName').value = deptName;
            document.getElementById('serveAreaModal').classList.add('show');
          }
          
          function closeServeAreaModal() {
            document.getElementById('serveAreaModal').classList.remove('show');
            currentServeAreaId = null;
          }
          
          async function submitServeAreaForm(event) {
            event.preventDefault();
            
            const name = document.getElementById('serveAreaName').value.trim();
            
            if (!name) {
              await showAlert('Error', 'Serve Area name is required');
              return;
            }
            
            try {
              const url = currentServeAreaId 
                ? \`/api/replenishment/departments/\${currentServeAreaId}\`
                : '/api/replenishment/departments';
              const method = currentServeAreaId ? 'PUT' : 'POST';
              
              const response = await fetch(url, {
                method: method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
              });
              
              const data = await response.json();
              
              if (data.success) {
                closeServeAreaModal();
                await showAlert('Success', currentServeAreaId ? 'Serve Area updated successfully' : 'Serve Area created successfully');
                localStorage.setItem('replenishment-active-tab', 'inventory');
                // Preserve Edit Mode through reload
                if (isEditMode) {
                  localStorage.setItem('replenishment-restore-edit-mode', 'true');
                }
                window.location.reload();
              } else {
                closeServeAreaModal();
                await showAlert('Error', data.error || 'Failed to save Serve Area');
              }
            } catch (error) {
              console.error('Error saving serve area:', error);
              await showAlert('Error', 'Failed to save Serve Area');
            }
          }
          
          async function deleteServeArea(deptId, deptName) {
            const confirmed = await openConfirmationModal(
              'Delete Serve Area',
              \`Are you sure you want to delete "\${deptName}"? This will also delete ALL items in this serve area.\`
            );
            
            if (!confirmed) return;
            
            try {
              const response = await fetch(\`/api/replenishment/departments/\${deptId}\`, {
                method: 'DELETE'
              });
              
              const data = await response.json();
              
              if (data.success) {
                await showAlert('Success', 'Serve Area deleted successfully');
                localStorage.setItem('replenishment-active-tab', 'inventory');
                // Preserve Edit Mode through reload
                if (isEditMode) {
                  localStorage.setItem('replenishment-restore-edit-mode', 'true');
                }
                window.location.reload();
              } else {
                await showAlert('Error', data.error || 'Failed to delete Serve Area');
              }
            } catch (error) {
              console.error('Error deleting serve area:', error);
              await showAlert('Error', 'Failed to delete Serve Area');
            }
          }
          
          // ===== ITEM CRUD =====
          
          let currentItemId = null;
          let currentItemDepartmentId = null;
          
          function openAddItemModal(deptId, deptName) {
            currentItemId = null;
            currentItemDepartmentId = deptId;
            document.getElementById('itemModalTitle').textContent = \`Add Item to \${deptName}\`;
            document.getElementById('itemId').value = '';
            document.getElementById('itemDepartmentId').value = deptId;
            document.getElementById('itemName').value = '';
            document.getElementById('itemDescription').value = '';
            document.getElementById('itemLocation').value = '';
            document.getElementById('itemUrl').value = '';
            document.getElementById('itemCurrentStock').value = '0';
            document.getElementById('itemMinThreshold').value = '10';
            document.getElementById('itemUnit').value = '';
            
            // Set last updated to today by default
            const today = new Date();
            const dateStr = today.getFullYear() + '-' + 
                           String(today.getMonth() + 1).padStart(2, '0') + '-' + 
                           String(today.getDate()).padStart(2, '0');
            document.getElementById('itemLastUpdated').value = dateStr;
            
            document.getElementById('itemModal').classList.add('show');
          }
          
          function editItem(itemId, deptId, name, description, location, url, stock, threshold, unit, lastUpdated) {
            currentItemId = itemId;
            currentItemDepartmentId = deptId;
            document.getElementById('itemModalTitle').textContent = 'Edit Item';
            document.getElementById('itemId').value = itemId;
            document.getElementById('itemDepartmentId').value = deptId;
            document.getElementById('itemName').value = name;
            document.getElementById('itemDescription').value = description || '';
            document.getElementById('itemLocation').value = location || '';
            document.getElementById('itemUrl').value = url || '';
            document.getElementById('itemCurrentStock').value = stock;
            document.getElementById('itemMinThreshold').value = threshold;
            document.getElementById('itemUnit').value = unit;
            
            // Set the last updated date field
            const date = new Date(lastUpdated || Date.now());
            const dateStr = date.getFullYear() + '-' + 
                           String(date.getMonth() + 1).padStart(2, '0') + '-' + 
                           String(date.getDate()).padStart(2, '0');
            document.getElementById('itemLastUpdated').value = dateStr;
            
            document.getElementById('itemModal').classList.add('show');
          }

          function copyItem(deptId, name, description, location, url, stock, threshold, unit, lastUpdated) {
            currentItemId = null;
            currentItemDepartmentId = deptId;
            document.getElementById('itemModalTitle').textContent = 'Copy Item (New)';
            document.getElementById('itemId').value = '';
            document.getElementById('itemDepartmentId').value = deptId;
            document.getElementById('itemName').value = name + ' (Copy)';
            document.getElementById('itemDescription').value = description || '';
            document.getElementById('itemLocation').value = location || '';
            document.getElementById('itemUrl').value = url || '';
            document.getElementById('itemCurrentStock').value = stock;
            document.getElementById('itemMinThreshold').value = threshold;
            document.getElementById('itemUnit').value = unit;
            
            // Set the last updated date field (copy the date too)
            const date = new Date(lastUpdated || Date.now());
            const dateStr = date.getFullYear() + '-' + 
                           String(date.getMonth() + 1).padStart(2, '0') + '-' + 
                           String(date.getDate()).padStart(2, '0');
            document.getElementById('itemLastUpdated').value = dateStr;
            
            document.getElementById('itemModal').classList.add('show');
          }

          function closeItemModal() {
            document.getElementById('itemModal').classList.remove('show');
            currentItemId = null;
            currentItemDepartmentId = null;
          }
          
          async function submitItemForm(event) {
            event.preventDefault();

            const name = document.getElementById('itemName').value.trim();
            const description = document.getElementById('itemDescription').value.trim();
            const location = document.getElementById('itemLocation').value.trim();
            const url = document.getElementById('itemUrl').value.trim();
            const currentStock = parseInt(document.getElementById('itemCurrentStock').value);
            const minThreshold = parseInt(document.getElementById('itemMinThreshold').value);
            const unit = document.getElementById('itemUnit').value.trim();
            const lastUpdatedStr = document.getElementById('itemLastUpdated').value;

            if (!name || isNaN(currentStock) || isNaN(minThreshold) || !unit) {
              await showAlert('Error', 'Please fill in all required fields');
              return;
            }

            try {
              const apiUrl = currentItemId
                ? \`/api/replenishment/items/\${currentItemId}\`
                : '/api/replenishment/items';
              const method = currentItemId ? 'PUT' : 'POST';

              // Convert date string to timestamp (parse as local date, not UTC)
              let lastUpdatedTimestamp;
              if (lastUpdatedStr) {
                const [year, month, day] = lastUpdatedStr.split('-').map(Number);
                const localDate = new Date(year, month - 1, day); // month is 0-indexed
                lastUpdatedTimestamp = localDate.getTime();
              } else {
                lastUpdatedTimestamp = Date.now();
              }

              const body = {
                name,
                description,
                location,
                url,
                currentStock,
                minThreshold,
                unit,
                lastUpdatedStock: lastUpdatedTimestamp
              };

              if (!currentItemId) {
                body.departmentId = currentItemDepartmentId;
              }

              const response = await fetch(apiUrl, {
                method: method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
              });
              
              const data = await response.json();
              
              if (data.success) {
                closeItemModal();
                await showAlert('Success', currentItemId ? 'Item updated successfully' : 'Item created successfully');
                localStorage.setItem('replenishment-active-tab', 'inventory');
                // Preserve Edit Mode through reload
                if (isEditMode) {
                  localStorage.setItem('replenishment-restore-edit-mode', 'true');
                }
                window.location.reload();
              } else {
                closeItemModal();
                await showAlert('Error', data.error || 'Failed to save item');
              }
            } catch (error) {
              console.error('Error saving item:', error);
              await showAlert('Error', 'Failed to save item');
            }
          }
          
          async function deleteItem(itemId, itemName) {
            const confirmed = await openConfirmationModal(
              'Delete Item',
              \`Are you sure you want to delete "\${itemName}"? This item will still appear in request history.\`
            );
            
            if (!confirmed) return;
            
            try {
              const response = await fetch(\`/api/replenishment/items/\${itemId}\`, {
                method: 'DELETE'
              });
              
              const data = await response.json();
              
              if (data.success) {
                await showAlert('Success', 'Item deleted successfully');
                localStorage.setItem('replenishment-active-tab', 'inventory');
                // Preserve Edit Mode through reload
                if (isEditMode) {
                  localStorage.setItem('replenishment-restore-edit-mode', 'true');
                }
                window.location.reload();
              } else {
                await showAlert('Error', data.error || 'Failed to delete item');
              }
            } catch (error) {
              console.error('Error deleting item:', error);
              await showAlert('Error', 'Failed to delete item');
            }
          }
          
          // Collapsible functionality
          function toggleStatusColumn(status) {
            const cardsElement = document.getElementById(status + '-cards');
            const iconElement = document.getElementById(status + '-icon');
            
            if (cardsElement.style.display === 'none') {
              cardsElement.style.display = 'flex';
              iconElement.classList.remove('collapsed');
              localStorage.setItem('replenishment-status-' + status, 'open');
            } else {
              cardsElement.style.display = 'none';
              iconElement.classList.add('collapsed');
              localStorage.setItem('replenishment-status-' + status, 'closed');
            }
          }
          
          function toggleInventorySection(sectionSlug) {
            const gridElement = document.getElementById(sectionSlug + '-grid');
            const iconElement = document.getElementById(sectionSlug + '-icon');
            const addItemSection = gridElement.closest('.inventory-section').querySelector('.add-item-section');
            
            if (gridElement.style.display === 'none') {
              gridElement.style.display = 'grid';
              iconElement.classList.remove('collapsed');
              // Remove the collapsed class so CSS can handle visibility based on edit mode
              if (addItemSection) {
                addItemSection.classList.remove('section-collapsed');
              }
              localStorage.setItem('replenishment-inventory-' + sectionSlug, 'open');
            } else {
              gridElement.style.display = 'none';
              iconElement.classList.add('collapsed');
              // Add collapsed class to hide the button regardless of edit mode
              if (addItemSection) {
                addItemSection.classList.add('section-collapsed');
              }
              localStorage.setItem('replenishment-inventory-' + sectionSlug, 'closed');
            }
          }

          function toggleLowStockItems() {
            const itemsElement = document.getElementById('low-stock-items');
            const iconElement = document.getElementById('low-stock-icon');
            if (!itemsElement || !iconElement) return;

            if (itemsElement.style.display === 'none') {
              itemsElement.style.display = 'grid';
              iconElement.classList.remove('collapsed');
            } else {
              itemsElement.style.display = 'none';
              iconElement.classList.add('collapsed');
            }
          }
          
          // Serve Area favorites management
          let serveAreaFavorites = new Set();
          
          function loadServeAreaFavorites() {
            try {
              const saved = localStorage.getItem('replenishment-serve-area-favorites');
              if (saved) {
                serveAreaFavorites = new Set(JSON.parse(saved));
              }
            } catch (error) {
              console.error('Error loading serve area favorites:', error);
              serveAreaFavorites = new Set();
            }
          }
          
          function saveServeAreaFavorites() {
            try {
              localStorage.setItem('replenishment-serve-area-favorites', JSON.stringify([...serveAreaFavorites]));
            } catch (error) {
              console.error('Error saving serve area favorites:', error);
            }
          }
          
          function toggleServeAreaFavorite(sectionSlug, sectionName) {
            const starElement = document.getElementById(sectionSlug + '-star');
            const isFavorited = serveAreaFavorites.has(sectionSlug);
            
            if (isFavorited) {
              serveAreaFavorites.delete(sectionSlug);
              starElement.classList.remove('favorited');
              starElement.textContent = '☆';
            } else {
              serveAreaFavorites.add(sectionSlug);
              starElement.classList.add('favorited');
              starElement.textContent = '★';
            }
            
            saveServeAreaFavorites();
            reorderInventorySections();
          }
          
          function reorderInventorySections() {
            const inventoryTab = document.getElementById('inventory-tab');
            const headerDiv = inventoryTab.querySelector('div[style*="justify-content: space-between"]');
            const sections = Array.from(inventoryTab.querySelectorAll('.inventory-section'));
            
            // Sort: favorites first, then alphabetically
            sections.sort((a, b) => {
              const aSlug = a.querySelector('h3 .collapse-icon').id.replace('-icon', '');
              const bSlug = b.querySelector('h3 .collapse-icon').id.replace('-icon', '');
              
              const aFavorited = serveAreaFavorites.has(aSlug);
              const bFavorited = serveAreaFavorites.has(bSlug);
              
              // Favorites first
              if (aFavorited && !bFavorited) return -1;
              if (!aFavorited && bFavorited) return 1;
              
              // Then alphabetically by name (get first span inside the div)
              const aNameElement = a.querySelector('h3 div span:first-child');
              const bNameElement = b.querySelector('h3 div span:first-child');
              const aName = aNameElement ? aNameElement.textContent.trim() : '';
              const bName = bNameElement ? bNameElement.textContent.trim() : '';
              return aName.localeCompare(bName);
            });
            
            // Clear and re-append in new order
            sections.forEach(section => section.remove());
            sections.forEach(section => {
              inventoryTab.appendChild(section);
            });
            
            // Keep header div at the top
            if (headerDiv) {
              inventoryTab.insertBefore(headerDiv, inventoryTab.firstChild);
            }
          }
          
          // Restore collapse states from localStorage
          function restoreCollapseStates() {
            // Restore status column states
            ['requested', 'ordered', 'delivered'].forEach(status => {
              const state = localStorage.getItem('replenishment-status-' + status);
              if (state === 'closed') {
                const cardsElement = document.getElementById(status + '-cards');
                const iconElement = document.getElementById(status + '-icon');
                if (cardsElement && iconElement) {
                  cardsElement.style.display = 'none';
                  iconElement.classList.add('collapsed');
                }
              }
            });
            
            // Restore inventory section states (dynamically get all sections)
            document.querySelectorAll('.inventory-section').forEach(section => {
              const gridElement = section.querySelector('.inventory-grid');
              if (gridElement && gridElement.id) {
                const sectionSlug = gridElement.id.replace('-grid', '');
                const state = localStorage.getItem('replenishment-inventory-' + sectionSlug);
                if (state === 'closed') {
                  const iconElement = document.getElementById(sectionSlug + '-icon');
                  if (iconElement) {
                    gridElement.style.display = 'none';
                    iconElement.classList.add('collapsed');
                    const addItemSection = section.querySelector('.add-item-section');
                    if (addItemSection) addItemSection.classList.add('section-collapsed');
                  }
                }
              }
            });
            
            // Restore and apply serve area favorites
            loadServeAreaFavorites();
            serveAreaFavorites.forEach(slug => {
              const starElement = document.getElementById(slug + '-star');
              if (starElement) {
                starElement.classList.add('favorited');
                starElement.textContent = '★';
              }
            });
            
            // Reorder sections based on favorites
            if (serveAreaFavorites.size > 0) {
              reorderInventorySections();
            }
          }
          
          async function deleteRequest(requestId, status, itemName) {
            try {
              let deletionReason = null;
              
              // If status is 'ordered' or 'delivered', require a reason
              if (status === 'ordered' || status === 'delivered') {
                deletionReason = await openDeletionModal(
                  \`You are about to delete the request for "\${itemName}" which has already been \${status}. Please provide a reason:\`
                );
              } else {
                // For 'requested' status, just confirm
                await openConfirmationModal(
                  'Delete Request',
                  \`Are you sure you want to delete the request for "\${itemName}"?\`
                );
              }
              
              const response = await fetch(\`/api/replenishment/requests/\${requestId}\`, {
                method: 'DELETE',
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  reason: deletionReason
                })
              });
              
              const result = await response.json();
              
              if (result.success) {
                await showAlert('Success', 'Request deleted successfully!');
                window.location.reload();
              } else {
                await showAlert('Error', result.error || 'Failed to delete request');
              }
            } catch (error) {
              if (error !== 'cancelled') {
                console.error('Error deleting request:', error);
                await showAlert('Error', 'Failed to delete request. Please try again.');
              }
            }
          }
          
          async function updateStatus(requestId, newStatus, itemName) {
            try {
              let changedBy = '';
              let changedByPersonId = null;
              let sendEmailNotification = false;
              
              if (newStatus === 'ordered' || newStatus === 'delivered' || newStatus === 'stocked') {
                const statusUpdateData = await openStatusUpdateModal(newStatus, itemName);
                changedBy = statusUpdateData.changedByName;
                changedByPersonId = statusUpdateData.changedByPersonId;
                sendEmailNotification = newStatus === 'stocked' ? true : statusUpdateData.sendEmailNotification;
              } else {
                const userName = await openNameModal(
                  'Confirm Status Update',
                  \`Enter your name to mark "\${itemName}" as \${newStatus}:\`
                );
                changedBy = userName;
              }
              
              const response = await fetch(\`/api/replenishment/requests/\${requestId}/status\`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  status: newStatus,
                  changedBy: changedBy,
                  changedByPersonId: changedByPersonId,
                  sendEmailNotification: sendEmailNotification
                })
              });
              
              const result = await response.json();
              
              if (result.success) {
                await showAlert('Success', \`Successfully marked as \${newStatus}!\`);
                window.location.reload();
              } else {
                await showAlert('Error', result.error || 'Failed to update status');
              }
            } catch (error) {
              if (error !== 'cancelled') {
                console.error('Error updating status:', error);
                await showAlert('Error', 'Failed to update status. Please try again.');
              }
            }
          }
          
          // Dark mode toggle functionality
          const darkModeToggle = document.getElementById('darkModeToggle');
          const body = document.body;
          
          // Check for saved dark mode preference
          const isDarkMode = localStorage.getItem('darkMode') === 'true';
          
          // Clean up temporary loading class and apply proper dark mode
          document.documentElement.classList.remove('dark-mode-loading');
          if (isDarkMode) {
            body.classList.add('dark-mode');
            darkModeToggle.innerHTML = '☀️ Light Mode';
          }
          
          // Toggle dark mode
          darkModeToggle.addEventListener('click', function() {
            body.classList.toggle('dark-mode');
            const isCurrentlyDark = body.classList.contains('dark-mode');
            
            // Update button text and icon
            if (isCurrentlyDark) {
              darkModeToggle.innerHTML = '☀️ Light Mode';
              localStorage.setItem('darkMode', 'true');
            } else {
              darkModeToggle.innerHTML = '🌙 Dark Mode';
              localStorage.setItem('darkMode', 'false');
            }
          });
          
          // Tab switching
          const tabButtons = document.querySelectorAll('.tab-button');
          const tabContents = document.querySelectorAll('.tab-content');
          
          // Function to switch to a specific tab
          function activateTab(tabName) {
            // Turn off Edit Mode when navigating away from Inventory tab
            if (tabName !== 'inventory') {
              turnOffEditMode();
            }
            
            // Remove active class from all tabs
            tabButtons.forEach(btn => btn.classList.remove('active'));
            tabContents.forEach(content => content.classList.remove('active'));
            
            // Add active class to specified tab
            const targetButton = document.querySelector(\`[data-tab="\${tabName}"]\`);
            if (targetButton) {
              targetButton.classList.add('active');
              document.getElementById(tabName + '-tab').classList.add('active');
              
              // Save to localStorage
              localStorage.setItem('replenishment-active-tab', tabName);
            }
          }
          
          // Restore previously active tab on page load
          const savedTab = localStorage.getItem('replenishment-active-tab');
          if (savedTab) {
            activateTab(savedTab);
          }
          
          // Initialize history pagination
          initializeHistoryPagination();

          tabButtons.forEach(button => {
            button.addEventListener('click', () => {
              const tabName = button.getAttribute('data-tab');
              activateTab(tabName);
            });
          });
          
          // Click outside modal to close functionality
          const modals = document.querySelectorAll('.modal');
          modals.forEach(modal => {
            let mousedownTarget = null;
            
            // Track where mousedown happened
            modal.addEventListener('mousedown', function(event) {
              mousedownTarget = event.target;
            });
            
            // Only close if both mousedown and mouseup happened on the backdrop
            modal.addEventListener('mouseup', function(event) {
              // Only close if both mousedown and mouseup were on the modal backdrop itself
              if (event.target === modal && mousedownTarget === modal) {
                // Determine which modal was clicked and call its close function
                const modalId = modal.id;

                if (modalId === 'newRequestModal') {
                  closeNewRequestModal();
                } else if (modalId === 'editStockModal') {
                  closeEditModal();
                } else if (modalId === 'nameInputModal') {
                  closeNameModal();
                } else if (modalId === 'statusUpdateModal') {
                  closeStatusUpdateModal();
                } else if (modalId === 'serveAreaModal') {
                  closeServeAreaModal();
                } else if (modalId === 'itemModal') {
                  closeItemModal();
                } else if (modalId === 'deletionModal') {
                  closeDeletionModal();
                } else if (modalId === 'confirmModal') {
                  closeConfirmModal(false);
                }
              }
              // Reset the tracking variable
              mousedownTarget = null;
            });
          });
          
          // Department selection for items
          const departmentSelect = document.getElementById('requestDepartment');
          const itemSelect = document.getElementById('requestItem');
          
          const allItems = ${JSON.stringify(items)};
          
          departmentSelect.addEventListener('change', function() {
            const deptId = parseInt(this.value);
            itemSelect.disabled = false;
            itemSelect.innerHTML = '<option value="">Select an item...</option>';
            
            if (deptId) {
              const deptItems = allItems.filter(item => item.department_id === deptId);
              deptItems.forEach(item => {
                const option = document.createElement('option');
                option.value = item.id;
                option.textContent = item.name + ' (Current: ' + item.current_stock + ' ' + item.unit + ')';
                if (item.needs_replenishment) {
                  option.textContent += ' ⚠️ Low Stock';
                }
                itemSelect.appendChild(option);
              });
            }
          });
          
          // Form submission
          const newRequestForm = document.getElementById('newRequestForm');
          newRequestForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            
            if (!replenishmentSelectedRequester) {
              await showAlert('Planning Center profile required', 'Type your name, then select your profile from the list.');
              return;
            }
            if (replenishmentOrderContacts.length === 0) {
              await showAlert('Who should order?', 'Add at least one person who should order or be notified (search and pick a name, or press Enter on a match).');
              return;
            }
            
            const formData = {
              itemId: parseInt(document.getElementById('requestItem').value),
              departmentId: parseInt(document.getElementById('requestDepartment').value),
              quantityRequested: parseInt(document.getElementById('requestQuantity').value),
              requestedByPersonId: replenishmentSelectedRequester.id,
              requestedByName: replenishmentSelectedRequester.name,
              orderContacts: replenishmentOrderContacts.map(function(c) {
                return { personId: c.id, personName: c.name };
              }),
              notes: document.getElementById('requestNotes').value
            };
            
            try {
              const response = await fetch('/api/replenishment/requests', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify(formData)
              });
              
              const result = await response.json();
              
              if (result.success) {
                closeNewRequestModal();
                await showAlert('Success', 'Request submitted successfully!');
                window.location.reload();
              } else {
                await showAlert('Error', result.error || 'Failed to submit request');
              }
            } catch (error) {
              console.error('Error submitting request:', error);
              await showAlert('Error', 'Failed to submit request. Please try again.');
            }
          });
          
          // New request button - open modal
          const newRequestButton = document.querySelector('.new-request-button');
          newRequestButton.disabled = false;
          newRequestButton.addEventListener('click', function() {
            openNewRequestModal();
          });
          
          // Handle edit stock form submission
          const editStockForm = document.getElementById('editStockForm');
          editStockForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const newStock = parseInt(document.getElementById('editNewStock').value);
            
            try {
              const response = await fetch(\`/api/replenishment/items/\${currentEditItemId}/stock\`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  stock: newStock
                })
              });
              
              const result = await response.json();
              
              if (result.success) {
                await showAlert('Success', 'Stock updated successfully!');
                window.location.reload();
              } else {
                await showAlert('Error', result.error || 'Failed to update stock');
              }
            } catch (error) {
              console.error('Error updating stock:', error);
              await showAlert('Error', 'Failed to update stock. Please try again.');
            }
          });
          
          // Handle name input form submission
          const nameInputForm = document.getElementById('nameInputForm');
          nameInputForm.addEventListener('submit', function(e) {
            e.preventDefault();
            
            const userName = document.getElementById('nameInput').value.trim();
            if (userName && window._nameModalResolve) {
              window._nameModalResolve(userName);
              window._nameModalResolve = null;
              window._nameModalReject = null;
              document.getElementById('nameInputModal').classList.remove('show');
            }
          });

          const statusUpdateForm = document.getElementById('statusUpdateForm');
          statusUpdateForm.addEventListener('submit', function(e) {
            e.preventDefault();
            if (!statusModalSelectedPerson || !window._statusModalResolve) {
              showAlert('Planning Center profile required', 'Select your name from Planning Center before updating status.');
              return;
            }
            const shouldSend = !!document.getElementById('statusSendEmailCheckbox').checked;
            window._statusModalResolve({
              changedByPersonId: statusModalSelectedPerson.id,
              changedByName: statusModalSelectedPerson.name,
              sendEmailNotification: shouldSend
            });
            window._statusModalResolve = null;
            window._statusModalReject = null;
            document.getElementById('statusUpdateModal').classList.remove('show');
          });
          
          // Handle deletion reason form submission
          const deletionReasonForm = document.getElementById('deletionReasonForm');
          deletionReasonForm.addEventListener('submit', function(e) {
            e.preventDefault();
            
            const reason = document.getElementById('deletionReason').value.trim();
            if (reason && window._deletionModalResolve) {
              window._deletionModalResolve(reason);
              window._deletionModalResolve = null;
              window._deletionModalReject = null;
              document.getElementById('deletionReasonModal').classList.remove('show');
            }
          });
          
          // Handle confirmation modal confirm button
          const confirmationModalConfirm = document.getElementById('confirmationModalConfirm');
          confirmationModalConfirm.addEventListener('click', function() {
            if (window._confirmationModalResolve) {
              window._confirmationModalResolve(true);
              window._confirmationModalResolve = null;
              window._confirmationModalReject = null;
              document.getElementById('confirmationModal').classList.remove('show');
            }
          });
          
          // Helper function to add proper click-outside-to-close behavior
          // Only closes if both mousedown and mouseup happen outside the modal content
          function addModalClickOutsideHandler(modalElement, closeFunction) {
            let mouseDownTarget = null;
            
            modalElement.addEventListener('mousedown', function(e) {
              mouseDownTarget = e.target;
            });
            
            modalElement.addEventListener('click', function(e) {
              // Only close if both mousedown and click happened on the modal backdrop
              if (e.target === this && mouseDownTarget === this) {
                closeFunction();
              }
              mouseDownTarget = null;
            });
          }
          
          // Close modals when clicking outside (both mousedown and mouseup must be outside)
          addModalClickOutsideHandler(document.getElementById('newRequestModal'), closeNewRequestModal);
          addModalClickOutsideHandler(document.getElementById('editStockModal'), closeEditModal);
          addModalClickOutsideHandler(document.getElementById('nameInputModal'), closeNameModal);
          addModalClickOutsideHandler(document.getElementById('statusUpdateModal'), closeStatusUpdateModal);
          addModalClickOutsideHandler(document.getElementById('deletionReasonModal'), closeDeletionModal);
          addModalClickOutsideHandler(document.getElementById('confirmationModal'), closeConfirmationModal);
          addModalClickOutsideHandler(document.getElementById('alertModal'), closeAlertModal);
          addModalClickOutsideHandler(document.getElementById('serveAreaModal'), closeServeAreaModal);
          addModalClickOutsideHandler(document.getElementById('itemModal'), closeItemModal);
          
          // Close modal when clicking outside
          window.addEventListener('click', function(event) {
            const editModal = document.getElementById('editStockModal');
            const nameModal = document.getElementById('nameInputModal');
            const statusUpdateModal = document.getElementById('statusUpdateModal');
            
            if (event.target === editModal) {
              closeEditModal();
            } else if (event.target === nameModal) {
              closeNameModal();
            } else if (event.target === statusUpdateModal) {
              closeStatusUpdateModal();
            }
          });
          
          // Close modal with Escape key
          window.addEventListener('keydown', function(event) {
            if (event.key === 'Escape') {
              const editModal = document.getElementById('editStockModal');
              const nameModal = document.getElementById('nameInputModal');
              const statusUpdateModal = document.getElementById('statusUpdateModal');
              
              if (editModal.classList.contains('show')) {
                closeEditModal();
              } else if (nameModal.classList.contains('show')) {
                closeNameModal();
              } else if (statusUpdateModal.classList.contains('show')) {
                closeStatusUpdateModal();
              }
            }
          });
          
          setupReplenishmentPcoSearch();
          setupStatusUpdateModalSearch();
          
          // Restore collapse states on page load
          restoreCollapseStates();
          
          // Restore Edit Mode if it was active during an inventory operation
          const shouldRestoreEditMode = localStorage.getItem('replenishment-restore-edit-mode');
          if (shouldRestoreEditMode === 'true') {
            localStorage.removeItem('replenishment-restore-edit-mode');
            toggleEditMode();
          }
        </script>
      </body>
      </html>
    `;
    
    res.send(html);
  } catch (error) {
    console.error('Error rendering replenishment requests page:', error);
    res.status(500).send('Error loading page');
  }
});

app.get('/life-groups/groups/:groupId/attendance', async (req, res) => {
  try {
    const { groupId } = req.params;
    const showAllEvents = req.query.showAll === 'true';
    const forceRefresh = req.query.forceRefresh === 'true';

    
    const [group, attendanceData] = await Promise.all([
      getGroup(groupId, forceRefresh),
      getGroupAttendance(groupId, showAllEvents, forceRefresh)
    ]);
    
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>QCC Hub - LGHR - ${group.attributes.name}: Attendance</title>
          <link rel="icon" type="image/x-icon" href="https://www.queencitypeople.com/favicon.ico">
          <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
          <style>
            /* Fix radio buttons and checkboxes to show blue when checked */
            input[type="radio"]:checked {
              accent-color: #007bff;
            }
            input[type="checkbox"]:checked {
              accent-color: #007bff;
            }
            /* Fallback for older browsers */
            input[type="radio"] {
              appearance: auto;
              -webkit-appearance: auto;
            }
            input[type="checkbox"] {
              appearance: auto;
              -webkit-appearance: auto;
            }
            body {
              font-family: Arial, sans-serif;
              margin: 20px;
              background-color: #f5f5f5;
              transition: background-color 0.3s ease;
            }
            
            /* Dark mode styles */
            body.dark-mode {
              background-color: #1a1a1a;
              color: #ffffff;
            }
            
            body.dark-mode .container {
              background-color: #2d2d2d;
              color: #ffffff;
            }
            
            body.dark-mode h1,
            body.dark-mode h2 {
              color: #ffffff;
            }
            
            body.dark-mode .stats-card {
              background-color: #3d3d3d;
              color: #ffffff;
            }
            
            body.dark-mode .stats-note {
              color: #cccccc;
            }
            
            body.dark-mode .stat-item {
              background-color: #2d2d2d;
              color: #ffffff;
            }
            
            body.dark-mode .stat-value {
              color: #ffffff;
            }
            
            body.dark-mode .stat-label {
              color: #cccccc;
            }
            
            body.dark-mode .chart-container {
              background-color: #2d2d2d;
            }
            
            body.dark-mode .chart-loading {
              color: #cccccc;
            }
            
            body.dark-mode .back-button {
              background-color: #495057;
              color: #ffffff;
            }
            
            body.dark-mode .back-button:hover {
              background-color: #6c757d;
            }
            
            body.dark-mode .toggle-container {
              background-color: #3d3d3d;
            }
            
            body.dark-mode .toggle-label {
              color: #cccccc;
            }
            
            body.dark-mode .date-range {
              color: #cccccc;
            }
            
            body.dark-mode .event-item {
              background-color: #3d3d3d;
              color: #ffffff;
            }
            
            body.dark-mode .event-date {
              color: #cccccc;
            }
            
            body.dark-mode .event-stats {
              color: #cccccc;
            }
            
            body.dark-mode .attendance-good {
              color: #4caf50;
            }
            
            body.dark-mode .attendance-warning {
              color: #ff9800;
            }
            
            body.dark-mode .attendance-poor {
              color: #f44336;
            }
            
            
            /* Chart.js text colors for dark mode */
            body.dark-mode canvas {
              filter: brightness(1.3) contrast(1.1);
            }
            
            /* Table styling for dark mode */
            body.dark-mode table {
              color: #ffffff;
            }
            
            body.dark-mode th {
              background-color: #3d3d3d;
              color: #ffffff;
            }
            
            body.dark-mode td {
              border-bottom-color: #555;
            }
            
            body.dark-mode tr:hover {
              background-color: #3d3d3d;
            }
            
            body.dark-mode .canceled-event {
              color: #aaaaaa;
            }
            
            body.dark-mode .canceled-label {
              color: #f44336;
            }
            
            /* Back button should always use button styling, not link styling */
            body.dark-mode .back-button {
              background-color: #495057 !important;
              color: #ffffff !important;
              text-decoration: none !important;
            }
            
            body.dark-mode .back-button:hover {
              background-color: #6c757d !important;
              color: #ffffff !important;
              text-decoration: none !important;
            }
            
            body.dark-mode .back-button:visited {
              background-color: #495057 !important;
              color: #ffffff !important;
              text-decoration: none !important;
            }
            
            /* Softer link colors for better readability - but not for buttons */
            body.dark-mode a:not(.back-button) {
              color: #87ceeb !important; /* Soft sky blue */
            }
            
            body.dark-mode a:not(.back-button):visited {
              color: #dda0dd !important; /* Soft purple for visited links */
            }
            
            body.dark-mode a:not(.back-button):hover {
              color: #b0e0e6 !important; /* Lighter blue on hover */
              text-decoration: underline;
            }
            
            /* FOUC Prevention - Temporary loading styles */
            html.dark-mode-loading {
              background-color: #1a1a1a !important;
            }
            
            html.dark-mode-loading body {
              background-color: #1a1a1a !important;
              color: #ffffff !important;
            }
            
            html.dark-mode-loading .container {
              background-color: #2d2d2d !important;
              color: #ffffff !important;
            }
            
            html.dark-mode-loading h1,
            html.dark-mode-loading h2 {
              color: #ffffff !important;
            }
            
            html.dark-mode-loading canvas {
              filter: brightness(1.3) contrast(1.1) !important;
            }
            
            html.dark-mode-loading .back-button {
              background-color: #495057 !important;
              color: #ffffff !important;
            }
            .container {
              max-width: 1200px;
              margin: 0 auto;
              background-color: white;
              padding: 20px;
              border-radius: 8px;
              box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            }
            .chart-container {
              background-color: white;
              padding: 20px;
              border-radius: 8px;
              margin: 20px 0;
              height: 400px;
              position: relative;
            }
            .chart-loading {
              position: absolute;
              top: 50%;
              left: 50%;
              transform: translate(-50%, -50%);
              display: flex;
              flex-direction: column;
              align-items: center;
              gap: 15px;
              color: #666;
              font-size: 16px;
            }
            .chart-loading .loading {
              width: 40px;
              height: 40px;
              border: 4px solid #f3f3f3;
              border-top: 4px solid #007bff;
            }
            h1, h2 {
              color: #333;
            }
            .stats-card {
              background-color: #f8f9fa;
              padding: 20px;
              border-radius: 8px;
              margin: 20px 0;
              border-left: 4px solid #28a745;
            }
            .stats-note {
              color: #666;
              margin-bottom: 10px;
            }
            .stats-grid {
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
              gap: 20px;
              margin-bottom: 20px;
            }
            .stat-item {
              text-align: center;
              padding: 15px;
              background-color: white;
              border-radius: 4px;
              box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            }
            .stat-value {
              font-size: 24px;
              font-weight: bold;
              color: #007bff;
            }
            .stat-label {
              color: #666;
              margin-top: 5px;
            }
            table {
              width: 100%;
              border-collapse: collapse;
              margin-top: 20px;
            }
            th, td {
              padding: 12px;
              text-align: left;
              border-bottom: 1px solid #ddd;
            }
            th {
              background-color: #f8f9fa;
              font-weight: bold;
            }
            tr:hover {
              background-color: #f5f5f5;
            }
            .canceled-event {
              text-decoration: line-through;
              color: #6c757d;
            }
            .canceled-label {
              color: #dc3545;
              font-weight: bold;
            }
            .attendance-good {
              color: #28a745;
            }
            .attendance-warning {
              color: #ffc107;
            }
            .attendance-poor {
              color: #dc3545;
            }
            .back-button {
              display: inline-flex;
              align-items: center;
              gap: 8px;
              padding: 10px 16px;
              background-color: #6c757d;
              color: white;
              text-decoration: none;
              border-radius: 4px;
              font-size: 14px;
              margin-bottom: 20px;
              transition: background-color 0.3s ease;
            }
            .back-button:hover {
              background-color: #5a6268;
            }
            .visitor-count {
              color: #28a745;
            }
            .stat-item.with-details {
              display: flex;
              flex-direction: column;
              gap: 5px;
            }
            .stat-details {
              font-size: 14px;
              color: #666;
            }
            .stat-details .visitor-count {
              font-size: 14px;
            }
            .toggle-container {
              margin: 20px 0;
              padding: 15px;
              background-color: #f8f9fa;
              border-radius: 8px;
              display: flex;
              align-items: center;
              gap: 10px;
            }
            .toggle-switch {
              position: relative;
              display: inline-block;
              width: 60px;
              height: 34px;
            }
            .toggle-switch input {
              opacity: 0;
              width: 0;
              height: 0;
            }
            .toggle-slider {
              position: absolute;
              cursor: pointer;
              top: 0;
              left: 0;
              right: 0;
              bottom: 0;
              background-color: #ccc;
              transition: .4s;
              border-radius: 34px;
            }
            .toggle-slider:before {
              position: absolute;
              content: "";
              height: 26px;
              width: 26px;
              left: 4px;
              bottom: 4px;
              background-color: white;
              transition: .4s;
              border-radius: 50%;
            }
            input:checked + .toggle-slider {
              background-color: #2196F3;
            }
            input:checked + .toggle-slider:before {
              transform: translateX(26px);
            }
            .toggle-label {
              font-size: 16px;
              color: #666;
            }
            .date-range {
              font-size: 14px;
              color: #666;
              margin-left: auto;
            }
            .meeting-type {
              display: inline-block;
              padding: 4px 8px;
              border-radius: 4px;
              font-size: 12px;
              font-weight: bold;
              text-align: center;
              min-width: 50px;
            }
            .meeting-type.moms {
              background-color: #ffebee;
              color: #c2185b;
              border: 1px solid #f8bbd9;
            }
            .meeting-type.dads {
              background-color: #e3f2fd;
              color: #1976d2;
              border: 1px solid #90caf9;
            }
            .meeting-type.family {
              background-color: #e8f5e8;
              color: #388e3c;
              border: 1px solid #a5d6a7;
            }
            .meeting-type.other {
              background-color: #f5f5f5;
              color: #666;
              border: 1px solid #ddd;
            }
          </style>
          <script>
            // Apply dark mode immediately to prevent flash
            if (localStorage.getItem('darkMode') === 'true') {
              document.documentElement.classList.add('dark-mode-loading');
            }
          </script>
        </head>
        <body>
          <div class="container">
            <a href="/life-groups" class="back-button">
              <span><strong>⟵</strong></span>
              <span>Back to Groups</span>
            </a>

            <h1>${group.attributes.name}</h1>
            
            <div class="stats-card">
              <h2>Overall Statistics</h2>
              <div class="stats-note">
                Calculated from ${attendanceData.overall_statistics.events_with_attendance} total events with attendance
                (excluding visitors, canceled events, and events with no attendance).
              </div>
              <div class="stats-grid">
                <div class="stat-item">
                  <div class="stat-value">${attendanceData.overall_statistics.total_events}</div>
                  <div class="stat-label">Total Events</div>
                </div>
                <div class="stat-item with-details">
                  <div class="stat-value">${attendanceData.overall_statistics.average_attendance}</div>
                  <div class="stat-label">Average Attendance</div>
                  <div class="stat-details">
                    Average Members: ${attendanceData.overall_statistics.average_members}<br>
                    Average Visitors: <span class="visitor-count">+${attendanceData.overall_statistics.average_visitors}</span>
                  </div>
                </div>
                <div class="stat-item">
                  <div class="stat-value">${attendanceData.overall_statistics.overall_attendance_rate}%</div>
                  <div class="stat-label">Overall Attendance Rate</div>
                </div>
              </div>
            </div>
            
            ${'familyGroup' in attendanceData.overall_statistics ? `
            <div class="stats-card">
              <h2>Family Group Breakdown</h2>
              <div class="stats-note">
                Specialized metrics for Family Groups with separate Parents Nights (Mothers + Fathers) and Family Nights meetings.
              </div>
              <div class="stats-grid">
                <div class="stat-item">
                  <div class="stat-value">${(attendanceData.overall_statistics as any).familyGroup.parentsNightsAttendance}</div>
                  <div class="stat-label">Parents Nights Avg. Attendance</div>
                </div>
                <div class="stat-item">
                  <div class="stat-value">${(attendanceData.overall_statistics as any).familyGroup.familyNightsAttendance}</div>
                  <div class="stat-label">Family Nights Avg. Attendance</div>
                </div>
                <div class="stat-item">
                  <div class="stat-value ${(attendanceData.overall_statistics as any).familyGroup.parentsNightsRate >= 70 ? 'attendance-good' : (attendanceData.overall_statistics as any).familyGroup.parentsNightsRate >= 50 ? 'attendance-warning' : 'attendance-poor'}">${(attendanceData.overall_statistics as any).familyGroup.parentsNightsRate}%</div>
                  <div class="stat-label">Parents Nights Attendance Rate</div>
                </div>
                <div class="stat-item">
                  <div class="stat-value ${(attendanceData.overall_statistics as any).familyGroup.familyNightsRate >= 70 ? 'attendance-good' : (attendanceData.overall_statistics as any).familyGroup.familyNightsRate >= 50 ? 'attendance-warning' : 'attendance-poor'}">${(attendanceData.overall_statistics as any).familyGroup.familyNightsRate}%</div>
                  <div class="stat-label">Family Nights Attendance Rate</div>
                </div>
              </div>
            </div>
            ` : ''}
            
            <div class="toggle-container">
              <label class="toggle-switch">
                <input type="checkbox" id="showAllEvents" ${showAllEvents ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </label>
              <span class="toggle-label">Show all years</span>
              <span id="toggleLoadingMessage" style="color: #666; display: none; align-items: center;">
                <div class="loading" style="width: 16px; height: 16px; margin: 0 8px;"></div>
                Loading events...
              </span>
              <span class="date-range">
                Showing events from: ${showAllEvents ? 'All years' : 'Current year'}
              </span>
            </div>

            <script>
                          document.getElementById('showAllEvents').addEventListener('change', function() {
              const loadingMessage = document.getElementById('toggleLoadingMessage');
              loadingMessage.style.display = 'flex';
              const newUrl = new URL(window.location.href);
              newUrl.searchParams.set('showAll', this.checked);
              window.location.href = newUrl.toString();
            });
            </script>

            <div class="chart-container">
              <div id="chartLoading" class="chart-loading">
                <div class="loading"></div>
                <span>Loading chart data...</span>
              </div>
              <canvas id="attendanceChart"></canvas>
            </div>
 
            <h2>Attendance History</h2>
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  ${('familyGroup' in attendanceData.overall_statistics) ? '<th>Meeting Type</th>' : ''}
                  <th>PCO Link</th>
                  <th>Members</th>
                  <th>Visitors</th>
                  <th>Total Present</th>
                  <th>Registered Members</th>
                  <th>Members Attendance Rate</th>
                </tr>
              </thead>
              <tbody>
                ${(() => {
                  const isFamilyGroup = 'familyGroup' in attendanceData.overall_statistics;
                  
                  // For family groups, we need to calculate meeting types based on position within month
                  let eventsByMonth = new Map();
                  if (isFamilyGroup) {
                    // Group all past events by month to determine position
                    const allPastEvents = attendanceData.events
                      .filter(event => new Date(event.event.date) <= new Date())
                      .sort((a, b) => new Date(a.event.date).getTime() - new Date(b.event.date).getTime());
                    
                    allPastEvents.forEach(event => {
                      const eventDate = new Date(event.event.date);
                      const monthKey = `${eventDate.getFullYear()}-${String(eventDate.getMonth() + 1).padStart(2, '0')}`;
                      
                      if (!eventsByMonth.has(monthKey)) {
                        eventsByMonth.set(monthKey, []);
                      }
                      eventsByMonth.get(monthKey).push(event);
                    });
                  }
                  
                  // Function to get meeting type for family groups
                  const getMeetingType = (event: any) => {
                    if (!isFamilyGroup) return { text: '', cssClass: '' };
                    
                    const eventDate = new Date(event.event.date);
                    const monthKey = `${eventDate.getFullYear()}-${String(eventDate.getMonth() + 1).padStart(2, '0')}`;
                    const monthEvents = eventsByMonth.get(monthKey) || [];
                    const position = monthEvents.findIndex((e: any) => e.event.id === event.event.id);
                    
                    if (position === 0) return { text: 'Moms', cssClass: 'moms' };
                    else if (position === 1) return { text: 'Dads', cssClass: 'dads' };
                    else if (position === 2) return { text: 'Family', cssClass: 'family' };
                    else return { text: `${position + 1}th`, cssClass: 'other' };
                  };
                  
                  return attendanceData.events
                    .filter(event => new Date(event.event.date) <= new Date()) // Only show past/today events
                    .sort((a, b) => new Date(b.event.date).getTime() - new Date(a.event.date).getTime())
                    .map(event => {
                      const rate = event.attendance_summary.attendance_rate;
                      let rateClass = 'attendance-poor';
                      if (rate >= 70) rateClass = 'attendance-good';
                      else if (rate >= 50) rateClass = 'attendance-warning';
                      
                      const rowClass = event.event.canceled ? 'canceled-event' : '';
                      const eventUrl = 'https://groups.planningcenteronline.com/groups/' + groupId + '/events/' + event.event.id;
                      const meetingType = getMeetingType(event);
                      
                      return '<tr class="' + rowClass + '">' +
                             '<td>' +
                             formatDate(event.event.date) +
                             (event.event.canceled ? '<span class="canceled-label"> (CANCELED)</span>' : '') +
                             '</td>' +
                             (isFamilyGroup ? '<td><span class="meeting-type ' + meetingType.cssClass + '">' + meetingType.text + '</span></td>' : '') +
                             '<td>' +
                             '<a target="_blank" rel="noopener noreferrer" href="' + eventUrl + '" rel="noopener noreferrer" class="' + rowClass + '">Attendance</a>' +
                             '</td>' +
                             '<td>' + event.attendance_summary.present_members + '</td>' +
                             '<td>' + (event.attendance_summary.present_visitors > 0 ? 
                                     '<span class="visitor-count">+' + event.attendance_summary.present_visitors + '</span>' : 
                                     '0') + '</td>' +
                             '<td>' + event.attendance_summary.present_count + '</td>' +
                             '<td>' + event.attendance_summary.total_count + '</td>' +
                             '<td class="' + rateClass + '">' + rate + '%</td>' +
                             '</tr>';
                    }).join('');
                })()}
              </tbody>
            </table>
          </div>

          <script>
            const ctx = document.getElementById('attendanceChart').getContext('2d');
            
            // Hide loading indicator and show chart when ready
            const chartLoading = document.getElementById('chartLoading');
            if (chartLoading) chartLoading.style.display = 'none';
            document.getElementById('attendanceChart').style.display = 'block';
            
            // Prepare data for the chart
            const isFamilyGroup = ${('familyGroup' in attendanceData.overall_statistics)};
            
            const chartData = ${JSON.stringify(attendanceData.events
              .filter(event => !event.event.canceled && event.attendance_summary.present_count > 0)
              .sort((a, b) => new Date(a.event.date).getTime() - new Date(b.event.date).getTime())
              .map(event => ({
                date: formatDate(event.event.date),
                attendance: event.attendance_summary.present_count,
                total: event.attendance_summary.total_count,
                rate: event.attendance_summary.attendance_rate,
                rawDate: event.event.date
              }))
            )};
            
            // For family groups, calculate point colors based on meeting type
            let pointColors = null;
            if (isFamilyGroup) {
              // Group events by month to determine position
              const eventsByMonth = new Map();
              const allEvents = ${JSON.stringify(attendanceData.events
                .filter(event => new Date(event.event.date) <= new Date())
                .sort((a, b) => new Date(a.event.date).getTime() - new Date(b.event.date).getTime())
              )};
              
              allEvents.forEach(event => {
                const eventDate = new Date(event.event.date);
                const monthKey = \`\${eventDate.getFullYear()}-\${String(eventDate.getMonth() + 1).padStart(2, '0')}\`;
                if (!eventsByMonth.has(monthKey)) {
                  eventsByMonth.set(monthKey, []);
                }
                eventsByMonth.get(monthKey).push(event);
              });
              
              // Calculate colors for chart data points
              pointColors = chartData.map(item => {
                const eventDate = new Date(item.rawDate);
                const monthKey = \`\${eventDate.getFullYear()}-\${String(eventDate.getMonth() + 1).padStart(2, '0')}\`;
                const monthEvents = eventsByMonth.get(monthKey) || [];
                const position = monthEvents.findIndex(e => new Date(e.event.date).getTime() === eventDate.getTime());
                
                if (position === 0) return '#c2185b'; // Moms - pink
                else if (position === 1) return '#1976d2'; // Dads - blue  
                else if (position === 2) return '#388e3c'; // Family - green
                else return '#007bff'; // Default blue
              });
            }

            // Calculate year boundaries for vertical lines
            const yearBoundaries = [];
            const showAllEvents = ${showAllEvents};
            if (showAllEvents && chartData.length > 0) {
              let currentYear = null;
              chartData.forEach((item, index) => {
                const itemYear = new Date(item.rawDate).getFullYear();
                if (currentYear !== null && itemYear !== currentYear) {
                  yearBoundaries.push(index);
                }
                currentYear = itemYear;
              });
            }

            new Chart(ctx, {
              type: 'line',
              plugins: showAllEvents && yearBoundaries.length > 0 ? [{
                id: 'yearSeparators',
                afterDraw: function(chart) {
                  const ctx = chart.ctx;
                  const chartArea = chart.chartArea;
                  
                  ctx.save();
                  ctx.strokeStyle = 'rgba(0, 0, 0, 0.2)';
                  ctx.lineWidth = 1;
                  ctx.setLineDash([5, 5]);
                  
                  yearBoundaries.forEach(boundaryIndex => {
                    const x = chart.scales.x.getPixelForValue(boundaryIndex);
                    ctx.beginPath();
                    ctx.moveTo(x, chartArea.top);
                    ctx.lineTo(x, chartArea.bottom);
                    ctx.stroke();
                  });
                  
                  ctx.restore();
                }
              }] : [],
              data: {
                labels: chartData.map(item => item.date),
                datasets: [
                  {
                    label: 'Attendance',
                    data: chartData.map(item => item.attendance),
                    borderColor: '#007bff',
                    backgroundColor: 'rgba(0, 123, 255, 0.1)',
                    pointBackgroundColor: pointColors || '#007bff',
                    pointBorderColor: pointColors || '#007bff',
                    pointRadius: 3.5,
                    fill: true,
                    tension: 0.4
                  },
                  {
                    label: 'Total Members',
                    data: chartData.map(item => item.total),
                    borderColor: '#6c757d',
                    backgroundColor: 'rgba(108, 117, 125, 0.1)',
                    fill: true,
                    tension: 0.4
                  }
                ]
              },
              options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                  title: {
                    display: true,
                    text: 'Attendance Trends'
                  }
                },
                scales: {
                  y: {
                    beginAtZero: true,
                    title: {
                      display: true,
                      text: 'Number of People'
                    }
                  },
                  x: {
                    title: {
                      display: true,
                      text: 'Date'
                    },
                    ticks: {
                      maxRotation: 45,
                      minRotation: 45
                    }
                  }
                }
              }
            });
            
            // Dark mode functionality
            document.addEventListener('DOMContentLoaded', function() {
              // Remove temporary dark mode loading class
              document.documentElement.classList.remove('dark-mode-loading');
              
              // Initialize dark mode state from localStorage
              const isDarkMode = localStorage.getItem('darkMode') === 'true';
              
              if (isDarkMode) {
                document.body.classList.add('dark-mode');
              }
            });
          </script>
        </body>
      </html>
    `;
    
    res.send(html);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Failed to fetch attendance' });
  }
});

// Email transporter configuration
const createEmailTransporter = () => {
  // Check if email is configured
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log('Email not configured - SMTP_HOST, SMTP_USER, or SMTP_PASS missing');
    return null;
  }
  
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
};

const createAlertEmailTransporter = () => {
  if (!process.env.ALERT_SMTP_HOST || !process.env.ALERT_SMTP_USER || !process.env.ALERT_SMTP_PASS) {
    return null;
  }

  return nodemailer.createTransport({
    host: process.env.ALERT_SMTP_HOST,
    port: parseInt(process.env.ALERT_SMTP_PORT || '587'),
    secure: process.env.ALERT_SMTP_SECURE === 'true',
    auth: {
      user: process.env.ALERT_SMTP_USER,
      pass: process.env.ALERT_SMTP_PASS
    }
  });
};

const isSmtpAuthError = (error: any): boolean => {
  return error?.code === 'EAUTH' || error?.responseCode === 535;
};

const sendSmtpAuthFailureAlert = async (stage: string, error: any) => {
  const alertTo = process.env.ALERT_EMAIL_TO;
  if (!alertTo) {
    return;
  }

  const now = Date.now();
  if (now - lastSmtpAuthAlertAt < SMTP_AUTH_ALERT_COOLDOWN_MS) {
    return;
  }

  const alertTransporter = createAlertEmailTransporter();
  if (!alertTransporter) {
    console.warn('ALERT_EMAIL_TO is set, but ALERT_SMTP_* is not fully configured. Cannot send SMTP auth failure alert email.');
    return;
  }

  const errorMessage = error?.message || String(error);
  const responseCode = error?.responseCode || 'unknown';
  const responseSnippet = (error?.response || 'N/A').toString().slice(0, 500);
  const environmentName = process.env.RENDER_SERVICE_NAME || process.env.NODE_ENV || 'unknown';
  const fromEmail = process.env.ALERT_EMAIL_FROM || process.env.ALERT_SMTP_USER;
  const occurredAt = new Date().toISOString();

  try {
    await alertTransporter.sendMail({
      from: fromEmail,
      to: alertTo,
      subject: `[QCC Hub] SMTP auth failure detected (${environmentName})`,
      text: [
        'QCC Hub detected an SMTP authentication failure while sending Dream Team check-in notifications.',
        '',
        `Time: ${occurredAt}`,
        `Environment: ${environmentName}`,
        `Stage: ${stage}`,
        `Error message: ${errorMessage}`,
        `Response code: ${responseCode}`,
        `Response: ${responseSnippet}`
      ].join('\n')
    });

    lastSmtpAuthAlertAt = now;
    console.log(`Sent SMTP auth failure alert email to ${alertTo}`);
  } catch (alertError: any) {
    console.error('Failed to send SMTP auth failure alert email:', alertError?.message || alertError);
  }
};

// Helper function to fetch email address for a person from PCO
const fetchPersonEmail = async (personId: string, retries = 3): Promise<string | null> => {
  try {
    const response = await pcoClient.get(`/people/v2/people/${personId}`, {
      params: { include: 'emails' }
    });
    
    const emails = response.data.included?.filter((item: any) => item.type === 'Email') || [];
    const primaryEmailObj = emails.find((email: any) => email.attributes.primary === true);
    
    if (primaryEmailObj) {
      return primaryEmailObj.attributes.address;
    } else if (emails.length > 0) {
      return emails[0].attributes.address;
    }
    return null;
  } catch (error: any) {
    if (error.response?.status === 429 && retries > 0) {
      const retryAfter = parseInt(error.response.headers['retry-after'] || '0');
      const waitTime = retryAfter * 1000 || 3000 * Math.pow(2, 3 - retries);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return fetchPersonEmail(personId, retries - 1);
    }
    console.error(`Error fetching email for person ${personId}:`, error.message);
    return null;
  }
};

interface ReplenishmentNotificationPayload {
  requestId: number;
  itemId: number;
  departmentId: number;
  quantityRequested: number;
  requestedByPersonId: string;
  requestedByName: string;
  orderContacts: Array<{ personId: string; personName: string }>;
  notes?: string;
}

const escapeHtml = (value: string): string => {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

async function sendReplenishmentRequestNotifications(payload: ReplenishmentNotificationPayload) {
  if (process.env.REPLENISHMENT_EMAIL_FLAG === 'false') {
    return { notificationsSent: 0, skipped: 'Replenishment notifications disabled' };
  }

  const transporter = createEmailTransporter();
  if (!transporter) {
    return { notificationsSent: 0, skipped: 'Email not configured' };
  }

  try {
    await transporter.verify();
  } catch (verifyError: any) {
    if (isSmtpAuthError(verifyError)) {
      await sendSmtpAuthFailureAlert('replenishment.transporter.verify', verifyError);
      return { notificationsSent: 0, skipped: 'SMTP authentication failed' };
    }
    console.error('SMTP verification failed for replenishment notifications:', verifyError?.message || verifyError);
    return { notificationsSent: 0, skipped: 'SMTP verification failed' };
  }

  const allItems = replenishmentRequests.getAllItems();
  const item = allItems.find((i) => i.id === payload.itemId && i.department_id === payload.departmentId);
  const itemName = item?.name || `Item #${payload.itemId}`;
  const departmentName = item?.department_name || `Serve Area #${payload.departmentId}`;
  const unit = item?.unit || 'units';
  const fromEmail = process.env.SMTP_FROM || process.env.SMTP_USER;
  const appBaseUrl = (process.env.BASE_URL || process.env.APP_URL || '').trim();
  const replenishmentPath = '/replenishment-requests';
  const replenishmentUrl = appBaseUrl
    ? `${appBaseUrl.replace(/\/+$/, '')}${replenishmentPath}`
    : replenishmentPath;

  const recipientsSource = [...payload.orderContacts];
  if (!recipientsSource.some((c) => c.personId === payload.requestedByPersonId)) {
    recipientsSource.push({
      personId: payload.requestedByPersonId,
      personName: payload.requestedByName
    });
  }

  const recipients = await mapWithConcurrency(recipientsSource, 2, async (contact) => {
    const email = await fetchPersonEmail(contact.personId);
    return {
      personId: contact.personId,
      personName: contact.personName,
      email
    };
  });

  const dedupedByEmail = new Map<string, { personName: string; email: string }>();
  for (const recipient of recipients) {
    if (!recipient.email) continue;
    const emailKey = recipient.email.toLowerCase();
    if (!dedupedByEmail.has(emailKey)) {
      dedupedByEmail.set(emailKey, {
        personName: recipient.personName,
        email: recipient.email
      });
    }
  }
  const validRecipients = Array.from(dedupedByEmail.values());
  if (validRecipients.length === 0) {
    console.log(`No valid recipient emails for replenishment request ${payload.requestId}`);
    return { notificationsSent: 0, skipped: 'No recipient emails found' };
  }

  const to = validRecipients.map((r) => r.email).join(', ');
  const recipientNames = validRecipients.map((r) => r.personName).join(', ');
  const notesText = payload.notes?.trim() ? payload.notes.trim() : 'None';

  const subject = `[QCC Hub] New Replenishment Request - ${itemName}`;
  const text = [
    'A new Replenishment Request has been submitted for you in QCC Hub.',
    '',
    `Item: ${itemName}`,
    `Serve Area: ${departmentName}`,
    `Quantity: ${payload.quantityRequested} ${unit}`,
    `Requested by: ${payload.requestedByName}`,
    `Notified contacts: ${recipientNames}`,
    `Notes: ${notesText}`,
    '',
    'Here is the Link to the Replenishment Requests: ${replenishmentUrl}',
    replenishmentUrl
  ].join('\n');

  const html = `
    <p>A new Replenishment Request has been submitted for you in <strong>QCC Hub</strong>.</p>
    <ul>
      <li><strong>Item:</strong> ${escapeHtml(itemName)}</li>
      <li><strong>Serve Area:</strong> ${escapeHtml(departmentName)}</li>
      <li><strong>Quantity:</strong> ${payload.quantityRequested} ${escapeHtml(unit)}</li>
      <li><strong>Requested by:</strong> ${escapeHtml(payload.requestedByName)}</li>
      <li><strong>Notified contacts:</strong> ${escapeHtml(recipientNames)}</li>
      <li><strong>Notes:</strong> ${escapeHtml(notesText)}</li>
    </ul>
    <p>Here's the Link to the <a href="${escapeHtml(replenishmentUrl)}">Replenishment Requests</a></p>
  `;

  try {
    await transporter.sendMail({
      from: fromEmail,
      to,
      subject,
      text,
      html
    });
    console.log(`Replenishment request notification sent for request ${payload.requestId} to ${to}`);
    return { notificationsSent: validRecipients.length };
  } catch (sendError: any) {
    if (isSmtpAuthError(sendError)) {
      await sendSmtpAuthFailureAlert('replenishment.sendMail', sendError);
      return { notificationsSent: 0, skipped: 'SMTP authentication failed while sending' };
    }
    console.error(`Failed to send replenishment notification for request ${payload.requestId}:`, sendError?.message || sendError);
    return { notificationsSent: 0, skipped: 'Send failed' };
  }
}

interface ReplenishmentStatusNotificationPayload {
  requestId: number;
  itemName: string;
  departmentName: string;
  quantityRequested: number;
  unit: string;
  requestedByName: string;
  requestedByPersonId: string | null;
  orderContacts: Array<{ personId: string; personName: string }>;
  newStatus: 'ordered' | 'delivered' | 'stocked';
  changedByName: string;
  currentStockTotal?: number | null;
}

async function sendReplenishmentStatusNotifications(payload: ReplenishmentStatusNotificationPayload) {
  if (process.env.REPLENISHMENT_EMAIL_FLAG === 'false') {
    return { notificationsSent: 0, skipped: 'Replenishment notifications disabled' };
  }

  const transporter = createEmailTransporter();
  if (!transporter) {
    return { notificationsSent: 0, skipped: 'Email not configured' };
  }

  try {
    await transporter.verify();
  } catch (verifyError: any) {
    if (isSmtpAuthError(verifyError)) {
      await sendSmtpAuthFailureAlert('replenishment.status.transporter.verify', verifyError);
      return { notificationsSent: 0, skipped: 'SMTP authentication failed' };
    }
    console.error('SMTP verification failed for replenishment status notifications:', verifyError?.message || verifyError);
    return { notificationsSent: 0, skipped: 'SMTP verification failed' };
  }

  const fromEmail = process.env.SMTP_FROM || process.env.SMTP_USER;
  const appBaseUrl = (process.env.BASE_URL || process.env.APP_URL || '').trim();
  const replenishmentPath = '/replenishment-requests';
  const replenishmentUrl = appBaseUrl
    ? `${appBaseUrl.replace(/\/+$/, '')}${replenishmentPath}`
    : replenishmentPath;

  const recipientsSource = [...payload.orderContacts];
  if (payload.requestedByPersonId && !recipientsSource.some((c) => c.personId === payload.requestedByPersonId)) {
    recipientsSource.push({
      personId: payload.requestedByPersonId,
      personName: payload.requestedByName
    });
  }

  const recipients = await mapWithConcurrency(recipientsSource, 2, async (contact) => {
    const email = await fetchPersonEmail(contact.personId);
    return { personName: contact.personName, email };
  });

  const dedupedByEmail = new Map<string, { personName: string; email: string }>();
  for (const recipient of recipients) {
    if (!recipient.email) continue;
    const emailKey = recipient.email.toLowerCase();
    if (!dedupedByEmail.has(emailKey)) {
      dedupedByEmail.set(emailKey, {
        personName: recipient.personName,
        email: recipient.email
      });
    }
  }
  const validRecipients = Array.from(dedupedByEmail.values());
  if (validRecipients.length === 0) {
    console.log(`No valid recipient emails for replenishment status update ${payload.requestId}`);
    return { notificationsSent: 0, skipped: 'No recipient emails found' };
  }

  const to = validRecipients.map((r) => r.email).join(', ');
  const recipientNames = validRecipients.map((r) => r.personName).join(', ');
  const humanStatus =
    payload.newStatus === 'ordered'
      ? 'Ordered'
      : payload.newStatus === 'delivered'
        ? 'Delivered'
        : 'Stocked';
  const stockedLine =
    payload.newStatus === 'stocked' && typeof payload.currentStockTotal === 'number'
      ? `New stock total: ${payload.currentStockTotal} ${payload.unit}`
      : null;
  const introLine =
    payload.newStatus === 'stocked'
      ? 'A replenishment request has been fully stocked in QCC Hub.'
      : 'A replenishment request status has been updated in QCC Hub.';

  const subject = `[QCC Hub] Replenishment Request ${humanStatus} - ${payload.itemName}`;
  const text = [
    introLine,
    '',
    `New status: ${humanStatus}`,
    `Item: ${payload.itemName}`,
    `Serve Area: ${payload.departmentName}`,
    `Quantity: ${payload.quantityRequested} ${payload.unit}`,
    ...(stockedLine ? [stockedLine] : []),
    `Originally requested by: ${payload.requestedByName}`,
    `Updated by: ${payload.changedByName}`,
    `Notified contacts: ${recipientNames}`,
    '',
    'Here is the link to the Replenishment Requests:',
    replenishmentUrl
  ].join('\n');

  const html = `
    <p>${escapeHtml(introLine)}</p>
    <ul>
      <li><strong>New status:</strong> ${escapeHtml(humanStatus)}</li>
      <li><strong>Item:</strong> ${escapeHtml(payload.itemName)}</li>
      <li><strong>Serve Area:</strong> ${escapeHtml(payload.departmentName)}</li>
      <li><strong>Quantity:</strong> ${payload.quantityRequested} ${escapeHtml(payload.unit)}</li>
      ${stockedLine ? `<li><strong>New stock total:</strong> ${payload.currentStockTotal} ${escapeHtml(payload.unit)}</li>` : ''}
      <li><strong>Originally requested by:</strong> ${escapeHtml(payload.requestedByName)}</li>
      <li><strong>Updated by:</strong> ${escapeHtml(payload.changedByName)}</li>
      <li><strong>Notified contacts:</strong> ${escapeHtml(recipientNames)}</li>
    </ul>
    <p>Here's the Link to the <a href="${escapeHtml(replenishmentUrl)}">Replenishment Requests</a></p>
  `;

  try {
    await transporter.sendMail({
      from: fromEmail,
      to,
      subject,
      text,
      html
    });
    console.log(`Replenishment status notification sent for request ${payload.requestId} to ${to}`);
    return { notificationsSent: validRecipients.length };
  } catch (sendError: any) {
    if (isSmtpAuthError(sendError)) {
      await sendSmtpAuthFailureAlert('replenishment.status.sendMail', sendError);
      return { notificationsSent: 0, skipped: 'SMTP authentication failed while sending' };
    }
    console.error(`Failed to send replenishment status notification for request ${payload.requestId}:`, sendError?.message || sendError);
    return { notificationsSent: 0, skipped: 'Send failed' };
  }
}

// Check for members with check-ins due today and send notifications
async function sendCheckInNotifications() {
  console.log(`[${new Date().toISOString()}] Checking for members with check-ins due today...`);
  
  const transporter = createEmailTransporter();
  if (!transporter) {
    console.log('Email notifications disabled - SMTP not configured');
    return { notificationsSent: 0, skipped: 'Email not configured' };
  }

  try {
    await transporter.verify();
  } catch (verifyError: any) {
    if (isSmtpAuthError(verifyError)) {
      console.error('SMTP authentication failed during check-in notifications. Skipping email sends until credentials are corrected.');
      await sendSmtpAuthFailureAlert('transporter.verify', verifyError);
      return { notificationsSent: 0, skipped: 'SMTP authentication failed' };
    }
    console.error('SMTP verification failed. Skipping check-in notification emails:', verifyError?.message || verifyError);
    return { notificationsSent: 0, skipped: 'SMTP verification failed' };
  }
  
  const fromEmail = process.env.SMTP_FROM || process.env.SMTP_USER;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  // Teams that don't require check-ins
  const teamsWithoutCheckIns = ['665166'];
  
  try {
    // Get all Dream Team workflows
    const workflows = await getDreamTeamWorkflows(false); // Use cached data from refresh
    
    interface CheckInNotification {
      workflowId: string;
      workflowName: string;
      memberName: string;
      memberId: string;
      checkInType: '2-month' | '6-month';
    }
    
    const notificationsToSend: CheckInNotification[] = [];
    
    // Process each workflow using cached data
    for (const workflow of workflows) {
      if (teamsWithoutCheckIns.includes(workflow.id)) continue;
      
      // Get workflow cards from cache (no API call if cached)
      const { cards, people } = await getWorkflowCards(workflow.id, false);
      
      // Filter to only completed members
      const completedCards = cards.filter((card: any) => card.attributes.stage === 'completed');
      
      // Build person map
      const personMap = new Map<string, any>();
      people.forEach((person: any) => personMap.set(person.id, person));
      
      // Get existing check-ins for this workflow (from local database - fast)
      const workflowCheckIns = dreamTeamsTracking.getWorkflowCheckIns(workflow.id);
      
      // SPECIAL TEST WORKFLOW: 610176 always sends notifications for all members
      if (workflow.id === '610176') {
        for (const card of completedCards) {
          const personId = card.relationships.person.data.id;
          const person = personMap.get(personId);
          const memberName = person 
            ? `${person.attributes.first_name} ${person.attributes.last_name}`
            : 'Unknown Member';
          
          // Get existing check-ins
          const memberCheckIns = workflowCheckIns.get(personId) || [];
          const hasTwoMonthCheckIn = memberCheckIns.some(c => c.checkInType === '2-month');
          const hasSixMonthCheckIn = memberCheckIns.some(c => c.checkInType === '6-month');
          
          // Add 2-month check-in notification if not already completed
          if (!hasTwoMonthCheckIn) {
            notificationsToSend.push({
              workflowId: workflow.id,
              workflowName: workflow.name,
              memberName,
              memberId: personId,
              checkInType: '2-month'
            });
          }
          
          // Add 6-month check-in notification if not already completed
          if (!hasSixMonthCheckIn) {
            notificationsToSend.push({
              workflowId: workflow.id,
              workflowName: workflow.name,
              memberName,
              memberId: personId,
              checkInType: '6-month'
            });
          }
        }
        continue; // Skip normal processing for this test workflow
      }
      
      // Process all cards without delays (no API calls here, just local data processing)
      for (const card of completedCards) {
        const personId = card.relationships.person.data.id;
        const person = personMap.get(personId);
        const memberName = person 
          ? `${person.attributes.first_name} ${person.attributes.last_name}`
          : 'Unknown Member';
        
        const originalJoinDate = new Date(card.attributes.created_at);
        const completionDate = card.attributes.moved_to_step_at 
          ? new Date(card.attributes.moved_to_step_at) 
          : null;
        
        // Check if this was a bulk completion on 10/1/2025
        const isBulkCompletion = completionDate && 
          completionDate.getFullYear() === 2025 && 
          completionDate.getMonth() === 9 && 
          completionDate.getDate() === 1;
        
        // Get existing check-ins
        const memberCheckIns = workflowCheckIns.get(personId) || [];
        const hasTwoMonthCheckIn = memberCheckIns.some(c => c.checkInType === '2-month');
        const hasSixMonthCheckIn = memberCheckIns.some(c => c.checkInType === '6-month');
        
        // Calculate the dates when check-ins become due
        const effectiveStartDate = isBulkCompletion ? originalJoinDate : (completionDate || originalJoinDate);
        
        // 2-month check-in due date
        const twoMonthDueDate = new Date(effectiveStartDate);
        twoMonthDueDate.setMonth(twoMonthDueDate.getMonth() + 2);
        twoMonthDueDate.setHours(0, 0, 0, 0);
        
        // 6-month check-in due date
        const sixMonthDueDate = new Date(effectiveStartDate);
        sixMonthDueDate.setMonth(sixMonthDueDate.getMonth() + 6);
        sixMonthDueDate.setHours(0, 0, 0, 0);
        
        // Check if 2-month check-in is due TODAY
        if (!hasTwoMonthCheckIn && twoMonthDueDate.getTime() === today.getTime()) {
          // Skip legacy members (bulk completion with join date 2+ months before)
          if (isBulkCompletion) {
            const monthsBeforeBulk = (completionDate!.getFullYear() - originalJoinDate.getFullYear()) * 12 + 
              (completionDate!.getMonth() - originalJoinDate.getMonth());
            if (monthsBeforeBulk >= 2) continue;
          }
          
          notificationsToSend.push({
            workflowId: workflow.id,
            workflowName: workflow.name,
            memberName,
            memberId: personId,
            checkInType: '2-month'
          });
        }
        
        // Check if 6-month check-in is due TODAY
        if (!hasSixMonthCheckIn && sixMonthDueDate.getTime() === today.getTime()) {
          // Skip legacy members (bulk completion with join date 6+ months before)
          if (isBulkCompletion) {
            const monthsBeforeBulk = (completionDate!.getFullYear() - originalJoinDate.getFullYear()) * 12 + 
              (completionDate!.getMonth() - originalJoinDate.getMonth());
            if (monthsBeforeBulk >= 6) continue;
          }
          
          notificationsToSend.push({
            workflowId: workflow.id,
            workflowName: workflow.name,
            memberName,
            memberId: personId,
            checkInType: '6-month'
          });
        }
      }
    }
    
    console.log(`Found ${notificationsToSend.length} check-in(s) due today`);
    
    if (notificationsToSend.length === 0) {
      return { notificationsSent: 0, message: 'No check-ins due today' };
    }
    
    // Group notifications by workflow
    const notificationsByWorkflow = new Map<string, CheckInNotification[]>();
    for (const notification of notificationsToSend) {
      const existing = notificationsByWorkflow.get(notification.workflowId) || [];
      existing.push(notification);
      notificationsByWorkflow.set(notification.workflowId, existing);
    }
    
    let emailsSent = 0;
    
    // Send emails to team leaders/directors for each team
    for (const [workflowId, notifications] of notificationsByWorkflow) {
      const workflowName = notifications[0].workflowName;
      
      // Get leaders for this team
      const leaders = dreamTeamsTracking.getTeamLeaders(workflowId);
      
      if (leaders.length === 0) {
        console.log(`No leaders configured for ${workflowName} - skipping notifications`);
        continue;
      }
      
      // Fetch email addresses for each leader
      const leaderEmails: string[] = [];
      for (const leader of leaders) {
        const email = await fetchPersonEmail(leader.personId);
        if (email) {
          leaderEmails.push(email);
        }
        await new Promise(resolve => setTimeout(resolve, 200)); // Rate limit protection
      }
      
      if (leaderEmails.length === 0) {
        console.log(`Could not fetch emails for leaders of ${workflowName} - skipping`);
        continue;
      }
      
      // Build email content
      const memberList = notifications.map(n => 
        `• ${n.memberName} - ${n.checkInType} check-in`
      ).join('\n');
      
      // Extract first names from Team Leaders, fallback to Directors if none
      let leadersToGreet = leaders.filter(leader => leader.role === 'team_leader');
      if (leadersToGreet.length === 0) {
        // No Team Leaders, use Directors instead
        leadersToGreet = leaders.filter(leader => leader.role === 'director');
      }
      
      const firstNames = leadersToGreet.map(leader => {
        const name = leader.personName.trim();
        const firstName = name.split(' ')[0];
        return firstName;
      });
      
      // Format greeting with first names
      let greeting = 'Hey ';
      if (firstNames.length === 1) {
        greeting += `${firstNames[0]}!`;
      } else if (firstNames.length === 2) {
        greeting += `${firstNames[0]} and ${firstNames[1]}!`;
      } else if (firstNames.length > 2) {
        // 3 or more: "John, Sarah, and Mike!"
        greeting += firstNames.slice(0, -1).join(', ') + `, and ${firstNames[firstNames.length - 1]}!`;
      } else {
        // No leaders at all (shouldn't happen), fallback to generic greeting
        greeting = 'Hello!';
      }
      
      const dreamTeamUrl = `${process.env.BASE_URL || 'https://qcc-hub.com'}/dream-teams/${workflowId}`;
      
      const emailSubject = `Dream Team Check-In${notifications.length > 1 ? 's' : ''} Due - ${workflowName}`;
      
      // Plain text version (fallback)
      const emailBodyText = `
${greeting}

You're receiving this email to let you know that the following ${notifications.length > 1 ? 'people have' : 'person has'} been serving on your team for a little while, and ${notifications.length > 1 ? 'are' : 'is'} due for a check-in!

${memberList}

As a reminder, here are the guidelines for how to accomplish this check-in >> https://drive.google.com/file/d/1Uim22MdjIzYw-vuj8R-Y6nibCinAXhZN/view?usp=sharing

This should be completed within 2 weeks from today. Please respond back to this email if you have any questions!

Once your check-in${notifications.length > 1 ? 's are' : ' is'} completed, please mark that next to the person's name on your Dream Team Health Report here >> ${dreamTeamUrl}

Thank you SO MUCH for loving and caring for our Dream Team well! 

Hannah Whorton
Next Steps Director
      `.trim();
      
      // HTML version (with formatting)
      const memberListHtml = notifications.map(n => 
        `<li>${n.memberName} - ${n.checkInType} check-in</li>`
      ).join('');
      
      const emailBodyHtml = `
<p>${greeting}</p>

<p>You're receiving this email to let you know that the following ${notifications.length > 1 ? 'people have' : 'person has'} been serving on your team for a little while, and ${notifications.length > 1 ? 'are' : 'is'} due for a check-in!</p>

<ul>
${memberListHtml}
</ul>

<p>As a reminder, here are the guidelines for how to accomplish this check-in &gt;&gt; <a href="https://drive.google.com/file/d/1Uim22MdjIzYw-vuj8R-Y6nibCinAXhZN/view?usp=sharing">Google Drive Link</a></p>

<p><strong>This should be completed within 2 weeks from today.</strong> Please respond back to this email if you have any questions!</p>

<p>Once your check-in${notifications.length > 1 ? 's are' : ' is'} completed, please mark that next to the person's name on your Dream Team Health Report here &gt;&gt; <a href="${dreamTeamUrl}">${workflowName} Team Roster</a></p>

<p>Thank you SO MUCH for loving and caring for our Dream Team well!</p>

<p>Hannah Whorton<br>
Next Steps Director</p>
      `.trim();
      
      try {
        const mailOptions: {
          from: string | undefined;
          to: string;
          subject: string;
          text: string;
          html: string;
          bcc?: string;
        } = {
          from: fromEmail,
          to: leaderEmails.join(', '),
          subject: emailSubject,
          text: emailBodyText,
          html: emailBodyHtml
        };
        
        // Add BCC for monitoring if configured
        if (process.env.SMTP_BCC) {
          mailOptions.bcc = process.env.SMTP_BCC;
        }
        
        await transporter.sendMail(mailOptions);
        
        emailsSent++;
        console.log(`Sent check-in notification email to ${workflowName} leaders: ${leaderEmails.join(', ')}${process.env.SMTP_BCC ? ` (BCC: ${process.env.SMTP_BCC})` : ''}`);
      } catch (emailError: any) {
        if (isSmtpAuthError(emailError)) {
          console.error(`SMTP auth failed while sending ${workflowName} notification. Stopping further email attempts.`);
          await sendSmtpAuthFailureAlert(`sendMail (${workflowName})`, emailError);
          break;
        }

        const emailErrorMessage = emailError?.message || String(emailError);
        console.error(`Failed to send email to ${workflowName} leaders: ${emailErrorMessage}`);
      }
    }
    
    return { 
      notificationsSent: emailsSent, 
      checkInsDue: notificationsToSend.length,
      teamsNotified: emailsSent
    };
    
  } catch (error) {
    console.error('Error checking for check-in notifications:', error);
    return { notificationsSent: 0, error: String(error) };
  }
}

// Automatic data refresh function
async function performAutomaticRefresh() {
  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] Starting automatic morning data refresh...`);
  
  try {
    const groupTypeIdFromEnv = process.env.PCO_GROUP_TYPE_ID;
    const groupTypeId = groupTypeIdFromEnv ? parseInt(groupTypeIdFromEnv, 10) : 429361;
    
    // First, get all groups with force refresh
    console.log('Fetching fresh group data...');
    const groupsResult = await getPeopleGroups(groupTypeId, true);
    console.log(`Found ${groupsResult.data.length} groups to refresh`);
    
    // Process groups with current year data only (not historical)
    let successCount = 0;
    let errorCount = 0;
    
    for (let i = 0; i < groupsResult.data.length; i++) {
      const group = groupsResult.data[i];
      
      try {
        console.log(`Processing group ${i + 1}/${groupsResult.data.length}: ${group.attributes.name}`);
        
        // Refresh current year attendance data (showAll=false, forceRefresh=true)
        await getGroupAttendance(group.id, false, true);
        successCount++;
        
        // Add delay between groups to be respectful to PCO API
        if (i < groupsResult.data.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second delay
        }
      } catch (error) {
        console.error(`Failed to refresh group ${group.id} (${group.attributes.name}):`, error);
        errorCount++;
      }
    }
    
    // Also refresh aggregate data
    console.log('Refreshing aggregate attendance data...');
    try {
      // This will use the freshly cached individual group data
      const response = await fetch(`http://localhost:${port}/api/aggregate-attendance?forceRefresh=false&showAll=false`);
      if (!response.ok) {
        throw new Error(`Aggregate refresh failed: ${response.status}`);
      }
      console.log('Aggregate data refreshed successfully');
    } catch (error) {
      console.error('Failed to refresh aggregate data:', error);
      errorCount++;
    }
    
    // Create daily membership snapshot
    try {
      const date = new Date().toISOString().split('T')[0];
      
      // Only create snapshot if we don't already have one for today
      if (!membershipSnapshots.hasSnapshotForDate(date)) {
        let snapshotSuccessCount = 0;
        let snapshotErrorCount = 0;
        
        for (const group of groupsResult.data) {
          try {
            const memberships = await getGroupMemberships(group.id, true); // Force refresh for daily snapshots!
            membershipSnapshots.storeDailySnapshot(date, group.id, group.attributes.name, memberships);
            snapshotSuccessCount++;
            
            // Small delay between groups
            await new Promise(resolve => setTimeout(resolve, 200));
          } catch (error) {
            console.error(`Failed to create membership snapshot for group ${group.id}:`, error);
            snapshotErrorCount++;
          }
        }
        
        console.log(`Membership snapshot completed for ${date}. Success: ${snapshotSuccessCount}, Errors: ${snapshotErrorCount}`);
      }
    } catch (error) {
      console.error('Failed to create membership snapshot:', error);
      errorCount++;
    }
    
    // Refresh Dream Teams workflow data
    console.log('Refreshing Dream Teams workflow data...');
    try {
      const dreamTeamWorkflows = await getDreamTeamWorkflows(true); // Force refresh
      console.log(`Dream Teams workflows refreshed: ${dreamTeamWorkflows.length} teams`);
      
      // Also refresh individual workflow cards for each team
      let dtSuccessCount = 0;
      let dtErrorCount = 0;
      
      for (let i = 0; i < dreamTeamWorkflows.length; i++) {
        const workflow = dreamTeamWorkflows[i];
        try {
          await getWorkflowCards(workflow.id, true); // Force refresh
          dtSuccessCount++;
          
          // Add delay between workflows to be respectful to PCO API
          if (i < dreamTeamWorkflows.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        } catch (error) {
          console.error(`Failed to refresh Dream Team workflow ${workflow.id} (${workflow.name}):`, error);
          dtErrorCount++;
        }
      }
      
      console.log(`Dream Teams refresh completed. Success: ${dtSuccessCount}, Errors: ${dtErrorCount}`);
    } catch (error) {
      console.error('Failed to refresh Dream Teams data:', error);
      errorCount++;
    }
    
    // Send check-in notifications after Dream Teams data is refreshed
    if (process.env.CHECKIN_EMAIL_FLAG === 'true') {
      console.log('Checking for Dream Team check-in notifications...');
      try {
        const notificationResult = await sendCheckInNotifications();
        console.log(`Check-in notifications result:`, notificationResult);
      } catch (error) {
        console.error('Failed to send check-in notifications:', error);
      }
    } else {
      console.log('Check-in notifications are disabled (CHECKIN_EMAIL_FLAG is not set to true)');
    }
    
    const duration = Math.round((Date.now() - startTime) / 1000);
    console.log(`[${new Date().toISOString()}] Automatic refresh completed in ${duration}s. Success: ${successCount}, Errors: ${errorCount}`);
    
  } catch (error) {
    const duration = Math.round((Date.now() - startTime) / 1000);
    console.error(`[${new Date().toISOString()}] Automatic refresh failed after ${duration}s:`, error);
  }
}

// Schedule automatic refresh at 6:00 AM EST every day
// Cron format: minute hour day month dayOfWeek
// Using timezone option to ensure it runs at EST regardless of server timezone
cron.schedule('0 6 * * *', performAutomaticRefresh, {
  scheduled: true,
  timezone: "America/New_York" // EST/EDT timezone
});

console.log('Automatic morning refresh scheduled for 6:00 AM EST daily');

// Start server
app.listen(port, () => {
  console.log('Server running at http://localhost:' + port);
}); 