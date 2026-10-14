// Host-authored CDP code. A newly created Chromium window can ignore its initial bounds while
// the window manager initializes it; target identity alone does not prove screen placement.
export function desktopWindowCode(slot: number): string {
  if (!Number.isInteger(slot) || slot < 0 || slot > 5)
    throw new Error("Invalid desktop screen slot");
  const left = (slot % 3) * 1280;
  const top = Math.floor(slot / 3) * 720;
  return `async (page) => {
    const cdp = await page.context().newCDPSession(page);
    let target;
    try {
      const bounds = { left: ${left}, top: ${top}, width: 1280, height: 720, windowState: 'normal' };
      target = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true, left: ${left}, top: ${top}, width: 1280, height: 720 });
      const { windowId } = await cdp.send('Browser.getWindowForTarget', target);
      await cdp.send('Browser.setWindowBounds', { windowId, bounds });
      let stable = 0;
      let actual;
      for (let attempt = 0; attempt < 20; attempt++) {
        await page.waitForTimeout(50);
        actual = (await cdp.send('Browser.getWindowBounds', { windowId })).bounds;
        if (Object.keys(bounds).every(key => actual[key] === bounds[key])) {
          // Several separated reads catch a delayed initial cascade after the first match.
          if (++stable === 3) return target;
        } else {
          stable = 0;
          await cdp.send('Browser.setWindowBounds', { windowId, bounds });
        }
      }
      throw new Error('Desktop window placement did not stabilize: ' + JSON.stringify(actual));
    } catch (error) {
      if (target) await cdp.send('Target.closeTarget', target).catch(() => {});
      throw error;
    } finally {
      await cdp.detach();
    }
  }`;
}
