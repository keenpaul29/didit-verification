// Updated controllers/diditAuthController.js (with Prisma integration)
import axios from 'axios';
import rateLimit from 'express-rate-limit';
import { body, validationResult } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger.js'; // Winston or Pino logger
import { PrismaClient } from '@prisma/client';
import * as crypto from 'node:crypto';

// Prisma client
const prisma = new PrismaClient();

// Environment variables
const DIDIT_API_KEY = process.env.DIDIT_API_KEY;
const DIDIT_WORKFLOW_ID = process.env.DIDIT_WORKFLOW_ID;
const DIDIT_BASE_URL = 'https://verification.didit.me/v2';
const CALLBACK_URL = `${process.env.APP_URL}/api/v1/didit/webhook`;

// Rate limiter: 5 verification requests per minute per user
const diditLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  message: { error: 'Too many verification attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * POST /api/v1/didit/initiate
 * Initiates Didit verification session
 */
export const initiateDiditVerification = [
  // Rate limiting
  diditLimiter,

  // Input validation
  body('userId')
    .isUUID(4)
    .withMessage('Valid userId (UUID v4) is required'),

  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { userId } = req.body;
    const correlationId = uuidv4();

    try {
      logger.info('Initiating Didit verification', { userId, correlationId });

      // Ensure user exists in DB (create if not)
      let user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        user = await prisma.user.create({
          data: { id: userId, email: `${userId}@example.com` }, // Placeholder email
        });
        logger.info('Created new user for verification', { userId });
      }

      // Check retry limit (max 2 retries = 3 total attempts)
      const MAX_RETRIES = 2;
      if (user.verificationRetries >= MAX_RETRIES) {
        logger.warn('User exceeded verification retry limit', { 
          userId, 
          retries: user.verificationRetries 
        });
        return res.status(429).json({ 
          error: 'Maximum verification attempts exceeded',
          message: `You have reached the maximum number of verification attempts (${MAX_RETRIES}). Please contact support.`,
          retriesUsed: user.verificationRetries,
          maxRetries: MAX_RETRIES
        });
      }

      // Check if already verified
      if (user.kycStatus === 'VERIFIED') {
        logger.info('User already verified', { userId });
        return res.status(200).json({
          success: false,
          message: 'User is already verified',
          data: {
            idVerified: user.idVerified,
            phoneVerified: user.phoneVerified,
            kycStatus: user.kycStatus
          }
        });
      }

      const payload = {
        workflow_id: DIDIT_WORKFLOW_ID,
        vendor_data: userId, // Maps to your internal user ID
        callback: CALLBACK_URL,
        // Optional: Add redirect URLs for success/failure
        redirect_url_success: `${process.env.FRONTEND_URL}/verification/success`,
        redirect_url_failure: `${process.env.FRONTEND_URL}/verification/failed`,
        // Verification requirements - ID, Phone, and Liveness
        verification_types: {
          id_verification: true,      // Enable ID verification
          phone_verification: true,   // Enable phone verification
          liveness_check: true,        // Enable liveness detection
        },
      };

      const response = await axios.post(
        `${DIDIT_BASE_URL}/session/`,
        payload,
        {
          headers: {
            'accept': 'application/json',
            'content-type': 'application/json',
            'x-api-key': DIDIT_API_KEY,
          },
          timeout: 10_000,
        }
      );

      const { session_id, url } = response.data;

      // Increment retry counter and update last attempt timestamp
      await prisma.user.update({
        where: { id: userId },
        data: {
          verificationRetries: user.verificationRetries + 1,
          lastVerificationAttempt: new Date(),
        },
      });

      logger.info('User verification retry incremented', { 
        userId, 
        retryCount: user.verificationRetries + 1,
        retriesRemaining: MAX_RETRIES - (user.verificationRetries + 1)
      });

      // Store session mapping in Redis (or DB) for webhook correlation
      try {
        // Redis v4+ uses setEx (camelCase) or set with EX option
        await req.app.locals.redis.set(
          `didit:session:${session_id}`,
          JSON.stringify({ userId, correlationId, initiatedAt: new Date() }),
          { EX: 3600 } // 1 hour TTL
        );
        logger.info('Session stored in Redis', { session_id });
      } catch (redisError) {
        // Redis is optional, log warning but continue
        logger.warn('Failed to store session in Redis, webhook correlation may fail', { 
          error: redisError.message,
          session_id 
        });
      }

      logger.info('Didit session created', { session_id, userId, correlationId });

      return res.status(201).json({
        success: true,
        data: {
          session_id,
          verification_url: url,
          expires_in: 3600,
          retriesUsed: user.verificationRetries + 1,
          retriesRemaining: MAX_RETRIES - (user.verificationRetries + 1),
        },
        message: 'Verification session created. Redirect user to verification_url.',
      });
    } catch (error) {
      logger.error('Didit session creation failed', {
        error: error.response?.data || error.message,
        status: error.response?.status,
        userId,
        correlationId,
      });

      // Handle specific HTTP error codes from Didit
      if (error.response?.status === 401) {
        return res.status(500).json({ 
          error: 'Invalid Didit API key',
          message: 'The API key is invalid or expired. Please check your DIDIT_API_KEY in .env file.'
        });
      }
      
      if (error.response?.status === 403) {
        return res.status(500).json({ 
          error: 'Permission denied',
          message: 'API key does not have permission. Possible causes: 1) Workflow ID does not belong to this API key, 2) Workflow is not published/active, 3) API key lacks required permissions. Please verify in Didit dashboard.',
          details: error.response?.data
        });
      }
      
      if (error.response?.status === 400) {
        return res.status(400).json({ 
          error: 'Invalid request',
          message: 'Invalid workflow ID or request payload',
          details: error.response?.data
        });
      }

      return res.status(502).json({ 
        error: 'Failed to connect to Didit service',
        message: error.message,
        details: error.response?.data
      });
    }
  },
];

/**
 * POST /api/v1/didit/webhook
 * Didit calls this when verification completes
 * Must be public endpoint (no auth middleware)
 */
export const diditWebhookHandler = async (req, res) => {
  const payload = req.body;
  const signature = req.headers['x-didit-signature'];

  // Verify webhook signature (HMAC)
  if (!verifyDiditSignature(payload, signature)) {
    logger.warn('Invalid Didit webhook signature', { payload });
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const { session_id, status, vendor_data } = payload;
  const userId = vendor_data; // We sent userId as vendor_data

  try {
    // Retrieve session context from Redis (if available)
    let correlationId = null;
    try {
      const sessionData = await req.app.locals.redis.get(`didit:session:${session_id}`);
      if (sessionData) {
        const parsed = JSON.parse(sessionData);
        correlationId = parsed.correlationId;
      } else {
        logger.warn('Didit webhook: session not found in Redis (may have expired)', { session_id });
      }
    } catch (redisError) {
      // Redis not available, continue without session correlation
      logger.warn('Redis not available for webhook, proceeding without session correlation', { 
        error: redisError.message 
      });
    }

    logger.info('Didit verification completed', {
      session_id,
      userId,
      status,
      correlationId,
    });

    // Update user verification status in DB
    await updateUserVerificationStatus(userId, status, payload);

    // Clean up Redis session (if Redis is available)
    try {
      await req.app.locals.redis.del(`didit:session:${session_id}`);
    } catch (redisError) {
      logger.warn('Failed to delete Redis session', { error: redisError.message });
    }

    // Trigger internal events (e.g., send email, unlock trading)
    if (status === 'completed') {
      await triggerPostVerificationActions(userId);
    }

    // Always respond 200 to Didit
    return res.status(200).json({ received: true });
  } catch (error) {
    logger.error('Didit webhook processing failed', {
      error: error.message,
      session_id,
      userId,
    });
    return res.status(200).json({ received: true }); // Still acknowledge
  }
};

// Helper: Verify Didit webhook HMAC signature
function verifyDiditSignature(payload, signature) {
  const hmac = crypto.createHmac('sha256', process.env.DIDIT_WEBHOOK_SECRET);
  const digest = hmac.update(JSON.stringify(payload)).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
}

// Helper: Update user in DB
async function updateUserVerificationStatus(userId, status, details) {
  const verificationStatus = status === 'completed' ? 'VERIFIED' : 'FAILED';
  
  // Extract verification details from Didit webhook payload
  const verificationData = details.verification_data || {};
  const idVerified = verificationData.id_verification?.status === 'verified' || false;
  const phoneVerified = verificationData.phone_verification?.status === 'verified' || false;
  const phoneNumber = verificationData.phone_verification?.phone_number || null;
  
  logger.info(`Updating user ${userId} verification status`, { 
    verificationStatus,
    idVerified,
    phoneVerified,
    phoneNumber: phoneNumber ? '***' + phoneNumber.slice(-4) : null
  });

  await prisma.user.update({
    where: { id: userId },
    data: {
      kycStatus: verificationStatus,
      kycProvider: 'DIDIT',
      kycCompletedAt: status === 'completed' ? new Date() : null,
      kycDetails: JSON.stringify(details), // Store as JSON string for SQLite
      idVerified,
      phoneVerified,
      phoneNumber,
    },
  });

  logger.info(`User ${userId} KYC updated successfully`, {
    idVerified,
    phoneVerified,
    status: verificationStatus
  });
}

// Helper: Post-verification actions
async function triggerPostVerificationActions(userId) {
  logger.info(`Triggering post-verification actions for user ${userId}`);

  // Enable trading account in DB
  await prisma.user.update({
    where: { id: userId },
    data: { tradingEnabled: true },
  });

  // TODO: Implement actual actions like sending email
  // Example: await sendVerificationSuccessEmail(userId);
  // await notifyComplianceTeam(userId);

  logger.info(`Trading enabled for user ${userId}`);
}

// GET /api/v1/didit/status/:userId - Check verification status
export const checkVerificationStatus = async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.status(200).json({
      success: true,
      data: {
        userId: user.id,
        kycStatus: user.kycStatus,
        idVerified: user.idVerified,
        phoneVerified: user.phoneVerified,
        verificationRetries: user.verificationRetries,
        retriesRemaining: Math.max(0, 2 - user.verificationRetries),
        lastAttempt: user.lastVerificationAttempt,
        tradingEnabled: user.tradingEnabled,
        completedAt: user.kycCompletedAt,
      },
    });
  } catch (error) {
    logger.error('Error fetching verification status', { error: error.message });
    return res.status(500).json({ error: 'Failed to fetch verification status' });
  }
};

// Optional: Health check endpoint
export const diditHealth = async (_, res) => {
  return res.json({ status: 'Didit integration active' });
};