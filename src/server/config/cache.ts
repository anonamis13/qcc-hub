interface CacheItem<T> {
  data: T;
  timestamp: number;
}

class Cache {
  private cache: Map<string, CacheItem<any>>;
  private readonly defaultTTL: number;

  constructor(defaultTTLMinutes: number = 60) {
    this.cache = new Map();
    this.defaultTTL = defaultTTLMinutes * 60 * 1000; // Convert minutes to milliseconds
  }

  set<T>(key: string, data: T, ttlMinutes?: number): void {
    const timestamp = Date.now();
    this.cache.set(key, {
      data,
      timestamp
    });

    // Optional: Set up automatic cleanup after TTL
    const ttl = (ttlMinutes ?? this.defaultTTL / 60000) * 60000;
    setTimeout(() => {
      const item = this.cache.get(key);
      if (item && item.timestamp === timestamp) {
        this.cache.delete(key);
      }
    }, ttl);
  }

  get<T>(key: string): T | null {
    const item = this.cache.get(key);
    if (!item) return null;

    const age = Date.now() - item.timestamp;
    if (age > this.defaultTTL) {
      this.cache.delete(key);
      return null;
    }

    return item.data as T;
  }

  clear(): void {
    this.cache.clear();
  }

  // Get cache stats
  getStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys())
    };
  }
}

// Create a singleton instance
export const cache = new Cache(60); // 60 minutes (1 hour) default TTL 