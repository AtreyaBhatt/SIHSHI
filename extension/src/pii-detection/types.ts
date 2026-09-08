import type { BBox, PiiTier, PiiType } from '../shared/schema';

/** Which part of a RawDomNode a detection points at. */
export type DetectionField = 'value' | 'text' | 'label';

export interface Detection {
  /** RawDomNode.path this was found on. */
  node_path: string;
  field: DetectionField;
  type: PiiType;
  tier: PiiTier;
  /** e.g. "dom:input-type", "regex:card_number". Reported in the manifest so the eval can score detectors separately. */
  detector: string;
  confidence: number;
  /**
   * Character range within the field, or null for "the whole field".
   *
   * Spans are what keep precision up: in "Contact us at ada@example.org for help"
   * only the address is masked, not the sentence. Redacting the whole node would
   * register as over-redaction against the IoU metric (PRD §8).
   */
  span: [number, number] | null;
  bbox: BBox | null;
}
