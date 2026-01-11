# Vercel quick test (USA)

This repo is designed for VM deployment (Tencent/Huawei etc.) and for Vercel serverless testing.

## Key differences on Vercel
- Vercel serverless filesystem is read-only except `/tmp`.
- In Vercel mode (`VERCEL=1`), the server defaults:
  - DATA_DIR -> /tmp/kenwei-data
  - UPLOADS_DIR -> /tmp/kenwei-uploads
- Uploaded images are served from `/uploads/*` (mapped to UPLOADS_DIR).

## Deploy steps (Vercel)
1) Push this repo to GitHub.
2) Import into Vercel.
3) Set **Environment Variables** in Vercel (optional):
   - `KIE_API_BASE` (default: https://api.kie.ai)
   - `FETCH_TIMEOUT_MS` (default: 9000 on Vercel)
   - `IMAGE_SYNC_MAX_WAIT_MS` (default: 9000 on Vercel)

> You usually do NOT need to set an API key as an env var: the UI stores your KIE API key locally and sends it as `Authorization: Bearer ...` on each request.

## Local run (optional)
```bash
npm install
npm run dev
```
Then open http://127.0.0.1:3000


## Important: Vercel payload limit (uploads/base64)
Vercel Functions enforce a max request/response payload size (commonly 4.5MB).
If you upload large images (especially base64), you may hit `413 FUNCTION_PAYLOAD_TOO_LARGE`.

Workarounds for testing:
- Use smaller images (or compress before upload).
- Prefer URL-based inputs (if the model/provider supports image URLs).
- For production-grade uploads, use an object storage / direct upload approach (Vercel Blob, S3, etc.), then pass URLs.

