import type { ActivityScope, PathMode } from "./sharedDfgView";

export function effectiveActivityScope(activityScope: ActivityScope, manualPathMode: PathMode): ActivityScope {
  if (activityScope === "specific") return "specific";
  if (manualPathMode === "shared") return "common";
  return activityScope;
}

export function effectiveConnectionMode(activityScope: ActivityScope, manualPathMode: PathMode): PathMode {
  return activityScope === "specific" ? "specific" : manualPathMode;
}

export function nextManualConnectionMode(activityScope: ActivityScope, currentManualMode: PathMode, requestedMode: PathMode): PathMode {
  return activityScope === "specific" ? currentManualMode : requestedMode;
}
