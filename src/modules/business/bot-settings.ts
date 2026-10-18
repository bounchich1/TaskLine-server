import { z } from 'zod';

import { MENU_LABELS } from '../../integrations/max/index.js';
import type { Ctx } from '../../shared/context.js';
import { one, type Sql } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';

export type MenuAction = keyof typeof MENU_LABELS;
export type MenuLabels = Record<MenuAction, string>;

export interface BotSettings {
    policyUrl: string;
    policyVersion: string;
    alternativeContact: string;
    menu: MenuLabels;
}

type BotRow = {
    policy_url: string | null;
    policy_version: string | null;
    alternative_contact: string | null;
    menu_labels: Partial<MenuLabels> | null;
    version: number;
};

const MENU_ACTIONS = Object.keys(MENU_LABELS) as MenuAction[];
const RESERVED_LABELS = new Set(['меню', 'menu', 'start']);

const menuLabel = z
    .string()
    .trim()
    .min(1)
    .max(40)
    .refine((label) => !label.startsWith('/'));

export const botSettingsBody = z
    .object({
        policy_url: z.url().max(500),
        alternative_contact: z.string().trim().min(1).max(300),
        menu: z.object({ tickets: menuLabel, help: menuLabel, withdraw: menuLabel }).strict(),
        new_policy_edition: z.boolean().default(false),
    })
    .strict();

type BotSettingsBody = z.infer<typeof botSettingsBody>;

async function readRow(db: Sql, org: string): Promise<BotRow | undefined> {
    return one<BotRow>(
        db,
        'SELECT policy_url,policy_version,alternative_contact,menu_labels,version FROM organizations WHERE id=$1',
        [org],
    );
}

function settingsOf(row: BotRow | undefined, ctx: Ctx): BotSettings {
    return {
        policyUrl: row?.policy_url ?? ctx.config.POLICY_URL,
        policyVersion: row?.policy_version ?? ctx.config.POLICY_VERSION,
        alternativeContact: row?.alternative_contact ?? ctx.config.ALTERNATIVE_CONTACT,
        menu: { ...MENU_LABELS, ...row?.menu_labels },
    };
}

export async function readBotSettings(db: Sql, ctx: Ctx): Promise<BotSettings> {
    return settingsOf(await readRow(db, ctx.org), ctx);
}

export async function currentPolicyVersion(db: Sql, ctx: Ctx): Promise<string> {
    return (await readBotSettings(db, ctx)).policyVersion;
}

export function menuActionFor(menu: MenuLabels, text: string): MenuAction | undefined {
    const wanted = text.trim().toLowerCase();

    return MENU_ACTIONS.find((action) =>
        [menu[action], MENU_LABELS[action]].some((label) => label.toLowerCase() === wanted),
    );
}

export async function botSettingsView(db: Sql, ctx: Ctx) {
    const row = await readRow(db, ctx.org);
    const settings = settingsOf(row, ctx);

    return {
        policy_url: settings.policyUrl,
        policy_version: settings.policyVersion,
        policy_version_source: row?.policy_version ? 'organization' : 'deployment',
        alternative_contact: settings.alternativeContact,
        menu: settings.menu,
        default_menu: MENU_LABELS,
        version: row?.version ?? 0,
    };
}

function assertDistinctLabels(menu: MenuLabels): void {
    const owners = new Map<string, MenuAction>();

    for (const action of MENU_ACTIONS) {
        for (const label of [menu[action], MENU_LABELS[action]]) {
            const key = label.trim().toLowerCase();
            const owner = owners.get(key);

            ensure(
                !RESERVED_LABELS.has(key) && (owner === undefined || owner === action),
                'menu_label_conflict',
                422,
                'Названия кнопок должны различаться и не совпадать со стандартными названиями других кнопок.',
            );

            owners.set(key, action);
        }
    }
}

function customLabels(menu: MenuLabels): Partial<MenuLabels> {
    return Object.fromEntries(
        MENU_ACTIONS.filter((action) => menu[action] !== MENU_LABELS[action]).map((action) => [action, menu[action]]),
    );
}

export async function saveBotSettings(
    tx: Sql,
    ctx: Ctx,
    { body, expectedVersion }: { body: BotSettingsBody; expectedVersion: number },
) {
    assertDistinctLabels(body.menu);

    const row = await one(
        tx,
        `UPDATE organizations SET policy_url=$2,alternative_contact=$3,menu_labels=$4::jsonb,
       policy_version=CASE WHEN $5::boolean THEN $6 ELSE policy_version END,version=version+1
     WHERE id=$1 AND version=$7 RETURNING id`,
        [
            ctx.org,
            body.policy_url === ctx.config.POLICY_URL ? null : body.policy_url,
            body.alternative_contact === ctx.config.ALTERNATIVE_CONTACT ? null : body.alternative_contact,
            JSON.stringify(customLabels(body.menu)),
            body.new_policy_edition,
            new Date().toISOString(),
            expectedVersion,
        ],
    );

    ensure(row, 'version_conflict');

    return botSettingsView(tx, ctx);
}
