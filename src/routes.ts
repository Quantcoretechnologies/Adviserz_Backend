import { Router } from 'express';
import { adminRouter } from './modules/admin/admin.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { catalogRouter } from './modules/catalog/catalog.routes.js';
import { onboardingRouter } from './modules/onboarding/onboarding.routes.js';
import { usersRouter } from './modules/users/users.routes.js';

/** Versioned API surface, mounted at env.API_PREFIX (default /api/v1). */
export const apiRouter = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/users/me', usersRouter);
apiRouter.use('/onboarding', onboardingRouter);
apiRouter.use('/admin', adminRouter);
apiRouter.use('/', catalogRouter);
