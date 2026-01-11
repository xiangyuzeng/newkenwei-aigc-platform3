/**
 * Duu小助手 - 图片服务器 API 客户端
 * 
 * 用于前端页面调用后端存储服务
 * 支持账号登录和 API Key 两种模式
 */

const ImageServer = {
  // 服务器地址
  baseUrl: (typeof window !== 'undefined' && window.location && window.location.origin && window.location.origin !== 'null' ? window.location.origin : 'http://localhost:3000'),

  /**
   * 设置服务器地址
   */
  setBaseUrl(url) {
    this.baseUrl = url.replace(/\/$/, '');
  },

  /**
   * 获取认证 headers
   */
  getAuthHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    
    // 优先使用账号 token
    if (typeof DuuAuth !== 'undefined' && DuuAuth.isLoggedIn()) {
      const token = DuuAuth.getToken();
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    }
    
    return headers;
  },

  /**
   * 检查是否应该保存到云端
   * 只有登录用户才保存到云端
   */
  shouldSaveToCloud() {
    if (typeof DuuAuth !== 'undefined') {
      return DuuAuth.isLoggedIn();
    }
    return false;
  },

  /**
   * 保存生成记录和图片
   * @param {string} apiKey - 用户的 API Key（游客模式不使用）
   * @param {string} prompt - 提示词
   * @param {Array} images - 图片数组
   * @param {string} model - 使用的模型
   * @param {string} sourceType - 来源类型
   */
  async saveGeneration(apiKey, prompt, images, model = '', sourceType = 'text') {
    // 游客模式不保存到云端
    if (!this.shouldSaveToCloud()) {
      console.log('未登录，跳过云端保存');
      return { success: true, skipped: true };
    }
    
    try {
      console.log('ImageServer.saveGeneration 调用:', { model, imageCount: images?.length });
      
      const response = await fetch(`${this.baseUrl}/api/generations`, {
        method: 'POST',
        headers: this.getAuthHeaders(),
        body: JSON.stringify({
          apiKey,
          prompt,
          model,
          sourceType,
          images: images.map(img => {
            if (typeof img === 'string') {
              if (img.startsWith('data:')) {
                return { base64: img };
              } else {
                return { url: img };
              }
            }
            if (img.data && img.mimeType) {
              return { base64: `data:${img.mimeType};base64,${img.data}` };
            }
            if (img.base64) {
              return { base64: img.base64 };
            }
            if (img.url) {
              return { url: img.url };
            }
            return img;
          })
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || '保存失败');
      }

      const result = await response.json();
      console.log('ImageServer.saveGeneration 成功:', result);
      return result;
    } catch (error) {
      console.error('ImageServer.saveGeneration 失败:', error);
      throw error;
    }
  },

  /**
   * 获取用户的生成历史
   */
  async getGenerations(apiKey, page = 1, pageSize = 20) {
    try {
      const params = new URLSearchParams({ page, pageSize });
      if (apiKey) params.append('apiKey', apiKey);
      
      const url = `${this.baseUrl}/api/generations?${params}`;
      
      const response = await fetch(url, {
        headers: this.getAuthHeaders()
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || '查询失败');
      }

      const data = await response.json();
      
      // 转换图片 URL 为完整路径
      if (data.generations && Array.isArray(data.generations)) {
        data.generations = data.generations.map(gen => ({
          ...gen,
          images: (gen.images || []).map(img => ({
            ...img,
            url: img.url && img.url.startsWith('http') ? img.url : `${this.baseUrl}${img.url}`
          }))
        }));
      }

      return data;
    } catch (error) {
      console.error('ImageServer.getGenerations 失败:', error);
      throw error;
    }
  },

  /**
   * 删除生成记录
   * @param {string} apiKey - 用户的 API Key
   * @param {string} generationId - 记录 ID
   */
  async deleteGeneration(apiKey, generationId) {
    try {
      const response = await fetch(
        `${this.baseUrl}/api/generations/${generationId}?apiKey=${encodeURIComponent(apiKey)}`,
        { method: 'DELETE' }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || '删除失败');
      }

      return await response.json();
    } catch (error) {
      console.error('ImageServer.deleteGeneration 失败:', error);
      throw error;
    }
  },

  /**
   * 获取用户统计
   * @param {string} apiKey - 用户的 API Key
   */
  async getStats(apiKey) {
    try {
      const response = await fetch(`${this.baseUrl}/api/stats?apiKey=${encodeURIComponent(apiKey)}`);

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || '获取统计失败');
      }

      return await response.json();
    } catch (error) {
      console.error('ImageServer.getStats 失败:', error);
      throw error;
    }
  },

  /**
   * 检查服务器是否可用
   */
  async checkHealth() {
    try {
      const response = await fetch(`${this.baseUrl}/api/health`);
      return response.ok;
    } catch {
      return false;
    }
  }
};

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ImageServer;
}
