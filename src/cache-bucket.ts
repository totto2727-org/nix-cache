import type { ReadBucketClient } from 'alchemy/Cloudflare/R2'
import { Context } from 'effect'

export class CacheBucket extends Context.Service<CacheBucket, Pick<ReadBucketClient, 'head' | 'get'>>()(
  'nix-cache/Bucket',
) {}
