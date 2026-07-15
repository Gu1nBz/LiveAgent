import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "katex/dist/katex.min.css";
import "streamdown/styles.css";

if (new URLSearchParams(window.location.search).get("window") === "pet") {
  document.documentElement.classList.add("pet-window");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
