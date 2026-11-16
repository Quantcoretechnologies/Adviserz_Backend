import { Op, QueryTypes, type WhereOptions } from 'sequelize';
import { sequelize } from '../../db/sequelize.js';
import { formatMoney } from '../../common/utils/decimal.js';
import { toPagination } from '../../common/utils/validation.js';
import { AuditLog } from '../../models/index.js';
import type { AuditActorType } from '../../models/enums.js';

/** Business days are bucketed in India Standard Time. */
const REPORTING_TIMEZONE = 'Asia/Kolkata';

interface UserTotalsRow {
  total: string;
  active: string;
  blocked: string;
  onboarded: string;
  onboarding_pending: string;
}

interface DailyRow {
  day: string;
  signups: string;
  onboarded: string;
}

interface SegmentRow {
  code: string;
  name: string;
  currency: string;
  users: string;
  total_capital: string | null;
}

interface ExperienceRow {
  market_experience: string;
  users: string;
}

interface SessionRow {
  active_sessions: string;
  logins_24h: string;
}

const toInt = (value: string | null | undefined): number => Number.parseInt(value ?? '0', 10);

/** Dashboard metrics. All aggregation happens in PostgreSQL. */
export async function getOverview(days: number) {
  const [totals] = await sequelize.query<UserTotalsRow>(
    `SELECT COUNT(*)                                                AS total,
            COUNT(*) FILTER (WHERE status = 'active')               AS active,
            COUNT(*) FILTER (WHERE status = 'blocked')              AS blocked,
            COUNT(*) FILTER (WHERE onboarding_status = 'completed') AS onboarded,
            COUNT(*) FILTER (WHERE onboarding_status = 'pending')   AS onboarding_pending
       FROM users`,
    { type: QueryTypes.SELECT },
  );

  const daily = await sequelize.query<DailyRow>(
    `WITH days AS (
       SELECT generate_series(
                (NOW() AT TIME ZONE :tz)::date - (:days - 1),
                (NOW() AT TIME ZONE :tz)::date,
                INTERVAL '1 day'
              )::date AS day
     )
     SELECT TO_CHAR(d.day, 'YYYY-MM-DD') AS day,
            (SELECT COUNT(*) FROM users u
              WHERE (u.created_at AT TIME ZONE :tz)::date = d.day) AS signups,
            (SELECT COUNT(*) FROM users u
              WHERE (u.onboarding_completed_at AT TIME ZONE :tz)::date = d.day) AS onboarded
       FROM days d
      ORDER BY d.day`,
    { type: QueryTypes.SELECT, replacements: { tz: REPORTING_TIMEZONE, days } },
  );

  const segments = await sequelize.query<SegmentRow>(
    `SELECT s.code, s.name, rps.currency,
            COUNT(DISTINCT rp.user_id) AS users,
            SUM(rps.capital)           AS total_capital
       FROM risk_profile_segments rps
       JOIN risk_profiles rp ON rp.id = rps.risk_profile_id AND rp.status = 'active'
       JOIN segments s       ON s.id = rps.segment_id
      GROUP BY s.code, s.name, s.display_order, rps.currency
      ORDER BY s.display_order, s.name`,
    { type: QueryTypes.SELECT },
  );

  const experience = await sequelize.query<ExperienceRow>(
    `SELECT market_experience, COUNT(*) AS users
       FROM risk_profiles
      WHERE status = 'active'
      GROUP BY market_experience
      ORDER BY market_experience`,
    { type: QueryTypes.SELECT },
  );

  const [sessions] = await sequelize.query<SessionRow>(
    `SELECT COUNT(*) FILTER (WHERE revoked_at IS NULL AND expires_at > NOW())         AS active_sessions,
            COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')         AS logins_24h
       FROM auth_sessions
      WHERE user_id IS NOT NULL`,
    { type: QueryTypes.SELECT },
  );

  return {
    users: {
      total: toInt(totals?.total),
      active: toInt(totals?.active),
      blocked: toInt(totals?.blocked),
      onboarded: toInt(totals?.onboarded),
      onboardingPending: toInt(totals?.onboarding_pending),
    },
    sessions: {
      active: toInt(sessions?.active_sessions),
      loginsLast24h: toInt(sessions?.logins_24h),
    },
    daily: daily.map((row) => ({ date: row.day, signups: toInt(row.signups), onboarded: toInt(row.onboarded) })),
    segments: segments.map((row) => ({
      code: row.code,
      name: row.name,
      currency: row.currency,
      users: toInt(row.users),
      totalCapital: formatMoney(row.total_capital ?? '0'),
    })),
    marketExperience: experience.map((row) => ({ value: row.market_experience, users: toInt(row.users) })),
    timezone: REPORTING_TIMEZONE,
  };
}

export async function listAuditLogs(query: {
  page: number;
  pageSize: number;
  actorType?: AuditActorType | undefined;
  actorId?: string | undefined;
  subjectUserId?: string | undefined;
  action?: string | undefined;
  entityType?: string | undefined;
  entityId?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
}) {
  const occurredAt =
    query.from || query.to
      ? {
          occurredAt: {
            ...(query.from ? { [Op.gte]: query.from } : {}),
            ...(query.to ? { [Op.lte]: query.to } : {}),
          },
        }
      : {};

  const where: WhereOptions<AuditLog> = {
    ...(query.actorType ? { actorType: query.actorType } : {}),
    ...(query.actorId ? { actorId: query.actorId } : {}),
    ...(query.subjectUserId ? { subjectUserId: query.subjectUserId } : {}),
    ...(query.action ? { action: query.action } : {}),
    ...(query.entityType ? { entityType: query.entityType } : {}),
    ...(query.entityId ? { entityId: query.entityId } : {}),
    ...occurredAt,
  };

  const { rows, count } = await AuditLog.findAndCountAll({
    where,
    order: [['occurredAt', 'DESC'], ['id', 'DESC']],
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });

  return {
    items: rows.map((row) => row.toJSON()),
    pagination: toPagination(query.page, query.pageSize, count),
  };
}
