/**
 * 统一网关 APIKey 管理工具（KIE.AI 统一 Key）
 *
 * ✅ 兼容旧页面：各模块仍会以 type=gemini/veo/sora/kling/... 调用
 * ✅ 但底层只存 1 份 key（gateway），所有模块共用同一个 KIE.AI APIKey
 */

const APIKEY_STORAGE_KEY = 'duu_global_apikeys';

window.DuuApiKeys = {
    /**
     * 获取指定类型的APIKey配置
     * @param {string} type - 'gemini' | 'gemini-ai' | 'veo' | 'sora' | 'claude' | 'gpt' | 'grok' | 'deepseek'
     * @returns {{primary: string, backup: string}}
     */
    get: (type) => {
        const allKeys = JSON.parse(localStorage.getItem(APIKEY_STORAGE_KEY) || '{}');
        // 统一网关：忽略 type，全部读取 gateway
        return allKeys.gateway || { primary: '', backup: '' };
    },

    /**
     * 获取首选APIKey
     * @param {string} type - 'gemini' | 'gemini-ai' | 'veo' | 'sora'
     * @returns {string}
     */
    getPrimary: (type) => {
        const keys = window.DuuApiKeys.get(type);
        return keys.primary || '';
    },

    /**
     * 获取备用APIKey
     * @param {string} type - 'gemini' | 'gemini-ai' | 'veo' | 'sora'
     * @returns {string}
     */
    getBackup: (type) => {
        const keys = window.DuuApiKeys.get(type);
        return keys.backup || '';
    },

    /**
     * 智能获取可用的APIKey
     * 优先返回首选Key，如果首选失败则返回备用Key
     * @param {string} type - 'gemini' | 'gemini-ai' | 'veo' | 'sora'
     * @param {boolean} primaryFailed - 首选Key是否已失败
     * @returns {string}
     */
    getAvailable: (type, primaryFailed = false) => {
        const keys = window.DuuApiKeys.get(type);
        if (primaryFailed && keys.backup) {
            return keys.backup;
        }
        return keys.primary || '';
    },

    /**
     * 检查是否有全局APIKey配置
     * @param {string} type - 'gemini' | 'gemini-ai' | 'veo' | 'sora'
     * @returns {boolean}
     */
    hasKey: (type) => {
        const keys = window.DuuApiKeys.get(type);
        return !!keys.primary;
    },

    /**
     * 获取APIKey（优先全局，否则使用传入的手动输入值）
     * @param {string} type - 'gemini' | 'gemini-ai' | 'veo' | 'sora'
     * @param {string} manualKey - 手动输入的APIKey
     * @returns {string}
     */
    resolve: (type, manualKey = '') => {
        const globalKey = window.DuuApiKeys.getPrimary('gateway');
        return globalKey || manualKey;
    },

    /**
     * 获取Gemini AI提示词润色的API端点
     * @param {string} apiKey - APIKey
     * @returns {string}
     */
    getGeminiAiEndpoint: (apiKey) => {
        // 旧页面会调用此方法来获取“润色提示词”的端点。
        // 在 KIE 适配版本中，我们在后端实现 /v1beta/... 的兼容层，因此这里继续返回同源路径即可。
        return `/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${encodeURIComponent(apiKey)}`;
    }
};

/**
 * 初始化模块的APIKey输入框
 * 如果有全局配置，自动填充并显示提示
 * @param {string} type - 'gemini' | 'veo' | 'sora'
 * @param {string} inputId - 输入框的ID
 */
window.initApiKeyInput = (type, inputId = 'credential') => {
    const input = document.getElementById(inputId);
    if (!input) return;

    const globalKey = window.DuuApiKeys.getPrimary('gateway');
    if (globalKey) {
        input.value = globalKey;
        input.placeholder = '已使用全局 KIE.AI APIKey（可在本地缓存中修改）';
        
        // 添加提示标签
        const helper = input.nextElementSibling;
        if (helper && helper.classList.contains('helper')) {
            const originalText = helper.textContent;
            helper.innerHTML = `<span style="color: #10b981; font-weight: 500;">✓ 已自动填充全局 KIE.AI APIKey</span> · ${originalText}`;
        }
    }
};

/**
 * 带自动重试的API调用
 * 首选Key失败时自动切换备用Key重试
 * @param {string} type - 'gemini' | 'gemini-ai' | 'veo' | 'sora'
 * @param {function} apiCall - API调用函数，接收apiKey参数，返回Promise
 * @param {string} manualKey - 手动输入的APIKey
 * @param {function} onRetry - 重试时的回调函数（可选）
 * @returns {Promise<any>}
 */
window.callWithRetry = async (type, apiCall, manualKey = '', onRetry = null) => {
    // 统一网关：忽略 type
    const keys = window.DuuApiKeys.get('gateway');
    const primaryKey = manualKey || keys.primary;
    const backupKey = keys.backup;

    if (!primaryKey) {
        throw new Error('请输入APIKey或在个人空间设置全局APIKey');
    }

    try {
        // 尝试首选Key
        return await apiCall(primaryKey);
    } catch (error) {
        const errorMsg = error.message || '';
        
        // 判断是否需要切换Key的错误类型
        const needRetry = errorMsg.includes('No available channels') || 
                          errorMsg.includes('分组') ||
                          errorMsg.includes('不可用') ||
                          errorMsg.includes('quota') ||
                          errorMsg.includes('rate limit') ||
                          errorMsg.includes('exceeded') ||
                          errorMsg.includes('invalid_api_key') ||
                          errorMsg.includes('401') ||
                          errorMsg.includes('403');
        
        // 如果有备用Key且需要重试
        if (backupKey && backupKey !== primaryKey && needRetry) {
            console.log('首选APIKey失败，尝试备用Key...', errorMsg);
            if (onRetry) onRetry();
            return await apiCall(backupKey);
        }
        throw error;
    }
};

/**
 * 检查错误是否需要切换Key
 * @param {string} errorMsg - 错误信息
 * @returns {boolean}
 */
window.shouldRetryWithBackup = (errorMsg) => {
    if (!errorMsg) return false;
    const retryKeywords = [
        'No available channels',
        '分组',
        '不可用',
        'quota',
        'rate limit',
        'exceeded',
        'invalid_api_key',
        '401',
        '403'
    ];
    return retryKeywords.some(keyword => errorMsg.includes(keyword));
};
