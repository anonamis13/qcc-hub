import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { getPeopleGroups, getGroupAttendance, getGroup } from './config/pco.js';
import { cache } from './config/cache.js';

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
    res.json(stats.overall_statistics);
  } catch (error) {
    console.error(`Error fetching stats for group ${req.params.groupId}:`, error);
    res.status(500).json({ error: 'Failed to fetch group statistics' });
  }
});

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

// Add new endpoint for aggregated attendance data
app.get('/api/aggregate-attendance', async (req, res) => {
  try {
    const forceRefresh = req.query.forceRefresh === 'true';
    const showAllEvents = req.query.showAll === 'true';
    const groupTypeIdFromEnv = process.env.PCO_GROUP_TYPE_ID;
    const groupTypeId = groupTypeIdFromEnv ? parseInt(groupTypeIdFromEnv, 10) : 429361;
    
    // Get all groups first
    const groups = await getPeopleGroups(groupTypeId, forceRefresh);
    
    // Get attendance data for each group
    // For aggregate calculations, we need some historical data to find fallback membership counts
    // Use current year + previous year to capture November 2024 data for early 2025 weeks
    const attendancePromises = groups.data.map(group => 
      getGroupAttendance(group.id, showAllEvents, forceRefresh)
    );
    
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
          
          // Only count attendance for non-cancelled events with attendance or events from yesterday/earlier
          if (!event.event.canceled && 
              (event.attendance_summary.present_count > 0 || 
               (event.attendance_summary.present_count === 0 && eventDate <= yesterday))) {
            
            const existing = weekMap.get(weekKey) || { 
              totalPresent: 0,
              totalVisitors: 0,
              groupsProcessed: new Set(),
              groupsWithAttendance: new Set(),
              daysWithAttendance: new Set()
            };
            
            // Add this group's data if we haven't processed it for this week
            const groupKey = `${event.event.id}-${dayOfWeek}`;
            if (!existing.groupsProcessed.has(groupKey)) {
              existing.totalPresent += event.attendance_summary.present_members;
              existing.totalVisitors += event.attendance_summary.present_visitors;
              
              existing.groupsProcessed.add(groupKey);
              existing.groupsProcessed.add(event.event.id);
              existing.groupsWithAttendance.add(groupData.group_id);
              existing.daysWithAttendance.add(dayOfWeek);
            }
            
            weekMap.set(weekKey, existing);
          }
        }
      });
    });
    
    // Filter out weeks with fewer than 5 groups having attendance
    const validWeeks = new Set();
    weekMap.forEach((weekData, weekKey) => {
      if (weekData.groupsWithAttendance.size >= 5) {
        validWeeks.add(weekKey);
      }
    });
    
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
      .map(([weekKey, data]) => ({
        date: weekKey,
        totalPresent: data.totalPresent,
        totalVisitors: data.totalVisitors,
        totalWithVisitors: data.totalPresent + data.totalVisitors,
        totalMembers: data.totalMembers,
        attendanceRate: data.totalMembers > 0 ? Math.round((data.totalPresent / data.totalMembers) * 100) : 0,
        daysIncluded: Array.from(data.daysWithAttendance).length,
        groupsWithData: data.groupsWithAttendance.size
      }))
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
            #groupCount {
              margin: 10px 0;
              color: #666;
              display: none;
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
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Queen City Church - Life Groups Health Report</h1>
            <button id="loadDataBtn" title="Click to refresh current year data. Shift+Click to refresh ALL historical data.">
              <span>Load Data</span>
              <span class="est-time">est. time ≈ 3 min.</span>
            </button>
            <p id="lastUpdate"></p>
            <p id="groupCount"></p>
            
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
            </div>
            
            <div id="initialMessage" class="initial-message">
              Loading...
            </div>
            <ul id="groupList" class="group-list"></ul>
          </div>

          <script>
            const loadDataBtn = document.getElementById('loadDataBtn');
            const groupList = document.getElementById('groupList');
            const groupCount = document.getElementById('groupCount');
            const initialMessage = document.getElementById('initialMessage');
            const lastUpdate = document.getElementById('lastUpdate');

            // Add a global variable to track force refresh state
            let forceRefreshParam = '';

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
              groupCount.style.display = 'none';
              
              // Hide toggle container while refreshing
              const toggleContainer = document.getElementById('toggleContainer');
              if (toggleContainer) {
                toggleContainer.style.display = 'none';
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
                groupCount.textContent = \`\${result.filtered_count} total groups.\`;
                groupCount.style.display = 'block';
                groupList.innerHTML = groupsHtml;
                
                // Show the toggle container now that we have data
                const toggleContainer = document.getElementById('toggleContainer');
                if (toggleContainer) {
                  toggleContainer.style.display = 'flex';
                }
                
                // Show chart container now that data is loaded
                if (chartContainer) {
                  chartContainer.style.display = 'block';
                }
                
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
                
                // Load aggregate data separately after groups are displayed
                await loadAggregateData();
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
              groupCount.textContent = \`\${result.filtered_count} total groups.\`;
              groupCount.style.display = 'block';
              initialMessage.style.display = 'none';
              groupList.style.display = 'block';
              
              // Show the toggle container now that we have data
              const toggleContainer = document.getElementById('toggleContainer');
              if (toggleContainer) {
                toggleContainer.style.display = 'flex';
              }
              
              groupList.innerHTML = result.data
                .sort((a, b) => a.attributes.name.localeCompare(b.attributes.name))
                .map(group => \`
                  <li class="group-item\${group.isFamilyGroup ? ' family-group' : ''}" id="group-\${group.id}">
                    <a href="/groups/\${group.id}/attendance">
                      \${group.attributes.name}
                    </a>
                    <div class="stats-container">
                      <div class="loading"></div>
                    </div>
                  </li>
                \`).join('');

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
                
                let rateClass = '';
                if (stats.overall_attendance_rate >= 70) rateClass = 'attendance-good';
                else if (stats.overall_attendance_rate >= 50) rateClass = 'attendance-warning';
                else if (stats.overall_attendance_rate > 0) rateClass = 'attendance-poor';

                if (container) {
                  const isFamilyGroup = document.querySelector(\`#group-\${groupId}\`).classList.contains('family-group');
                  
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

            // Add function to load and display aggregate data
            async function loadAggregateData(forceRefresh = false) {
              const chartLoading = document.getElementById('chartLoading');
              const chartCanvas = document.getElementById('aggregateChart');
              const showAllYears = document.getElementById('showAllYears').checked;
              
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
                
                // Build query parameters
                const params = new URLSearchParams();
                if (forceRefresh) params.set('forceRefresh', 'true');
                if (showAllYears) params.set('showAll', 'true');
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
                  options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                      title: {
                        display: true,
                        text: 'Weekly Life Groups Attendance Trends (Wed-Thu Combined)' + (showAllYears ? ' - All Years' : ' - Current Year')
                      },
                      subtitle: {
                        display: true,
                        text: 'Click a dataset color to exclude it from the chart. Hover over a data point to see more info. Data shows ' + (showAllYears ? 'all years' : 'current year') + ', past events only.',
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
                            return [
                              'Weekly Attendance Rate: ' + data.attendanceRate + '%',
                              'Members Present: ' + data.totalPresent,
                              'Visitors: +' + data.totalVisitors,
                              'Total with Visitors: ' + data.totalWithVisitors,
                              'Groups with Data: ' + data.groupsWithData,
                              'Days with Data: ' + data.daysIncluded + ' (Wed/Thu)'
                            ];
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
              } finally {
                // Hide loading indicator and show chart
                if (chartLoading) chartLoading.style.display = 'none';
                if (chartCanvas) chartCanvas.style.display = 'block';
                
                // Update date range indicator
                const dateRangeElement = document.getElementById('chartDateRange');
                if (dateRangeElement) {
                  dateRangeElement.textContent = 'Showing data from: ' + (showAllYears ? 'All years' : 'Current year');
                }
              }
            }

            // Add event listener for the show all years toggle
            document.getElementById('showAllYears').addEventListener('change', async function() {
              const loadingMessage = document.getElementById('chartToggleLoadingMessage');
              if (loadingMessage) loadingMessage.style.display = 'flex';
              
              const showAllYears = this.checked;
              
              try {
                // Update chart data
                await loadAggregateData(false);
                
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
                  <th>PCO Link</th>
                  <th>Members</th>
                  <th>Visitors</th>
                  <th>Total Present</th>
                  <th>Registered Members</th>
                  <th>Members Attendance Rate</th>
                </tr>
              </thead>
              <tbody>
                ${attendanceData.events
                  .filter(event => new Date(event.event.date) <= new Date()) // Only show past/today events
                  .sort((a, b) => new Date(b.event.date).getTime() - new Date(a.event.date).getTime())
                  .map(event => {
                    const rate = event.attendance_summary.attendance_rate;
                    let rateClass = 'attendance-poor';
                    if (rate >= 70) rateClass = 'attendance-good';
                    else if (rate >= 50) rateClass = 'attendance-warning';
                    
                    const rowClass = event.event.canceled ? 'canceled-event' : '';
                    const eventUrl = 'https://groups.planningcenteronline.com/groups/' + groupId + '/events/' + event.event.id;
                    
                    return '<tr class="' + rowClass + '">' +
                           '<td>' +
                           formatDate(event.event.date) +
                           (event.event.canceled ? '<span class="canceled-label"> (CANCELED)</span>' : '') +
                           '</td>' +
                           '<td>' +
                           '<a href="' + eventUrl + '" rel="noopener noreferrer" class="' + rowClass + '">Attendance</a>' +
                           '</td>' +
                           '<td>' + event.attendance_summary.present_members + '</td>' +
                           '<td>' + (event.attendance_summary.present_visitors > 0 ? 
                                   '<span class="visitor-count">+' + event.attendance_summary.present_visitors + '</span>' : 
                                   '0') + '</td>' +
                           '<td>' + event.attendance_summary.present_count + '</td>' +
                           '<td>' + event.attendance_summary.total_count + '</td>' +
                           '<td class="' + rateClass + '">' + rate + '%</td>' +
                           '</tr>';
                  }).join('')}
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

// Start server
app.listen(port, () => {
  console.log('Server running at http://localhost:' + port);
}); 