---
name: screenshot-evidence
description: Capture and annotate browser evidence with Playwright and ImageMagick tools already in the workspace.
---

# Screenshot evidence

Use this skill when a visual state is part of the result or a claim needs visual support.

1. Navigate with the shared browser and wait for the relevant state to settle.
2. Capture only the relevant page or element. Avoid private account details that are not needed for the task.
3. Save originals under `/work/evidence/<task>/` with descriptive names. Keep the untouched original next to any annotation.
4. Use the preinstalled ImageMagick `magick` command only for local crops, highlights, labels, or format conversion. Never replace the original.
5. Record the page title, visible URL, capture time, and what the image demonstrates in a neighboring Markdown file.
6. Check the saved image before citing it. If the page changed, capture a new file rather than silently overwriting evidence.

When a human is controlling the shared browser, wait for handback before capturing or interacting.
