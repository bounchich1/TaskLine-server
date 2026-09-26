import { MaxClient } from '../../../integrations/max/index.js';
import { ensure } from '../../../shared/errors.js';
import type { CliCommand } from '../cli-command.js';

const UPDATE_TYPES = ['message_created', 'message_edited', 'message_removed', 'message_callback', 'bot_started'];
const STAFF_UPDATE_TYPES = ['message_created', 'bot_started'];

export const subscribeCommand: CliCommand = async ({ config, args }) => {
    ensure(config.MAX_MODE === 'live' && new URL(config.PUBLIC_URL).protocol === 'https:', 'https_live_required', 422);

    if (args.at(0) === 'staff') {
        ensure(config.MAX_STAFF_BOT_TOKEN && config.MAX_STAFF_WEBHOOK_SECRET, 'staff_bot_not_configured', 422);

        await new MaxClient(config, { token: config.MAX_STAFF_BOT_TOKEN }).request('/subscriptions', {
            url: `${config.PUBLIC_URL}/webhooks/max-staff`,
            secret: config.MAX_STAFF_WEBHOOK_SECRET,
            update_types: STAFF_UPDATE_TYPES,
        });

        return 'Staff bot webhook subscription registered.';
    }

    await new MaxClient(config).request('/subscriptions', {
        url: `${config.PUBLIC_URL}/webhooks/max`,
        secret: config.MAX_WEBHOOK_SECRET,
        update_types: UPDATE_TYPES,
    });

    return 'Webhook subscription registered.';
};
