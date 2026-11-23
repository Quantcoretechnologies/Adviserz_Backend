import { QueryTypes } from 'sequelize';
import type { MigrationContext } from '../umzug.js';

/**
 * Default capital-band risk limits.
 *
 * Equity Intraday (daily loss %): suggested = midpoint of min and max.
 * Equity Delivery (total risk on the whole capital %): max 50%, suggested typed.
 * F&O Stock / F&O Index: tables not decided yet. They keep one band with the
 * old open range (from 0, 0.01–100%, suggested = 100% so no disclaimer can
 * apply) until their real tables are added.
 *
 * On a NEW database this is each segment's version 1 and notifies nobody. On
 * a database that already had segments (the migration turned their single
 * range into version 1), the Intraday and Delivery tables arrive as a new
 * version that notifies customers holding those segments, exactly as an
 * admin change would.
 *
 * Every version is append-only, so `down` cannot remove them: publish a new
 * version from the admin console instead.
 */
type Band = readonly [capitalFrom: string, min: string, suggested: string | null, max: string];

const EQUITY_INTRADAY: readonly Band[] = [
  ['10000', '5', null, '7.5'],
  ['20000', '2.5', null, '5'],
  ['50000', '1', null, '4.2'],
  ['100000', '0.7', null, '3.6'],
  ['200000', '0.5', null, '3'],
  ['500000', '0.42', null, '2.4'],
  ['1000000', '0.33', null, '1.95'],
  ['2000000', '0.25', null, '1.5'],
  ['5000000', '0.19', null, '1.2'],
  ['10000000', '0.15', null, '0.97'],
  ['20000000', '0.1', null, '0.75'],
  ['50000000', '0.1', null, '0.75'],
];

const EQUITY_DELIVERY: readonly Band[] = [
  ['25000', '10', '32.8', '50'],
  ['50000', '8.4', '30.4', '50'],
  ['100000', '6.7', '27.7', '50'],
  ['200000', '5', '25', '50'],
  ['500000', '4.02', '21', '50'],
  ['1000000', '3.26', '18', '50'],
  ['2000000', '2.5', '15', '50'],
  ['5000000', '1.9', '13', '50'],
  ['10000000', '1.45', '11.5', '50'],
  ['20000000', '1', '10', '50'],
  ['50000000', '1', '10', '50'],
];

const PLACEHOLDER: readonly Band[] = [['0', '0.01', '100', '100']];

const TABLES = [
  { code: 'EQUITY_INTRADAY', mode: 'midpoint', bands: EQUITY_INTRADAY, replaceExisting: true },
  { code: 'EQUITY_DELIVERY', mode: 'manual', bands: EQUITY_DELIVERY, replaceExisting: true },
  { code: 'FNO_STOCK', mode: 'manual', bands: PLACEHOLDER, replaceExisting: false },
  { code: 'FNO_INDEX', mode: 'manual', bands: PLACEHOLDER, replaceExisting: false },
] as const;

export async function up({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await sequelize.transaction(async (transaction) => {
    for (const table of TABLES) {
      const [segment] = await sequelize.query<{ id: string; latest: number | null }>(
        `SELECT s.id, (SELECT MAX(version) FROM segment_risk_rule_sets rs WHERE rs.segment_id = s.id) AS latest
           FROM segments s WHERE s.code = :code`,
        { replacements: { code: table.code }, transaction, type: QueryTypes.SELECT },
      );
      if (!segment) continue;
      const latest = segment.latest === null ? 0 : Number(segment.latest);
      if (latest > 0 && !table.replaceExisting) continue;

      const [ruleSet] = await sequelize.query<{ id: string }>(
        `INSERT INTO segment_risk_rule_sets (segment_id, version, suggested_mode, source, notify_users)
         VALUES (:segmentId, :version, :mode, 'seed', :notify)
         RETURNING id`,
        {
          replacements: { segmentId: segment.id, version: latest + 1, mode: table.mode, notify: latest > 0 },
          transaction,
          type: QueryTypes.SELECT,
        },
      );
      if (!ruleSet) throw new Error(`Could not create risk bands for ${table.code}`);

      for (const [capitalFrom, min, suggested, max] of table.bands) {
        await sequelize.query(
          `INSERT INTO segment_risk_bands (rule_set_id, capital_from, min_risk_percent, suggested_risk_percent, max_risk_percent)
           VALUES (:ruleSetId, :capitalFrom, :min, COALESCE(CAST(:suggested AS NUMERIC), ROUND((CAST(:min AS NUMERIC) + CAST(:max AS NUMERIC)) / 2, 4)), :max)`,
          { replacements: { ruleSetId: ruleSet.id, capitalFrom, min, suggested, max }, transaction },
        );
      }
      await sequelize.query(`UPDATE segments SET suggested_mode = :mode, updated_at = NOW() WHERE id = :segmentId`, {
        replacements: { mode: table.mode, segmentId: segment.id },
        transaction,
      });
    }
  });
}

export async function down(): Promise<void> {
  // Rule-set versions are append-only; publish a new version instead of undoing this one.
}
