# Church Life Groups Dashboard

A web application for tracking church group membership and attendance using Planning Center Online data.

## Features

- Integration with Planning Center Online API
- Real-time attendance tracking
- Group membership management
- Historical attendance reporting
- Interactive dashboard

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
- Group lists
- Attendance records
- Member information

## Development

- Backend: Node.js with Express and TypeScript
- Database: MongoDB
- API Integration: Planning Center Online
- Testing: Jest
