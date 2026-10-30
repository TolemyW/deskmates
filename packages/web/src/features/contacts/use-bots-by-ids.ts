// A bounded bot name map (#113 §3.2): a screen passes the bot ids it renders and gets back those
// bots, asked for by id and never the whole list. Ids already answered are not asked again; a
// failed lookup leaves the ids unlabelled (callers fall back to the id).

import type { BotDefinition } from "@deskmates/contracts";
import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../api/client.js";

export function useBotLookup(api: Pick<ApiClient, "listBotsByIds">, ids: readonly string[]) {
  const [bots, setBots] = useState<ReadonlyMap<string, BotDefinition>>(new Map());
  const [failedIds, setFailedIds] = useState<ReadonlySet<string>>(new Set());
  const [revision, setRevision] = useState(0);
  const asked = useRef(new Set<string>());
  const apiRef = useRef(api);
  if (apiRef.current !== api) {
    apiRef.current = api;
    asked.current = new Set();
  }
  const key = [...new Set(ids)].sort().join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision retries a failed bounded lookup.
  useEffect(() => {
    const missing = key === "" ? [] : key.split(",").filter((id) => !asked.current.has(id));
    if (missing.length === 0) return;
    for (const id of missing) asked.current.add(id);
    setFailedIds((previous) => new Set([...previous].filter((id) => !missing.includes(id))));
    // The answer is merged even after `ids` moved on: the ids stay asked, so it must land.
    api
      .listBotsByIds(missing)
      .then((found) => {
        if (apiRef.current !== api) return;
        if (found.length === 0) return;
        setBots((prev) => {
          const next = new Map(prev);
          for (const bot of found) next.set(bot.id, bot);
          return next;
        });
      })
      .catch(() => {
        if (apiRef.current !== api) return;
        setFailedIds((previous) => new Set([...previous, ...missing]));
        // Failed ids remain eligible for an explicit retry or a changed id set.
        for (const id of missing) asked.current.delete(id);
      });
  }, [api, key, revision]);
  return {
    bots,
    error: ids.some((id) => failedIds.has(id)),
    retry: () => setRevision((value) => value + 1),
  };
}

export function useBotsByIds(
  api: Pick<ApiClient, "listBotsByIds">,
  ids: readonly string[],
): ReadonlyMap<string, BotDefinition> {
  return useBotLookup(api, ids).bots;
}
