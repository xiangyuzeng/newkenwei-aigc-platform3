/**
 * 公告组件 - 换行用 <br>
 */
(function() {
    var config = {
        enabled: true,
        type: "info",
        title: "亲爱的小助手用户",
        content: '您好！当您点击"小助手"的那一刻，便开启了我们彼此陪伴的旅程。在此，小助手团队向每一位选择我们、信任我们的伙伴，致以最诚挚的感谢与最衷心的敬意！<br><br>感恩您在众多选择中，将信任托付于小助手。我们深知，每一次选择的背后，都是对服务品质的期待、对合作共赢的期许。从您注册API站，打开小助手，开始使用每项功能时，我们始终以"用户至上"为核心，致力于提供稳定、高效、省心的一站式服务——无论是安全可靠的技术支撑、简洁易用的操作后台，还是及时响应的客服团队、持续迭代的功能优化，我们都在全力以赴，只为不辜负您的每一份信任。',
        link: "",
        linkText: "",
        updatedAt: "2026-01-03"
    };

    var KEY = 'duu_announcement_read';
    var icons = { info: '📢', warning: '⚠️', error: '🚨', success: '🎉' };

    function show() {
        if (!config.enabled) return;
        if (localStorage.getItem(KEY) === config.updatedAt) return;

        var css = document.createElement('style');
        css.textContent = '.ann-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center}.ann-box{background:#fff;border-radius:16px;width:90%;max-width:600px;max-height:85vh;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.3)}.ann-head{padding:24px 28px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;gap:12px;background:linear-gradient(135deg,#dbeafe,#bfdbfe)}.ann-head.warning{background:linear-gradient(135deg,#fef3c7,#fde68a)}.ann-head.error{background:linear-gradient(135deg,#fee2e2,#fecaca)}.ann-head.success{background:linear-gradient(135deg,#d1fae5,#a7f3d0)}.ann-icon{font-size:32px}.ann-title{font-size:20px;font-weight:600;color:#1e293b}.ann-body{padding:28px;font-size:16px;line-height:2;color:#475569;max-height:400px;overflow-y:auto}.ann-date{font-size:13px;color:#94a3b8;margin-top:20px}.ann-foot{padding:20px 28px;border-top:1px solid #e5e7eb;display:flex;gap:12px;justify-content:flex-end}.ann-btn{padding:12px 24px;border-radius:8px;font-size:15px;font-weight:500;cursor:pointer;border:none}.ann-later{background:#f1f5f9;color:#64748b}.ann-ok{background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff}';
        document.head.appendChild(css);

        var div = document.createElement('div');
        div.className = 'ann-overlay';
        div.innerHTML = '<div class="ann-box"><div class="ann-head ' + config.type + '"><span class="ann-icon">' + (icons[config.type] || '📢') + '</span><span class="ann-title">' + config.title + '</span></div><div class="ann-body">' + config.content + '<div class="ann-date">发布时间：' + config.updatedAt + '</div></div><div class="ann-foot"><button class="ann-btn ann-later">下次再看</button><button class="ann-btn ann-ok">已知晓</button></div></div>';

        div.querySelector('.ann-later').onclick = function() { div.remove(); };
        div.querySelector('.ann-ok').onclick = function() { localStorage.setItem(KEY, config.updatedAt); div.remove(); };

        document.body.appendChild(div);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', show);
    } else {
        show();
    }
})();
