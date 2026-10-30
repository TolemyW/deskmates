// Analytics owns no route of its own: its navigation entry opens Grafana, outside the operator
// UI (ADR-0046 decision 8). The module exists because every feature has one.

import { defineRoutes } from "../../app/routes.js";

export const routes = defineRoutes<never>({ screens: {}, segments: {} });
