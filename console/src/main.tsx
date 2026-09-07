import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import "./styles.css";

const host = document.getElementById("root");
if (!host) throw new Error("#root missing from index.html");
createRoot(host).render(<StrictMode><App /></StrictMode>);
