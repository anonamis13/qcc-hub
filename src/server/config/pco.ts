import axios, { AxiosError } from 'axios';
import dotenv from 'dotenv';
import { cache } from './cache.js';

dotenv.config();

const PCO_BASE_URL = 'https://api.planningcenteronline.com';

// Utility function to wait
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Retry function with exponential backoff
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  retries = 8,
  baseDelay = 3000
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (!(error instanceof AxiosError) || !error.response || error.response.status !== 429 || retries === 0) {
      if (retries > 0 && error instanceof AxiosError && error.response?.status !== 404) {
        console.log(`Non-429 error, retrying... (${retries - 1} retries left): ${error.message}`);
        await delay(baseDelay);
        return retryWithBackoff(fn, retries - 1, baseDelay);
      }
      throw error;
    }

    // Get retry-after header or use exponential backoff
    const retryAfter = parseInt(error.response.headers['retry-after'] || '0');
    const waitTime = retryAfter * 1000 || baseDelay * Math.pow(2, 9 - retries);
    
    console.log(`Rate limited. Waiting ${waitTime/1000}s (${retries - 1} retries left)`);
    await delay(waitTime);
    
    return retryWithBackoff(fn, retries - 1, baseDelay);
  }
}

interface PCOTag {
  type: string;
  id: string;
  attributes: {
    name: string;
    color?: string;
    [key: string]: any;
  };
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
    tags?: {
      data: Array<{
        type: string;
        id: string;
      }>;
    };
    [key: string]: any;
  };
}

interface PCOResponse {
  data: PCOGroup[];
  included?: Array<PCOTag | any>;
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

// Add interface for group membership data
interface PCOMembership {
  type: string;
  id: string;
  attributes: {
    role: string;
    joined_at?: string;
    [key: string]: any;
  };
  relationships: {
    person: {
      data: {
        type: string;
        id: string;
      };
    };
    group: {
      data: {
        type: string;
        id: string;
      };
    };
  };
}

interface PCOMembershipResponse {
  data: PCOMembership[];
  included?: Array<any>;
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

async function getAllGroups(forceRefresh: boolean = false): Promise<PCOGroup[]> {
  const cacheKey = 'all_groups';
  const cachedGroups = cache.get<PCOGroup[]>(cacheKey);
  
  // Always use cache if available, unless force refresh is requested
  if (cachedGroups && !forceRefresh) {
    return cachedGroups;
  }

  let allGroups: PCOGroup[] = [];
  let offset = 0;
  const PER_PAGE = 100; // Maximum allowed by PCO API
  
  while (true) {
    const response = await pcoClient.get<PCOResponse>('/groups/v2/groups', {
      params: {
        include: 'group_type,tags',
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
  
  // Cache the results
  cache.set(cacheKey, allGroups);
  return allGroups;
}

// Function to get tags for a specific group
export const getGroupTags = async (groupId: string, forceRefresh: boolean = false) => {
  const cacheKey = `tags_${groupId}`;
  const cachedTags = cache.get<PCOTag[]>(cacheKey);
  
  // Always use cache if available, unless force refresh is requested
  if (cachedTags && !forceRefresh) {
    return cachedTags;
  }

  return retryWithBackoff(async () => {
    try {
      const response = await pcoClient.get(`/groups/v2/groups/${groupId}/tags`);
      const tags = response.data.data as PCOTag[];
      
      // Cache the results
      cache.set(cacheKey, tags);
      return tags;
    } catch (error) {
      console.error(`Error fetching tags for group ${groupId}:`, error);
      return []; // Return empty array on error
    }
  });
};

// Helper function to check if a group is a Family Group using direct tag lookup
const isFamilyGroup = async (groupId: string): Promise<boolean> => {
  try {
    const tags = await getGroupTags(groupId, false);
    return tags.some(tag => tag.id === '1252160');
  } catch (error) {
    console.error(`Error checking if group ${groupId} is family group:`, error);
    return false;
  }
};

// Helper function to extract metadata from group tags
const extractGroupMetadata = (tags: PCOTag[]) => {
  const metadata = {
    groupType: 'Unknown',
    meetingDay: 'Unknown',
    allTags: tags.map(tag => ({ id: tag.id, name: tag.attributes.name }))
  };
  
  // Extract group type from tags
  const groupTypeTag = tags.find(tag => 
    tag.attributes.name === 'Family' || 
    tag.attributes.name === 'Stage of Life' || 
    tag.attributes.name === 'Location Based'
  );
  if (groupTypeTag) {
    metadata.groupType = groupTypeTag.attributes.name;
  }
  
  // Extract meeting day from tags
  const meetingDayTag = tags.find(tag => 
    tag.attributes.name === 'Wednesday' || 
    tag.attributes.name === 'Thursday'
  );
  if (meetingDayTag) {
    metadata.meetingDay = meetingDayTag.attributes.name;
  }
  
  return metadata;
};

export const getPeopleGroups = async (groupTypeId?: number, forceRefresh: boolean = false) => {
  try {
    // Get all groups with pagination
    const allGroups = await getAllGroups(forceRefresh);
    
    if (!groupTypeId) {
      // Check each group for Family Group status and get tags
      const groupsWithMetadata = await Promise.all(
        allGroups.map(async (group) => {
          const [isFamilyGroupResult, tags] = await Promise.all([
            isFamilyGroup(group.id),
            getGroupTags(group.id, forceRefresh)
          ]);
          
          return {
            ...group,
            isFamilyGroup: isFamilyGroupResult,
            tags: tags,
            metadata: extractGroupMetadata(tags)
          };
        })
      );
      
      return { 
        data: groupsWithMetadata
      };
    }

    // Filter groups by group type ID
    const filteredGroups = allGroups.filter(group => 
      group.relationships.group_type.data.id === groupTypeId.toString()
    );
    
    // Check each filtered group for Family Group status and get tags
    const groupsWithMetadata = await Promise.all(
      filteredGroups.map(async (group) => {
        const [isFamilyGroupResult, tags] = await Promise.all([
          isFamilyGroup(group.id),
          getGroupTags(group.id, forceRefresh)
        ]);
        
        return {
          ...group,
          isFamilyGroup: isFamilyGroupResult,
          tags: tags,
          metadata: extractGroupMetadata(tags)
        };
      })
    );
    
    return {
      data: groupsWithMetadata,
      filtered_count: filteredGroups.length,
      total_count: allGroups.length
    };
  } catch (error) {
    console.error('Error fetching groups:', error);
    throw error;
  }
};

export const getGroupEvents = async (groupId: string, showAllEvents: boolean = false, forceRefresh: boolean = false) => {
  const cacheKey = `events_${groupId}_${showAllEvents}`;
  const cachedEvents = cache.get<PCOEvent[]>(cacheKey);
  
  // Always use cache if available, unless force refresh is requested
  if (cachedEvents && !forceRefresh) {
    return cachedEvents;
  }

      return retryWithBackoff(async () => {
    try {
      // Construct query parameters
      const queryParams: Record<string, string> = {
        order: '-starts_at', // Most recent first
        per_page: '100' // Get maximum number of events per page
      };

      // Only add date filter if we're not showing all events
      if (!showAllEvents) {
        const currentYear = new Date().getFullYear();
        // Use UTC to avoid timezone differences between dev and prod
        const startOfYear = new Date(Date.UTC(currentYear, 0, 1)); // January 1st at 00:00 UTC
        const today = new Date();
        // Set to end of day in UTC to be inclusive
        const endOfToday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 23, 59, 59, 999));
        
        queryParams['where[starts_at][gte]'] = startOfYear.toISOString();
        queryParams['where[starts_at][lte]'] = endOfToday.toISOString(); // Only past/today events
      }

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
      
      // Cache the results
      cache.set(cacheKey, events);
      return events as PCOEvent[];
    } catch (error) {
      console.error('Error fetching group events:', error);
      throw error;
    }
  });
};

export const getEventAttendance = async (eventId: string, forceRefresh: boolean = false) => {
  const cacheKey = `attendance_${eventId}`;
  const cachedAttendance = cache.get<{data: PCOAttendance[], meta: {total_count: number}}>(cacheKey);
  
  // Always use cache if available, unless force refresh is requested
  if (cachedAttendance && !forceRefresh) {
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
        await delay(200);
        
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
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Error fetching attendance for event ${eventId}:`, errorMessage);
      throw error;
    }
  });
};

// Get all attendance data for a group
export const getGroupAttendance = async (groupId: string, showAllEvents: boolean = false, forceRefresh: boolean = false) => {
  return retryWithBackoff(async () => {
    try {
      // First get all events for this group
      const events = await getGroupEvents(groupId, showAllEvents, forceRefresh);

      
      // Get attendance for each event
      const attendancePromises = events.map(async (event) => {
        const attendance = await getEventAttendance(event.id, forceRefresh);
        
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

      // Check if this is a Family Group and calculate special metrics
      const isFamily = await isFamilyGroup(groupId);
      let familyGroupMetrics = null;
      
      if (isFamily) {
        familyGroupMetrics = calculateFamilyGroupMetrics(attendanceData);
      }

      const baseStats = {
        total_events: overallStats.total_events,
        events_with_attendance: eventsWithAttendance,
        average_attendance: overallStats.total_events > 0 
          ? Math.round(overallStats.total_attendance / overallStats.total_events)
          : 0,
        average_members: overallStats.total_events > 0
          ? Math.round(overallStats.total_possible / overallStats.total_events)
          : 0,
        average_visitors: overallStats.total_events > 0
          ? Math.round(overallStats.total_visitors / overallStats.total_events)
          : 0,
        overall_attendance_rate: overallStats.total_possible > 0
          ? Math.round((overallStats.total_attendance / overallStats.total_possible) * 100)
          : 0
      };

      return {
        group_id: groupId,
        overall_statistics: isFamily ? {
          ...baseStats,
          familyGroup: {
            parentsNightsRate: familyGroupMetrics?.parentsNightsRate || 0,
            familyNightsRate: familyGroupMetrics?.familyNightsRate || 0,
            parentsNightsAttendance: familyGroupMetrics?.parentsNightsAttendance || 0,
            familyNightsAttendance: familyGroupMetrics?.familyNightsAttendance || 0,
            eventsBreakdown: familyGroupMetrics?.eventsBreakdown || {
              totalMonths: 0,
              monthsWithCompleteData: 0,
              mothersNightsCount: 0,
              fathersNightsCount: 0,
              familyNightsCount: 0
            }
          }
        } : baseStats,
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

// Helper function to calculate Family Group specific metrics
const calculateFamilyGroupMetrics = (events: Array<{
  event: {
    id: string;
    name: string;
    date: string;
    canceled: boolean;
  };
  attendance_summary: {
    total_count: number;
    present_count: number;
    present_members: number;
    present_visitors: number;
    absent_count: number;
    attendance_rate: number;
  };
}>) => {
  const currentDate = new Date();
  
  // Get all events that are in the past (including cancelled and zero attendance)
  // We need ALL events to determine correct positioning
  const allPastEvents = events.filter(event => 
    new Date(event.event.date) <= currentDate
  );

  // Group ALL events by month (YYYY-MM format) - including cancelled/zero attendance
  const eventsByMonth = new Map<string, typeof allPastEvents>();
  
  allPastEvents.forEach(event => {
    const eventDate = new Date(event.event.date);
    const monthKey = `${eventDate.getFullYear()}-${String(eventDate.getMonth() + 1).padStart(2, '0')}`;
    
    if (!eventsByMonth.has(monthKey)) {
      eventsByMonth.set(monthKey, []);
    }
    eventsByMonth.get(monthKey)!.push(event);
  });

  // Sort events within each month by date to get correct chronological order
  eventsByMonth.forEach((monthEvents) => {
    monthEvents.sort((a, b) => new Date(a.event.date).getTime() - new Date(b.event.date).getTime());
  });

  let totalParentsNightsRate = 0;
  let totalFamilyNightsRate = 0;
  let monthsWithParentsData = 0;
  let monthsWithFamilyData = 0;
  
  // Track attendance totals for averages
  let totalParentsNightsAttendance = 0;
  let totalFamilyNightsAttendance = 0;
  let parentsNightsEventsCount = 0;
  let familyNightsEventsCount = 0;
  
  let mothersNightsCount = 0;
  let fathersNightsCount = 0;
  let familyNightsCount = 0;

  // Calculate metrics for each month
  eventsByMonth.forEach((monthEvents, monthKey) => {
    // We can process any month that has at least 1 event
    // The position tells us what type of meeting it is
    let mothersNightRate = 0;
    let fathersNightRate = 0;
    let familyNightRate = 0;
    let hasMothersData = false;
    let hasFathersData = false;
    let hasFamilyData = false;

    // Process each position (1st, 2nd, 3rd meeting)
    for (let i = 0; i < monthEvents.length && i < 3; i++) {
      const event = monthEvents[i];
      const isValidForCalculation = !event.event.canceled && event.attendance_summary.present_count > 0;

      if (i === 0) {
        // 1st meeting = Mothers Night
        if (isValidForCalculation) {
          const mothersHalfMembers = Math.ceil(event.attendance_summary.total_count / 2);
          mothersNightRate = mothersHalfMembers > 0 
            ? (event.attendance_summary.present_members / mothersHalfMembers) * 100 
            : 0;
          hasMothersData = true;
          // Track attendance for average calculation
          totalParentsNightsAttendance += event.attendance_summary.present_members;
          parentsNightsEventsCount++;
        }
        mothersNightsCount++; // Count all Mothers Nights (even cancelled)
      } else if (i === 1) {
        // 2nd meeting = Fathers Night
        if (isValidForCalculation) {
          const fathersHalfMembers = Math.ceil(event.attendance_summary.total_count / 2);
          fathersNightRate = fathersHalfMembers > 0 
            ? (event.attendance_summary.present_members / fathersHalfMembers) * 100 
            : 0;
          hasFathersData = true;
          // Track attendance for average calculation
          totalParentsNightsAttendance += event.attendance_summary.present_members;
          parentsNightsEventsCount++;
        }
        fathersNightsCount++; // Count all Fathers Nights (even cancelled)
      } else if (i === 2) {
        // 3rd meeting = Family Night
        if (isValidForCalculation) {
          familyNightRate = event.attendance_summary.attendance_rate;
          hasFamilyData = true;
          // Track attendance for average calculation
          totalFamilyNightsAttendance += event.attendance_summary.present_members;
          familyNightsEventsCount++;
        }
        familyNightsCount++; // Count all Family Nights (even cancelled)
      }
    }

    // Calculate Parents Nights average for this month (if we have any parents data)
    if (hasMothersData || hasFathersData) {
      let monthParentsRate = 0;
      let parentsNightsWithData = 0;
      
      if (hasMothersData) {
        monthParentsRate += mothersNightRate;
        parentsNightsWithData++;
      }
      if (hasFathersData) {
        monthParentsRate += fathersNightRate;
        parentsNightsWithData++;
      }
      
      if (parentsNightsWithData > 0) {
        totalParentsNightsRate += (monthParentsRate / parentsNightsWithData);
        monthsWithParentsData++;
      }
    }

    // Include Family Night data if available
    if (hasFamilyData) {
      totalFamilyNightsRate += familyNightRate;
      monthsWithFamilyData++;
    }
  });

  const avgParentsNightsRate = monthsWithParentsData > 0 
    ? Math.round(totalParentsNightsRate / monthsWithParentsData) 
    : 0;
    
  const avgFamilyNightsRate = monthsWithFamilyData > 0 
    ? Math.round(totalFamilyNightsRate / monthsWithFamilyData) 
    : 0;

  // Calculate average attendance numbers
  const avgParentsNightsAttendance = parentsNightsEventsCount > 0 
    ? Math.round(totalParentsNightsAttendance / parentsNightsEventsCount)
    : 0;
    
  const avgFamilyNightsAttendance = familyNightsEventsCount > 0 
    ? Math.round(totalFamilyNightsAttendance / familyNightsEventsCount)
    : 0;
  
  return {
    parentsNightsRate: avgParentsNightsRate,
    familyNightsRate: avgFamilyNightsRate,
    parentsNightsAttendance: avgParentsNightsAttendance,
    familyNightsAttendance: avgFamilyNightsAttendance,
    eventsBreakdown: {
      totalMonths: eventsByMonth.size,
      monthsWithParentsData: monthsWithParentsData,
      monthsWithFamilyData: monthsWithFamilyData,
      mothersNightsCount: mothersNightsCount,
      fathersNightsCount: fathersNightsCount,
      familyNightsCount: familyNightsCount
    }
  };
};

// Function to get group memberships (current members)
export const getGroupMemberships = async (groupId: string, forceRefresh: boolean = false) => {
  const cacheKey = `memberships_${groupId}`;
  const cachedMemberships = cache.get<any[]>(cacheKey);
  
  // Always use cache if available, unless force refresh is requested
  if (cachedMemberships && !forceRefresh) {
    return cachedMemberships;
  }

  return retryWithBackoff(async () => {
    try {
      // Get group memberships with included person data
      const response = await pcoClient.get<PCOMembershipResponse>(`/groups/v2/groups/${groupId}/memberships`, {
        params: {
          include: 'person',
          per_page: '100'
        }
      });
      
      let memberships = response.data.data;
      let included = response.data.included || [];
      
      // Handle pagination if there are more pages
      let nextPage = response.data.links?.next;
      while (nextPage) {
        await delay(100);
        
        const nextResponse = await pcoClient.get<PCOMembershipResponse>(nextPage);
        memberships = [...memberships, ...nextResponse.data.data];
        if (nextResponse.data.included) {
          included = [...included, ...nextResponse.data.included];
        }
        nextPage = nextResponse.data.links?.next;
      }
      
      // Create a map of person ID to person data for quick lookup
      const personMap = new Map();
      included.filter(item => item.type === 'Person').forEach(person => {
        personMap.set(person.id, person);
      });
      
      // Combine membership and person data
      const membershipData = memberships.map(membership => {
        const personId = membership.relationships.person.data.id;
        const person = personMap.get(personId);
        
        return {
          membershipId: membership.id,
          personId: personId,
          role: membership.attributes.role,
          joinedAt: membership.attributes.joined_at,
          person: person ? {
            firstName: person.attributes.first_name,
            lastName: person.attributes.last_name,
            emailAddresses: person.attributes.email_addresses || [],
            phoneNumbers: person.attributes.phone_numbers || []
          } : null
        };
      });
      
      // Cache the results
      cache.set(cacheKey, membershipData);
      return membershipData;
    } catch (error) {
      console.error(`Error fetching memberships for group ${groupId}:`, error);
      throw error;
    }
  });
};

// PCO People API interfaces for Dream Teams
interface PCOWorkflowCategory {
  type: string;
  id: string;
  attributes: {
    name: string;
    created_at: string;
    updated_at: string;
  };
}

interface PCOWorkflow {
  type: string;
  id: string;
  attributes: {
    name: string;
    created_at: string;
    updated_at: string;
    my_ready_card_count: number;
    total_ready_card_count: number;
    completed_card_count: number;
    total_card_count: number;
  };
  relationships: {
    category: {
      data: {
        type: string;
        id: string;
      };
    };
  };
}

interface PCOWorkflowCard {
  type: string;
  id: string;
  attributes: {
    created_at: string;
    updated_at: string;
    moved_to_step_at: string;
    completed_at?: string;
    flagged_for_notification_at?: string;
    removed_at?: string;
    stage: string;
  };
  relationships: {
    person: {
      data: {
        type: string;
        id: string;
      };
    };
    current_step: {
      data: {
        type: string;
        id: string;
      } | null;
    };
    workflow: {
      data: {
        type: string;
        id: string;
      };
    };
  };
}

interface PCOPerson {
  type: string;
  id: string;
  attributes: {
    first_name: string;
    last_name: string;
    nickname?: string;
    created_at: string;
    updated_at: string;
  };
}

interface PCOWorkflowCategoryResponse {
  data: PCOWorkflowCategory[];
  meta: {
    total_count: number;
    count: number;
    next?: {
      offset: number;
    };
  };
}

interface PCOWorkflowResponse {
  data: PCOWorkflow[];
  meta: {
    total_count: number;
    count: number;
    next?: {
      offset: number;
    };
  };
}

interface PCOWorkflowCardResponse {
  data: PCOWorkflowCard[];
  included?: PCOPerson[];
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

// Get all workflow categories to find "Dream Team" category
export const getWorkflowCategories = async (forceRefresh: boolean = false) => {
  const cacheKey = 'workflow_categories';
  const cachedCategories = cache.get<PCOWorkflowCategory[]>(cacheKey);
  
  if (cachedCategories && !forceRefresh) {
    return cachedCategories;
  }

  return retryWithBackoff(async () => {
    try {
      const response = await pcoClient.get<PCOWorkflowCategoryResponse>('/people/v2/workflow_categories', {
        params: {
          per_page: '100'
        }
      });
      
      let categories = response.data.data;
      
      // Handle pagination if needed
      let offset = 100;
      while (response.data.meta.next) {
        await delay(100);
        const nextResponse = await pcoClient.get<PCOWorkflowCategoryResponse>('/people/v2/workflow_categories', {
          params: {
            per_page: '100',
            offset: offset
          }
        });
        categories = [...categories, ...nextResponse.data.data];
        offset += 100;
        if (!nextResponse.data.meta.next) break;
      }
      
      cache.set(cacheKey, categories);
      return categories;
    } catch (error) {
      console.error('Error fetching workflow categories:', error);
      throw error;
    }
  });
};

// Get workflows for a specific category (Dream Team)
export const getWorkflowsInCategory = async (categoryId: string, forceRefresh: boolean = false) => {
  const cacheKey = `workflows_category_${categoryId}`;
  const cachedWorkflows = cache.get<PCOWorkflow[]>(cacheKey);
  
  if (cachedWorkflows && !forceRefresh) {
    return cachedWorkflows;
  }

  return retryWithBackoff(async () => {
    try {
      const response = await pcoClient.get<PCOWorkflowResponse>(`/people/v2/workflows`, {
        params: {
          'where[workflow_category_id]': categoryId,
          per_page: '100'
        }
      });
      
      let workflows = response.data.data;
      
      // Handle pagination if needed
      let offset = 100;
      while (response.data.meta.next) {
        await delay(100);
        const nextResponse = await pcoClient.get<PCOWorkflowResponse>(`/people/v2/workflows`, {
          params: {
            'where[workflow_category_id]': categoryId,
            per_page: '100',
            offset: offset
          }
        });
        workflows = [...workflows, ...nextResponse.data.data];
        offset += 100;
        if (!nextResponse.data.meta.next) break;
      }
      
      cache.set(cacheKey, workflows);
      return workflows;
    } catch (error) {
      console.error(`Error fetching workflows for category ${categoryId}:`, error);
      throw error;
    }
  });
};

// Get workflow cards (people) for a specific workflow
export const getWorkflowCards = async (workflowId: string, forceRefresh: boolean = false) => {
  const cacheKey = `workflow_cards_${workflowId}`;
  const cachedCards = cache.get<{cards: PCOWorkflowCard[], people: PCOPerson[]}>(cacheKey);
  
  if (cachedCards && !forceRefresh) {
    return cachedCards;
  }

  return retryWithBackoff(async () => {
    try {
      const response = await pcoClient.get<PCOWorkflowCardResponse>(`/people/v2/workflows/${workflowId}/cards`, {
        params: {
          include: 'person',
          per_page: '100'
          // Get all cards - we'll filter out 'removed' ones after fetching
        }
      });
      
      let cards = response.data.data;
      let people = response.data.included?.filter(item => item.type === 'Person') as PCOPerson[] || [];
      
      // Handle pagination
      let nextPage = response.data.links?.next;
      while (nextPage) {
        await delay(100);
        
        const nextResponse = await pcoClient.get<PCOWorkflowCardResponse>(nextPage);
        cards = [...cards, ...nextResponse.data.data];
        if (nextResponse.data.included) {
          const nextPeople = nextResponse.data.included.filter(item => item.type === 'Person') as PCOPerson[];
          people = [...people, ...nextPeople];
        }
        nextPage = nextResponse.data.links?.next;
      }
      
      const result = { cards, people };
      cache.set(cacheKey, result);
      return result;
    } catch (error) {
      console.error(`Error fetching workflow cards for workflow ${workflowId}:`, error);
      throw error;
    }
  });
};

// Helper function to get Dream Team workflows with roster data
export const getDreamTeamWorkflows = async (forceRefresh: boolean = false) => {
  try {
    // Use the specific Dream Team category ID
    const dreamTeamCategoryId = '11927';
    
    // Workflow IDs to exclude (not actual teams)
    const excludedWorkflowIds = ['568000' ,'610176']; // Dream Team Onboarding, Trev Test
    
    // Get all workflows in the Dream Team category
    const allWorkflows = await getWorkflowsInCategory(dreamTeamCategoryId, forceRefresh);
    
    // Filter out excluded workflows
    const workflows = allWorkflows.filter(workflow => !excludedWorkflowIds.includes(workflow.id));
    
    // Get roster data for each workflow
    const workflowsWithRosters = await Promise.all(
      workflows.map(async (workflow) => {
        try {
          const { cards, people } = await getWorkflowCards(workflow.id, forceRefresh);
          
          // Create a person lookup map
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
          
          const roster = currentMembers.map(card => {
            const person = personMap.get(card.relationships.person.data.id);
            return {
              cardId: card.id,
              personId: card.relationships.person.data.id,
              firstName: person?.attributes.first_name || 'Unknown',
              lastName: person?.attributes.last_name || '',
              nickname: person?.attributes.nickname,
              joinedAt: card.attributes.created_at,
              movedToStepAt: card.attributes.moved_to_step_at,
              stage: card.attributes.stage
            };
          }).sort((a, b) => a.firstName.localeCompare(b.firstName));
          
          return {
            id: workflow.id,
            name: workflow.attributes.name,
            totalCards: workflow.attributes.total_card_count,
            readyCards: workflow.attributes.total_ready_card_count,
            completedCards: workflow.attributes.completed_card_count,
            lastUpdated: workflow.attributes.updated_at,
            roster: roster
          };
        } catch (error) {
          console.error(`Error fetching roster for workflow ${workflow.id}:`, error);
          return {
            id: workflow.id,
            name: workflow.attributes.name,
            totalCards: workflow.attributes.total_card_count,
            readyCards: workflow.attributes.total_ready_card_count,
            completedCards: workflow.attributes.completed_card_count,
            lastUpdated: workflow.attributes.updated_at,
            roster: []
          };
        }
      })
    );
    
    return workflowsWithRosters;
  } catch (error) {
    console.error('Error fetching Dream Team workflows:', error);
    throw error;
  }
};

export default pcoClient; 