import { Broker } from '../../models/index.js';

/**
 * Broker integrations are not live yet. The master list and connection tables
 * exist so the onboarding "connect broker" step can be switched on without a
 * schema change; until then no broker is active and the step can be skipped.
 */
export function serializeBroker(broker: Broker) {
  return { id: broker.id, code: broker.code, name: broker.name, isActive: broker.isActive };
}

export async function listActiveBrokers(): Promise<Broker[]> {
  return Broker.findAll({ where: { isActive: true }, order: [['displayOrder', 'ASC'], ['name', 'ASC']] });
}
