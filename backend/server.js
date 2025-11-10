// Updated server.js (with Prisma initialization)
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createClient } from 'redis';
import winston from 'winston';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

// Load environment variables
dotenv.config();

// Import controllers (legacy - kept for backward compatibility)
import { initiateDiditVerification, diditWebhookHandler, diditHealth, checkVerificationStatus } from './controllers/diditAuthController.js';

// Import new verification routes
import verificationRoutes from './routes/verificationRoutes.js';

// Logger setup
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.simple(),
    }),
    // new winston.transports.File({ filename: 'error.log', level: 'error' }),
    // new winston.transports.File({ filename: 'combined.log' }),
  ],
});

// Export logger for use in controllers
export { logger };

// Prisma client (global for reuse)
const prisma = new PrismaClient();

// Redis client setup with auto-reconnect disabled for development
const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
  socket: {
    reconnectStrategy: false, // Disable auto-reconnect
  },
});

let redisConnected = false;

// Only log critical Redis errors, suppress connection attempts
redisClient.on('error', (err) => {
  if (redisConnected) {
    logger.error('Redis Client Error', err);
  }
});

// Connect to Redis with error handling
(async () => {
  try {
    await redisClient.connect();
    redisConnected = true;
    logger.info('✓ Redis connected');
  } catch (error) {
    logger.warn('⚠ Redis not available - running without session storage. To enable: start Redis server.', { error: error.message });
  }
})();

// Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());

// CORS configuration - allow multiple origins in development
const allowedOrigins = [
  'http://localhost:3001',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://127.0.0.1:3001',
];

if (process.env.FRONTEND_URL) {
  allowedOrigins.push(process.env.FRONTEND_URL);
}

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin) || process.env.NODE_ENV === 'development') {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Attach Redis and Prisma to app locals
app.locals.redis = redisClient;
app.locals.prisma = prisma;

// New Verification Routes (comprehensive API)
app.use('/api/v1/verification', verificationRoutes);

// Legacy Routes (backward compatibility)
app.post('/api/v1/didit/initiate', initiateDiditVerification);
app.post('/api/v1/didit/webhook', diditWebhookHandler);
app.get('/api/v1/didit/status/:userId', checkVerificationStatus);
app.get('/api/v1/didit/health', diditHealth);

// Health check
app.get('/health', async (req, res) => {
  try {
    await prisma.$connect();
    await prisma.$disconnect();
    res.status(200).json({ status: 'Server running', timestamp: new Date().toISOString(), db: 'connected' });
  } catch (error) {
    res.status(500).json({ status: 'Server running', db: 'error', error: error.message });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Start server
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  await prisma.$disconnect();
  if (redisConnected) {
    await redisClient.quit();
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  await prisma.$disconnect();
  if (redisConnected) {
    await redisClient.quit();
  }
  process.exit(0);
});