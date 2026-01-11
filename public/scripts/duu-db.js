/**
 * DUU 统一数据库模块 v2.0
 * 整合所有 IndexedDB 存储功能：个人空间、任务历史、缓存
 * 优化：LRU内存缓存 + 批量写入队列 + 定时清理
 */

// ==================== LRU 内存缓存 ====================
class LRUCache {
  constructor(maxSize = 100) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  get(key) {
    if (!this.cache.has(key)) return undefined;
    // 移到最后（最近使用）
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // 删除最旧的（第一个）
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }

  delete(key) {
    this.cache.delete(key);
  }

  has(key) {
    return this.cache.has(key);
  }

  clear() {
    this.cache.clear();
  }

  keys() {
    return Array.from(this.cache.keys());
  }
}

// ==================== 批量写入队列 ====================
class WriteQueue {
  constructor(flushDelay = 300, maxBatchSize = 50) {
    this.queue = [];
    this.flushDelay = flushDelay;
    this.maxBatchSize = maxBatchSize;
    this.timer = null;
    this.flushing = false;
  }

  add(operation) {
    return new Promise((resolve, reject) => {
      this.queue.push({ operation, resolve, reject });
      
      // 达到批量上限立即执行
      if (this.queue.length >= this.maxBatchSize) {
        this._flush();
      } else {
        this._scheduleFlush();
      }
    });
  }

  _scheduleFlush() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this._flush();
    }, this.flushDelay);
  }

  async _flush() {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;

    const batch = this.queue.splice(0, this.maxBatchSize);
    
    try {
      await DuuDB._executeBatch(batch);
    } catch (e) {
      // 批量失败，逐个重试
      for (const item of batch) {
        try {
          await item.operation();
          item.resolve();
        } catch (err) {
          item.reject(err);
        }
      }
    }
    
    this.flushing = false;
    
    // 还有剩余继续处理
    if (this.queue.length > 0) {
      this._scheduleFlush();
    }
  }

  // 立即刷新所有队列
  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.queue.length > 0) {
      await this._flush();
    }
  }
}

// ==================== 主数据库模块 ====================
const DuuDB = {
  DB_NAME: 'DuuDatabase',
  DB_VERSION: 2,
  db: null,

  STORES: {
    PERSONAL: 'personal_space',
    HISTORY: 'task_history',
    CACHE: 'cache'
  },

  EXPIRY: {
    PERSONAL: 7 * 24 * 60 * 60 * 1000,   // 个人空间：7天
    HISTORY: 7 * 24 * 60 * 60 * 1000,    // 任务历史：7天
    CACHE: 7 * 24 * 60 * 60 * 1000       // 通用缓存：7天
  },

  MAX_HISTORY_TASKS: 100,                 // 每页最多100条任务
  CLEANUP_INTERVAL: 24 * 60 * 60 * 1000,  // 24小时清理一次
  LAST_CLEANUP_KEY: 'duu_last_cleanup',

  // LRU 缓存实例
  _memCache: new LRUCache(200),
  _taskCache: new LRUCache(100),
  _personalCache: new LRUCache(50),

  // 写入队列
  _writeQueue: new WriteQueue(300, 50),

  /**
   * 初始化数据库
   */
  async init() {
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        this._scheduleCleanup();
        resolve(this.db);
      };

      request.onupgradeneeded = (e) => {
        const db = e.target.result;

        if (!db.objectStoreNames.contains(this.STORES.PERSONAL)) {
          const store = db.createObjectStore(this.STORES.PERSONAL, { keyPath: 'id', autoIncrement: true });
          store.createIndex('apiKeyHash', 'apiKeyHash', { unique: false });
          store.createIndex('type', 'type', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }

        if (!db.objectStoreNames.contains(this.STORES.HISTORY)) {
          const store = db.createObjectStore(this.STORES.HISTORY, { keyPath: 'id' });
          store.createIndex('pageKey', 'pageKey', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }

        if (!db.objectStoreNames.contains(this.STORES.CACHE)) {
          db.createObjectStore(this.STORES.CACHE, { keyPath: 'key' });
        }
      };
    });
  },

  // 检查是否需要清理（每12小时一次）
  _scheduleCleanup() {
    try {
      const lastCleanup = parseInt(localStorage.getItem(this.LAST_CLEANUP_KEY) || '0', 10);
      const now = Date.now();
      
      if (now - lastCleanup > this.CLEANUP_INTERVAL) {
        // 延迟执行清理，不阻塞初始化
        setTimeout(() => {
          this.cleanup().then(() => {
            localStorage.setItem(this.LAST_CLEANUP_KEY, String(Date.now()));
          }).catch(console.warn);
        }, 5000);
      }
    } catch (e) {
      console.warn('清理调度失败:', e);
    }
  },

  // 批量执行写入操作
  async _executeBatch(batch) {
    await this.init();
    
    // 按 store 分组
    const groups = {};
    for (const item of batch) {
      const storeName = item.operation._storeName || this.STORES.CACHE;
      if (!groups[storeName]) groups[storeName] = [];
      groups[storeName].push(item);
    }

    // 每个 store 一个事务
    for (const [storeName, items] of Object.entries(groups)) {
      await new Promise((resolve, reject) => {
        const tx = this.db.transaction([storeName], 'readwrite');
        const store = tx.objectStore(storeName);
        
        tx.oncomplete = () => {
          items.forEach(item => item.resolve());
          resolve();
        };
        tx.onerror = () => {
          items.forEach(item => item.reject(tx.error));
          reject(tx.error);
        };

        for (const item of items) {
          try {
            item.operation._execute(store);
          } catch (e) {
            console.warn('批量操作项失败:', e);
          }
        }
      });
    }
  },

  // ==================== 个人空间 ====================

  hashApiKey(apiKey) {
    let hash = 0;
    for (let i = 0; i < apiKey.length; i++) {
      hash = ((hash << 5) - hash) + apiKey.charCodeAt(i);
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  },

  async saveImage(apiKey, imageData, title, source) {
    let data = imageData;
    if (!imageData.startsWith('data:')) {
      data = `data:image/png;base64,${imageData}`;
    }
    return this._savePersonal(apiKey, 'image', data, title, source);
  },

  async saveVideo(apiKey, videoData, title, source) {
    let data = videoData;
    if (!videoData.startsWith('data:') && !videoData.startsWith('blob:') && !videoData.startsWith('http')) {
      data = `data:video/mp4;base64,${videoData}`;
    }
    return this._savePersonal(apiKey, 'video', data, title, source);
  },

  async _savePersonal(apiKey, type, data, title, source) {
    await this.init();
    const hash = this.hashApiKey(apiKey);
    const record = {
      apiKeyHash: hash,
      type, data,
      title: title || '未命名',
      source: source || '未知来源',
      createdAt: Date.now()
    };

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.STORES.PERSONAL], 'readwrite');
      const store = tx.objectStore(this.STORES.PERSONAL);
      const request = store.add(record);
      
      request.onsuccess = () => {
        // 清除该用户的缓存，下次重新加载
        this._personalCache.delete(`personal_${hash}`);
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
    });
  },

  async getPersonalRecords(apiKey = null) {
    const hash = apiKey ? this.hashApiKey(apiKey) : null;
    const cacheKey = `personal_${hash || 'all'}`;
    
    // 检查内存缓存
    const cached = this._personalCache.get(cacheKey);
    if (cached && Date.now() - cached.time < 30000) { // 30秒缓存
      return cached.data;
    }

    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.STORES.PERSONAL], 'readonly');
      const store = tx.objectStore(this.STORES.PERSONAL);
      const request = store.getAll();

      request.onsuccess = () => {
        let records = request.result || [];
        const now = Date.now();
        records = records.filter(r => (now - r.createdAt) <= this.EXPIRY.PERSONAL);
        if (hash) {
          records = records.filter(r => r.apiKeyHash === hash);
        }
        records.sort((a, b) => b.createdAt - a.createdAt);
        
        // 存入内存缓存
        this._personalCache.set(cacheKey, { data: records, time: now });
        resolve(records);
      };
      request.onerror = () => reject(request.error);
    });
  },

  async deletePersonal(id) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.STORES.PERSONAL], 'readwrite');
      const request = tx.objectStore(this.STORES.PERSONAL).delete(id);
      request.onsuccess = () => {
        // 清除所有个人空间缓存
        this._personalCache.keys().forEach(k => {
          if (k.startsWith('personal_')) this._personalCache.delete(k);
        });
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  },

  // ==================== 任务历史 ====================

  async saveTask(pageKey, task) {
    await this.init();
    const record = {
      id: task.id || `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      pageKey,
      // 保存完整的任务数据
      taskId: task.taskId,
      prompt: task.prompt,
      fileName: task.fileName,
      status: task.status,
      videoUrl: task.videoUrl,
      model: task.model,
      images: task.images || [],
      totalCount: task.totalCount || task.images?.length || 0,
      createdAt: task.createdAt || Date.now()
    };

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.STORES.HISTORY], 'readwrite');
      const request = tx.objectStore(this.STORES.HISTORY).put(record);
      request.onsuccess = () => {
        // 清除该页面的任务缓存
        this._taskCache.delete(`tasks_${pageKey}`);
        this._pruneHistory(pageKey).catch(console.warn);
        resolve(record.id);
      };
      request.onerror = () => reject(request.error);
    });
  },

  async getTasks(pageKey) {
    const cacheKey = `tasks_${pageKey}`;
    
    // 检查内存缓存
    const cached = this._taskCache.get(cacheKey);
    if (cached && Date.now() - cached.time < 10000) { // 10秒缓存
      return cached.data;
    }

    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.STORES.HISTORY], 'readonly');
      const index = tx.objectStore(this.STORES.HISTORY).index('pageKey');
      const request = index.getAll(pageKey);

      request.onsuccess = () => {
        const tasks = (request.result || []).sort((a, b) => b.createdAt - a.createdAt);
        // 存入内存缓存
        this._taskCache.set(cacheKey, { data: tasks, time: Date.now() });
        resolve(tasks);
      };
      request.onerror = () => reject(request.error);
    });
  },

  async deleteTask(taskId) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.STORES.HISTORY], 'readwrite');
      const request = tx.objectStore(this.STORES.HISTORY).delete(taskId);
      request.onsuccess = () => {
        // 清除所有任务缓存
        this._taskCache.keys().forEach(k => {
          if (k.startsWith('tasks_')) this._taskCache.delete(k);
        });
        resolve(true);
      };
      request.onerror = () => reject(request.error);
    });
  },

  /**
   * 删除任务中的单张图片
   * @param {string} taskId - 任务ID
   * @param {number} imageIndex - 图片在 images 数组中的索引
   * @returns {Promise<boolean>} - 如果任务被完全删除返回 true
   */
  async deleteTaskImage(taskId, imageIndex) {
    await this.init();
    
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.STORES.HISTORY], 'readwrite');
      const store = tx.objectStore(this.STORES.HISTORY);
      const getRequest = store.get(taskId);
      
      getRequest.onsuccess = () => {
        const task = getRequest.result;
        if (!task) {
          resolve(false);
          return;
        }
        
        // 如果只有一张图片或没有图片数组，删除整个任务
        if (!task.images || task.images.length <= 1) {
          const deleteRequest = store.delete(taskId);
          deleteRequest.onsuccess = () => {
            this._taskCache.keys().forEach(k => {
              if (k.startsWith('tasks_')) this._taskCache.delete(k);
            });
            resolve(true);
          };
          deleteRequest.onerror = () => reject(deleteRequest.error);
          return;
        }
        
        // 删除指定索引的图片
        task.images.splice(imageIndex, 1);
        task.totalCount = task.images.length;
        
        const putRequest = store.put(task);
        putRequest.onsuccess = () => {
          this._taskCache.keys().forEach(k => {
            if (k.startsWith('tasks_')) this._taskCache.delete(k);
          });
          resolve(false);
        };
        putRequest.onerror = () => reject(putRequest.error);
      };
      
      getRequest.onerror = () => reject(getRequest.error);
    });
  },

  async _pruneHistory(pageKey) {
    const tasks = await this.getTasks(pageKey);
    if (tasks.length <= this.MAX_HISTORY_TASKS) return;
    const toDelete = tasks.slice(this.MAX_HISTORY_TASKS);
    for (const task of toDelete) {
      await this.deleteTask(task.id);
    }
  },

  // ==================== 通用缓存（使用批量队列） ====================

  async setCache(key, value, ttl = undefined) {
    // ttl: undefined = 使用默认过期时间, null = 永不过期, 数字 = 指定毫秒
    const entry = {
      key,
      value,
      timestamp: Date.now(),
      ttl: ttl === undefined ? this.EXPIRY.CACHE : ttl
    };

    // 立即更新内存缓存
    this._memCache.set(key, entry);

    // 直接写入 IndexedDB（不使用队列，确保数据不丢失）
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.STORES.CACHE], 'readwrite');
      const request = tx.objectStore(this.STORES.CACHE).put(entry);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  },

  async getCache(key, defaultValue = null) {
    // 先查内存缓存
    const memEntry = this._memCache.get(key);
    if (memEntry) {
      if (!memEntry.ttl || (Date.now() - memEntry.timestamp <= memEntry.ttl)) {
        return memEntry.value;
      }
      this._memCache.delete(key);
    }

    // 查 IndexedDB
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.STORES.CACHE], 'readonly');
      const request = tx.objectStore(this.STORES.CACHE).get(key);

      request.onsuccess = () => {
        const entry = request.result;
        if (entry) {
          if (!entry.ttl || (Date.now() - entry.timestamp <= entry.ttl)) {
            // 存入内存缓存
            this._memCache.set(key, entry);
            resolve(entry.value);
            return;
          }
        }
        resolve(defaultValue);
      };
      request.onerror = () => reject(request.error);
    });
  },

  async removeCache(key) {
    this._memCache.delete(key);
    
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.STORES.CACHE], 'readwrite');
      const request = tx.objectStore(this.STORES.CACHE).delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  },

  // ==================== 清理（每12小时执行一次） ====================

  async cleanup() {
    await this.init();
    const now = Date.now();
    let cleaned = { personal: 0, history: 0, cache: 0 };

    // 清理个人空间
    try {
      const tx1 = this.db.transaction([this.STORES.PERSONAL], 'readwrite');
      const store1 = tx1.objectStore(this.STORES.PERSONAL);
      const req1 = store1.openCursor();
      
      await new Promise((resolve) => {
        req1.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            if (now - cursor.value.createdAt > this.EXPIRY.PERSONAL) {
              cursor.delete();
              cleaned.personal++;
            }
            cursor.continue();
          } else {
            resolve();
          }
        };
        req1.onerror = () => resolve();
      });
    } catch (e) {
      console.warn('清理个人空间失败:', e);
    }

    // 清理任务历史
    try {
      const tx2 = this.db.transaction([this.STORES.HISTORY], 'readwrite');
      const store2 = tx2.objectStore(this.STORES.HISTORY);
      const req2 = store2.openCursor();
      
      await new Promise((resolve) => {
        req2.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            if (now - cursor.value.createdAt > this.EXPIRY.HISTORY) {
              cursor.delete();
              cleaned.history++;
            }
            cursor.continue();
          } else {
            resolve();
          }
        };
        req2.onerror = () => resolve();
      });
    } catch (e) {
      console.warn('清理任务历史失败:', e);
    }

    // 清理过期缓存
    try {
      const tx3 = this.db.transaction([this.STORES.CACHE], 'readwrite');
      const store3 = tx3.objectStore(this.STORES.CACHE);
      const req3 = store3.openCursor();
      
      await new Promise((resolve) => {
        req3.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            const entry = cursor.value;
            if (entry.ttl && (now - entry.timestamp > entry.ttl)) {
              cursor.delete();
              cleaned.cache++;
            }
            cursor.continue();
          } else {
            resolve();
          }
        };
        req3.onerror = () => resolve();
      });
    } catch (e) {
      console.warn('清理缓存失败:', e);
    }

    // 清空内存缓存
    this._memCache.clear();
    this._taskCache.clear();
    this._personalCache.clear();

    console.log(`[DuuDB] 清理完成: 个人空间 ${cleaned.personal}, 历史 ${cleaned.history}, 缓存 ${cleaned.cache}`);
    return cleaned;
  },

  async clearAll() {
    await this.init();
    const stores = Object.values(this.STORES);
    const tx = this.db.transaction(stores, 'readwrite');
    for (const name of stores) {
      tx.objectStore(name).clear();
    }
    
    // 清空内存缓存
    this._memCache.clear();
    this._taskCache.clear();
    this._personalCache.clear();
  },

  // 强制刷新写入队列
  async flush() {
    return this._writeQueue.flush();
  }
};

// ==================== 兼容旧 API ====================
const DuuStorage = {
  saveImage: (apiKey, data, title, source) => DuuDB.saveImage(apiKey, data, title, source),
  saveVideo: (apiKey, data, title, source) => DuuDB.saveVideo(apiKey, data, title, source),
  getRecords: (apiKey) => DuuDB.getPersonalRecords(apiKey),
  delete: (id) => DuuDB.deletePersonal(id)
};

const HistoryDB = {
  saveTask: (pageKey, task) => DuuDB.saveTask(pageKey, task),
  getTasks: (pageKey) => DuuDB.getTasks(pageKey),
  deleteTask: (taskId) => DuuDB.deleteTask(taskId)
};

class CacheManager {
  constructor(namespace) {
    this.namespace = namespace;
  }
  async set(key, value, options = {}) {
    return DuuDB.setCache(`${this.namespace}:${key}`, value, options.ttl);
  }
  async get(key, defaultValue = null) {
    return DuuDB.getCache(`${this.namespace}:${key}`, defaultValue);
  }
  async remove(key) {
    return DuuDB.removeCache(`${this.namespace}:${key}`);
  }
}

// 页面关闭前刷新队列
window.addEventListener('beforeunload', () => {
  DuuDB.flush();
});

window.DuuDB = DuuDB;
window.DuuStorage = DuuStorage;
window.HistoryDB = HistoryDB;
window.CacheManager = CacheManager;
