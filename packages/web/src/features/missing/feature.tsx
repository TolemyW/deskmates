import { defineFeature } from "../../app/feature.js";
import { MissingPage } from "../../app/missing-page.js";
import { routes } from "./route.js";

export const feature = defineFeature(routes, {
  render: (route) => <MissingPage path={route.path} />,
});
