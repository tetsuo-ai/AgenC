/**
 * Normalize MCP tool content payloads into printable text.
 */
export function normalizeMcpContent(
  content,
  options = {},
) {
  const { pretty = false, emptyOnNull = true } = options;

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (item && typeof item === "object" && item.type === "text") {
          return item.text ?? "";
        }
        try {
          const serialized = JSON.stringify(item, null, pretty ? 2 : undefined);
          return serialized ?? (emptyOnNull ? "" : String(item));
        } catch {
          return String(item);
        }
      })
      .join("\n");
  }

  if (typeof content === "string") return content;
  if (content === undefined || content === null) {
    return emptyOnNull ? "" : String(content);
  }

  try {
    const serialized = JSON.stringify(content, null, pretty ? 2 : undefined);
    return serialized ?? (emptyOnNull ? "" : String(content));
  } catch {
    return String(content);
  }
}
