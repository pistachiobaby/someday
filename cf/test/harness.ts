// Vite-served harness that boots the production map client against injected
// fixture data — the same MAP_CLIENT_JS the Worker ships, no DB or network.
// Tests may pre-set window.__PLACES__ / window.__BUCKETS__ (via Playwright
// addInitScript) to drive custom data; otherwise the default fixture loads.
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { MAP_STYLES, MAP_BODY, MAP_CLIENT_JS } from "../src/mapClient";
import { FIXTURE, FIXTURE_BUCKETS } from "./fixtures";

declare global {
  interface Window {
    __PLACES__?: unknown;
    __BUCKETS__?: unknown;
    L?: unknown;
    __ready__?: boolean;
  }
}

(window as any).L = L;

const style = document.createElement("style");
style.textContent = MAP_STYLES;
document.head.append(style);

document.body.insertAdjacentHTML("afterbegin", MAP_BODY);

if (!window.__BUCKETS__) window.__BUCKETS__ = FIXTURE_BUCKETS;
if (!window.__PLACES__) window.__PLACES__ = FIXTURE;

const script = document.createElement("script");
script.textContent = MAP_CLIENT_JS;
document.body.append(script);

window.__ready__ = true;
