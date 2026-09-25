import { MaxClient } from '../../../integrations/max/index.js';
import { ensure } from '../../../shared/errors.js';
import type { CliCommand } from '../cli-command.js';

const UPDATE_TYPES = ['message_created', 'message_edited', 'message_removed', 'message_callback', 'bot_started'];

export const subscribeCommand: CliCommand = async ({ config }) => {
    ensure(config.MAX_MODE === 'live' && new URL(config.PUBLIC_URL).protocol === 'https:', 'https_live_required', 422);

    await new MaxClient(config).request('/subscriptions', {
        url: `${config.PUBLIC_URL}/webhooks/max`,
        secret: config.MAX_WEBHOOK_SECRET,
        update_types: UPDATE_TYPES,
    });

    return 'Webhook subscription registered.';
};
