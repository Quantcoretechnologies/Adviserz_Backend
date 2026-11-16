import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/AppError.js';
import { ErrorCode } from '../../common/errors/errorCodes.js';
import { getRequestContext } from '../../common/http/requestContext.js';
import { sendCreated, sendSuccess } from '../../common/http/response.js';
import { parseInput } from '../../common/utils/validation.js';
import * as authService from './auth.service.js';
import {
  forgotPasswordBody,
  loginBody,
  mobileRefreshBody,
  registerBody,
  resetPasswordBody,
  sendEmailOtpBody,
  sendPhoneOtpBody,
  usernameAvailabilityQuery,
  verifyOtpBody,
} from './auth.schemas.js';
import type { IssuedTokens } from './session.service.js';
import { clearAuthCookies, readRefreshCookie, setAuthCookies } from './webCookies.js';

function accessPayload(tokens: IssuedTokens) {
  return {
    tokenType: 'Bearer' as const,
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
    sessionId: tokens.sessionId,
  };
}

/** Web: refresh token goes into an HttpOnly cookie, never the body. */
function webTokenResponse(res: Response, tokens: IssuedTokens) {
  const csrfToken = setAuthCookies(res, 'user', tokens.refreshToken, tokens.refreshTokenExpiresAt);
  return { ...accessPayload(tokens), csrfToken };
}

/** Mobile: refresh token is returned for storage in Keychain / Keystore. */
function mobileTokenResponse(tokens: IssuedTokens) {
  return { ...accessPayload(tokens), refreshToken: tokens.refreshToken };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export async function usernameAvailability(req: Request, res: Response): Promise<void> {
  const { username } = parseInput(usernameAvailabilityQuery, req.query);
  const available = await authService.isUsernameAvailable(username);
  sendSuccess(res, { username, available }, available ? 'Username is available' : 'Username is already taken');
}

export async function sendRegistrationEmailOtp(req: Request, res: Response): Promise<void> {
  const { email } = parseInput(sendEmailOtpBody, req.body);
  const result = await authService.sendRegistrationEmailOtp(email, getRequestContext(req));
  sendSuccess(res, result, 'Verification code sent to your email');
}

export async function sendRegistrationPhoneOtp(req: Request, res: Response): Promise<void> {
  const { phone } = parseInput(sendPhoneOtpBody, req.body);
  const result = await authService.sendRegistrationPhoneOtp(phone, getRequestContext(req));
  sendSuccess(res, result, 'Verification code sent to your phone');
}

export async function verifyRegistrationOtp(req: Request, res: Response): Promise<void> {
  const { verificationId, otp } = parseInput(verifyOtpBody, req.body);
  const result = await authService.verifyRegistrationOtp(verificationId, otp, getRequestContext(req));
  sendSuccess(res, result, 'Verified successfully');
}

export async function register(req: Request, res: Response): Promise<void> {
  const body = parseInput(registerBody, req.body);
  const user = await authService.registerUser(body, getRequestContext(req));
  sendCreated(res, { user }, 'Account created successfully. Please sign in');
}

// ---------------------------------------------------------------------------
// Web session (cookie + CSRF)
// ---------------------------------------------------------------------------

export async function webLogin(req: Request, res: Response): Promise<void> {
  const body = parseInput(loginBody, req.body);
  const result = await authService.loginUser(body, 'web', getRequestContext(req));
  sendSuccess(
    res,
    { ...webTokenResponse(res, result.tokens), user: result.user, nextAction: result.nextAction },
    'Signed in successfully',
  );
}

export async function webRefresh(req: Request, res: Response): Promise<void> {
  const refreshToken = readRefreshCookie(req, 'user');
  if (!refreshToken) {
    throw AppError.unauthorized('Refresh token is missing', ErrorCode.REFRESH_TOKEN_INVALID);
  }
  try {
    const tokens = await authService.refreshUserSession(refreshToken, 'web', getRequestContext(req));
    sendSuccess(res, webTokenResponse(res, tokens), 'Session refreshed');
  } catch (error) {
    // Any refresh failure ends the browser session: drop the dead cookies.
    if (error instanceof AppError && error.statusCode === 401) clearAuthCookies(res, 'user');
    throw error;
  }
}

export async function webLogout(req: Request, res: Response): Promise<void> {
  await authService.logoutUser(readRefreshCookie(req, 'user'), 'web', getRequestContext(req));
  clearAuthCookies(res, 'user');
  sendSuccess(res, null, 'Signed out successfully');
}

// ---------------------------------------------------------------------------
// Mobile session (refresh token in body)
// ---------------------------------------------------------------------------

export async function mobileLogin(req: Request, res: Response): Promise<void> {
  const body = parseInput(loginBody, req.body);
  const result = await authService.loginUser(body, 'mobile', getRequestContext(req));
  sendSuccess(
    res,
    { ...mobileTokenResponse(result.tokens), user: result.user, nextAction: result.nextAction },
    'Signed in successfully',
  );
}

export async function mobileRefresh(req: Request, res: Response): Promise<void> {
  const { refreshToken } = parseInput(mobileRefreshBody, req.body);
  const tokens = await authService.refreshUserSession(refreshToken, 'mobile', getRequestContext(req));
  sendSuccess(res, mobileTokenResponse(tokens), 'Session refreshed');
}

export async function mobileLogout(req: Request, res: Response): Promise<void> {
  const { refreshToken } = parseInput(mobileRefreshBody, req.body);
  await authService.logoutUser(refreshToken, 'mobile', getRequestContext(req));
  sendSuccess(res, null, 'Signed out successfully');
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

export async function forgotPassword(req: Request, res: Response): Promise<void> {
  const { email } = parseInput(forgotPasswordBody, req.body);
  const result = await authService.requestPasswordReset(email, getRequestContext(req));
  sendSuccess(res, result, 'If an account exists for this email, a verification code has been sent');
}

export async function verifyPasswordResetOtp(req: Request, res: Response): Promise<void> {
  const { verificationId, otp } = parseInput(verifyOtpBody, req.body);
  const result = await authService.verifyPasswordResetOtp(verificationId, otp, getRequestContext(req));
  sendSuccess(res, result, 'Code verified. You can now set a new password');
}

export async function resetPassword(req: Request, res: Response): Promise<void> {
  const { resetToken, newPassword } = parseInput(resetPasswordBody, req.body);
  await authService.resetPassword(resetToken, newPassword, getRequestContext(req));
  sendSuccess(res, null, 'Password updated successfully. Please sign in');
}
