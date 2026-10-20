import "./lib/polyfills";
import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";
import { isWebOS } from "./lib/backend";
import { app } from "./lib/state.svelte";
import { startTv } from "./lib/tv";

// On a TV, the remote drives everything; the player handles its own keys.
if (isWebOS) startTv(() => !!app.player);

export default mount(App, { target: document.getElementById("app")! });
