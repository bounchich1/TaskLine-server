import { ObjectStorage } from '../../../modules/files/index.js';
import type { CliCommand } from '../cli-command.js';

export const storageInitCommand: CliCommand = async ({ config }) => {
    await new ObjectStorage(config).prepareBucket();

    return `Bucket ${config.S3_BUCKET} ready with versioning.`;
};
