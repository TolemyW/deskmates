// Run only in an authorized CUA session, passing its already-bound isolated-preview tab.
// No browser launch, credentials, network client, task submission or third-party automation.
export async function checkReading(tab, { expandName, collapseName, composerLabel = "Message" }) {
  const input = tab.playwright.getByRole("textbox", { name: composerLabel, exact: true });
  if ((await input.evaluate((element) => element.value)).trim())
    throw new Error("Use a dedicated fixture with an empty draft; never replace a person's draft");
  const expand = tab.playwright.getByRole("button", { name: expandName, exact: true });
  if ((await expand.count()) !== 1) throw new Error("The named historical reply must start folded");
  const position = () => tab.playwright.evaluate(() => {
    const viewport = document.querySelector(".gb-chat-viewport");
    return { top: viewport.scrollTop, height: viewport.scrollHeight, viewport: viewport.clientHeight };
  });
  const probe = "UI-only fixture draft; do not send";
  try {
    await input.fill(probe);
    await tab.getAXState({ emit: false });
    // Native keyboard focus may scroll a control into view. Establish it first, then measure
    // only the disclosure activation, rather than incorrectly counting focus movement as follow.
    await expand.press("ArrowLeft");
    await tab.getAXState({ emit: false });
    const before = await position();
    await tab.pressKey(null, "Return");
    await tab.getAXState({ emit: false });
    const after = await position();
    const draftRetained = (await input.evaluate((element) => element.value)) === probe;
    const collapse = tab.playwright.getByRole("button", { name: collapseName, exact: true });
    const expanded = (await collapse.getAttribute("aria-expanded")) === "true";
    const scrollRetained = Math.abs(before.top - after.top) <= 1;
    if (!draftRetained || !expanded || !scrollRetained)
      throw new Error(JSON.stringify({ before, after, draftRetained, expanded, scrollRetained }));
    await collapse.click();
    await tab.getAXState({ emit: false });
    return { before, after, draftRetained, expanded, scrollRetained };
  } finally {
    const collapse = tab.playwright.getByRole("button", { name: collapseName, exact: true });
    if ((await collapse.count()) === 1) {
      await collapse.click();
      await tab.getAXState({ emit: false });
    }
    // Clear only this check's own unsent fixture text, never send it.
    if ((await input.evaluate((element) => element.value)) === probe) {
      await input.fill("");
      await tab.getAXState({ emit: false });
    }
  }
}
