import { DeskmatesError } from "@deskmates/contracts";
import type { DockerProvider } from "../docker-provider.js";

/** Fail the suite's setup once, before dependent cases use an uninitialized sandbox handle. */
export async function requireEgressImage(provider: DockerProvider, image: string): Promise<void> {
  const response = await provider.client.request(
    "GET",
    `/images/${encodeURIComponent(image)}/json`,
  );
  if (response.status === 200) return;
  throw new DeskmatesError("sandbox_unavailable", "egress proxy image is unavailable", {
    reason: response.status === 404 ? "image_missing" : "image_inspect_failed",
    image,
    status: response.status,
  });
}
