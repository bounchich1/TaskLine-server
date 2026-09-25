import { readFileSync } from 'node:fs';
import { rootCertificates } from 'node:tls';

import { Agent } from 'undici';

import type { Config } from './config.js';

const roots = new Map<string, string[]>();
const agents = new Map<string, Agent>();

export function maxTrustedRoots(config: Pick<Config, 'MAX_CA_FILE'>): string[] | undefined {
    const file = config.MAX_CA_FILE;

    if (!file) {
        return undefined;
    }

    let trusted = roots.get(file);

    if (!trusted) {
        trusted = [...rootCertificates, readFileSync(file, 'utf8')];
        roots.set(file, trusted);
    }

    return trusted;
}

export function maxDispatcher(config: Pick<Config, 'MAX_CA_FILE'>): Agent | undefined {
    const ca = maxTrustedRoots(config);

    if (!ca) {
        return undefined;
    }

    let agent = agents.get(config.MAX_CA_FILE);

    if (!agent) {
        agent = new Agent({ connect: { ca } });
        agents.set(config.MAX_CA_FILE, agent);
    }

    return agent;
}
