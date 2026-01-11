# Kenwei AIGC Platform

AIGC (AI Generated Content) 视频/图像生成平台，支持 Sora、VEO、Kling 等多种 AI 模型。

## ✨ 功能特点

- **视频生成**: Sora 2/Pro, VEO 3/3.1, Kling 2.x 文生视频/图生视频
- **图像处理**: 印花提取、四图/十图参考、自定义模式、产品海报
- **AI 对话**: GPT, Claude, Gemini, DeepSeek, Grok, Kimi
- **统一网关**: 使用 KIE.AI 作为统一 API 网关
- **本地缓存**: IndexedDB 任务历史和设置缓存
- **响应式设计**: 支持桌面和移动端

## 🚀 快速部署

### Vercel 部署（推荐）

1. Fork 此仓库到你的 GitHub
2. 在 [Vercel](https://vercel.com) 导入项目
3. 配置环境变量（可选）:
   - `KIE_API_BASE`: KIE API 地址 (默认: https://api.kie.ai)
4. 点击部署

### 本地开发

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 访问 http://localhost:3000
```

### 云服务器部署 (腾讯云/华为云)

```bash
# 1. 克隆代码
git clone <your-repo-url>
cd kenwei-aigc

# 2. 安装依赖
npm install

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env 文件

# 4. 使用 PM2 启动
npm install -g pm2
pm2 start server.js --name kenwei-aigc

# 5. 配置 Nginx 反向代理 (参考 deploy/nginx-kenwei.conf)
```

## ⚙️ 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `KIE_API_BASE` | KIE API 网关地址 | https://api.kie.ai |
| `PORT` | 服务端口 | 3000 |
| `FETCH_TIMEOUT_MS` | API 请求超时 | 120000 (Vercel: 9000) |
| `MAX_UPLOAD_BYTES` | 最大上传大小 | 20971520 (20MB) |

## 🔑 使用方法

1. 获取 KIE.AI API Key: https://kie.ai
2. 在平台设置页面填入 API Key
3. 选择功能模块开始使用

## 📁 项目结构

```
├── api/
│   └── index.js          # Vercel serverless 入口
├── public/
│   ├── index.html        # 主页面
│   ├── sora/             # Sora 视频模块
│   ├── veo/              # VEO 视频模块
│   ├── kling-video/      # Kling 视频模块
│   ├── gemini/           # 图像处理模块
│   ├── zhinengti/        # AI 对话模块
│   ├── scripts/          # 前端脚本
│   └── styles/           # 样式文件
├── deploy/               # 部署配置
├── server.js             # Express 服务器
├── vercel.json           # Vercel 配置
└── package.json
```

## 🔧 API 端点

### 视频生成
- `POST /v1/videos` - 创建视频任务
- `GET /v1/videos/:taskId` - 查询任务状态

### Kling 视频
- `POST /kling/v1/videos/text2video` - 文生视频
- `POST /kling/v1/videos/image2video` - 图生视频

### 用量查询
- `GET /api/proxy/token/info` - 查询余额
- `GET /api/proxy/log/self` - 查询调用日志

### 健康检查
- `GET /api/health` - 服务健康状态
- `GET /api/health?check=kie` - 包含 KIE 连通性检查

## ⚠️ Vercel 限制

- **请求超时**: 免费版 10 秒，Pro 版 60 秒
- **请求体大小**: 最大 4.5MB
- **文件系统**: 只有 `/tmp` 可写

视频生成任务会立即返回任务 ID，前端通过轮询获取结果，不受超时限制。

## 📝 更新日志

### v1.1.0
- 优化 Vercel 部署配置
- 改进错误处理
- 添加健康检查端点
- 修复静态文件服务

### v1.0.0
- 初始版本
- 支持 Sora/VEO/Kling 视频生成
- KIE.AI 统一网关集成

## 📄 License

MIT License
