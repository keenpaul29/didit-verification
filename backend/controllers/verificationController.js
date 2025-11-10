/**
 * Verification Controller - Complete Didit Verification Flow
 * 
 * This controller implements the full verification flow including:
 * 1. Session-based verification (ID + Phone + Liveness)
 * 2. Standalone phone verification (send/check code)
 * 3. Standalone ID verification
 * 4. Session retrieval
 * 5. Webhook handling
 */

import axios from 'axios';
import { body, validationResult } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'node:crypto';
import { logger } from '../utils/logger.js';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Didit API Configuration
const DIDIT_API_KEY = process.env.DIDIT_API_KEY;
const DIDIT_WORKFLOW_ID = process.env.DIDIT_WORKFLOW_ID;
const DIDIT_BASE_URL = 'https://verification.didit.me/v2';
const DIDIT_WEBHOOK_SECRET = process.env.DIDIT_WEBHOOK_SECRET;
const CALLBACK_URL = `${process.env.APP_URL}/api/v1/didit/webhook`;
const FRONTEND_URL = process.env.FRONTEND_URL;

// Constants
const MAX_VERIFICATION_RETRIES = 2;
const SESSION_TTL = 3600; // 1 hour
const PHONE_CODE_VALIDITY = 300; // 5 minutes

/**
 * ============================================================
 * SESSION-BASED VERIFICATION APIs
 * ============================================================
 */

/**
 * POST /api/v1/verification/session/create
 * Creates a comprehensive verification session (ID + Phone + Liveness)
 * 
 * @body {string} userId - User UUID
 * @body {object} contactDetails - Optional: email, phone for pre-fill
 * @body {object} expectedDetails - Optional: first_name, last_name
 * @body {object} metadata - Optional: custom metadata
 */
export const createVerificationSession = [
  body('userId').isUUID(4).withMessage('Valid userId (UUID v4) is required'),
  body('contactDetails.email').optional().isEmail().withMessage('Valid email required'),
  body('contactDetails.phone').optional().isMobilePhone().withMessage('Valid phone number required'),
  body('expectedDetails.first_name').optional().isString().trim(),
  body('expectedDetails.last_name').optional().isString().trim(),

  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        errors: errors.array() 
      });
    }

    const { userId, contactDetails, expectedDetails, metadata } = req.body;
    const correlationId = uuidv4();

    try {
      logger.info('Creating verification session', { userId, correlationId });

      // Ensure user exists
      let user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        user = await prisma.user.create({
          data: { 
            id: userId, 
            email: contactDetails?.email || `${userId}@example.com` 
          },
        });
      }

      // Check if already verified
      if (user.kycStatus === 'VERIFIED') {
        return res.status(200).json({
          success: false,
          message: 'User is already verified',
          data: {
            idVerified: user.idVerified,
            phoneVerified: user.phoneVerified,
            kycStatus: user.kycStatus,
            completedAt: user.kycCompletedAt
          }
        });
      }

      // Check retry limit
      if (user.verificationRetries >= MAX_VERIFICATION_RETRIES) {
        return res.status(429).json({
          success: false,
          error: 'Maximum verification attempts exceeded',
          message: `You have reached the maximum number of verification attempts (${MAX_VERIFICATION_RETRIES}). Please contact support.`,
          retriesUsed: user.verificationRetries,
          maxRetries: MAX_VERIFICATION_RETRIES
        });
      }

      // Create Didit session
      const payload = {
        workflow_id: DIDIT_WORKFLOW_ID,
        vendor_data: userId,
        callback: CALLBACK_URL,
        redirect_url_success: `${FRONTEND_URL}/verification/success`,
        redirect_url_failure: `${FRONTEND_URL}/verification/failed`,
      };

      // Add optional fields if provided
      if (contactDetails) {
        payload.contact_details = contactDetails;
      }
      if (expectedDetails) {
        payload.expected_details = expectedDetails;
      }
      if (metadata) {
        payload.metadata = metadata;
      }

      const response = await axios.post(
        `${DIDIT_BASE_URL}/session/`,
        payload,
        {
          headers: {
            'accept': 'application/json',
            'content-type': 'application/json',
            'x-api-key': DIDIT_API_KEY,
          },
          timeout: 10000,
        }
      );

      const { session_id, session_number, session_token, url, status } = response.data;

      // Increment retry counter
      await prisma.user.update({
        where: { id: userId },
        data: {
          verificationRetries: user.verificationRetries + 1,
          lastVerificationAttempt: new Date(),
        },
      });

      // Store session in Redis
      try {
        await req.app.locals.redis.set(
          `didit:session:${session_id}`,
          JSON.stringify({ 
            userId, 
            correlationId, 
            initiatedAt: new Date(),
            sessionNumber: session_number 
          }),
          { EX: SESSION_TTL }
        );
      } catch (redisError) {
        logger.warn('Failed to store session in Redis', { 
          error: redisError.message,
          session_id 
        });
      }

      logger.info('Verification session created', { 
        session_id, 
        session_number,
        userId, 
        correlationId 
      });

      return res.status(201).json({
        success: true,
        data: {
          session_id,
          session_number,
          session_token,
          verification_url: url,
          status,
          expires_in: SESSION_TTL,
          retriesUsed: user.verificationRetries + 1,
          retriesRemaining: MAX_VERIFICATION_RETRIES - (user.verificationRetries + 1),
        },
        message: 'Verification session created. Redirect user to verification_url.',
      });

    } catch (error) {
      logger.error('Failed to create verification session', {
        error: error.response?.data || error.message,
        status: error.response?.status,
        userId,
        correlationId,
      });

      return handleDiditApiError(error, res);
    }
  },
];

/**
 * GET /api/v1/verification/session/:sessionId
 * Retrieves the status and results of a verification session
 * 
 * @param {string} sessionId - Didit session ID
 */
export const retrieveSession = async (req, res) => {
  const { sessionId } = req.params;

  try {
    logger.info('Retrieving verification session', { sessionId });

    const response = await axios.get(
      `${DIDIT_BASE_URL}/session/${sessionId}/`,
      {
        headers: {
          'accept': 'application/json',
          'x-api-key': DIDIT_API_KEY,
        },
        timeout: 10000,
      }
    );

    const sessionData = response.data;

    logger.info('Session retrieved successfully', { 
      sessionId, 
      status: sessionData.status 
    });

    return res.status(200).json({
      success: true,
      data: sessionData,
    });

  } catch (error) {
    logger.error('Failed to retrieve session', {
      error: error.response?.data || error.message,
      sessionId,
    });

    return handleDiditApiError(error, res);
  }
};

/**
 * ============================================================
 * STANDALONE PHONE VERIFICATION APIs
 * ============================================================
 */

/**
 * POST /api/v1/verification/phone/send
 * Sends a verification code to a phone number
 * 
 * @body {string} phone_number - Phone number in E.164 format
 * @body {string} userId - Optional: User UUID for tracking
 */
export const sendPhoneVerificationCode = [
  body('phone_number')
    .optional()
    .isMobilePhone()
    .withMessage('Valid phone number in E.164 format is required'),
  body('phoneNumber')
    .optional()
    .isMobilePhone()
    .withMessage('Valid phone number in E.164 format is required'),
  body('userId')
    .optional()
    .isUUID(4)
    .withMessage('Valid userId (UUID v4) is required'),

  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        errors: errors.array() 
      });
    }

    const incomingNumber = req.body.phone_number || req.body.phoneNumber;
    if (!incomingNumber) {
      return res.status(400).json({ 
        success: false, 
        error: 'phone_number is required' 
      });
    }

    const { userId } = req.body;
    const correlationId = uuidv4();

    try {
      logger.info('Sending phone verification code', { 
        phoneNumber: maskPhoneNumber(incomingNumber), 
        userId,
        correlationId 
      });

      const response = await axios.post(
        `${DIDIT_BASE_URL}/phone/send/`,
        { phone_number: incomingNumber },
        {
          headers: {
            'accept': 'application/json',
            'content-type': 'application/json',
            'x-api-key': DIDIT_API_KEY,
          },
          timeout: 10000,
        }
      );

      const { request_id, phone_number, message } = response.data;

      // Store request_id in Redis for verification
      try {
        await req.app.locals.redis.set(
          `didit:phone:${request_id}`,
          JSON.stringify({ 
            userId, 
            phoneNumber: incomingNumber, 
            correlationId,
            sentAt: new Date() 
          }),
          { EX: PHONE_CODE_VALIDITY }
        );
      } catch (redisError) {
        logger.warn('Failed to store phone verification in Redis', { 
          error: redisError.message 
        });
      }

      logger.info('Phone verification code sent', { 
        request_id, 
        phone: maskPhoneNumber(phone_number || incomingNumber),
        userId 
      });

      // Return DIDIT response directly to match expected cURL response shape
      return res.status(200).json(response.data);

    } catch (error) {
      logger.error('Failed to send phone verification code', {
        error: error.response?.data || error.message,
        phoneNumber: maskPhoneNumber(incomingNumber),
        userId,
        correlationId,
      });

      return handleDiditApiError(error, res);
    }
  },
];

/**
 * POST /api/v1/verification/phone/check
 * Verifies a phone verification code
 * 
 * @body {string} phone_number - Phone number in E.164 format
 * @body {string} code - 6-digit verification code
 */
export const checkPhoneVerificationCode = [
  body('code').isLength({ min: 4, max: 6 }).withMessage('Valid verification code is required'),
  body('phone_number').optional().isMobilePhone().withMessage('Valid phone number is required'),

  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        errors: errors.array() 
      });
    }

    const incomingNumber = req.body.phone_number;
    const { code } = req.body;

    try {
      logger.info('Checking phone verification code', { phoneNumber: maskPhoneNumber(incomingNumber), code });

      if (!incomingNumber) {
        return res.status(400).json({ 
          success: false, 
          error: 'phone_number is required' 
        });
      }

      // Prepare payload with phone number if available
      const payload = {
        code: code,
        phone_number: incomingNumber
      };

      const response = await axios.post(
        `${DIDIT_BASE_URL}/phone/check/`,
        payload,
        {
          headers: {
            'accept': 'application/json',
            'content-type': 'application/json',
            'x-api-key': DIDIT_API_KEY,
          },
          timeout: 10000,
        }
      );

      // Return DIDIT response directly to match expected cURL response shape
      return res.status(200).json(response.data);

    } catch (error) {
      logger.error('Failed to check phone verification code', {
        error: error.response?.data || error.message,
        phoneNumber: maskPhoneNumber(incomingNumber),
      });

      return handleDiditApiError(error, res);
    }
  },
];

/**
 * ============================================================
 * STANDALONE ID VERIFICATION API
 * ============================================================
 */

/**
 * POST /api/v1/verification/id/verify
 * Performs standalone ID document verification
 * 
 * @body {string} userId - User UUID
 * @body {string} frontImage - Base64 encoded front image of document
 * @body {string} backImage - Base64 encoded back image (optional)
 * @body {string} documentType - Optional: passport, id_card, driver_license
 */
export const verifyIdDocument = [
  body('userId').isUUID(4).withMessage('Valid userId (UUID v4) is required'),
  body('frontImage').isBase64().withMessage('Front image must be base64 encoded'),
  body('backImage').optional().isBase64().withMessage('Back image must be base64 encoded'),
  body('documentType').optional().isIn(['passport', 'id_card', 'driver_license']),

  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        errors: errors.array() 
      });
    }

    const { userId, frontImage, backImage, documentType } = req.body;
    const correlationId = uuidv4();

    try {
      logger.info('Performing ID verification', { userId, documentType, correlationId });

      const payload = {
        front_image: frontImage,
      };

      if (backImage) {
        payload.back_image = backImage;
      }

      if (documentType) {
        payload.document_type = documentType;
      }

      const response = await axios.post(
        `${DIDIT_BASE_URL}/id-verification/`,
        payload,
        {
          headers: {
            'accept': 'application/json',
            'content-type': 'application/json',
            'x-api-key': DIDIT_API_KEY,
          },
          timeout: 30000, // ID verification can take longer
        }
      );

      const verificationResult = response.data;

      // Update user ID verification status
      if (verificationResult.status === 'verified' || verificationResult.status === 'Approved') {
        await prisma.user.update({
          where: { id: userId },
          data: {
            idVerified: true,
            kycDetails: JSON.stringify(verificationResult),
          },
        });

        logger.info('ID verified successfully', { userId, correlationId });
      }

      return res.status(200).json({
        success: true,
        data: {
          status: verificationResult.status,
          document_type: verificationResult.document_type,
          document_number: verificationResult.document_number,
          first_name: verificationResult.first_name,
          last_name: verificationResult.last_name,
          date_of_birth: verificationResult.date_of_birth,
          expiration_date: verificationResult.expiration_date,
          nationality: verificationResult.nationality,
          issuing_state: verificationResult.issuing_state,
          warnings: verificationResult.warnings || [],
        },
      });

    } catch (error) {
      logger.error('Failed to verify ID document', {
        error: error.response?.data || error.message,
        userId,
        correlationId,
      });

      return handleDiditApiError(error, res);
    }
  },
];

/**
 * ============================================================
 * WEBHOOK HANDLER
 * ============================================================
 */

/**
 * POST /api/v1/verification/webhook
 * Handles Didit webhook callbacks for verification updates
 * 
 * Webhook types:
 * - status.updated: Status change notifications
 * - data.updated: Manual data updates by reviewers
 */
export const handleWebhook = async (req, res) => {
  const rawBody = JSON.stringify(req.body);
  const signature = req.headers['x-didit-signature'];

  // Verify webhook signature
  if (!verifyWebhookSignature(rawBody, signature)) {
    logger.warn('Invalid webhook signature', { 
      headers: req.headers,
      bodyPreview: rawBody.substring(0, 100) 
    });
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const payload = req.body;
  const { 
    session_id, 
    status, 
    vendor_data, 
    webhook_type, 
    decision,
    workflow_id = process.env.DIDIT_WORKFLOW_ID,
    metadata 
  } = payload;

  const userId = vendor_data;

  try {
    logger.info('Webhook received', {
      session_id,
      status,
      webhook_type,
      userId,
      hasDecision: !!decision,
    });

    // Retrieve session context from Redis
    let sessionContext = null;
    try {
      const sessionData = await req.app.locals.redis.get(`didit:session:${session_id}`);
      if (sessionData) {
        sessionContext = JSON.parse(sessionData);
      }
    } catch (redisError) {
      logger.warn('Redis not available for webhook', { error: redisError.message });
    }

    // Process based on webhook type
    if (webhook_type === 'status.updated') {
      await handleStatusUpdate(userId, status, decision, payload);
    } else if (webhook_type === 'data.updated') {
      await handleDataUpdate(userId, decision, payload);
    }

    // Clean up Redis session if verification is complete
    if (['Approved', 'Declined', 'Abandoned'].includes(status)) {
      try {
        await req.app.locals.redis.del(`didit:session:${session_id}`);
      } catch (redisError) {
        logger.warn('Failed to delete session from Redis', { error: redisError.message });
      }
    }

    // Trigger post-verification actions for approved verifications
    if (status === 'Approved' && decision) {
      await triggerPostVerificationActions(userId, decision);
    }

    logger.info('Webhook processed successfully', { session_id, status, userId });

    // Always return 200 to acknowledge webhook
    return res.status(200).json({ received: true });

  } catch (error) {
    logger.error('Webhook processing failed', {
      error: error.message,
      stack: error.stack,
      session_id,
      userId,
    });
    // Still return 200 to prevent retries for processing errors
    return res.status(200).json({ received: true, error: error.message });
  }
};

/**
 * ============================================================
 * USER STATUS ENDPOINT
 * ============================================================
 */

/**
 * GET /api/v1/verification/status/:userId
 * Retrieves the verification status for a user
 */
export const getUserVerificationStatus = async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      return res.status(404).json({ 
        success: false,
        error: 'User not found' 
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        userId: user.id,
        email: user.email,
        kycStatus: user.kycStatus,
        kycProvider: user.kycProvider,
        idVerified: user.idVerified,
        phoneVerified: user.phoneVerified,
        phoneNumber: user.phoneNumber ? maskPhoneNumber(user.phoneNumber) : null,
        verificationRetries: user.verificationRetries,
        retriesRemaining: Math.max(0, MAX_VERIFICATION_RETRIES - user.verificationRetries),
        lastAttempt: user.lastVerificationAttempt,
        completedAt: user.kycCompletedAt,
        tradingEnabled: user.tradingEnabled,
      },
    });
  } catch (error) {
    logger.error('Error fetching verification status', { 
      error: error.message,
      userId: req.params.userId 
    });
    return res.status(500).json({ 
      success: false,
      error: 'Failed to fetch verification status' 
    });
  }
};

/**
 * ============================================================
 * HELPER FUNCTIONS
 * ============================================================
 */

/**
 * Verifies webhook HMAC signature
 */
function verifyWebhookSignature(rawBody, signature) {
  if (!signature || !DIDIT_WEBHOOK_SECRET) {
    return false;
  }

  try {
    const hmac = crypto.createHmac('sha256', DIDIT_WEBHOOK_SECRET);
    const digest = hmac.update(rawBody).digest('hex');
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(digest)
    );
  } catch (error) {
    logger.error('Signature verification failed', { error: error.message });
    return false;
  }
}

/**
 * Handles status.updated webhook events
 */
async function handleStatusUpdate(userId, status, decision, payload) {
  logger.info('Processing status update', { userId, status });

  const updateData = {
    kycProvider: 'DIDIT',
  };

  // Map Didit status to our KYC status
  if (status === 'Approved') {
    updateData.kycStatus = 'VERIFIED';
    updateData.kycCompletedAt = new Date();
  } else if (status === 'Declined') {
    updateData.kycStatus = 'FAILED';
  } else if (status === 'In Review') {
    updateData.kycStatus = 'PENDING';
  }

  // Extract verification details from decision object
  if (decision) {
    // ID Verification
    if (decision.id_verification) {
      updateData.idVerified = decision.id_verification.status === 'Approved';
    }

    // Phone Verification
    if (decision.phone_verification) {
      updateData.phoneVerified = decision.phone_verification.status === 'Approved';
      if (decision.phone_verification.phone_number) {
        updateData.phoneNumber = decision.phone_verification.phone_number;
      }
    }

    // Store complete decision data
    updateData.kycDetails = JSON.stringify(decision);
  }

  await prisma.user.update({
    where: { id: userId },
    data: updateData,
  });

  logger.info('User verification status updated', { 
    userId, 
    kycStatus: updateData.kycStatus,
    idVerified: updateData.idVerified,
    phoneVerified: updateData.phoneVerified 
  });
}

/**
 * Handles data.updated webhook events
 */
async function handleDataUpdate(userId, decision, payload) {
  logger.info('Processing data update', { userId });

  if (decision) {
    await prisma.user.update({
      where: { id: userId },
      data: {
        kycDetails: JSON.stringify(decision),
      },
    });

    logger.info('User verification data updated', { userId });
  }
}

/**
 * Triggers post-verification actions
 */
async function triggerPostVerificationActions(userId, decision) {
  logger.info('Triggering post-verification actions', { userId });

  try {
    // Enable trading for verified users
    await prisma.user.update({
      where: { id: userId },
      data: { tradingEnabled: true },
    });

    // TODO: Implement additional actions
    // - Send verification success email
    // - Notify compliance team
    // - Update external systems
    // - Grant access to premium features

    logger.info('Post-verification actions completed', { userId });
  } catch (error) {
    logger.error('Failed to execute post-verification actions', {
      error: error.message,
      userId,
    });
  }
}

/**
 * Handles Didit API errors
 */
function handleDiditApiError(error, res) {
  const status = error.response?.status;
  const data = error.response?.data;

  if (status === 401) {
    return res.status(500).json({
      success: false,
      error: 'Authentication failed',
      message: 'Invalid or expired API key. Please check DIDIT_API_KEY configuration.',
    });
  }

  if (status === 403) {
    return res.status(500).json({
      success: false,
      error: 'Permission denied',
      message: 'API key lacks required permissions or workflow is inactive.',
      details: data,
    });
  }

  if (status === 400) {
    return res.status(400).json({
      success: false,
      error: 'Invalid request',
      message: 'Request validation failed',
      details: data,
    });
  }

  if (status === 429) {
    return res.status(429).json({
      success: false,
      error: 'Rate limit exceeded',
      message: 'Too many requests. Please try again later.',
      retryAfter: error.response?.headers['retry-after'],
    });
  }

  if (status === 404) {
    return res.status(404).json({
      success: false,
      error: 'Resource not found',
      message: 'The requested resource does not exist.',
    });
  }

  return res.status(502).json({
    success: false,
    error: 'Service unavailable',
    message: 'Failed to connect to verification service',
    details: error.message,
  });
}

/**
 * Masks phone number for privacy
 */
function maskPhoneNumber(phone) {
  if (!phone) return null;
  const length = phone.length;
  if (length <= 4) return phone;
  return '***' + phone.slice(-4);
}

export default {
  createVerificationSession,
  retrieveSession,
  sendPhoneVerificationCode,
  checkPhoneVerificationCode,
  verifyIdDocument,
  handleWebhook,
  getUserVerificationStatus,
};
