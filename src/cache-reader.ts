import { Context, Schema } from 'effect'

const ReaderSettings = Schema.Struct({
  cacheNamespace: Schema.String,
  password: Schema.Redacted(Schema.String),
  username: Schema.Redacted(Schema.String),
})

export class CacheReader extends Context.Service<CacheReader, typeof ReaderSettings.Type>()('nix-cache/Reader') {}
