# Kenwei AIGC - 中国大陆服务器部署指南（腾讯云 / 华为云）

> 目标：在中国大陆云服务器上更稳定地部署（不依赖 Google Fonts、jsDelivr、Cloudflare 等在国内可能不稳定的资源）。
>
> **本项目已改造为同源调用模式**：前端所有模型请求都会访问你的站点同域路径（如 `/v1/videos`、`/kling/v1/videos/*`、`/v1beta/models/*:generateContent`、`/v1/chat/completions`），然后由后端 `server.js` 统一调用 **KIE.AI API**（通过 `UPSTREAM_GATEWAY_BASE`/`KIE_API_BASE` 指定）。这样可以避免浏览器跨域问题，也便于你在中国网络环境下更换线路。

## 1) 前置条件

- 服务器：Ubuntu 22.04 / Debian 12 / CentOS 7+ 均可
- Node.js：建议 18 LTS+
- Nginx：建议作为反向代理（80/443）
- 域名：若服务器位于中国大陆，通常需要完成 ICP 备案后才能长期稳定对外访问

## 2) 部署步骤（最简）

### 2.1 上传代码

把项目上传到服务器，例如：`/opt/kenwei-aigc`

### 2.2 安装依赖

```bash
cd /opt/kenwei-aigc
npm config set registry https://registry.npmmirror.com
npm install --omit=dev
```

### 2.3 配置环境变量

复制示例配置：

```bash
cp deploy/.env.example .env
```

编辑 `.env`：

- `PORT=3000`（或任意未占用端口）
- `UPSTREAM_GATEWAY_BASE=https://api.kie.ai`（或你自建/镜像的 KIE 网关域名）

> 说明：本项目**不会**在前端硬编码网关域名，全部由服务器转发。

### 2.4 启动服务

```bash
npm start
```

建议生产环境用 PM2：

```bash
npm i -g pm2
pm2 start server.js --name kenwei-aigc
pm2 save
pm2 startup
```

## 3) Nginx 反向代理（推荐）

把 `deploy/nginx-kenwei.conf` 复制到服务器：

- `/etc/nginx/conf.d/kenwei.conf`

并修改：

- `server_name your-domain.com;` -> 你的域名
- `proxy_pass http://127.0.0.1:3000;` -> 你的 Node 端口

然后：

```bash
nginx -t
systemctl reload nginx
```

如需 HTTPS，请在腾讯云/华为云控制台申请证书或使用 ACME/Certbot。

## 4) 常见问题

### 4.1 上游网关在国内不稳定怎么办？

- 把 `UPSTREAM_GATEWAY_BASE` 指向 **更靠近中国网络** 的线路（例如香港/新加坡的网关）。
- 对于跨境链路，可以考虑使用云厂商的加速产品（例如腾讯云 GAAP、华为云全球加速）做网络优化。

### 4.2 我的用量页面无数据

`我的用量` 页面会调用同域 `/api/proxy/token/info`、`/api/proxy/log/self`。
只有当你的上游网关也提供这些接口时才会返回数据。

如果你的上游网关不提供该接口，你可以：
- 更换上游网关；或
- 在后端自行实现该接口（根据你选择的网关/供应商 API 文档适配）。
