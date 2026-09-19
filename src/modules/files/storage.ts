import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import type { Config } from '../../shared/config.js';
import { ensure } from '../../shared/errors.js';

/** Private object storage for attachments: S3 in production, a local directory in development. */
export class ObjectStorage {
  private readonly s3?: S3Client;

  constructor(private readonly config: Config) {
    if (config.STORAGE_MODE === 's3') {
      this.s3 = new S3Client({
        region: config.S3_REGION,
        endpoint: config.S3_ENDPOINT,
        forcePathStyle: !!config.S3_ENDPOINT,
        credentials: {
          accessKeyId: config.S3_ACCESS_KEY_ID,
          secretAccessKey: config.S3_SECRET_ACCESS_KEY,
        },
      });
    }
  }

  async put(key: string, path: string, mime: string): Promise<void> {
    if (this.s3) {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.config.S3_BUCKET,
          Key: key,
          Body: createReadStream(path),
          ContentType: mime,
          ContentLength: (await stat(path)).size,
          ServerSideEncryption: 'AES256',
        }),
      );
      return;
    }
    const target = this.localPath(key);
    await mkdir(resolve(target, '..'), { recursive: true });
    await pipeline(createReadStream(path), createWriteStream(target, { flags: 'w', mode: 0o600 }));
  }

  async read(key: string): Promise<Readable> {
    if (this.s3) {
      const result = await this.s3.send(
        new GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }),
      );
      ensure(result.Body, 'object_missing', 404);
      return result.Body as Readable;
    }
    return createReadStream(this.localPath(key));
  }

  /** Keys are `<org uuid>/<attachment uuid>`; anything else could escape the storage root. */
  private localPath(key: string): string {
    ensure(/^[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(key), 'invalid_object_key', 500);
    return resolve(this.config.STORAGE_PATH, key);
  }
}
