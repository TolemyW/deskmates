// The fixed texts the Discord plugin sends in reply to a person's message when something was not
// received or not decided. They name what happened and never echo the person's content.

export const OTHER_MEDIA_NOTICE =
  "Only text and images reach the assistant here. Voice messages, videos, files and stickers were not received.";

export const EMPTY_MESSAGE_NOTICE =
  "That message had nothing the assistant can read. Please send text or an image.";

export const APPROVAL_REFUSED_NOTICE =
  "That approval is not part of this conversation, so it was not decided.";

export const APPROVAL_SETTLED_NOTICE = "That approval was already decided.";

export const APPROVAL_NOT_DECIDABLE_NOTICE =
  "That approval cannot be decided from Discord. Decide it in the web app.";

export function imagesRefusedNotice(count: number): string {
  const what = count === 1 ? "One image was" : `${count} images were`;
  return `${what} not received. Images must be GIF, JPEG, PNG or WebP, at most 10 MiB each, up to 4 per message.`;
}
