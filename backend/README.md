# Didit Verification Backend

Backend service for Didit identity verification integration with Prisma, Redis, and Express.

## Prerequisites

- Node.js 20+ (for local development)
- Docker & Docker Compose (for containerized deployment)

## Quick Start

### Docker Deployment (Recommended)

1. **Copy environment file:**
   ```bash
   cp .env.example .env
   ```

2. **Edit `.env` with your Didit credentials:**
   ```bash
   DIDIT_API_KEY=your_actual_api_key
   DIDIT_WORKFLOW_ID=your_actual_workflow_id
   DIDIT_WEBHOOK_SECRET=your_actual_webhook_secret
   ```

3. **Start services with Docker Compose:**
   ```bash
   docker-compose up -d
   ```

4. **Check service status:**
   ```bash
   docker-compose ps
   docker-compose logs -f backend
   ```

5. **Access the API:**
   - Backend: http://localhost:3000
   - Health check: http://localhost:3000/health
   - Redis: localhost:6379

### Local Development

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Generate Prisma Client:**
   ```bash
   npx prisma generate
   ```

3. **Run database migrations:**
   ```bash
   npx prisma migrate dev
   ```

4. **Start Redis (optional, required for session management):**
   ```bash
   redis-server
   ```

5. **Start development server:**
   ```bash
   npm run dev
   ```

## API Endpoints

### Health Check
```bash
GET /health
GET /api/v1/didit/health
```

### Initiate Verification
```bash
POST /api/v1/didit/initiate
Content-Type: application/json

{
  "userId": "550e8400-e29b-41d4-a716-446655440000"
}
```

### Webhook (Didit callback)
```bash
POST /api/v1/didit/webhook
```

### Check Verification Status
```bash
GET /api/v1/didit/status/:userId

# Example
GET /api/v1/didit/status/550e8400-e29b-41d4-a716-446655440000
```

**Response:**
```json
{
  "success": true,
  "data": {
    "userId": "550e8400-e29b-41d4-a716-446655440000",
    "kycStatus": "VERIFIED",
    "idVerified": true,
    "phoneVerified": true,
    "verificationRetries": 1,
    "retriesRemaining": 1,
    "lastAttempt": "2025-11-06T12:00:00.000Z",
    "tradingEnabled": true,
    "completedAt": "2025-11-06T12:05:00.000Z"
  }
}
```

## Docker Commands

### Build and start services
```bash
docker-compose up -d --build
```

### Stop services
```bash
docker-compose down
```

### View logs
```bash
docker-compose logs -f
docker-compose logs -f backend
docker-compose logs -f redis
```

### Restart a service
```bash
docker-compose restart backend
```

### Remove all containers and volumes
```bash
docker-compose down -v
```

### Access container shell
```bash
docker exec -it didit-backend sh
docker exec -it didit-redis redis-cli
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Environment (development/production) | `development` |
| `PORT` | Server port | `3000` |
| `REDIS_URL` | Redis connection URL | `redis://localhost:6379` |
| `APP_URL` | Backend URL for webhooks | `http://localhost:3000` |
| `FRONTEND_URL` | Frontend URL for CORS | `http://localhost:3001` |
| `DIDIT_API_KEY` | Didit API key | **Required** |
| `DIDIT_WORKFLOW_ID` | Didit workflow ID | **Required** |
| `DIDIT_WEBHOOK_SECRET` | Webhook signature secret | **Required** |
| `LOG_LEVEL` | Logging level (info/debug/warn/error) | `info` |

## Database

The application uses SQLite with Prisma ORM. The database file is stored at `prisma/dev.db`.

### View database
```bash
npx prisma studio
```

### Reset database
```bash
npx prisma migrate reset
```

## Architecture

```
┌─────────────────┐
│   Frontend      │
│  (Port 3001)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐      ┌─────────────────┐
│   Backend       │◄────►│     Redis       │
│  (Port 3000)    │      │  (Port 6379)    │
└────────┬────────┘      └─────────────────┘
         │
         │
         ▼
┌─────────────────┐      ┌─────────────────┐
│   SQLite DB     │      │   Didit API     │
│   (Prisma)      │      │ (verification)  │
└─────────────────┘      └─────────────────┘
```

## Troubleshooting

### Redis connection failed
If you see Redis connection errors but the server is running, Redis is optional for basic functionality. To enable full session management, ensure Redis is running.

### Prisma errors
```bash
# Regenerate Prisma Client
npx prisma generate

# Reset database
npx prisma migrate reset
```

### Docker build issues
```bash
# Clean rebuild
docker-compose down -v
docker-compose build --no-cache
docker-compose up -d
```

## Production Considerations

1. **Use PostgreSQL instead of SQLite** for production (update `prisma/schema.prisma`)
2. **Enable Redis persistence** (already configured in docker-compose)
3. **Set up proper secrets management** (don't commit `.env` file)
4. **Configure reverse proxy** (nginx/traefik) for SSL/TLS
5. **Monitor logs** and set up alerting
6. **Regular backups** of database and Redis data
7. **Rate limiting** is configured (5 requests/minute per user)

## License

MIT
