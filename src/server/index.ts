import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cron from 'node-cron';
import { getPeopleGroups, getGroupAttendance, getGroup, getGroupMemberships } from './config/pco.js';
import { cache } from './config/cache.js';
import { membershipSnapshots } from '../data/database.js';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

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
    
    console.log('Individual group attendance requested for groups:', selectedGroupIds);
    
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
    
    console.log('Filter parameters received:', {
      groupTypesQuery: req.query.groupTypes,
      meetingDaysQuery: req.query.meetingDays,
      selectedGroupsQuery: req.query.selectedGroups,
      groupTypesFilter,
      meetingDaysFilter,
      selectedGroupIds
    });
    
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

// Add new debugging endpoint
app.get('/api/debug-info', async (req, res) => {
  try {
    const groupTypeIdFromEnv = process.env.PCO_GROUP_TYPE_ID;
    const groupTypeId = groupTypeIdFromEnv ? parseInt(groupTypeIdFromEnv, 10) : 429361;
    
    // Get basic environment info
    const envInfo = {
      nodeEnv: process.env.NODE_ENV,
      groupTypeId: groupTypeId,
      groupTypeIdSource: groupTypeIdFromEnv ? 'env' : 'default',
      hasApiCreds: !!(process.env.PCO_APP_ID && process.env.PCO_SECRET),
      currentTime: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    };

    // Get cache stats
    const cacheStats = cache.getStats();
    
    // Get group count
    const groups = await getPeopleGroups(groupTypeId, false);
    
    res.json({
      environment: envInfo,
      cache: cacheStats,
      groupCount: groups.data.length,
      filteredCount: groups.filtered_count,
      groupIds: groups.data.map(g => g.id).sort()
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get debug info', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// Add new endpoint to check specific week data
app.get('/api/debug-week/:date', async (req, res) => {
  try {
    const { date } = req.params; // Expected format: YYYY-MM-DD
    const groupTypeIdFromEnv = process.env.PCO_GROUP_TYPE_ID;
    const groupTypeId = groupTypeIdFromEnv ? parseInt(groupTypeIdFromEnv, 10) : 429361;
    
    const groups = await getPeopleGroups(groupTypeId, false);
    
    // Get attendance data for each group for the specific week
    const attendancePromises = groups.data.map(async group => {
      const attendance = await getGroupAttendance(group.id, false, false);
      // Filter events for the specific week using UTC to avoid timezone issues
      const targetDate = new Date(date + 'T00:00:00.000Z'); // Force UTC
      const weekStart = new Date(targetDate);
      
      // Get the Sunday of the week - use UTC methods to avoid timezone issues
      const dayOfWeek = weekStart.getUTCDay();
      weekStart.setUTCDate(weekStart.getUTCDate() - dayOfWeek); // Go back to Sunday
      
      const weekEnd = new Date(weekStart);
      weekEnd.setUTCDate(weekStart.getUTCDate() + 6); // Get Saturday
      
      const weekEvents = attendance.events.filter(event => {
        const eventDate = new Date(event.event.date);
        return eventDate >= weekStart && eventDate <= weekEnd && !event.event.canceled;
      });
      
      return {
        groupId: group.id,
        groupName: group.attributes.name,
        weekEvents: weekEvents.map(e => ({
          date: e.event.date,
          totalMembers: e.attendance_summary.total_count,
          presentMembers: e.attendance_summary.present_members,
          visitors: e.attendance_summary.present_visitors
        }))
      };
    });
    
    const weekData = await Promise.all(attendancePromises);
    const totalMembers = weekData.reduce((sum, group) => {
      const groupMax = Math.max(...group.weekEvents.map(e => e.totalMembers), 0);
      return sum + groupMax;
    }, 0);
    
    // Calculate week start using UTC to ensure consistency
    const targetDateUTC = new Date(date + 'T00:00:00.000Z');
    const weekStartUTC = new Date(targetDateUTC);
    weekStartUTC.setUTCDate(targetDateUTC.getUTCDate() - targetDateUTC.getUTCDay());
    
    res.json({
      requestedDate: date,
      weekStart: weekStartUTC.toISOString().split('T')[0],
      totalGroups: groups.data.length,
      groupsWithData: weekData.filter(g => g.weekEvents.length > 0).length,
      totalMembers: totalMembers,
      groupBreakdown: weekData.filter(g => g.weekEvents.length > 0)
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get week debug info', details: error instanceof Error ? error.message : 'Unknown error' });
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

// Add new endpoint to debug specific group attendance data
app.get('/api/debug-group/:groupId', async (req, res) => {
  try {
    const { groupId } = req.params;
    const forceRefresh = req.query.forceRefresh === 'true';
    
    const attendanceData = await getGroupAttendance(groupId, false, forceRefresh);
    
    // Filter for February events specifically
    const februaryEvents = attendanceData.events.filter(event => {
      const eventDate = new Date(event.event.date);
      return eventDate.getMonth() === 1 && eventDate.getFullYear() === 2025; // February = month 1
    });
    
    // Also filter for Wed/Thu February events
    const wedThuFebEvents = februaryEvents.filter(event => {
      // Use local time (Eastern) since Life Groups meet Wed/Thu in Cincinnati
      const dayOfWeek = new Date(event.event.date).getDay();
      return dayOfWeek === 3 || dayOfWeek === 4; // Wednesday or Thursday
    });
    
    const debugInfo = {
      environment: process.env.NODE_ENV || 'development',
      groupId: groupId,
      totalEvents: attendanceData.events.length,
      februaryEvents: februaryEvents.length,
      wedThuFebEvents: wedThuFebEvents.length,
      februaryEventDetails: februaryEvents.map(event => ({
        date: event.event.date,
        // Use local time (Eastern) since meetings are Wed/Thu in Cincinnati
        dayOfWeek: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(event.event.date).getDay()],
        canceled: event.event.canceled,
        presentCount: event.attendance_summary.present_count,
        presentMembers: event.attendance_summary.present_members,
        presentVisitors: event.attendance_summary.present_visitors,
        totalCount: event.attendance_summary.total_count
      })),
      cacheKey: `events_${groupId}_false`,
      timestamp: new Date().toISOString()
    };
    
    res.json(debugInfo);
  } catch (error) {
    console.error(`Error debugging group ${req.params.groupId}:`, error);
    res.status(500).json({ 
      error: 'Failed to debug group', 
      details: error instanceof Error ? error.message : 'Unknown error',
      groupId: req.params.groupId
    });
  }
});

// Add new endpoint to debug Family Group tags
app.get('/api/debug-family-groups', async (req, res) => {
  try {
    const groupTypeIdFromEnv = process.env.PCO_GROUP_TYPE_ID;
    const groupTypeId = groupTypeIdFromEnv ? parseInt(groupTypeIdFromEnv, 10) : 429361;
    
    const groups = await getPeopleGroups(groupTypeId, false);
    
    const familyGroups = groups.data.filter(group => group.isFamilyGroup);
    const regularGroups = groups.data.filter(group => !group.isFamilyGroup);
    
    res.json({
      totalGroups: groups.data.length,
      familyGroups: familyGroups.length,
      regularGroups: regularGroups.length,
      familyGroupNames: familyGroups.map(g => g.attributes.name),
      regularGroupNames: regularGroups.map(g => g.attributes.name)
    });
  } catch (error) {
    console.error('Error debugging Family Groups:', error);
    res.status(500).json({ 
      error: 'Failed to debug Family Groups', 
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Add debug endpoint for Family Group metrics
app.get('/api/debug-family-metrics/:groupId', async (req, res) => {
  try {
    const { groupId } = req.params;
    const attendanceData = await getGroupAttendance(groupId, false, false);
    const stats = attendanceData.overall_statistics;
    const hasFamilyMetrics = 'familyGroup' in stats;
    
    // Create a detailed breakdown showing ALL events (including cancelled/zero attendance) for position identification
    const eventsByMonth = new Map();
    const allPastEvents = attendanceData.events.filter(event => 
      new Date(event.event.date) <= new Date()
    );
    
    allPastEvents.forEach(event => {
      const eventDate = new Date(event.event.date);
      const monthKey = `${eventDate.getFullYear()}-${String(eventDate.getMonth() + 1).padStart(2, '0')}`;
      
      if (!eventsByMonth.has(monthKey)) {
        eventsByMonth.set(monthKey, []);
      }
      eventsByMonth.get(monthKey).push({
        date: event.event.date,
        canceled: event.event.canceled,
        present: event.attendance_summary.present_members,
        total: event.attendance_summary.total_count,
        rate: event.attendance_summary.attendance_rate,
        validForCalculation: !event.event.canceled && event.attendance_summary.present_count > 0
      });
    });
    
    // Sort events within each month
    eventsByMonth.forEach((monthEvents: any[]) => {
      monthEvents.sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());
    });
    
    const monthlyBreakdown = Array.from(eventsByMonth.entries()).map(([month, events]: [string, any[]]) => {
      const breakdown = {
        month,
        totalEvents: events.length,
        mothersNight: null as any,
        fathersNight: null as any,
        familyNight: null as any,
        hasParentsData: false,
        hasFamilyData: false
      };

      // Process each position
      for (let i = 0; i < events.length && i < 3; i++) {
        const event = events[i];
        
        if (i === 0) {
          // 1st meeting = Mothers Night
          breakdown.mothersNight = {
            ...event,
            meetingType: 'Mothers Night',
            calculatedRate: event.validForCalculation 
              ? Math.round((event.present / Math.ceil(event.total / 2)) * 100) + '%' 
              : 'N/A (cancelled or no attendance)',
            usedInCalculation: event.validForCalculation
          };
          if (event.validForCalculation) breakdown.hasParentsData = true;
        } else if (i === 1) {
          // 2nd meeting = Fathers Night
          breakdown.fathersNight = {
            ...event,
            meetingType: 'Fathers Night',
            calculatedRate: event.validForCalculation 
              ? Math.round((event.present / Math.ceil(event.total / 2)) * 100) + '%' 
              : 'N/A (cancelled or no attendance)',
            usedInCalculation: event.validForCalculation
          };
          if (event.validForCalculation) breakdown.hasParentsData = true;
        } else if (i === 2) {
          // 3rd meeting = Family Night
          breakdown.familyNight = {
            ...event,
            meetingType: 'Family Night',
            calculatedRate: event.validForCalculation 
              ? event.rate + '%' 
              : 'N/A (cancelled or no attendance)',
            usedInCalculation: event.validForCalculation
          };
          if (event.validForCalculation) breakdown.hasFamilyData = true;
        }
      }

      return breakdown;
    });
    
    res.json({
      groupId: groupId,
      isFamilyGroup: hasFamilyMetrics,
      regularStats: {
        totalEvents: stats.total_events,
        eventsWithAttendance: stats.events_with_attendance,
        averageAttendance: stats.average_attendance,
        averageMembers: stats.average_members,
        overallAttendanceRate: stats.overall_attendance_rate
      },
      familyGroupStats: hasFamilyMetrics ? (stats as any).familyGroup : null,
      monthlyBreakdown: monthlyBreakdown,
      explanation: {
        methodology: "All events (including cancelled) are used to determine meeting positions. Only non-cancelled events with attendance are used in calculations.",
        positions: {
          "1st meeting": "Mothers Night (present / half of total members)",
          "2nd meeting": "Fathers Night (present / half of total members)", 
          "3rd meeting": "Family Night (present / total members)"
        }
      }
    });
  } catch (error) {
    console.error(`Error testing Family Group metrics for ${req.params.groupId}:`, error);
    res.status(500).json({ 
      error: 'Failed to test Family Group metrics', 
      details: error instanceof Error ? error.message : 'Unknown error'
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

//Membership Changes Page
app.get('/membership-changes', async (req, res) => {
  try {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Recent Membership Changes - Queen City Church</title>
          <link rel="icon" type="image/x-icon" href="https://www.queencitypeople.com/favicon.ico">
          <style>
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
          </style>
        </head>
        <body>
          <div class="container">
            <div class="button-group">
              <a href="/" class="back-button">
                <span>←</span>
                <span>Back to Home</span>
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
app.get('', async (req, res) => {
  try {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Queen City Church - Life Groups Health Report</title>
          <link rel="icon" type="image/x-icon" href="https://www.queencitypeople.com/favicon.ico">
          <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
          <style>
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
              background-color: #ccc;
              cursor: not-allowed;
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
            .group-item.needs-attention::before {
              content: "!";
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
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Queen City Church - Life Groups Health Report</h1>
            <div style="display: flex; gap: 15px; align-items: center; margin-bottom: -10px;">
              <button id="loadDataBtn" title="Click to refresh current year data. Shift+Click to refresh ALL historical data.">
                <span>Load Data</span>
                <span class="est-time">est. time ≈ 3 min.</span>
              </button>
              <button id="viewMembershipChangesBtn" style="padding: 12px 24px; font-size: 16px; font-weight: 500; color: white; background-color: #28a745; border: none; border-radius: 4px; cursor: pointer; margin-bottom: 20px; transition: all 0.3s ease; display: flex; flex-direction: column; align-items: center; min-width: 160px;" onmouseover="this.style.backgroundColor='#218838';" onmouseout="this.style.backgroundColor='#28a745';">
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
              console.log('Setting up sort/filter toggle...');
              const sortFilterToggleBtn = document.getElementById('sortFilterToggleBtn');
              const sortFilterToggleIcon = document.getElementById('sortFilterToggleIcon');
              const sortFilterExpandedContent = document.getElementById('sortFilterExpandedContent');
              
              console.log('Elements found:', {
                sortFilterToggleBtn: !!sortFilterToggleBtn,
                sortFilterToggleIcon: !!sortFilterToggleIcon,
                sortFilterExpandedContent: !!sortFilterExpandedContent
              });
              
              if (sortFilterToggleBtn && sortFilterToggleIcon && sortFilterExpandedContent) {
                console.log('Adding click event listener to sort/filter toggle');
                sortFilterToggleBtn.addEventListener('click', function() {
                  console.log('Sort/filter toggle clicked');
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
                         (group.stats?.needsAttention ? ' title="Recent event missing attendance data"' : '') + '>' +
                    '<a href="/groups/' + group.id + '/attendance" style="color: #007bff; text-decoration: none; font-size: 18px; font-weight: 500;" onmouseover="this.style.textDecoration=&quot;underline&quot;;" onmouseout="this.style.textDecoration=&quot;none&quot;;">' +
                      group.attributes.name +
                    '</a>' +
                    '<div class="stats-container" id="stats-' + group.id + '">' +
                      statsHtml +
                    '</div>' +
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
                  window.location.href = '/membership-changes';
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
                    membershipButtonSummary.innerHTML = 
                      '<span style="color: #006400; font-weight: bold;">+' + data.totalJoins + '</span> Joined ' +
                      '<span style="color: #dc3545; font-weight: bold;">-' + data.totalLeaves + '</span> Left ' +
                      '<span style="color: #007bff; font-weight: bold;">' + netChangeText + '</span> Net';
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
                      const historicalResponse = await fetch(\`/groups/\${group.id}/attendance?showAll=true&forceRefresh=true\`);
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
                      '<a href="/groups/' + group.id + '/attendance">' +
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
                }
              } catch (error) {
                console.error('Error checking cache:', error);
                loadDataBtn.disabled = false;
                loadDataBtn.innerHTML = '<span>Load Data</span><span class="est-time">est. time ≈ 3 min.</span>';
                initialMessage.textContent = 'Error checking data status. Click "Load Data" to try fetching Life Groups data.';
              }
            }

            async function loadGroups() {
              try {
                loadDataBtn.disabled = true;
                loadDataBtn.innerHTML = '<span>Loading...</span><span class="est-time">est. time ≈ 3 min.</span>';
                
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
              } finally {
                loadDataBtn.disabled = false;
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
                  
                  // Update attention styling
                  if (stats.needsAttention) {
                    groupElement.classList.add('needs-attention');
                    groupElement.setAttribute('title', 'Recent event missing attendance data');
                  } else {
                    groupElement.classList.remove('needs-attention');
                    groupElement.removeAttribute('title');
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
                
                console.log('Received individual group data:', individualData);
                
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
                
                console.log('Received aggregate data:', aggregateData);
                
                // Update chart group count
                updateChartGroupCount(aggregateData);
                
                // Handle empty data case
                if (!aggregateData || aggregateData.length === 0) {
                  console.log('No aggregate data - showing empty chart');
                  
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
          </script>
        </body>
      </html>
    `;
    
    res.send(html);
  } catch (error) {
    res.status(500).json({ error: 'Failed to load page' });
  }
});

app.get('/groups/:groupId/attendance', async (req, res) => {
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
            .back-link {
              display: inline-block;
              margin-bottom: 20px;
              color: #007bff;
              text-decoration: none;
            }
            .back-link:hover {
              text-decoration: underline;
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
        </head>
        <body>
          <div class="container">
            <a href="/" class="back-link">← Back to Groups</a>
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