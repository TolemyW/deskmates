// Use the Gateway's actual addressing metadata. An addressed message requests a handoff;
// it does not prove that the recipient ran, and the latest reply is not labelled a final result.
import type { ThreadMessage } from "@deskmates/contracts";
import { useT } from "../../i18n/i18n-provider.js";

export function MessageContext({
  message,
  botName,
}: { message: ThreadMessage; botName: (id: string) => string }) {
  const t = useT();
  if (message.authorKind !== "bot") return null;
  const names = message.mentions.some((mention) => mention.kind === "everyone")
    ? t("chatPane.message.everyone")
    : [
        ...new Set(
          message.mentions.flatMap((mention) =>
            mention.kind === "bot" ? [botName(mention.botId)] : [],
          ),
        ),
      ].join(", ");
  return (
    <>
      {names ? (
        <span className="message-addressed" title={t("chatPane.message.addressed", { names })}>
          {t("chatPane.message.addressed", { names })}
        </span>
      ) : null}
    </>
  );
}
