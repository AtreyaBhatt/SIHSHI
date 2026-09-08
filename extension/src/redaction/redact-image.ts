/**
 * Pixel-level redaction (PRD §6.2.4), running in the service worker on an
 * OffscreenCanvas so compositing stays off the page's main thread — client
 * resource use is 20% of the rubric (PRD §8).
 *
 * Note there is no fetch() here even for the data: URL. Decoding base64 by hand
 * costs a few lines and keeps `extension/src` literally free of fetch, XHR and
 * WebSocket, which makes "this build cannot send anything" checkable with grep
 * rather than a matter of trust.
 *
 * M3 adds face boxes from BlazeFace to the same `regions` list; nothing in this
 * file changes when it does.
 */
import type { BBox, PiiTier } from '../shared/schema';

export interface RedactionRegion {
  bbox: BBox;
  tier: PiiTier;
}

const BLUR_RADIUS_PX = 12;

function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  if (comma === -1) throw new Error('Malformed data URL');
  const mime = /:(.*?);/.exec(dataUrl.slice(0, comma))?.[1] ?? 'image/png';
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Returns base64 PNG (no data: prefix) as PRD §7.1 specifies for
 * `screenshot_redacted`.
 *
 * Boxes arrive in viewport CSS pixels while the capture is in device pixels, so
 * everything is scaled by the ratio the bitmap actually reports rather than by
 * a devicePixelRatio read separately — the two disagree on zoomed pages.
 */
export async function redactScreenshot(
  screenshotDataUrl: string,
  regions: RedactionRegion[],
  viewportWidth: number,
): Promise<string> {
  const bitmap = await createImageBitmap(dataUrlToBlob(screenshotDataUrl));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');

  ctx.drawImage(bitmap, 0, 0);
  const scale = viewportWidth > 0 ? bitmap.width / viewportWidth : 1;

  for (const { bbox, tier } of regions) {
    const x = Math.max(0, Math.floor(bbox[0] * scale));
    const y = Math.max(0, Math.floor(bbox[1] * scale));
    const w = Math.min(bitmap.width - x, Math.ceil((bbox[2] - bbox[0]) * scale));
    const h = Math.min(bitmap.height - y, Math.ceil((bbox[3] - bbox[1]) * scale));
    if (w <= 0 || h <= 0) continue;

    if (tier === 1) {
      // Solid fill, not blur. A blurred region still carries the signal, and
      // Tier 1 is defined as "never leaves the device".
      ctx.fillStyle = '#000';
      ctx.fillRect(x, y, w, h);
    } else {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.filter = `blur(${BLUR_RADIUS_PX}px)`;
      ctx.drawImage(bitmap, 0, 0);
      ctx.restore();
    }
  }

  bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return toBase64(await blob.arrayBuffer());
}
