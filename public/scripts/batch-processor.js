/**
 * Duu小助手 - 批量处理工具
 *
 * 该文件为前端页面提供：
 * - BatchProcessor：并发执行任务队列，支持暂停/继续
 * - ProgressBar：简单的进度条 UI 组件
 * - BatchTaskState：断点续传状态（localStorage）
 * - showResumePrompt：检测到未完成任务时的提示
 *
 * 说明：
 * - 任务对象格式：{ fileName?: string, execIndex?: number, execute: () => Promise<any>, ... }
 * - 页面会通过 new BatchProcessor({...}).process(tasks) 使用
 */

(function (global) {
  'use strict';

  /**
   * 批量任务处理器（并发 + 暂停/继续）
   */
  class BatchProcessor {
    constructor(options = {}) {
      const {
        maxConcurrent = 5,
        onProgress = null,
        onTaskComplete = null,
        onError = null,
        onComplete = null
      } = options;

      this.maxConcurrent = Math.max(1, Number(maxConcurrent) || 1);

      this.onProgress = typeof onProgress === 'function' ? onProgress : null;
      this.onTaskComplete = typeof onTaskComplete === 'function' ? onTaskComplete : null;
      this.onError = typeof onError === 'function' ? onError : null;
      this.onComplete = typeof onComplete === 'function' ? onComplete : null;

      this._paused = false;
      this._pausePromise = null;
      this._resumeResolver = null;

      this._running = false;
    }

    isPaused() {
      return !!this._paused;
    }

    pause() {
      if (this._paused) return;
      this._paused = true;
      if (!this._pausePromise) {
        this._pausePromise = new Promise((resolve) => {
          this._resumeResolver = resolve;
        });
      }
    }

    resume() {
      if (!this._paused) return;
      this._paused = false;
      if (this._resumeResolver) {
        this._resumeResolver();
      }
      this._pausePromise = null;
      this._resumeResolver = null;
    }

    async _waitWhilePaused() {
      while (this._paused) {
        // eslint-disable-next-line no-await-in-loop
        await (this._pausePromise || Promise.resolve());
      }
    }

    /**
     * 处理任务队列
     * @param {Array} tasks
     * @returns {Promise<{total:number, completed:number, succeeded:number, failed:number, results:any[], errors:any[]}>}
     */
    async process(tasks = []) {
      if (this._running) {
        throw new Error('BatchProcessor 正在运行中，请等待完成后再启动新的批处理。');
      }
      this._running = true;

      const list = Array.isArray(tasks) ? tasks.slice() : [];
      const total = list.length;

      let completed = 0;
      let succeeded = 0;
      let failed = 0;

      const results = new Array(total);
      const errors = new Array(total);

      // 为避免并发竞争，使用共享索引分发任务
      let nextIndex = 0;

      const emitProgress = (currentFileName, idxForCb) => {
        if (!this.onProgress) return;
        try {
          this.onProgress({
            total,
            completed,
            succeeded,
            failed,
            fileName: currentFileName,
            index: idxForCb,
            percent: total ? Math.round((completed / total) * 100) : 100
          });
        } catch (_) {
          // ignore
        }
      };

      const emitTaskComplete = (payload) => {
        if (!this.onTaskComplete) return;
        try { this.onTaskComplete(payload); } catch (_) { /* ignore */ }
      };

      const emitError = (payload) => {
        if (!this.onError) return;
        try { this.onError(payload); } catch (_) { /* ignore */ }
      };

      const runOne = async (task, i) => {
        const fileName = (task && task.fileName) ? String(task.fileName) : `任务 ${i + 1}`;
        const cbIndex = (task && typeof task.execIndex === 'number') ? task.execIndex : i;

        try {
          if (!task || typeof task.execute !== 'function') {
            throw new Error('任务缺少 execute() 方法');
          }

          const result = await task.execute();
          results[i] = result;
          succeeded += 1;

          emitTaskComplete({
            index: cbIndex,
            success: true,
            result,
            fileName,
            task
          });

          return { ok: true, result };
        } catch (error) {
          errors[i] = error;
          failed += 1;

          emitError({
            index: cbIndex,
            error,
            fileName,
            task
          });

          emitTaskComplete({
            index: cbIndex,
            success: false,
            error,
            fileName,
            task
          });

          return { ok: false, error };
        } finally {
          completed += 1;
          emitProgress(fileName, cbIndex);
        }
      };

      const worker = async () => {
        while (true) {
          // eslint-disable-next-line no-await-in-loop
          await this._waitWhilePaused();

          const i = nextIndex;
          nextIndex += 1;
          if (i >= total) break;

          // eslint-disable-next-line no-await-in-loop
          await runOne(list[i], i);
        }
      };

      try {
        const workerCount = Math.min(this.maxConcurrent, total || 1);
        const workers = Array.from({ length: workerCount }, () => worker());
        await Promise.all(workers);

        const summary = { total, completed, succeeded, failed, results, errors };

        if (this.onComplete) {
          try { this.onComplete(summary); } catch (_) { /* ignore */ }
        }

        return summary;
      } finally {
        this._running = false;
      }
    }
  }

  /**
   * 简易进度条组件
   * 使用方式：const bar = new ProgressBar('container-id');
   */
  class ProgressBar {
    constructor(containerId) {
      this.containerId = containerId;
      this.container = null;

      this.onRetry = null;

      this._init();
    }

    _init() {
      const el = document.getElementById(this.containerId);
      if (!el) return;
      this.container = el;

      // 仅初始化一次
      if (this.container.dataset.inited === '1') return;
      this.container.dataset.inited = '1';

      this.container.innerHTML = `
        <div class="progress-wrap" style="display:flex; flex-direction:column; gap:10px; padding:12px; border:1px solid rgba(148,163,184,.35); border-radius:12px; background:rgba(15,23,42,.04);">
          <div class="progress-head" style="display:flex; justify-content:space-between; align-items:center; gap:10px;">
            <div class="progress-text" style="font-size:13px; color:#334155;">
              <span data-role="progress-label">准备中...</span>
            </div>
            <div class="progress-count" style="font-size:12px; color:#64748b;">
              <span data-role="progress-count">0/0</span>
            </div>
          </div>
          <div class="progress-track">
            <div class="progress-bar" data-role="progress-bar"></div>
          </div>
          <div class="progress-actions" data-role="actions" style="display:none; gap:10px; align-items:center;">
            <button data-role="retry" type="button" style="padding:8px 12px; border-radius:10px; border:1px solid rgba(148,163,184,.6); background:#fff; cursor:pointer; font-size:12px;">重试失败项</button>
            <button data-role="hide" type="button" style="padding:8px 12px; border-radius:10px; border:1px solid rgba(148,163,184,.6); background:#fff; cursor:pointer; font-size:12px;">收起</button>
          </div>
          <div class="progress-failed" data-role="failed" style="display:none; border-top:1px dashed rgba(148,163,184,.4); padding-top:10px;">
            <div style="font-size:12px; color:#b91c1c; margin-bottom:6px;">失败列表</div>
            <div data-role="failed-list" style="display:flex; flex-direction:column; gap:6px; font-size:12px; color:#475569;"></div>
          </div>
        </div>
      `;

      const retryBtn = this.container.querySelector('[data-role="retry"]');
      const hideBtn = this.container.querySelector('[data-role="hide"]');
      if (retryBtn) {
        retryBtn.addEventListener('click', () => {
          if (typeof this.onRetry === 'function') {
            const failedItems = this._lastFailedItems || [];
            this.onRetry(failedItems);
          }
        });
      }
      if (hideBtn) {
        hideBtn.addEventListener('click', () => {
          this.container.style.display = 'none';
        });
      }
    }

    show() {
      if (!this.container) this._init();
      if (!this.container) return;
      this.container.style.display = '';
      const wrap = this.container.querySelector('.progress-wrap');
      if (wrap) wrap.style.display = '';
    }

    reset() {
      if (!this.container) this._init();
      if (!this.container) return;

      this._setLabel('准备中...');
      this._setCount(0, 0);
      this._setPercent(0);

      const actions = this.container.querySelector('[data-role="actions"]');
      const failed = this.container.querySelector('[data-role="failed"]');
      if (actions) actions.style.display = 'none';
      if (failed) failed.style.display = 'none';

      const list = this.container.querySelector('[data-role="failed-list"]');
      if (list) list.innerHTML = '';

      this._lastFailedItems = [];
    }

    update(progress) {
      if (!this.container) this._init();
      if (!this.container) return;

      const total = Number(progress?.total || 0);
      const completed = Number(progress?.completed || 0);
      const fileName = progress?.fileName ? String(progress.fileName) : '';

      this._setLabel(fileName ? `处理中：${fileName}` : '处理中...');
      this._setCount(completed, total);

      const pct = total ? Math.min(100, Math.max(0, Math.round((completed / total) * 100))) : 0;
      this._setPercent(pct);
    }

    complete(summary, failedItems = []) {
      if (!this.container) this._init();
      if (!this.container) return;

      const total = Number(summary?.total || 0);
      const succeeded = Number(summary?.succeeded || 0);
      const failed = Number(summary?.failed || 0);
      const completed = Number(summary?.completed || succeeded + failed);

      this._setCount(completed, total);
      this._setPercent(total ? Math.round((completed / total) * 100) : 100);

      if (failed > 0) {
        this._setLabel(`完成：成功 ${succeeded}，失败 ${failed}`);
      } else {
        this._setLabel(`完成：成功 ${succeeded}`);
      }

      // 显示失败列表与操作按钮
      const actions = this.container.querySelector('[data-role="actions"]');
      const failedWrap = this.container.querySelector('[data-role="failed"]');
      const list = this.container.querySelector('[data-role="failed-list"]');

      this._lastFailedItems = Array.isArray(failedItems) ? failedItems : [];

      if (failed > 0 && list) {
        list.innerHTML = '';
        this._lastFailedItems.slice(0, 200).forEach((item) => {
          const name = item?.fileName || item?.name || '未知文件';
          const msg = item?.error || item?.message || '失败';
          const row = document.createElement('div');
          row.textContent = `${name}：${msg}`;
          list.appendChild(row);
        });
        if (failedWrap) failedWrap.style.display = '';
      } else {
        if (failedWrap) failedWrap.style.display = 'none';
      }

      const canRetry = failed > 0 && typeof this.onRetry === 'function';
      if (actions) {
        actions.style.display = canRetry ? 'flex' : 'none';
      }
    }

    _setLabel(text) {
      const el = this.container?.querySelector('[data-role="progress-label"]');
      if (el) el.textContent = text;
    }

    _setCount(done, total) {
      const el = this.container?.querySelector('[data-role="progress-count"]');
      if (el) el.textContent = `${done}/${total}`;
    }

    _setPercent(pct) {
      const bar = this.container?.querySelector('[data-role="progress-bar"]');
      if (bar) bar.style.width = `${pct}%`;
    }
  }

  /**
   * 断点续传状态管理（localStorage）
   */
  class BatchTaskState {
    constructor(pageKey) {
      this.pageKey = String(pageKey || 'default');
      this.storageKey = `duu_batch_task_state_${this.pageKey}`;
      this.expiryMs = 12 * 60 * 60 * 1000; // 默认 12h
      this.version = 1;
    }

    _now() {
      return Date.now();
    }

    getState() {
      try {
        const raw = localStorage.getItem(this.storageKey);
        if (!raw) return null;
        const state = JSON.parse(raw);

        // 过期检查
        if (state && state.updatedAt && (this._now() - state.updatedAt > this.expiryMs)) {
          this.clear();
          return null;
        }

        // 版本检查
        if (state && typeof state.version === 'number' && state.version !== this.version) {
          // 版本不一致直接清理，避免结构不兼容
          this.clear();
          return null;
        }

        return state || null;
      } catch {
        return null;
      }
    }

    save(partialState) {
      const state = partialState || {};
      const payload = {
        version: this.version,
        updatedAt: this._now(),
        pendingFiles: Array.isArray(state.pendingFiles) ? state.pendingFiles : [],
        completedFiles: Array.isArray(state.completedFiles) ? state.completedFiles : [],
        failedFiles: Array.isArray(state.failedFiles) ? state.failedFiles : [],
        options: state.options || {}
      };
      try {
        localStorage.setItem(this.storageKey, JSON.stringify(payload));
      } catch {
        // ignore
      }
      return payload;
    }

    clear() {
      try { localStorage.removeItem(this.storageKey); } catch { /* ignore */ }
    }

    hasPending() {
      const state = this.getState();
      if (!state) return false;
      const pending = Array.isArray(state.pendingFiles) ? state.pendingFiles.length : 0;
      const completed = Array.isArray(state.completedFiles) ? state.completedFiles.length : 0;
      // 只要还有未完成就算 pending
      return pending > 0 && completed < pending;
    }

    /**
     * 校验本次选择的文件是否与上次任务一致
     * @param {File[]} files
     */
    matchFiles(files = []) {
      const state = this.getState();
      if (!state || !Array.isArray(state.pendingFiles) || state.pendingFiles.length === 0) return false;

      const current = Array.isArray(files) ? files : [];
      if (current.length === 0) return false;

      // 使用 name + size + lastModified 进行匹配
      const toKey = (f) => `${f.name}__${f.size}__${f.lastModified}`;
      const expectedSet = new Set(state.pendingFiles.map((f) => `${f.name}__${f.size}__${f.lastModified}`));
      const currentSet = new Set(current.map(toKey));

      // 允许 current 包含更多文件（比如用户多选了），但至少要包含 expected 的全部
      for (const k of expectedSet) {
        if (!currentSet.has(k)) return false;
      }
      return true;
    }

    /**
     * 过滤出未完成的文件（包含失败项）
     * @param {File[]} files
     */
    filterPending(files = []) {
      const state = this.getState();
      if (!state) return Array.isArray(files) ? files : [];

      const completed = new Set(Array.isArray(state.completedFiles) ? state.completedFiles : []);
      const arr = Array.isArray(files) ? files : [];
      return arr.filter((f) => !completed.has(f.name));
    }

    markCompleted(fileName) {
      const state = this.getState();
      if (!state) return;

      const name = String(fileName || '');
      if (!name) return;

      const completed = new Set(Array.isArray(state.completedFiles) ? state.completedFiles : []);
      completed.add(name);
      state.completedFiles = Array.from(completed);

      // 从失败列表移除
      if (Array.isArray(state.failedFiles)) {
        state.failedFiles = state.failedFiles.filter((f) => f && f.fileName !== name && f.name !== name);
      }

      state.updatedAt = this._now();
      try { localStorage.setItem(this.storageKey, JSON.stringify(state)); } catch { /* ignore */ }
    }

    markFailed(fileName, errorMessage) {
      const state = this.getState();
      if (!state) return;

      const name = String(fileName || '');
      if (!name) return;

      const msg = (errorMessage == null) ? '失败' : String(errorMessage);

      const failed = Array.isArray(state.failedFiles) ? state.failedFiles.slice() : [];
      const idx = failed.findIndex((f) => (f && (f.fileName === name || f.name === name)));
      const item = { fileName: name, error: msg };
      if (idx >= 0) {
        failed[idx] = { ...failed[idx], ...item };
      } else {
        failed.push(item);
      }
      state.failedFiles = failed;

      state.updatedAt = this._now();
      try { localStorage.setItem(this.storageKey, JSON.stringify(state)); } catch { /* ignore */ }
    }
  }

  /**
   * 断点续传提示
   * @param {BatchTaskState} stateManager
   * @param {(state:any)=>void} onResume
   * @param {()=>void} onRestart
   */
  function showResumePrompt(stateManager, onResume, onRestart) {
    try {
      if (!stateManager || typeof stateManager.getState !== 'function') {
        if (typeof onRestart === 'function') onRestart();
        return;
      }
      const state = stateManager.getState();
      if (!state) {
        if (typeof onRestart === 'function') onRestart();
        return;
      }
      const total = Array.isArray(state.pendingFiles) ? state.pendingFiles.length : 0;
      const completed = Array.isArray(state.completedFiles) ? state.completedFiles.length : 0;
      const failed = Array.isArray(state.failedFiles) ? state.failedFiles.length : 0;
      const remaining = Math.max(0, total - completed);

      const ok = window.confirm(`检测到上次未完成任务：总计 ${total} 项，已完成 ${completed} 项，失败 ${failed} 项，剩余 ${remaining} 项。\n\n是否继续处理剩余任务？\n\n【确定】继续  /  【取消】重新开始`);
      if (ok) {
        if (typeof onResume === 'function') onResume(state);
      } else {
        stateManager.clear();
        if (typeof onRestart === 'function') onRestart();
      }
    } catch (e) {
      if (typeof onRestart === 'function') onRestart();
    }
  }

  // 导出到全局
  global.BatchProcessor = BatchProcessor;
  global.ProgressBar = ProgressBar;
  global.BatchTaskState = BatchTaskState;
  global.showResumePrompt = showResumePrompt;

  // CommonJS 导出（便于本地测试）
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { BatchProcessor, ProgressBar, BatchTaskState, showResumePrompt };
  }
})(typeof window !== 'undefined' ? window : globalThis);
