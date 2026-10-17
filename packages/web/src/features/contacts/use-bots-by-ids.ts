// A bounded bot name map (#113 §3.2): a screen passes the bot ids it renders and gets back those
// bots, asked for by id and never the whole list. Ids already answered are not asked again; a
// failed lookup leaves the ids unlabelled (callers fall back to the id).

import type { BotDefinition } from "@deskmates/contracts";
import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../api/client.js";

export function useBotsByIds(
  api: Pick<ApiClient, "listBotsByIds">,
  ids: readonly string[],
): ReadonlyMap<string, BotDefinition> {
  const [bots, setBots] = useState<ReadonlyMap<string, BotDefinition>>(new Map());
  const asked = useRef(new Set<string>());
  const apiRef = useRef(api);
  if (apiRef.current !== api) {
    apiRef.current = api;
    asked.current = new Set();
  }
  const key = [...new Set(ids)].sort().join(",");
  useEffect(() => {
    const missing = key === "" ? [] : key.split(",").filter((id) => !asked.current.has(id));
    if (missing.length === 0) return;
    for (const id of missing) asked.current.add(id);
    // The answer is merged even after `ids` moved on: the ids stay asked, so it must land.
    api
      .listBotsByIds(missing)
      .then((found) => {
        if (found.length === 0) return;
        setBots((prev) => {
          const next = new Map(prev);
          for (const bot of found) next.set(bot.id, bot);
          return next;
        });
      })
      .catch(() => {
        // Unlabelled rows still work; a later render may ask again.
        for (const id of missing) asked.current.delete(id);
      });
  }, [api, key]);
  return bots;
}
