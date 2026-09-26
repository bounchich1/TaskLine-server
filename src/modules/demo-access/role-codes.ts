import { ROLES, type Role } from '../../shared/access.js';
import { equal } from '../../shared/crypto.js';

const CODE_PATTERN = /^[A-Z0-9-]{12,64}$/;

export interface RoleCode {
    code: string;
    role: Role;
}

export function parseRoleCodes(raw: string): RoleCode[] {
    const codes = raw
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map(parseEntry);

    if (new Set(codes.map((entry) => entry.code)).size !== codes.length) {
        throw new Error('DEMO_ROLE_CODES contains the same code twice');
    }

    return codes;
}

export function roleFor(codes: readonly RoleCode[], entered: string): Role | undefined {
    const candidate = normalizeCode(entered);
    let match: Role | undefined;

    for (const { code, role } of codes) {
        if (equal(code, candidate)) {
            match = role;
        }
    }

    return match;
}

function parseEntry(entry: string): RoleCode {
    const separator = entry.indexOf(':');
    const role = entry.slice(0, separator).trim();
    const code = normalizeCode(entry.slice(separator + 1));

    if (separator < 0 || !isRole(role) || !CODE_PATTERN.test(code)) {
        throw new Error('DEMO_ROLE_CODES entries must look like role:CODE with 12-64 letters, digits or dashes');
    }

    return { code, role };
}

function isRole(value: string): value is Role {
    return (ROLES as readonly string[]).includes(value);
}

function normalizeCode(value: string): string {
    return value.replace(/\s+/g, '').toUpperCase();
}
