export interface ParsedToolResultMedia {
  imageUrls: string[];
  redactedText: string;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function toDataUrl(mimeType: string | undefined, base64: string): string {
  const mime = mimeType && mimeType.startsWith('image/') ? mimeType : 'image/png';
  return `data:${mime};base64,${base64}`;
}

function addImageUrl(imageUrls: string[], candidate: string | undefined): void {
  if (!candidate) return;
  if (!candidate.startsWith('data:image/')) return;
  if (!imageUrls.includes(candidate)) imageUrls.push(candidate);
}

function addBase64Image(
  imageUrls: string[],
  base64: string | undefined,
  mimeType?: string,
): void {
  if (!base64 || base64.length < 8) return;
  const dataUrl = toDataUrl(mimeType, base64);
  if (!imageUrls.includes(dataUrl)) imageUrls.push(dataUrl);
}

function isBase64Like(value: string): boolean {
  if (value.length < 128) return false;
  return /^[A-Za-z0-9+/=\r\n]+$/.test(value);
}

function redactParsedBinary(value: unknown, keyHint?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactParsedBinary(entry));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactParsedBinary(entry, key.toLowerCase());
    }
    return out;
  }
  if (typeof value !== 'string') return value;

  if (value.startsWith('data:image/')) {
    return '(image data url omitted)';
  }
  if (
    keyHint &&
    /(image|dataurl|data|base64)/.test(keyHint) &&
    isBase64Like(value)
  ) {
    return '(base64 omitted)';
  }
  if (value.length >= 2048 && isBase64Like(value)) {
    return '(base64 omitted)';
  }
  return value;
}

function extractFromObject(value: unknown, imageUrls: string[]): void {
  if (!value || typeof value !== 'object') return;
  const obj = value as Record<string, unknown>;

  const dataUrl = typeof obj.dataUrl === 'string' ? obj.dataUrl : undefined;
  addImageUrl(imageUrls, dataUrl);

  const imageMimeType =
    typeof obj.imageMimeType === 'string'
      ? obj.imageMimeType
      : typeof obj.mimeType === 'string'
        ? obj.mimeType
        : undefined;
  const image = typeof obj.image === 'string' ? obj.image : undefined;
  addBase64Image(imageUrls, image, imageMimeType);

  const type = typeof obj.type === 'string' ? obj.type : undefined;
  const data = typeof obj.data === 'string' ? obj.data : undefined;
  if (type === 'image') {
    addBase64Image(imageUrls, data, imageMimeType);
  }
}

export function parseToolResultMedia(result: string | undefined): ParsedToolResultMedia {
  if (!result) return { imageUrls: [], redactedText: '' };

  const imageUrls: string[] = [];
  let redactedText = result;

  const parsed = safeJsonParse(result);
  if (parsed && typeof parsed === 'object') {
    extractFromObject(parsed, imageUrls);
    redactedText = JSON.stringify(redactParsedBinary(parsed), null, 2);
    const parsedContent =
      (parsed as Record<string, unknown>).content &&
      typeof (parsed as Record<string, unknown>).content === 'string'
        ? safeJsonParse((parsed as Record<string, unknown>).content as string)
        : null;
    if (parsedContent) extractFromObject(parsedContent, imageUrls);
  }

  // Matches: {"type":"image","data":"...","mimeType":"image/png"}
  const imageJsonPattern =
    /\{\s*"type"\s*:\s*"image"\s*,\s*"data"\s*:\s*"([A-Za-z0-9+/=\r\n]+)"\s*,\s*"mimeType"\s*:\s*"([^"]+)"\s*\}/g;
  redactedText = redactedText.replace(
    imageJsonPattern,
    (_match: string, data: string, mimeType: string) => {
      addBase64Image(imageUrls, data, mimeType);
      return `{"type":"image","data":"(base64 omitted)","mimeType":"${mimeType}"}`;
    },
  );

  const dataUrlPattern = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+/g;
  redactedText = redactedText.replace(dataUrlPattern, (match: string) => {
    addImageUrl(imageUrls, match);
    return '(image data url omitted)';
  });

  // Large standalone base64 blobs still sneak in occasionally.
  redactedText = redactedText.replace(/[A-Za-z0-9+/=\r\n]{2048,}/g, '(base64 omitted)');

  return { imageUrls, redactedText: redactedText.trim() };
}
