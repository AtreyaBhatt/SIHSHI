import { api } from '../shared/browser';
import { DOM_RULES } from '../pii-detection/dom-heuristics';
import { PATTERNS } from '../pii-detection/patterns';

/**
 * Demo-only switch: names of detectors (DomRule/PatternRule `detector`, e.g.
 * `regex:email`) that `detectPii` skips this pass, so the independent firewall
 * scan (`redaction/firewall.ts`) is the one that catches the value instead —
 * proof it works, not a way to make it optional. Never read by the firewall.
 */
export const DEBUG_DISABLED_DETECTORS_KEY = 'athena:debug-disabled-detectors';
/** Every name the cascade can report; anything else is rejected, never stored. */
const KNOWN_DETECTORS = new Set([...DOM_RULES, ...PATTERNS].map((rule) => rule.detector));

export async function readDisabledDetectors(): Promise<Set<string> | undefined> {
  try {
    // storage.session, so the switch is gone after a browser restart.
    const stored = (await api.storage.session.get(DEBUG_DISABLED_DETECTORS_KEY))?.[
      DEBUG_DISABLED_DETECTORS_KEY
    ] as string[] | undefined;
    return stored && stored.length > 0 ? new Set(stored) : undefined;
  } catch {
    return undefined;
  }
}

/** Validates and stores the demo switch (names omitted: read only); returns the stored set. */
export async function setDisabledDetectors(input: string[] | undefined): Promise<string[]> {
  if (input !== undefined) {
    const names = Array.isArray(input) ? input : []; // a malformed message clears rather than throws
    const unknown = names.filter((name) => !KNOWN_DETECTORS.has(name));
    if (unknown.length > 0) throw new Error(`${unknown.length} name(s) are not detector names (use the names shown against each finding, e.g. regex:email). Nothing was changed.`);
    await api.storage.session.set({ [DEBUG_DISABLED_DETECTORS_KEY]: [...new Set(names)] });
  }
  return [...((await readDisabledDetectors()) ?? [])];
}
// Earlier builds kept the switch in storage.local, where it outlived the session.
void api.storage.local.remove(DEBUG_DISABLED_DETECTORS_KEY).catch(() => {});
