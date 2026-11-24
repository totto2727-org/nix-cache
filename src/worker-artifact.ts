import { Schema } from 'effect'

export const workerArtifactDirectory = 'dist/worker'
export const WorkerArtifact = Schema.fromJsonString(
  Schema.Struct({
    entry: Schema.String,
    hash: Schema.String,
    modules: Schema.Array(Schema.String),
  }),
)
