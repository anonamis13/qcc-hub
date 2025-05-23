import axios, { AxiosError } from 'axios';
import dotenv from 'dotenv';
import { cache } from './cache';

dotenv.config();

const PCO_BASE_URL = 'https://api.planningcenteronline.com';

// Utility function to wait
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Retry function with exponential backoff
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  retries = 3,
  baseDelay = 1000
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (!(error instanceof AxiosError) || !error.response || error.response.status !== 429 || retries === 0) {
      throw error;
    }

    // Get retry-after header or use exponential backoff
    const retryAfter = parseInt(error.response.headers['retry-after'] || '0');
    const waitTime = retryAfter * 1000 || baseDelay * Math.pow(2, 4 - retries);
    
    console.log(`Rate limited. Waiting ${waitTime/1000} seconds before retry. ${retries - 1} retries remaining.`);
    await delay(waitTime);
    
    return retryWithBackoff(fn, retries - 1, baseDelay);
  }
}

interface PCOGroup {
  type: string;
  id: string;
  attributes: {
    name: string;
    [key: string]: any;
  };
  relationships: {
    group_type: {
      data: {
        type: string;
        id: string;
      };
    };
    [key: string]: any;
  };
}

interface PCOResponse {
  data: PCOGroup[];
  meta: {
    total_count: number;
    count: number;
    next?: {
      offset: number;
    };
  };
}

interface PCOEvent {
  type: string;
  id: string;
  attributes: {
    name: string;
    starts_at: string;
    ends_at: string;
    canceled: boolean;
    description?: string;
    visitors_count: number;
  };
  relationships: {
    group: {
      data: {
        type: string;
        id: string;
      };
    };
  };
}

interface PCOAttendance {
  type: string;
  id: string;
  attributes: {
    attended: boolean;
    role: string;
  };
  relationships: {
    person: {
      data: {
        type: string;
        id: string;
      };
    };
    event: {
      data: {
        type: string;
        id: string;
      };
    };
  };
}

interface PCOAttendanceResponse {
  data: PCOAttendance[];
  meta: {
    total_count: number;
    count: number;
    next?: {
      offset: number;
    };
  };
  links?: {
    next?: string;
  };
}

// Create an axios instance with PCO API configuration
const pcoClient = axios.create({
  baseURL: PCO_BASE_URL,
  auth: {
    username: process.env.PCO_APP_ID || '',
    password: process.env.PCO_SECRET || ''
  },
  headers: {
    'Content-Type': 'application/json'
  }
});

async function getAllGroups(): Promise<PCOGroup[]> {
  const cacheKey = 'all_groups';
  const cachedGroups = cache.get<PCOGroup[]>(cacheKey);
  if (cachedGroups) {
    console.log('Using cached groups data');
    return cachedGroups;
  }

  let allGroups: PCOGroup[] = [];
  let offset = 0;
  const PER_PAGE = 100; // Maximum allowed by PCO API
  
  while (true) {
    const response = await pcoClient.get<PCOResponse>('/groups/v2/groups', {
      params: {
        include: 'group_type',
        per_page: PER_PAGE,
        offset: offset
      }
    });

    const groups = response.data.data;
    allGroups = [...allGroups, ...groups];

    // Check if there are more pages
    if (!response.data.meta.next) {
      break;
    }
    
    offset += PER_PAGE;
    
    // Optional: Add a small delay to avoid rate limiting
    await delay(100);
  }

  // Cache the results for 5 minutes
  cache.set(cacheKey, allGroups);
  return allGroups;
}

export const getPeopleGroups = async (groupTypeId?: number) => {
  try {
    // Get all groups with pagination
    const allGroups = await getAllGroups();
    
    if (!groupTypeId) {
      return { data: allGroups };
    }

    // Filter groups by group type ID
    const filteredGroups = allGroups.filter(group => 
      group.relationships.group_type.data.id === groupTypeId.toString()
    );
    
    return {
      data: filteredGroups,
      filtered_count: filteredGroups.length,
      total_count: allGroups.length
    };
  } catch (error) {
    console.error('Error fetching groups:', error);
    throw error;
  }
};

export const getGroupEvents = async (groupId: string, showAllEvents: boolean = false) => {
  const cacheKey = `events_${groupId}_${showAllEvents}`;
  const cachedEvents = cache.get<PCOEvent[]>(cacheKey);
  if (cachedEvents) {
    console.log(`Using cached events data for group ${groupId}`);
    return cachedEvents;
  }

  return retryWithBackoff(async () => {
    try {
      console.log('Fetching events with showAllEvents:', showAllEvents);
      
      // Construct query parameters
      const queryParams: Record<string, string> = {
        order: '-starts_at', // Most recent first
        per_page: '100' // Get maximum number of events per page
      };

      // Only add date filter if we're not showing all events
      if (!showAllEvents) {
        const currentYear = new Date().getFullYear();
        const startOfYear = new Date(currentYear, 0, 1); // Month is 0-indexed (0 for January)
        queryParams['where[starts_at][gte]'] = startOfYear.toISOString();
      }

      console.log('Query parameters:', queryParams);

      // Get events specifically for this group
      const response = await pcoClient.get(`/groups/v2/groups/${groupId}/events`, {
        params: queryParams
      });
      
      let events = response.data.data;
      
      // Handle pagination if there are more pages
      let nextPage = response.data.links?.next;
      while (nextPage) {
        // Add a small delay between requests
        await delay(100);
        
        const nextResponse = await pcoClient.get(nextPage);
        events = [...events, ...nextResponse.data.data];
        nextPage = nextResponse.data.links?.next;
      }
      
      console.log(`Found ${events.length} total events after pagination`);
      
      // Cache the results
      cache.set(cacheKey, events);
      return events as PCOEvent[];
    } catch (error) {
      console.error('Error fetching group events:', error);
      throw error;
    }
  });
};

export const getEventAttendance = async (eventId: string) => {
  const cacheKey = `attendance_${eventId}`;
  const cachedAttendance = cache.get<{data: PCOAttendance[], meta: {total_count: number}}>(cacheKey);
  if (cachedAttendance) {
    console.log(`Using cached attendance data for event ${eventId}`);
    return cachedAttendance;
  }

  return retryWithBackoff(async () => {
    try {
      const response = await pcoClient.get<PCOAttendanceResponse>(`/groups/v2/events/${eventId}/attendances`);
      let attendances = response.data.data;
      const totalCount = response.data.meta.total_count;
      
      // If there are more pages, fetch them
      let nextPage = response.data.links?.next;
      while (nextPage) {
        // Add a delay between pagination requests
        await delay(100);
        
        const nextResponse = await pcoClient.get<PCOAttendanceResponse>(nextPage);
        attendances = [...attendances, ...nextResponse.data.data];
        nextPage = nextResponse.data.links?.next;
      }
      
      const result = {
        data: attendances,
        meta: {
          total_count: totalCount
        }
      };

      // Cache the results
      cache.set(cacheKey, result);
      return result;
    } catch (error) {
      console.error('Error fetching event attendance:', error);
      throw error;
    }
  });
};

// Get all attendance data for a group
export const getGroupAttendance = async (groupId: string, showAllEvents: boolean = false) => {
  return retryWithBackoff(async () => {
    try {
      // First get all events for this group
      const events = await getGroupEvents(groupId, showAllEvents);
      
      // Get attendance for each event
      const attendancePromises = events.map(async (event) => {
        const attendance = await getEventAttendance(event.id);
        
        // Count attendees using the total from meta and counting present from data
        const totalAttendees = attendance.meta.total_count;
        const presentMembers = attendance.data.filter(a => a.attributes.attended).length;
        const presentVisitors = event.attributes.visitors_count;
        const presentTotal = presentMembers + presentVisitors;
        
        return {
          event: {
            id: event.id,
            name: event.attributes.name,
            date: event.attributes.starts_at,
            canceled: event.attributes.canceled
          },
          attendance_summary: {
            total_count: totalAttendees,
            present_count: presentTotal,
            present_members: presentMembers,
            present_visitors: presentVisitors,
            absent_count: totalAttendees - presentMembers,
            attendance_rate: totalAttendees > 0 ? Math.round((presentMembers / totalAttendees) * 100) : 0
          }
        };
      });

      const attendanceData = await Promise.all(attendancePromises);
      
      // Calculate overall statistics (only including events with attendance)
      const currentDate = new Date();
      const overallStats = attendanceData.reduce((stats, event) => {
        const eventDate = new Date(event.event.date);
        
        // Only include events that:
        // 1. Are not canceled
        // 2. Are in the past
        // 3. Have at least one person present (members + visitors)
        if (!event.event.canceled && 
            eventDate <= currentDate && 
            event.attendance_summary.present_count > 0) {
          stats.total_events += 1;
          stats.total_attendance += event.attendance_summary.present_count;
          stats.total_members += event.attendance_summary.present_members;
          stats.total_visitors += event.attendance_summary.present_visitors;
          stats.total_possible += event.attendance_summary.total_count;
        }
        return stats;
      }, { 
        total_events: 0, 
        total_attendance: 0, 
        total_members: 0,
        total_visitors: 0,
        total_possible: 0 
      });

      // Add a note about how many events were included in statistics
      const eventsWithAttendance = attendanceData.filter(event => 
        !event.event.canceled && 
        new Date(event.event.date) <= currentDate && 
        event.attendance_summary.present_count > 0
      ).length;

      return {
        group_id: groupId,
        overall_statistics: {
          total_events: overallStats.total_events,
          events_with_attendance: eventsWithAttendance,
          average_attendance: overallStats.total_events > 0 
            ? Math.round(overallStats.total_attendance / overallStats.total_events)
            : 0,
          average_members: overallStats.total_events > 0
            ? Math.round(overallStats.total_members / overallStats.total_events)
            : 0,
          average_visitors: overallStats.total_events > 0
            ? Math.round(overallStats.total_visitors / overallStats.total_events)
            : 0,
          overall_attendance_rate: overallStats.total_possible > 0
            ? Math.round((overallStats.total_attendance / overallStats.total_possible) * 100)
            : 0
        },
        events: attendanceData
      };
    } catch (error) {
      console.error('Error fetching group attendance:', error);
      throw error;
    }
  });
};

export const getGroup = async (groupId: string) => {
  const cacheKey = `group_${groupId}`;
  const cachedGroup = cache.get<PCOGroup>(cacheKey);
  if (cachedGroup) {
    console.log(`Using cached group data for ${groupId}`);
    return cachedGroup;
  }

  return retryWithBackoff(async () => {
    try {
      const response = await pcoClient.get(`/groups/v2/groups/${groupId}`);
      const group = response.data.data as PCOGroup;
      
      // Cache the results
      cache.set(cacheKey, group);
      return group;
    } catch (error) {
      console.error('Error fetching group:', error);
      throw error;
    }
  });
};

export default pcoClient; 