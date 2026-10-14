// "Back to workspace list" (ADR-0034 decision 4): when a row of the list opened the detail, Back
// returns to that history entry, whose state holds the page; otherwise the link's own address
// (the list with the same search and filters) is followed.

let openedFromList = false;

/** A list row is opening the detail page. */
export function markOpenedFromList(): void {
  openedFromList = true;
}

/** The Back link's click: step back in history when the list opened this detail. */
export function backToList(event: { preventDefault: () => void }): void {
  if (!openedFromList) return;
  openedFromList = false;
  event.preventDefault();
  window.history.back();
}
