import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cron from 'node-cron';
import pcoClient, { getPeopleGroups, getGroupAttendance, getGroup, getGroupMemberships, getDreamTeamWorkflows, getWorkflowCards } from './config/pco.js';
import { cache } from './config/cache.js';
import { membershipSnapshots, dreamTeamsTracking } from '../data/database.js';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

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

// Add new endpoint to get cache timestamp
app.get('/api/cache-info', async (req, res) => {
  try {
    const cacheKey = 'all_groups';
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
    
    // Get attendance data for each selected group
    const groupAttendancePromises = selectedGroups.map(async (group) => {
      const attendance = await getGroupAttendance(group.id, showAllEvents, forceRefresh);
      return {
        groupId: group.id,
        groupName: group.attributes.name,
        ...attendance
      };
    });
    
    const allGroupsAttendance = await Promise.all(groupAttendancePromises);
    
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
    const attendancePromises = filteredGroups.data.map(async (group) => {
      const attendance = await getGroupAttendance(group.id, showAllEvents, forceRefresh);
      return {
        ...attendance,
        group_name: group.attributes.name
      };
    });
    
    const allGroupsAttendance = await Promise.all(attendancePromises);
    
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
      
      // Filter database removals to only those still active in this workflow's PCO data
      const workflowRemovals = allRemovals.filter(removal => removal.workflowId === workflow.id);
      const actualPendingRemovals = workflowRemovals.filter(removal => {
        // Check if this person is still in the current workflow roster
        const currentMember = workflow.roster.find(member => member.personId === removal.personId);
        if (!currentMember) {
          return false; // Not in roster
        }
        
        // Check if they rejoined after the removal date
        const joinDate = new Date(currentMember.movedToStepAt || currentMember.joinedAt);
        const removalDate = new Date(removal.removalDate);
        
        // Only consider it pending if they didn't rejoin after removal
        return joinDate <= removalDate;
      });
      
      // Calculate if review is needed (more than 30 days since last review)
      let needsReview = true;
      if (lastReviewed) {
        const daysSinceReview = Math.floor((Date.now() - new Date(lastReviewed).getTime()) / (1000 * 60 * 60 * 24));
        needsReview = daysSinceReview > 30;
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

// Get all pending removals across all teams (for admin review)
app.get('/api/dream-teams/pending-removals', async (req, res) => {
  try {
    // Get all removals from database
    const allRemovals = dreamTeamsTracking.getAllPendingRemovals();
    
    // Get current PCO data for all workflows to see who's still there
    const currentWorkflows = await getDreamTeamWorkflows();
    
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
    
    // Filter removals to only show people who are still in PCO workflows AND haven't rejoined
    const actualPendingRemovals = allRemovals.filter(removal => {
      const memberKey = `${removal.workflowId}-${removal.personId}`;
      const memberDetails = currentMemberDetails.get(memberKey);
      
      if (!memberDetails) {
        return false; // Not currently in any workflow
      }
      
      // Check if they rejoined after the removal date
      const removalDate = new Date(removal.removalDate);
      return memberDetails.joinDate <= removalDate;
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
    
    // Get all removals for this workflow and filter based on current PCO data
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
      
      if (isCurrentlyInPCO) {
        // Check if they rejoined after the removal date
        const currentJoinDate = currentMemberJoinDates.get(removal.personId);
        const removalDate = new Date(removal.removalDate);
        
        if (currentJoinDate && currentJoinDate > removalDate) {
          // They rejoined after being removed - treat as past member (don't mark as pending)
          pastMembers.push(removal);
        } else {
          // Still pending removal
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
    
    // Combine card and person data
    const roster = currentMembers.map(card => {
      const person = personMap.get(card.relationships.person.data.id);
      const personId = card.relationships.person.data.id;
      const isPendingRemoval = pendingRemovalMap.has(personId);
      
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
        removalReason: isPendingRemoval ? pendingRemovalMap.get(personId) : null
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
        

        
        // Clear the tables
        const reviewResult = dbInstance.prepare('DELETE FROM dream_team_reviews').run();
        const removalResult = dbInstance.prepare('DELETE FROM dream_team_removals').run();
        
        result.clearedDatabase = reviewCount + removalCount;
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
          <title>Recent Membership Changes - QCC Hub</title>
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
                <span>←</span>
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
          <title>Queen City Church - Life Groups Health Report</title>
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
              color: #4fc3f7;
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
                    '<a href="/life-groups/groups/' + group.id + '/attendance" style="color: #007bff; text-decoration: none; font-size: 18px; font-weight: 500;" onmouseover="this.style.textDecoration=&quot;underline&quot;;" onmouseout="this.style.textDecoration=&quot;none&quot;;">' +
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

            async function updateLastUpdateTime() {
              try {
                const response = await fetch('/api/cache-info');
                if (!response.ok) throw new Error('Failed to fetch cache info');
                const { timestamp } = await response.json();
                if (timestamp) {
                  lastUpdate.textContent = \`Last updated: \${formatLastUpdateTime(timestamp)}\`;
                  lastUpdate.style.display = 'block';
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
                      // First fetch all historical attendance data to populate cache
                      const historicalResponse = await fetch(\`/life-groups/groups/\${group.id}/attendance?showAll=true&forceRefresh=true\`);
                      if (!historicalResponse.ok) {
                        console.warn(\`Failed to fetch historical data for group \${group.id}\`);
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
                
                await updateLastUpdateTime();
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
                  await updateLastUpdateTime();
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
                await updateLastUpdateTime();
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
        <title>Queen City Church - Dream Team Health Report</title>
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
          
          body.dark-mode .header {
            border-bottom-color: #555;
          }
          
          body.dark-mode .team-card {
            background-color: #3d3d3d;
            color: #ffffff;
            border-color: #555;
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
              </a>
              <button id="refreshButton" class="refresh-button">
                <span>Refresh Data</span>
              </button>
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

          async function loadTeams(forceRefresh = false) {
            const loadingContainer = document.getElementById('loadingContainer');
            const errorContainer = document.getElementById('errorContainer');
            const teamsContainer = document.getElementById('teamsContainer');
            const refreshButton = document.getElementById('refreshButton');

            // Show loading state
            loadingContainer.style.display = 'block';
            errorContainer.style.display = 'none';
            teamsContainer.style.display = 'none';
            refreshButton.disabled = true;

            try {
              const response = await fetch(\`/api/dream-teams?forceRefresh=\${forceRefresh}\`);
              const result = await response.json();

              if (!result.success) {
                throw new Error(result.error || 'Failed to fetch teams');
              }

              teamsData = result.data;
              displayTeams();

              // Hide loading, show teams
              loadingContainer.style.display = 'none';
              teamsContainer.style.display = 'grid';

            } catch (error) {
              console.error('Error loading teams:', error);
              document.getElementById('errorMessage').textContent = error.message;
              loadingContainer.style.display = 'none';
              errorContainer.style.display = 'block';
            } finally {
              refreshButton.disabled = false;
            }
          }

          function displayTeams() {
            const container = document.getElementById('teamsContainer');
            
            if (teamsData.length === 0) {
              container.innerHTML = '<p style="text-align: center; color: #666; grid-column: 1 / -1;">No dream teams found</p>';
              return;
            }

            container.innerHTML = teamsData.map(team => {
              // Determine status based on actual review data
              let statusClass = 'old';
              let statusText = 'Needs review';
              
              if (team.lastReviewed) {
                const lastReviewed = new Date(team.lastReviewed);
                const now = new Date();
                const daysSince = Math.floor((now - lastReviewed) / (1000 * 60 * 60 * 24));
                
                if (daysSince <= 14) {
                  statusClass = 'fresh';
                  statusText = 'Recently reviewed';
                } else if (daysSince <= 30) {
                  statusClass = 'needs-review';
                  statusText = 'Review soon';
                } else {
                  statusClass = 'old';
                  statusText = 'Needs attention';
                }
              }
              
              // Show pending removals if any
              if (team.pendingRemovals > 0) {
                statusText += ' (' + team.pendingRemovals + ' pending)';
              }

              return \`
                <div class="team-card \${statusClass}" onclick="openTeam('\${team.id}', '\${team.name}')">
                  <div class="team-name">
                    <span class="status-indicator status-\${statusClass}"></span>
                    \${team.name}
                  </div>
                  
                  <div class="team-stats">
                    <div class="stat">
                      <div class="stat-value">\${team.readyCards}</div>
                      <div class="stat-label">Active Members</div>
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
    console.error('Error rendering dream teams page:', error);
    res.status(500).send('Error loading page');
  }
});

// Individual Dream Team roster management page
// Pending removals page (for admin review)
app.get('/dream-teams/pending-removals', async (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Queen City Church - Pending Dream Team Removals</title>
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
          color: #aaaaaa;
        }
        
        body.dark-mode .reviewer-name {
          color: #cccccc;
        }
        
        body.dark-mode .removal-status {
          background-color: #495057;
          color: #ffffff;
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
          color: #999;
          font-size: 0.85em;
        }
        .reviewer-name {
          color: #666;
          font-size: 0.85em;
          font-weight: 500;
          margin-top: 4px;
        }
        .removal-status {
          background-color: #e9ecef;
          color: #6c757d;
          padding: 8px 16px;
          border-radius: 4px;
          font-size: 0.85em;
          text-align: center;
          font-style: italic;
          white-space: nowrap;
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
          <a href="/dream-teams" class="back-button">
            <span>←</span>
            <span>Back to Teams</span>
          </a>
        </div>
        
        <div id="summary" class="summary" style="display: none;">
          <h3>Removal Summary</h3>
          <p id="summaryText">Loading...</p>
        </div>
        
        <div id="errorMessage" class="error" style="display: none;"></div>
        <div id="loadingMessage" class="loading">Loading pending removals...</div>
        <div id="removalsList" class="removals-list"></div>
      </div>

      <script>
        let pendingRemovalsData = [];

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

        async function loadPendingRemovals() {
          try {
            const response = await fetch('/api/dream-teams/pending-removals');
            const result = await response.json();
            
            if (result.success) {
              pendingRemovalsData = result.data.pendingRemovals;
              displayPendingRemovals(pendingRemovalsData);
              updateSummary(result.data.totalCount);
            } else {
              showError('Failed to load pending removals: ' + result.error);
            }
          } catch (error) {
            console.error('Error loading pending removals:', error);
            showError('Failed to load pending removals. Please try again.');
          } finally {
            document.getElementById('loadingMessage').style.display = 'none';
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
              groupedRemovals[removal.workflowName] = [];
            }
            groupedRemovals[removal.workflowName].push(removal);
          });

          // Build HTML
          let html = '';
          Object.keys(groupedRemovals).sort().forEach(function(teamName) {
            const teamRemovals = groupedRemovals[teamName];
            html += '<div class="team-section">';
            html += '<div class="team-header">' + teamName + ' (' + teamRemovals.length + ' removal' + (teamRemovals.length === 1 ? '' : 's') + ')</div>';
            
            teamRemovals.forEach(function(removal) {
              const removalDate = new Date(removal.removalDate).toLocaleDateString();
              const reason = removal.reason || 'No reason provided';
              const reviewerName = removal.reviewerName || 'Unknown';
              
              html += '<div class="removal-item">';
              html += '<div class="member-info">';
              html += '<div class="member-name">' + removal.firstName + ' ' + removal.lastName + '</div>';
              html += '<div class="removal-details">Reason: ' + reason + '</div>';
              html += '<div class="removal-date">Marked for removal: ' + removalDate + '</div>';
              html += '<div class="reviewer-name">Requested by: ' + reviewerName + '</div>';
              html += '</div>';
              html += '<div class="removal-status">Remove from PCO to clear</div>';
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
            summaryText.textContent = 'There ' + (totalCount === 1 ? 'is' : 'are') + ' ' + totalCount + ' member' + (totalCount === 1 ? '' : 's') + ' marked for removal who ' + (totalCount === 1 ? 'is' : 'are') + ' still active in PCO. Remove ' + (totalCount === 1 ? 'them' : 'them') + ' from the workflow in Planning Center Online, then refresh this page.';
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

        // Load data on page load
        loadPendingRemovals();
      </script>
    </body>
    </html>
  `);
});

app.get('/dream-teams/:workflowId', async (req, res) => {
  try {
    const { workflowId } = req.params;
    
    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Team Roster Management - QCC Hub</title>
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
            background-color: #856404;
            color: #fff3cd;
            border-color: #ffeaa7;
          }
          
          body.dark-mode .join-date {
            color: #cccccc;
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
            align-items: center;
            margin-bottom: 30px;
            border-bottom: 2px solid #e9ecef;
            padding-bottom: 20px;
          }
          .team-info h1 {
            color: #333;
            margin-bottom: 8px;
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
          .member-item:hover {
            background-color: #f8f9fa;
          }
          .member-info {
            display: flex;
            align-items: center;
            gap: 15px;
          }
          .member-name {
            font-weight: 500;
            color: #333;
          }
          .pending-removal-indicator {
            background-color: #fff3cd;
            color: #856404;
            border: 1px solid #ffeaa7;
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 0.75em;
            font-weight: 600;
            margin-left: 8px;
            cursor: help;
          }
          .join-date {
            color: #666;
            font-size: 0.9em;
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
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s ease;
            min-width: 50px;
            text-align: center;
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
            font-size: 14px;
            box-sizing: border-box;
          }
          .reviewer-input input:focus {
            outline: none;
            border-color: #007bff;
            box-shadow: 0 0 0 2px rgba(0, 123, 255, 0.25);
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
          .modal-btn.undo-confirm {
            background-color: #28a745;
            color: white;
          }
          .modal-btn.undo-confirm:hover {
            background-color: #218838;
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
              <div id="pendingCount" class="pending-count" style="display: none;"></div>
              <div class="last-updated" id="lastUpdated">Last Updated: Loading...</div>
            </div>
            <a href="/dream-teams" class="back-button">
              <span>←</span>
              <span>Back to Teams</span>
            </a>
          </div>
          
          <div id="loadingContainer" class="loading">
            <p>Loading team roster...</p>
          </div>
          
          <div id="errorContainer" class="error" style="display: none;">
            <p id="errorMessage">Failed to load team roster</p>
          </div>
          
          <div id="rosterContainer" style="display: none;">
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
              <div class="member-list" id="memberList">
                <!-- Members will be loaded here -->
              </div>
            </div>
            
            <div class="action-section">
              <div class="reviewer-input">
                <label for="reviewerName">Your Name:</label>
                <input type="text" id="reviewerName" placeholder="Enter your name" required>
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
            <p>Please provide a reason for removing this member (optional):</p>
            <textarea id="removalReason" placeholder="e.g., Moved to different team, No longer attending, etc."></textarea>
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
              const joinDate = new Date(member.joinedAt).toLocaleDateString('en-US', {
                month: 'numeric',
                day: 'numeric',
                year: 'numeric'
              });
              
              const pendingIndicator = member.markedForRemoval ? 
                '<span class="pending-removal-indicator" title="Pending removal: ' + (member.removalReason || 'No reason provided') + '">Pending Removal</span>' : '';
              
              const removeButton = member.markedForRemoval ? 
                '<div class="undo-button" data-member-id="' + member.personId + '" data-member-name="' + member.firstName + ' ' + member.lastName + '" title="Click to undo removal">Undo</div>' :
                '<div class="remove-checkbox" data-member-id="' + member.personId + '" data-member-name="' + member.firstName + ' ' + member.lastName + '">✗</div>';
              
              return '<div class="member-item" data-member-id="' + member.personId + '">' +
                       '<div class="member-info">' +
                         '<div class="member-name">' + member.firstName + ' ' + member.lastName + '</div>' +
                         '<div class="join-date">' + joinDate + ' ' + pendingIndicator + '</div>' +
                       '</div>' +
                       removeButton +
                     '</div>';
            }).join('');
            
            // Re-setup checkbox listeners after updating the HTML
            setupCheckboxListeners();
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
              pastMembersList.innerHTML = teamData.pastMembers.map(function(member) {
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

          // Load team roster on page load
          loadTeamRoster();
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

app.get('/life-groups/groups/:groupId/attendance', async (req, res) => {
  try {
    const { groupId } = req.params;
    const showAllEvents = req.query.showAll === 'true';
    const forceRefresh = req.query.forceRefresh === 'true';

    
    const [group, attendanceData] = await Promise.all([
      getGroup(groupId),
      getGroupAttendance(groupId, showAllEvents, forceRefresh)
    ]);
    
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>${group.attributes.name} - Attendance Report</title>
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
              <span>←</span>
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

// Automatic data refresh function
async function performAutomaticRefresh() {
  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] Starting automatic overnight data refresh...`);
  
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
    
    const duration = Math.round((Date.now() - startTime) / 1000);
    console.log(`[${new Date().toISOString()}] Automatic refresh completed in ${duration}s. Success: ${successCount}, Errors: ${errorCount}`);
    
  } catch (error) {
    const duration = Math.round((Date.now() - startTime) / 1000);
    console.error(`[${new Date().toISOString()}] Automatic refresh failed after ${duration}s:`, error);
  }
}

// Schedule automatic refresh at 12:30 AM EST every day
// Cron format: minute hour day month dayOfWeek
// Using timezone option to ensure it runs at EST regardless of server timezone
cron.schedule('30 0 * * *', performAutomaticRefresh, {
  scheduled: true,
  timezone: "America/New_York" // EST/EDT timezone
});

console.log('Automatic overnight refresh scheduled for 12:30 AM EST daily');

// Start server
app.listen(port, () => {
  console.log('Server running at http://localhost:' + port);
}); 