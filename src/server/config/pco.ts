import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const PCO_BASE_URL = 'https://api.planningcenteronline.com';

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
    await new Promise(resolve => setTimeout(resolve, 100));
  }

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

export const getGroupEvents = async (groupId: string) => {
  try {
    // Get events specifically for this group
    const response = await pcoClient.get(`/groups/v2/groups/${groupId}/events`, {
      params: {
        where: {
          starts_at: {
            gte: '2025-01-01T00:00:00Z'  // Start from beginning of 2024
          }
        },
        per_page: 100,  // Get maximum number of events per page
        order: '-starts_at' // Most recent first
      }
    });
    
    let events = response.data.data as PCOEvent[];
    
    // If there are more pages, fetch them
    let nextPage = response.data.links?.next;
    while (nextPage) {
      const nextResponse = await pcoClient.get(nextPage);
      events = [...events, ...nextResponse.data.data];
      nextPage = nextResponse.data.links?.next;
      
      // Add a small delay between requests
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    return events;
  } catch (error) {
    console.error('Error fetching group events:', error);
    throw error;
  }
};

export const getEventAttendance = async (eventId: string) => {
  try {
    const response = await pcoClient.get<PCOAttendanceResponse>(`/groups/v2/events/${eventId}/attendances`);
    let attendances = response.data.data;
    const totalCount = response.data.meta.total_count;
    
    // If there are more pages, fetch them
    let nextPage = response.data.links?.next;
    while (nextPage) {
      const nextResponse = await pcoClient.get<PCOAttendanceResponse>(nextPage);
      attendances = [...attendances, ...nextResponse.data.data];
      nextPage = nextResponse.data.links?.next;
      
      // Add a small delay between requests
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    return {
      data: attendances,
      meta: {
        total_count: totalCount
      }
    };
  } catch (error) {
    console.error('Error fetching event attendance:', error);
    throw error;
  }
};

// Get all attendance data for a group
export const getGroupAttendance = async (groupId: string) => {
  try {
    // First get all events for this group
    const events = await getGroupEvents(groupId);
    
    // Get attendance for each event
    const attendancePromises = events.map(async (event) => {
      const attendance = await getEventAttendance(event.id);
      
      // Count attendees using the total from meta and counting present from data
      const totalAttendees = attendance.meta.total_count;
      const presentAttendees = attendance.data.filter(a => a.attributes.attended).length;
      
      return {
        event: {
          id: event.id,
          name: event.attributes.name,
          date: event.attributes.starts_at,
          canceled: event.attributes.canceled
        },
        attendance_summary: {
          total_count: totalAttendees,
          present_count: presentAttendees,
          absent_count: totalAttendees - presentAttendees,
          attendance_rate: totalAttendees > 0 ? Math.round((presentAttendees / totalAttendees) * 100) : 0
        }
      };
    });

    const attendanceData = await Promise.all(attendancePromises);
    
    // Calculate overall statistics
    const currentDate = new Date();
    const overallStats = attendanceData.reduce((stats, event) => {
      const eventDate = new Date(event.event.date);
      
      // Only include events that:
      // 1. Are not canceled
      // 2. Are in the past
      // 3. Have at least one attendance record
      if (!event.event.canceled && 
          eventDate <= currentDate && 
          event.attendance_summary.total_count > 0) {
        stats.total_events += 1;
        stats.total_attendance += event.attendance_summary.present_count;
        stats.total_possible += event.attendance_summary.total_count;
      }
      return stats;
    }, { total_events: 0, total_attendance: 0, total_possible: 0 });

    return {
      group_id: groupId,
      overall_statistics: {
        total_events: overallStats.total_events,
        average_attendance: overallStats.total_events > 0 
          ? Math.round(overallStats.total_attendance / overallStats.total_events)
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
};

export const getGroup = async (groupId: string) => {
  try {
    const response = await pcoClient.get(`/groups/v2/groups/${groupId}`);
    return response.data.data as PCOGroup;
  } catch (error) {
    console.error('Error fetching group:', error);
    throw error;
  }
};

export default pcoClient; 