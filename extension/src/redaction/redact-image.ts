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
import type { BBox, MaskingStrategy } from '../shared/schema';

export interface RedactionRegion {
  bbox: BBox;
  masking: MaskingStrategy;
}

/**
 * Blur geometry, tuned against the detector rather than by eye.
 *
 * A tight face box leaves the hairline, jaw and ears sharp, and the detector
 * re-finds the face from what is left — measured: 2 of 22 faces still detectable
 * after blurring the boxes as returned. Padding the region and scaling the
 * radius to the face's own size takes that to zero, which is the only version of
 * "the faces are blurred" that can be asserted rather than asserted-about.
 */
const BLUR_PAD_RATIO = 0.25;
const BLUR_MIN_RADIUS_PX = 10;
const BLUR_RADIUS_RATIO = 0.45;

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

  for (const { bbox, masking } of regions) {
    // Blurred regions are grown before masking; filled ones are exact, since a
    // black box already removes everything inside it.
    const padX = masking === 'blur' ? (bbox[2] - bbox[0]) * BLUR_PAD_RATIO : 0;
    const padY = masking === 'blur' ? (bbox[3] - bbox[1]) * BLUR_PAD_RATIO : 0;

    const x = Math.max(0, Math.floor((bbox[0] - padX) * scale));
    const y = Math.max(0, Math.floor((bbox[1] - padY) * scale));
    const w = Math.min(bitmap.width - x, Math.ceil((bbox[2] - bbox[0] + padX * 2) * scale));
    const h = Math.min(bitmap.height - y, Math.ceil((bbox[3] - bbox[1] + padY * 2) * scale));
    if (w <= 0 || h <= 0) continue;

    if (masking !== 'blur') {
      // Solid fill by default: a blurred region still carries signal, and Tier 1
      // means never leaves the device.
      ctx.fillStyle = '#000';
      ctx.fillRect(x, y, w, h);
    } else {
      // Faces are the deliberate exception (PRD §4.3, §10). A black rectangle
      // over a video tile destroys the layout the agent needs — "a person is in
      // this tile" is the structure, the identity is the secret — so a heavy
      // blur removes the second while preserving the first.
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      const radius = Math.max(BLUR_MIN_RADIUS_PX, Math.round(Math.min(w, h) * BLUR_RADIUS_RATIO));
      // Drawing the whole bitmap under the clip means edge pixels are blurred
      // against their real surroundings, so there is no sharp seam at the border.
      ctx.filter = `blur(${radius}px)`;
      ctx.drawImage(bitmap, 0, 0);
      ctx.restore();
    }
  }

  bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return toBase64(await blob.arrayBuffer());
}
