/**
 * Verification Routes
 * 
 * All routes for Didit verification APIs
 */

import express from 'express';
import rateLimit from 'express-rate-limit';
import {
  createVerificationSession,
  retrieveSession,
  sendPhoneVerificationCode,
  checkPhoneVerificationCode,
  verifyIdDocument,
  handleWebhook,
  getUserVerificationStatus,
} from '../controllers/verificationController.js';

const router = express.Router();

// Rate limiters
const sessionLimiter = rateLimit({
  windowMs: 60_000, // 1 minute
  max: 5, // 5 requests per minute per IP
  message: { 
    success: false,
    error: 'Too many verification session requests. Please try again later.' 
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const phoneLimiter = rateLimit({
  windowMs: 60_000, // 1 minute
  max: 3, // 3 requests per minute per IP
  message: { 
    success: false,
    error: 'Too many phone verification requests. Please try again later.' 
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const idVerificationLimiter = rateLimit({
  windowMs: 60_000, // 1 minute
  max: 3, // 3 requests per minute per IP
  message: { 
    success: false,
    error: 'Too many ID verification requests. Please try again later.' 
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * ============================================================
 * SESSION-BASED VERIFICATION ROUTES
 * ============================================================
 */

/**
 * @route   POST /api/v1/verification/session/create
 * @desc    Create a comprehensive verification session (ID + Phone + Liveness)
 * @access  Public (should be protected in production)
 */
router.post('/session/create', sessionLimiter, createVerificationSession);

/**
 * @route   GET /api/v1/verification/session/:sessionId
 * @desc    Retrieve verification session details and results
 * @access  Public (should be protected in production)
 */
router.get('/session/:sessionId', retrieveSession);

/**
 * ============================================================
 * STANDALONE PHONE VERIFICATION ROUTES
 * ============================================================
 */

/**
 * @route   POST /api/v1/verification/phone/send
 * @desc    Send verification code to phone number
 * @access  Public (should be protected in production)
 */
router.post('/phone/send', phoneLimiter, sendPhoneVerificationCode);

/**
 * @route   POST /api/v1/verification/phone/check
 * @desc    Verify phone verification code
 * @access  Public (should be protected in production)
 */
router.post('/phone/check', phoneLimiter, checkPhoneVerificationCode);

/**
 * ============================================================
 * STANDALONE ID VERIFICATION ROUTE
 * ============================================================
 */

/**
 * @route   POST /api/v1/verification/id/verify
 * @desc    Perform standalone ID document verification
 * @access  Public (should be protected in production)
 */
router.post('/id/verify', idVerificationLimiter, verifyIdDocument);

/**
 * ============================================================
 * WEBHOOK ROUTE
 * ============================================================
 */

/**
 * @route   POST /api/v1/verification/webhook
 * @desc    Handle Didit webhook callbacks
 * @access  Public (signature verified)
 */
router.post('/webhook', handleWebhook);

/**
 * ============================================================
 * USER STATUS ROUTE
 * ============================================================
 */

/**
 * @route   GET /api/v1/verification/status/:userId
 * @desc    Get user verification status
 * @access  Public (should be protected in production)
 */
router.get('/status/:userId', getUserVerificationStatus);

/**
 * ============================================================
 * HEALTH CHECK
 * ============================================================
 */

/**
 * @route   GET /api/v1/verification/health
 * @desc    Health check for verification service
 * @access  Public
 */
router.get('/health', (req, res) => {
  res.status(200).json({ 
    success: true,
    message: 'Didit verification service is operational',
    timestamp: new Date().toISOString(),
  });
});

export default router;
