# Runbook — PPOS Preflight Service

## 📡 Service Overview
The `ppos-preflight-service` orchestrates PDF analysis and fixes between the product and the OS engine/worker.

---

## 🛠 Operation & Setup

### 1. Initial Setup
```bash
npm install
cp .env.example .env
npm start
```

### 2. Environment Variables
| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | Service port | `8001` |
| `ADMIN_API_KEY` | Key for authentication | Required |
| `LOG_LEVEL` | info, warn, error | `info` |

---

## 🚑 Health & Troubleshooting

### Health Check Endpoint
- **URL**: `GET /health`
- **Output**: Returns status, memory, uptime, and dependency status.

### Security (API Key Auth)
- All endpoints (except `/health`) require `x-api-key` header matching `ADMIN_API_KEY`.
- 401 response indicates a missing or invalid key.

### Common Issues
1. **Engine Not Found**: Ensure `@ppos/preflight-engine` is correctly linked in `package.json`.
2. **Storage Issue**: Verify `PPOS_UPLOADS_DIR` (or `temp-staging/`) is writable.

---

## 🚀 Deployment (Staging)
1. Ensure `NODE_ENV=production`.
2. Set `ADMIN_API_KEY` to a secure UUID.
3. Verify connectivity to the Job Queue (if async processing is enabled).
