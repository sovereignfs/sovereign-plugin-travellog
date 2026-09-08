/**
 * Content sniffing for the two upload routes — the stored `contentType` is
 * decided by the bytes, never by the client's declared `File.type`. The
 * platform's signed-URL route (`/api/storage/[token]`) serves an object
 * inline with whatever content type was stored, outside the session-gated
 * CSP surface, so a client-declared `text/html` (attachments) or
 * `image/svg+xml` (a "photo") would become a script-running document on the
 * runtime origin for anyone handed the link. Only raster images and PDFs
 * are accepted, and only when their magic bytes agree.
 */
export type SniffedType =
  'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'image/heic' | 'application/pdf';

const RASTER_IMAGE_TYPES: readonly SniffedType[] = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
];

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, i) => bytes[offset + i] === byte);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, Math.min(end, bytes.length)));
}

/** The type the bytes actually are, or `null` for anything this plugin doesn't store. */
export function sniffFileType(bytes: Uint8Array): SniffedType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && ascii(bytes, 8, 12) === 'WEBP')
    return 'image/webp';
  if (ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12);
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heif'].includes(brand))
      return 'image/heic';
  }
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  return null;
}

/** A raster image only — never SVG, never anything a browser would execute or render as a document. */
export function sniffRasterImageType(bytes: Uint8Array): SniffedType | null {
  const type = sniffFileType(bytes);
  return type && RASTER_IMAGE_TYPES.includes(type) ? type : null;
}
