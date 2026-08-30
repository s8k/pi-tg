export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PiModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  /** pi’s per-model mapping; null = unsupported, undefined = infer (xhigh/max then unsupported) */
  thinkingLevelMap?: Partial<Record<PiThinkingLevel, string | null>>;
}

const ALL: PiThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Mirrors pi’s thinking-level support rules (see “Verified API facts”). */
export function supportedThinkingLevels(model: PiModel): PiThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return ALL.filter((lvl) => {
    const v = model.thinkingLevelMap?.[lvl];
    if (v === null) return false; // explicitly unsupported
    if ((lvl === "xhigh" || lvl === "max") && v === undefined) return false; // needs explicit map entry
    return true;
  });
}
