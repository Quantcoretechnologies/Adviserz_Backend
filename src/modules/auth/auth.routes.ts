import { Router } from 'express';
import { authLimiter, otpLimiter } from '../../common/middleware/rateLimiters.js';
import { requireAllowedOrigin, requireCsrf } from '../../common/middleware/webSecurity.js';
import * as controller from './auth.controller.js';

/**
 * Mounted at {API_PREFIX}/auth
 *
 * Registration (verify email + phone first, then submit the form):
 *   GET  /username-availability?username=
 *   POST /register/email/send-otp     { email }
 *   POST /register/phone/send-otp     { phone }
 *   POST /register/verify-otp         { verificationId, otp }  -> verificationToken
 *   POST /register                    { ...form, emailVerificationToken, phoneVerificationToken }
 *
 * Web sessions (refresh token in HttpOnly cookie; refresh/logout need X-CSRF-Token):
 *   POST /web/login | /web/refresh | /web/logout
 *
 * Mobile sessions (refresh token in body):
 *   POST /mobile/login | /mobile/refresh | /mobile/logout
 *
 * Password reset (OTP to email):
 *   POST /password/forgot | /password/verify-otp | /password/reset
 */
export const authRouter = Router();

authRouter.get('/username-availability', controller.usernameAvailability);
authRouter.post('/register/email/send-otp', otpLimiter, controller.sendRegistrationEmailOtp);
authRouter.post('/register/phone/send-otp', otpLimiter, controller.sendRegistrationPhoneOtp);
authRouter.post('/register/verify-otp', otpLimiter, controller.verifyRegistrationOtp);
authRouter.post('/register', authLimiter, controller.register);

authRouter.post('/web/login', authLimiter, requireAllowedOrigin, controller.webLogin);
authRouter.post('/web/refresh', authLimiter, requireAllowedOrigin, requireCsrf('user'), controller.webRefresh);
authRouter.post('/web/logout', requireAllowedOrigin, requireCsrf('user'), controller.webLogout);

authRouter.post('/mobile/login', authLimiter, controller.mobileLogin);
authRouter.post('/mobile/refresh', authLimiter, controller.mobileRefresh);
authRouter.post('/mobile/logout', controller.mobileLogout);

authRouter.post('/password/forgot', otpLimiter, controller.forgotPassword);
authRouter.post('/password/verify-otp', otpLimiter, controller.verifyPasswordResetOtp);
authRouter.post('/password/reset', authLimiter, controller.resetPassword);
