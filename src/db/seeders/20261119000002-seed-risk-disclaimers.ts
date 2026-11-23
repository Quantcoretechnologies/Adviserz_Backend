import { createHash } from 'node:crypto';
import type { MigrationContext } from '../umzug.js';
import { executeInTransaction } from '../migrationUtils.js';

/**
 * Version 1 of the three risk disclaimer texts, wording approved on
 * 2026-11-19. They are templates: `{{name}}` placeholders are filled with the
 * user's own numbers when shown (see modules/riskRules/riskDisclaimers.ts).
 *
 * Layout understood by the apps: paragraphs separated by a blank line;
 * numbered lines form a list; a final paragraph starting with "Declaration:"
 * is the sentence the user ticks.
 *
 * Later wording is published as a new version from the admin console. Users
 * who accepted an earlier version are not asked again.
 */
const DISCLAIMERS = [
  {
    type: 'risk_disclaimer_above_suggested',
    title: 'Risk Acknowledgement: Above Suggested Level',
    content: [
      'You have selected a risk level of {{riskPercent}} ({{riskAmount}} {{riskAmountPeriod}}) for {{segment}} on a capital of {{capital}}. This is above the suggested level of {{suggestedPercent}} for your capital range and moves you toward the highest level of risk Adviserz considers appropriate. Please consider this decision carefully.',
      'By continuing, you confirm that:\n' +
        '1. You understand that a higher risk level can lead to larger and faster losses of your capital.\n' +
        '2. This choice is made by you, of your own free will, and is not a recommendation by Adviserz.\n' +
        '3. You are financially able to bear the loss of the amount at risk.\n' +
        '4. Adviserz, its directors, employees and associates are not liable for any loss arising from this choice.',
      'You can lower your risk level at any time from your profile.',
      'Declaration: I have read and understood this disclaimer and accept the risk level I have chosen.',
    ].join('\n\n'),
  },
  {
    type: 'risk_disclaimer_above_maximum',
    title: 'Important Risk Warning: Above Maximum Limit',
    content: [
      'You have selected a risk level of {{riskPercent}} ({{riskAmount}} {{riskAmountPeriod}}) for {{segment}} on a capital of {{capital}}. This exceeds the maximum limit of {{maxPercent}} set by Adviserz for your capital range (suggested level: {{suggestedPercent}}). Adviserz does not recommend this level.',
      'At this level you face a high probability of significant or total loss of the capital allocated to this segment, possibly within a short period.',
      'By proceeding, you expressly confirm that:\n' +
        '1. You are choosing this level against the limits and suggestion of Adviserz, solely on your own judgement and at your own risk.\n' +
        '2. You understand that trading in securities is subject to market risks, that past performance does not guarantee future results, and that you may lose some or all of your capital.\n' +
        '3. The capital at risk is not borrowed money or money you need for essential expenses, and you have the financial capacity to bear its loss.\n' +
        '4. Nothing communicated by Adviserz shall be read as encouragement to take this level of risk.\n' +
        '5. Adviserz, its directors, employees and associates shall not be liable for any loss, direct or indirect, arising from this decision.\n' +
        '6. This acknowledgement, with the date, time, IP address and device details, is recorded and may be relied upon as evidence of your informed consent.',
      'Declaration: I have read and understood this warning in full.',
    ].join('\n\n'),
  },
  {
    type: 'risk_limits_change_notice',
    title: 'Update to Your Risk Limits',
    content: [
      'Adviserz has updated the risk limits for the following segment(s) in your profile. These changes are part of our risk framework to help protect your capital.',
      '{{changes}}',
      '{{actions}}',
      'By accepting, you confirm that you have read the updated limits and understand how they apply to your profile. Your continued use of Adviserz is subject to these limits.',
    ].join('\n\n'),
  },
] as const;

export async function up({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await sequelize.transaction(async (transaction) => {
    for (const disclaimer of DISCLAIMERS) {
      await sequelize.query(
        `INSERT INTO policy_documents (type, version, title, content, content_sha256, status, published_at)
         VALUES (:type, 1, :title, :content, :sha, 'published', NOW())
         ON CONFLICT (type, version) DO NOTHING`,
        {
          replacements: {
            type: disclaimer.type,
            title: disclaimer.title,
            content: disclaimer.content,
            sha: createHash('sha256').update(disclaimer.content, 'utf8').digest('hex'),
          },
          transaction,
        },
      );
    }
  });
}

export async function down({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  // Fails (FK RESTRICT) once any acknowledgement references them — consent records are never discarded.
  await executeInTransaction(sequelize, [
    `DELETE FROM policy_documents WHERE version = 1 AND type IN
       ('risk_disclaimer_above_suggested', 'risk_disclaimer_above_maximum', 'risk_limits_change_notice')`,
  ]);
}
