// The runner settings' setting (integrations.runnerScheduler.controls.configHelper): parsed with
// `~/` allowed, refused when it isn't a path, carried into the pool paths and into an internal
// build's --allow-run; absent means no runner settings.

import { assert, assertEquals, assertFalse } from "@std/assert";
import { validateSettings } from "../lib/settings.ts";
import { poolPaths, poolPrograms } from "../lib/controls.ts";
import { grantsFromConfig } from "../lib/build-grants.ts";

const doc = (controls: Record<string, unknown>) => ({
  v: 1,
  integrations: { runnerScheduler: { controls: { pausePool: "/opt/ops/pause.sh", ...controls } } },
});

Deno.test("configHelper: parsed (~/ allowed), carried into the pool paths and the build grants", () => {
  const r = validateSettings(doc({ configHelper: "~/ops/apply-config.sh" }));
  assert(r.ok);
  const c = r.settings.integrations.runnerScheduler!.controls!;
  assertEquals(c.configHelper, "~/ops/apply-config.sh");
  const p = poolPaths(c, "/home/me")!;
  assertEquals(p.configHelper, "/home/me/ops/apply-config.sh");
  assert(poolPrograms(p).includes("/home/me/ops/apply-config.sh"));
  const g = grantsFromConfig(doc({ configHelper: "~/ops/apply-config.sh" }), "/home/me");
  assert(g.run.includes("/home/me/ops/apply-config.sh"), "an internal build may run the helper");
});

Deno.test("configHelper: absent is off; a non-path is refused", () => {
  const r = validateSettings(doc({}));
  assert(r.ok);
  assertEquals(r.settings.integrations.runnerScheduler!.controls!.configHelper, "");
  const p = poolPaths(r.settings.integrations.runnerScheduler!.controls, "/home/me")!;
  assertEquals(p.configHelper, "");
  assertFalse(poolPrograms(p).some((x) => x.endsWith("apply-config.sh")));
  const bad = validateSettings(doc({ configHelper: "rm -rf" }));
  assertFalse(bad.ok);
});
