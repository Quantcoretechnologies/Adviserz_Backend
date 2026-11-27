import { z } from 'zod';

export const markReadBody = z.object({
  ids: z
    .array(z.uuid({ error: 'Invalid notification id' }), { error: 'ids must be a list of notification ids' })
    .min(1, 'Select at least one notification')
    .max(100, 'Too many notifications at once'),
});
