import { AwsClient } from 'aws4fetch';
import type { Bindings } from '../types';
import { AppError } from '../middleware/error';

let cachedClient: { keyId: string; client: AwsClient } | null = null;

const getClient = (env: Bindings): AwsClient => {
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_ACCOUNT_ID) {
    throw new AppError(
      503,
      'r2_not_configured',
      'R2 presigning is not configured on this environment.'
    );
  }
  if (cachedClient && cachedClient.keyId === env.R2_ACCESS_KEY_ID) {
    return cachedClient.client;
  }
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  });
  cachedClient = { keyId: env.R2_ACCESS_KEY_ID, client };
  return client;
};

/**
 * Generate a presigned PUT URL for an R2 object. Browsers PUT directly to
 * this URL with `Content-Type: <expected>`; the bytes never touch the
 * Worker. Expires after `expiresIn` seconds (default 600 = 10 minutes).
 */
export const presignPut = async (
  env: Bindings,
  key: string,
  contentType: string,
  expiresIn = 600
): Promise<string> => {
  const client = getClient(env);
  const url = new URL(
    `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${key}`
  );
  url.searchParams.set('X-Amz-Expires', String(expiresIn));

  const signed = await client.sign(
    new Request(url, { method: 'PUT', headers: { 'Content-Type': contentType } }),
    { aws: { signQuery: true } }
  );
  return signed.url;
};
