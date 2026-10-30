import type { ThreadMessage } from "@deskmates/contracts";
import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "../../i18n/i18n-provider.js";
import { ApprovalCard, type ApprovalCardProps, decisionLabel } from "../approvals/approval-card.js";

/** Keep the request and its receipts together without dropping their audit text or deep links. */
export function ChatApproval({
  receipts,
  reveal,
  ...props
}: ApprovalCardProps & { receipts: readonly ThreadMessage[]; reveal: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(reveal);
  useEffect(() => {
    if (reveal) setOpen(true);
  }, [reveal]);
  if (props.approval?.decision === undefined) return <ApprovalCard {...props} compact />;
  const { decidedBy, ...withoutActor } = props.approval;
  return (
    <details
      className="chat-approval-receipt"
      data-chat-disclosure
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <ChevronRight size={14} aria-hidden="true" />
        <span>{decisionLabel(decidedBy === "system:expiry" ? props.approval : withoutActor)}</span>
      </summary>
      <ApprovalCard {...props} compact />
      {receipts.length > 0 ? (
        <details className="chat-approval-audit" open={reveal}>
          <summary>{t("actor.audit")}</summary>
          {receipts.map((receipt) => (
            <div key={receipt.id} id={`message-${receipt.id}`} className="approval-decision-text">
              <time dateTime={receipt.ts}>{receipt.ts}</time>
              <p>{receipt.body}</p>
            </div>
          ))}
        </details>
      ) : null}
    </details>
  );
}
