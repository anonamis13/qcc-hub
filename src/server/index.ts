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
    const stats = await getGroupAttendance(groupId);
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

    if (groupTypeIdFromEnv && isNaN(groupTypeId)) {
      console.warn(`Warning: PCO_GROUP_TYPE_ID environment variable ('${groupTypeIdFromEnv}') is not a valid number. Using default 429361.`);
    }

    const result = await getPeopleGroups(groupTypeId);
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
    res.json({ hasCachedData: !!cachedGroups });
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

//Home Page
app.get('', async (req, res) => {
  try {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Queen City Church - Life Groups Health Report</title>
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
            #lastUpdate {
              margin: 10px 0;
              color: #666;
              font-size: 14px;
              display: none;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Queen City Church - Life Groups Health Report</h1>
            <button id="loadDataBtn">Load Data</button>
            <p id="lastUpdate"></p>
            <p id="groupCount"></p>
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

            async function loadGroups() {
              try {
                loadDataBtn.disabled = true;
                loadDataBtn.textContent = 'Loading...';
                
                const response = await fetch('/api/load-groups');
                if (!response.ok) throw new Error('Failed to fetch groups');
                const result = await response.json();
                
                displayGroups(result);
                await updateLastUpdateTime();
              } catch (error) {
                console.error('Error:', error);
                loadDataBtn.textContent = 'Load Data';
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

              loadDataBtn.textContent = 'Refresh Data';
              
              // Load stats for each group
              result.data.forEach(group => updateGroupStats(group.id));
            }

            // Check cache and load data if available
            async function checkCacheAndLoad() {
              try {
                const response = await fetch('/api/check-cache');
                if (!response.ok) throw new Error('Failed to check cache');
                const { hasCachedData } = await response.json();
                
                if (hasCachedData) {
                  // If we have cached data, load it immediately
                  loadGroups();
                  await updateLastUpdateTime();
                } else {
                  // If no cached data, show the button and initial message
                  loadDataBtn.disabled = false;
                  initialMessage.textContent = 'Click "Load Data" to fetch and display the Life Groups data.';
                }
              } catch (error) {
                console.error('Error checking cache:', error);
                loadDataBtn.disabled = false;
                initialMessage.textContent = 'Click "Load Data" to fetch and display the Life Groups data.';
              }
            }

            // Add click event listener
            loadDataBtn.addEventListener('click', loadGroups);

            // Check cache when page loads
            checkCacheAndLoad();

            // Function to update stats for a group
            async function updateGroupStats(groupId) {
              const container = document.querySelector(\`#group-\${groupId} .stats-container\`);
              try {
                const response = await fetch(\`/api/group-stats/\${groupId}\`);
                if (!response.ok) throw new Error('Failed to fetch stats');
                const stats = await response.json();
                
                let rateClass = '';
                if (stats.overall_attendance_rate >= 70) rateClass = 'attendance-good';
                else if (stats.overall_attendance_rate >= 50) rateClass = 'attendance-warning';
                else if (stats.overall_attendance_rate > 0) rateClass = 'attendance-poor';

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
              } catch (error) {
                console.error('Error fetching stats:', error);
                container.innerHTML = \`<div class="no-data">Failed to load statistics</div>\`;
              }
            }
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
    console.log('Request params:', { groupId, showAllEvents, query: req.query });
    
    const [group, attendanceData] = await Promise.all([
      getGroup(groupId),
      getGroupAttendance(groupId, showAllEvents)
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
              <span class="date-range">
                Showing events from: ${showAllEvents ? 'All years' : 'Current year'}
              </span>
            </div>

            <script>
              document.getElementById('showAllEvents').addEventListener('change', function() {
                console.log('Toggle changed:', this.checked);
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
                  <th>Total Members</th>
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
                    const eventUrl = `https://groups.planningcenteronline.com/groups/${groupId}/events/${event.event.id}`;
                    
                    return `
                      <tr class="${rowClass}">
                        <td>
                          ${formatDate(event.event.date)}
                          ${event.event.canceled ? '<span class="canceled-label"> (CANCELED)</span>' : ''}
                        </td>
                        <td>
                          <a href="${eventUrl}" rel="noopener noreferrer" 
                             class="${rowClass}">Attendance</a>
                        </td>
                        <td>${event.attendance_summary.present_members}</td>
                        <td>${event.attendance_summary.present_visitors > 0 ? 
                             `<span class="visitor-count">+${event.attendance_summary.present_visitors}</span>` : 
                             '0'}</td>
                        <td>${event.attendance_summary.present_count}</td>
                        <td>${event.attendance_summary.total_count}</td>
                        <td class="${rateClass}">${rate}%</td>
                      </tr>
                    `;
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
  console.log(`Server running at http://localhost:${port}`);
}); 