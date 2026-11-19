import 'express-serve-static-core';
import type { OnboardingStatus } from '../models/enums.js';
import type { PermissionKey } from '../modules/access/permissionCatalog.js';

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
      isSuperAdmin: boolean;
      /** Signed in with a generated password; only changing it is allowed. */
      mustChangePassword: boolean;
      /** Everything this admin may do right now (all permissions for a super admin). */
      permissions: ReadonlySet<PermissionKey>;
    };
  }
}

export {};
