import 'express-serve-static-core';
import type { OnboardingStatus } from '../models/enums.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Correlation id for logs, audit entries and the response envelope. */
    requestId: string;
    /** Set by authenticateUser. */
    userAuth?: {
      userId: string;
      sessionId: string;
      onboardingStatus: OnboardingStatus;
    };
    /** Set by authenticateAdmin. */
    adminAuth?: {
      adminId: string;
      sessionId: string;
    };
  }
}

export {};
