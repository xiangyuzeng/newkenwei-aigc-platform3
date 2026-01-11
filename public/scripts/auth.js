/**
 * auth.js (simplified)
 *
 * This project previously carried a "隐私模式 / 登录" concept.
 * Per your latest requirements, we REMOVE the "隐私模式" feature and
 * keep the app in a simple LOCAL mode:
 * - No login UI
 * - No cloud token
 * - Any "cloud" features in pages should be treated as unavailable
 *
 * If you later want to re-add account login, you can restore a real auth module.
 */

(function () {
  const DuuAuth = {
    isLoggedIn() {
      return false;
    },

    getToken() {
      return null;
    },

    async renderUserStatus() {
      const container = document.getElementById('userStatusContainer');
      if (!container) return;

      container.innerHTML = `
        <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;">
          <div style="width:36px;height:36px;min-width:36px;border-radius:50%;background:linear-gradient(135deg,#2563eb 0%,#8b5cf6 100%);display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px;">
            🧩
          </div>
          <div>
            <div style="font-size:14px;font-weight:700;color:#0f172a;">本地模式</div>
            <div style="font-size:12px;color:#64748b;">不启用登录功能。缓存与任务记录仅保存在本机浏览器。</div>
          </div>
        </div>
      `;
    },

    async init() {
      await this.renderUserStatus();
    }
  };

  window.DuuAuth = DuuAuth;

  document.addEventListener('DOMContentLoaded', () => {
    DuuAuth.init().catch(() => void 0);
  });
})();
