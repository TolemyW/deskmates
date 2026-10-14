import { createRoot } from "react-dom/client";
import { Studio } from "./studio.js";
import "./studio.css";

const root = document.getElementById("root");
if (root) createRoot(root).render(<Studio />);
