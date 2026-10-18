import type { Config } from '../../shared/config.js';
import { createCtx, type Ctx } from '../../shared/context.js';
import type { Database } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';
import {
    botSettingsBody,
    botSettingsView,
    findPreset,
    listPresets,
    profileBody,
    readProfile,
    saveBotSettings,
    saveProfile,
} from '../business/index.js';

import { runAdminMutation } from './admin-mutation.js';
import type { AdminRequest } from './admin.js';
import { applyPreset, previewPreset } from './apply-preset.js';

const permission = 'organization.configure' as const;

export class BusinessAdmin {
    private readonly ctx: Ctx;

    constructor(
        private readonly db: Database,
        config: Config,
    ) {
        this.ctx = createCtx(config);
    }

    async profile() {
        return readProfile(this.db, this.ctx.org);
    }

    async saveProfile(request: AdminRequest) {
        const body = profileBody.parse(request.body);
        const mutation = { ...request, permission, route: 'admin.profile', body };

        return runAdminMutation(this.db, this.ctx.org, mutation, (tx) =>
            saveProfile(tx, this.ctx.org, { body, expectedVersion: request.expectedVersion }),
        );
    }

    async bot() {
        return botSettingsView(this.db, this.ctx);
    }

    async saveBot(request: AdminRequest) {
        const body = botSettingsBody.parse(request.body);
        const mutation = { ...request, permission, route: 'admin.bot', body };

        return runAdminMutation(this.db, this.ctx.org, mutation, (tx) =>
            saveBotSettings(tx, this.ctx, { body, expectedVersion: request.expectedVersion }),
        );
    }

    async presets() {
        const { preset } = await readProfile(this.db, this.ctx.org);

        return { items: listPresets(), current: preset };
    }

    async presetPreview(id: string) {
        return previewPreset(this.db, this.ctx.org, findPreset(id));
    }

    async applyPreset(request: AdminRequest & { id: string }) {
        const preset = findPreset(request.id);
        const mutation = { ...request, permission, route: `admin.preset:${preset.id}`, objectId: preset.id, body: {} };

        return runAdminMutation(this.db, this.ctx.org, mutation, async (tx) => {
            const { version } = await readProfile(tx, this.ctx.org);

            ensure(version === request.expectedVersion, 'version_conflict');

            return applyPreset(tx, this.ctx.org, preset);
        });
    }
}
