// The app as denext serves it: the route renders the page shell (title, stylesheet, the bundled
// fonts reachable), with no desktop runtime (the page then waits for the backend).

import "./fixture-settings.ts";

import { assertEquals, assertStringIncludes } from "@std/assert";
import { createTestApp, createTestClient } from "denext/testing";

Deno.test("app: / renders the shell; the stylesheet and fonts are served from the app", async () => {
  await using app = await createTestApp(new URL("../", import.meta.url).pathname);
  const client = createTestClient(app);
  const page = await client.get("/");
  assertEquals(page.status, 200);
  assertStringIncludes(page.text, "<title>Fleet</title>");
  assertStringIncludes(page.text, 'href="/styles.css"');
  assertStringIncludes(page.text, "Looking for a GitHub token");
  const css = await client.get("/styles.css");
  assertEquals(css.status, 200);
  assertStringIncludes(css.text, "/fonts/ibm-plex-sans-latin-400-normal.woff2");
  // No font comes from a CDN.
  assertEquals(/https?:\/\//.test(css.text), false);
  const font = await client.get("/fonts/ibm-plex-sans-latin-400-normal.woff2");
  assertEquals(font.status, 200);
});
