# QCC Hub

Queen City Church Administrative Hub - A comprehensive web application for managing church operations including Life Groups Health Reports, Dream Team Health Reports, and administrative tools using Planning Center Online data.

## Features

### Life Groups Health Report
- Real-time attendance tracking and reporting
- Group membership management and changes
- Historical attendance analysis
- Interactive charts and statistics

### Dream Team Health Report
- Team membership tracking and health monitoring
- Workflow-based team management
- Member removal workflow system
- Team review and approval processes

### Ministry Metrics
- Weekly attendance, giving, and ministry figures captured in the app
- Historical spreadsheet import (one worksheet per Sunday)
- Year-over-year charts, including alignment on special Sundays so Easter
  compares against Easter rather than against a calendar week
- Highlighted Sundays (Easter, Church Birthday, Christmas) resolved by rule
- CSV export of everything held in the section
- Password protected, since it contains giving figures

This section stores its data in its own SQLite database (`metrics.db`) rather
than the shared cache, because it is hand-entered and cannot be rebuilt from
Planning Center.

### Core Features
- Integration with Planning Center Online API
- Real-time attendance tracking
- Group membership management
- Historical attendance reporting
- Interactive dashboard
- Dark/Light mode toggle
- Responsive design
- Interactive dashboards
- Data caching and optimization

## Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a `.env` file in the root directory with your Planning Center Online API credentials:
   ```
   PCO_APP_ID=your_app_id
   PCO_SECRET=your_secret
   MONGODB_URI=your_mongodb_connection_string
   PORT=3000
   METRICS_PASSWORD_HASH=scrypt$...
   ```
   Generate the Ministry Metrics password hash with:
   ```bash
   npm run build
   node dist/server/ministry-metrics/cli-hash-password.js "your password"
   ```
4. Start the development server:
   ```bash
   npm run dev
   ```

## Project Structure

```
├── src/
│   ├── server/           # Backend Node.js/Express code
│   │   ├── config/      # Configuration files
│   │   ├── controllers/ # Route controllers
│   │   ├── models/      # Database models
│   │   ├── routes/      # API routes
│   │   └── services/    # Business logic and external services
│   └── client/          # Frontend React code (to be added)
├── .env                 # Environment variables
├── .gitignore          # Git ignore file
├── package.json        # Project dependencies
└── README.md          # This file
```

## API Integration

This application uses the Planning Center Online API to fetch:
- Group and team lists
- Attendance records
- Member information
- Workflow data
- Team assignments

## Development

- Backend: Node.js with Express and TypeScript
- Database: SQLite with better-sqlite3
- API Integration: Planning Center Online
- Frontend: Server-rendered HTML with vanilla JavaScript
- Testing: Jest
- Caching: Aggressive API response caching with automatic cleanup
