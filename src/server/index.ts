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
    const stats = await getGroupAttendance(groupId, false, forceRefresh);
    res.json(stats.overall_statistics);
  } catch (error) {
    console.error(`Error fetching stats for group ${req.params.groupId}:`, error);
    res.status(500).json({ error: 'Failed to fetch group statistics' });
  }
});

// Add new endpoint for loading group data
app.get('/api/load-groups', async (req, res) => {
  try {
    const groupTypeIdFromEnv = process.env.PCO_GROUP_TYPE_ID;
    const groupTypeId = groupTypeIdFromEnv ? parseInt(groupTypeIdFromEnv, 10) : 429361;
    const forceRefresh = req.query.forceRefresh === 'true';

    if (groupTypeIdFromEnv && isNaN(groupTypeId)) {
      console.warn(`Warning: PCO_GROUP_TYPE_ID environment variable ('${groupTypeIdFromEnv}') is not a valid number. Using default 429361.`);
    }

    const result = await getPeopleGroups(groupTypeId, forceRefresh);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch groups' });
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
    const groupTypeIdFromEnv = process.env.PCO_GROUP_TYPE_ID;
    const groupTypeId = groupTypeIdFromEnv ? parseInt(groupTypeIdFromEnv, 10) : 429361;

    // Get all groups first
    const groups = await getPeopleGroups(groupTypeId, forceRefresh);
    
    // Get attendance data for each group
    const attendancePromises = groups.data.map(group => 
      getGroupAttendance(group.id, false, forceRefresh)
    );
    
    const allGroupsAttendance = await Promise.all(attendancePromises);
    
    // Create a map of week -> attendance data
    const weekMap = new Map();
    
    // Add debug logging
    console.log('=== AGGREGATE CALCULATION DEBUG ===');
    console.log('Environment:', process.env.NODE_ENV || 'development');
    console.log('Total groups:', allGroupsAttendance.length);
    
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
    
    let totalEventsProcessed = 0;
    let februaryEventsFound = 0;
    
    allGroupsAttendance.forEach((groupData, groupIndex) => {
      console.log(`Group ${groupIndex + 1} (ID: ${groupData.group_id}): ${groupData.events.length} events`);
      
      groupData.events.forEach(event => {
        if (!event.event.canceled && event.attendance_summary.present_count > 0) {
          const eventDate = new Date(event.event.date);
          const dayOfWeek = eventDate.getUTCDay(); // Use UTC to avoid timezone issues
          
          // Only process Wednesday and Thursday events
          if (dayOfWeek === 3 || dayOfWeek === 4) {
            totalEventsProcessed++;
            
            // Get the Wednesday of this week
            const wednesday = getWednesdayOfWeek(eventDate);
            const weekKey = wednesday.toISOString().split('T')[0];
            
            // Debug February events specifically
            if (weekKey.startsWith('2025-02')) {
              februaryEventsFound++;
              console.log(`February event found: ${event.event.date} (${dayOfWeek === 3 ? 'Wed' : 'Thu'}) -> Week: ${weekKey}`);
              console.log(`  Members: ${event.attendance_summary.present_members}, Visitors: ${event.attendance_summary.present_visitors}, Total: ${event.attendance_summary.total_count}`);
            }
            
            const existing = weekMap.get(weekKey) || { 
              totalPresent: 0,
              totalMembers: 0,
              totalVisitors: 0,
              groupsProcessed: new Set(),
              daysWithAttendance: new Set()
            };
            
            // Add this group's data if we haven't processed it for this week
            const groupKey = `${event.event.id}-${dayOfWeek}`;
            if (!existing.groupsProcessed.has(groupKey)) {
              existing.totalPresent += event.attendance_summary.present_members;
              existing.totalVisitors += event.attendance_summary.present_visitors;
              
              // Only count total members once per group per week
              if (!existing.groupsProcessed.has(event.event.id)) {
                existing.totalMembers += event.attendance_summary.total_count;
              }
              
              existing.groupsProcessed.add(groupKey);
              existing.groupsProcessed.add(event.event.id);
              existing.daysWithAttendance.add(dayOfWeek);
            }
            
            weekMap.set(weekKey, existing);
          }
        }
      });
    });
    
    console.log('Total Wed/Thu events processed:', totalEventsProcessed);
    console.log('February events found:', februaryEventsFound);
    console.log('Weeks found:', Array.from(weekMap.keys()).sort());
    
    // Log February specific data
    weekMap.forEach((data, weekKey) => {
      if (weekKey.startsWith('2025-02')) {
        console.log(`Week ${weekKey}: ${data.totalPresent} present, ${data.totalMembers} members, groups: ${data.groupsProcessed.size}`);
      }
    });
    
    // Convert map to array and sort by date
    const aggregatedData = Array.from(weekMap.entries())
      .map(([weekKey, data]) => ({
        date: weekKey,
        totalPresent: data.totalPresent,
        totalVisitors: data.totalVisitors,
        totalWithVisitors: data.totalPresent + data.totalVisitors,
        totalMembers: data.totalMembers,
        attendanceRate: Math.round((data.totalPresent / data.totalMembers) * 100),
        daysIncluded: Array.from(data.daysWithAttendance).length
      }))
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    
    console.log('=== END AGGREGATE DEBUG ===');
    
    res.json(aggregatedData);
  } catch (error) {
    console.error('Error fetching aggregate attendance:', error);
    res.status(500).json({ error: 'Failed to fetch aggregate attendance data' });
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

// Add new endpoint to debug specific group attendance data
app.get('/api/debug-group/:groupId', async (req, res) => {
  try {
    const { groupId } = req.params;
    const forceRefresh = req.query.forceRefresh === 'true';
    
    console.log(`Debugging group ${groupId}, forceRefresh: ${forceRefresh}`);
    
    const attendanceData = await getGroupAttendance(groupId, false, forceRefresh);
    
    // Filter for February events specifically
    const februaryEvents = attendanceData.events.filter(event => {
      const eventDate = new Date(event.event.date);
      return eventDate.getMonth() === 1 && eventDate.getFullYear() === 2025; // February = month 1
    });
    
    // Also filter for Wed/Thu February events
    const wedThuFebEvents = februaryEvents.filter(event => {
      const dayOfWeek = new Date(event.event.date).getUTCDay(); // Use UTC to avoid timezone issues
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
        dayOfWeek: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(event.event.date).getUTCDay()], // Use UTC
        canceled: event.event.canceled,
        presentCount: event.attendance_summary.present_count,
        presentMembers: event.attendance_summary.present_members,
        presentVisitors: event.attendance_summary.present_visitors,
        totalCount: event.attendance_summary.total_count
      })),
      cacheKey: `events_${groupId}_false`,
      timestamp: new Date().toISOString()
    };
    
    console.log('Group debug info:', debugInfo);
    
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

//Home Page
app.get('', async (req, res) => {
  try {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Queen City Church - Life Groups Health Report</title>
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
              min-width: 300px;
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
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Queen City Church - Life Groups Health Report</h1>
            <button id="loadDataBtn">
              <span>Load Data</span>
              <span class="est-time">est. time ≈ 3 min.</span>
            </button>
            <p id="lastUpdate"></p>
            <p id="groupCount"></p>
            
            <div class="chart-container">
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
              // Check if it's been less than 1 hour since last refresh (unless shift-clicked)
              if (!event.shiftKey) {
                try {
                  const response = await fetch('/api/cache-info');
                  if (response.ok) {
                    const { timestamp } = await response.json();
                    if (timestamp) {
                      const hoursSinceLastUpdate = (Date.now() - timestamp) / (1000 * 60 * 60);
                      if (hoursSinceLastUpdate < 1) {
                        const confirmed = confirm(
                          \`Data was last refreshed less than 1 hour ago.\\n\\n\` +
                          \`Are you sure you want to refresh now?\\n\\n\`
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
              } else {
                console.log('Shift-click detected, bypassing confirmation dialog');
              }

              const loadingHtml = '<span>Refreshing...</span><span class="est-time">est. time ≈ 3 min.</span>';
              loadDataBtn.innerHTML = loadingHtml;
              loadDataBtn.style.backgroundColor = '#007bff';
              loadDataBtn.disabled = true;

              // Clear everything and show loading state
              groupList.innerHTML = '';
              groupList.style.display = 'none';
              groupCount.style.display = 'none';
              
              // Hide chart container while loading
              const chartContainer = document.querySelector('.chart-container');
              if (chartContainer) {
                chartContainer.style.display = 'none';
              }
              
              initialMessage.textContent = 'Loading fresh data...';
              const elapsedTimeSpan = document.createElement('span');
              elapsedTimeSpan.className = 'elapsed-time';
              initialMessage.appendChild(elapsedTimeSpan);
              initialMessage.style.display = 'block';

              // Start timer
              const startTime = Date.now();
              const updateElapsedTime = () => {
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                const minutes = Math.floor(elapsed / 60);
                const seconds = elapsed % 60;
                elapsedTimeSpan.textContent = \`Time elapsed: \${minutes}:\${seconds.toString().padStart(2, '0')}\`;
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
                console.log('Starting data refresh...');
                
                // Only fetch groups once
                const groupsResponse = await fetch('/api/load-groups?forceRefresh=true');
                if (!groupsResponse.ok) throw new Error('Failed to fetch groups');
                const result = await groupsResponse.json();
                console.log('Groups fetched:', result.data.length);

                // For the stats, we can use cached event data since event attendance doesn't change frequently
                // Only the group membership (total_count) needs to be updated, which is handled by the groups refresh
                console.log('Starting to fetch stats for', result.data.length, 'groups (current year only)');
                
                // Process groups sequentially to avoid cache race conditions
                const groupStats = [];
                for (let i = 0; i < result.data.length; i++) {
                  const group = result.data[i];
                  try {
                    console.log(\`Processing group \${i + 1}/\${result.data.length}: \${group.attributes.name} (ID: \${group.id})\`);
                    const response = await fetch('/api/group-stats/' + group.id + '?forceRefresh=true');
                    if (!response.ok) {
                      console.error('Failed to fetch stats for group', group.id, 'Status:', response.status, response.statusText);
                      groupStats.push(null);
                    } else {
                      const stats = await response.json();
                      console.log(\`✓ Group \${group.id} processed: \${stats.events_with_attendance} events\`);
                      groupStats.push(stats);
                    }
                    
                    // Add delay between group processing to reduce API load (especially important for production)
                    if (i < result.data.length - 1) { // Don't delay after the last group
                      await new Promise(resolve => setTimeout(resolve, 500)); // 500ms delay between groups
                    }
                  } catch (error) {
                    console.error('Error fetching stats for group', group.id, error);
                    groupStats.push(null);
                  }
                }
                
                console.log('All data loaded:', { groups: result.data.length, stats: groupStats.filter(s => s !== null).length });
                console.log('Check the console above for individual group API call counts');
                
                // Add a brief delay to ensure all cache writes from individual group processing are complete
                console.log('Ensuring all cache writes are complete...');
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                // Remove the artificial delay since we're now processing sequentially
                console.log('Data processing complete, displaying results...');

                // Load aggregate chart with cached data (no forceRefresh to avoid duplicate API calls)
                await loadAggregateData(false);

                // Force a page refresh to ensure we display consistent cached data
                console.log('Refreshing page to display consistent data...');
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
                      } else {
                        statsHtml = 
                          '<div class="stat">' +
                            '<div class="stat-value">' + (stats.average_attendance || 0) + '</div>' +
                            '<div class="stat-label">Avg. Attendance</div>' +
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

                    return '<li class="group-item" id="group-' + group.id + '">' +
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
                
                // Show chart container now that data is loaded
                if (chartContainer) {
                  chartContainer.style.display = 'block';
                }
                
                console.log('Display complete');
                await updateLastUpdateTime();
                clearInterval(timerInterval); // Stop the timer
                const totalTime = Math.floor((Date.now() - startTime) / 1000);
                const totalMinutes = Math.floor(totalTime / 60);
                const totalSeconds = totalTime % 60;
                console.log(\`Total refresh time: \${totalMinutes}:\${totalSeconds.toString().padStart(2, '0')} (\${totalTime} seconds)\`);
              } catch (error) {
                console.error('Error refreshing data:', error);
                initialMessage.textContent = 'Failed to refresh data. Please try again.';
                alert('Failed to refresh data. Please try again.');
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
                  // If no cached data, show initial load message
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
              
              groupList.innerHTML = result.data
                .sort((a, b) => a.attributes.name.localeCompare(b.attributes.name))
                .map(group => \`
                  <li class="group-item" id="group-\${group.id}">
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
              result.data.forEach(group => updateGroupStats(group.id));
            }

            // Function to update stats for a group
            async function updateGroupStats(groupId) {
              const container = document.querySelector(\`#group-\${groupId} .stats-container\`);
              try {
                const response = await fetch(\`/api/group-stats/\${groupId}\${forceRefreshParam}\`);
                if (!response.ok) throw new Error('Failed to fetch stats');
                const stats = await response.json();
                
                let rateClass = '';
                if (stats.overall_attendance_rate >= 70) rateClass = 'attendance-good';
                else if (stats.overall_attendance_rate >= 50) rateClass = 'attendance-warning';
                else if (stats.overall_attendance_rate > 0) rateClass = 'attendance-poor';

                if (container) {
                  container.innerHTML = stats ? \`
                    <div class="stat">
                      <div class="stat-value">\${stats.average_attendance}</div>
                      <div class="stat-label">Avg. Attendance</div>
                    </div>
                    <div class="stat">
                      <div class="stat-value \${rateClass}">\${stats.overall_attendance_rate}%</div>
                      <div class="stat-label">Attendance Rate</div>
                    </div>
                    <div class="stat">
                      <div class="stat-value">\${stats.events_with_attendance}</div>
                      <div class="stat-label">Events</div>
                    </div>
                  \` : \`
                    <div class="no-data">No attendance data available</div>
                  \`;
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
              try {
                const refreshParam = forceRefresh ? '?forceRefresh=true' : '';
                const response = await fetch('/api/aggregate-attendance' + refreshParam);
                if (!response.ok) throw new Error('Failed to fetch aggregate data');
                const aggregateData = await response.json();
                
                const ctx = document.getElementById('aggregateChart').getContext('2d');
                
                // Clear any existing chart
                if (window.aggregateChartInstance) {
                  window.aggregateChartInstance.destroy();
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
                  options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                      title: {
                        display: true,
                        text: 'Weekly Life Groups Attendance Trends (Wed-Thu Combined)'
                      },
                      subtitle: {
                        display: true,
                        text: 'Click a dataset color to exclude it from the chart. Hover over a data point to see more info. Data shows current year, past events only.',
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
              }
            }

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
    console.log('Request params:', { groupId, showAllEvents, forceRefresh, query: req.query });
    
    const [group, attendanceData] = await Promise.all([
      getGroup(groupId),
      getGroupAttendance(groupId, showAllEvents, forceRefresh)
    ]);
    
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>${group.attributes.name} - Attendance Report</title>
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
                console.log('Toggle changed:', this.checked);
                const loadingMessage = document.getElementById('toggleLoadingMessage');
                loadingMessage.style.display = 'flex';
                const newUrl = new URL(window.location.href);
                newUrl.searchParams.set('showAll', this.checked);
                console.log('Redirecting to:', newUrl.toString());
                window.location.href = newUrl.toString();
              });
            </script>

            <div class="chart-container">
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
            
            // Prepare data for the chart
            const chartData = ${JSON.stringify(attendanceData.events
              .filter(event => !event.event.canceled && event.attendance_summary.present_count > 0)
              .sort((a, b) => new Date(a.event.date).getTime() - new Date(b.event.date).getTime())
              .map(event => ({
                date: formatDate(event.event.date),
                attendance: event.attendance_summary.present_count,
                total: event.attendance_summary.total_count,
                rate: event.attendance_summary.attendance_rate
              }))
            )};

            new Chart(ctx, {
              type: 'line',
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