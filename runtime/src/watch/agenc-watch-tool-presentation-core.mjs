export const WATCH_PREVIEW_MODE_SOURCE_READ = "source-read";
export const WATCH_PREVIEW_MODE_SOURCE_WRITE = "source-write";
export const WATCH_SOURCE_PREVIEW_MODES = Object.freeze({
  read: WATCH_PREVIEW_MODE_SOURCE_READ,
  write: WATCH_PREVIEW_MODE_SOURCE_WRITE,
});

export const WATCH_SOURCE_MUTATION_KINDS = Object.freeze({
  append: "append",
  create: "create",
  insert: "insert",
  replace: "replace",
  write: "write",
});

export const WATCH_SOURCE_METADATA_FIELDS = Object.freeze([
  "filePath",
  "fileRange",
  "mutationKind",
  "mutationBeforeText",
  "mutationAfterText",
]);

export function buildWatchSourceMetadata({
  filePath = null,
  fileRange = null,
  mutationKind = null,
  mutationBeforeText = undefined,
  mutationAfterText = undefined,
} = {}) {
  const metadata = {};
  if (filePath) {
    metadata.filePath = filePath;
  }
  if (fileRange && typeof fileRange === "object") {
    metadata.fileRange = fileRange;
  }
  if (mutationKind) {
    metadata.mutationKind = mutationKind;
  }
  if (typeof mutationBeforeText === "string") {
    metadata.mutationBeforeText = mutationBeforeText;
  }
  if (typeof mutationAfterText === "string") {
    metadata.mutationAfterText = mutationAfterText;
  }
  return metadata;
}

export const buildSourceMetadata = buildWatchSourceMetadata;
