// Which avatar each bot wears, by name and by id, so every place that draws a bot by name (the
// transcript, the rail, member chips) shows the operator's choice without carrying the whole
// bot row around. Screens that load bots remember them here; the Avatar component looks up.

import type { BotAvatar, BotDefinition } from "@deskmates/contracts";
import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from "react";

export type AvatarLookup = (nameOrId: string) => BotAvatar | undefined;

const LookupContext = createContext<AvatarLookup>(() => undefined);
const RememberContext = createContext<(bots: readonly BotDefinition[]) => void>(() => {});

export function BotAvatarsProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<ReadonlyMap<string, BotAvatar>>(new Map());
  const remember = useCallback((bots: readonly BotDefinition[]) => {
    setEntries((prev) => {
      let next: Map<string, BotAvatar> | undefined;
      for (const bot of bots) {
        for (const key of [bot.id, bot.name]) {
          const before = prev.get(key);
          const after = bot.avatar;
          if (sameAvatar(before, after)) continue;
          next ??= new Map(prev);
          if (after) next.set(key, after);
          else next.delete(key);
        }
      }
      return next ?? prev;
    });
  }, []);
  const lookup = useCallback<AvatarLookup>((key) => entries.get(key), [entries]);
  const lookupValue = useMemo(() => lookup, [lookup]);
  return (
    <RememberContext.Provider value={remember}>
      <LookupContext.Provider value={lookupValue}>{children}</LookupContext.Provider>
    </RememberContext.Provider>
  );
}

function sameAvatar(a: BotAvatar | undefined, b: BotAvatar | undefined): boolean {
  return a?.emoji === b?.emoji && a?.color === b?.color;
}

/** The avatar for a bot name or id; undefined outside a provider or for an unknown bot. */
export function useAvatarLookup(): AvatarLookup {
  return useContext(LookupContext);
}

/** Lets a screen register the bots it loaded. A no-op outside the provider. */
export function useRememberBots(): (bots: readonly BotDefinition[]) => void {
  return useContext(RememberContext);
}
