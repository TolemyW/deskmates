// Operator route policies for files; aggregated in `../route-policy.ts` (ADR-0022 P2).

import { type PolicyTable, member } from "./policy.js";

// ADR-0014 amendment A5 decision 28: Members, Admins and Owners upload, Guests do not; the guard
// checks the current workspace role on every request of an upload.
const UPLOAD = "the upload is looked up inside the guarded workspace";
const OWN_UPLOAD = `${UPLOAD}; only its uploader sends parts or completes it`;
const READ_OR_CANCEL = `${UPLOAD}; its uploader, an Admin or an Owner reads or cancels it`;

export const filesRoutePolicies: PolicyTable = {
  "GET /api/workspaces/:id/files": member({ params: { id: "workspace" } }),
  // ADR-0014 amendment A2: the read-only Files collection; Members read it like a download (C6).
  "GET /api/workspaces/:id/assets": member({ params: { id: "workspace" } }),
  "POST /api/workspaces/:id/uploads": member({ params: { id: "workspace" } }),
  "GET /api/workspaces/:id/uploads/:uploadId": member({
    params: { id: "workspace" },
    handlerCheck: READ_OR_CANCEL,
  }),
  "DELETE /api/workspaces/:id/uploads/:uploadId": member({
    params: { id: "workspace" },
    handlerCheck: READ_OR_CANCEL,
  }),
  "PUT /api/workspaces/:id/uploads/:uploadId/parts": member({
    params: { id: "workspace" },
    handlerCheck: OWN_UPLOAD,
  }),
  "POST /api/workspaces/:id/uploads/:uploadId/complete": member({
    params: { id: "workspace" },
    handlerCheck: OWN_UPLOAD,
  }),
};
