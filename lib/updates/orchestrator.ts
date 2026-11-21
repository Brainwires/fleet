// The update run: one machine at a time, over ports (pools, remote, clock, store, status, peers,
// events), every step logged. Pure: no Deno API; lib/deno-updates.ts supplies the ports.
//
//  0 preflight   config, lock, exclusivity, fresh status, ssh + host key (boot-id), baseline, disk
//  1 hold        hold every listed pool (drain cap + 2 h, self-expiring); pools already paused are
//                noted and never resumed by this run
//  2 drain       poll pool status and the busy plugins every 15 s, up to the cap or the window's
//                end; still busy then: resume, `deferred-busy`; a job is never stopped
//  3 final-check still idle, still free, the pause still in force with enough time left
//  4 install     detached on the host, polled, 60 min cap; survives an ssh drop and a Fleet
//                restart (re-attached from update-run.json); a failure never reboots, goes to 7
//  5 reboot      only if required or asked and the policy allows; step 3 again first
//  6 wait-boot   the boot id changes and ssh answers (15 min, Windows 45); else holds kept and
//                renewed (24 h), bad alert, no second reboot
//  7 verify      system state, no new failed unit, docker, mounts, verify.d, reach list, slots
//                ready, macOS's Xcode iOS platform; else holds kept and renewed, the user resumes
//  8 resume      the pools this run paused (not ones paused before it)
//  9 report      audit line, events, a fresh status
//
// A machine with no pools (a `server`) skips the hold, the pool half of the drain, and the resume;
// its drain and final check run only its busy plugins (none by default). Cancel is accepted
// through step 3 and resumes the pools; after that it is refused.

import { holdPoolCommand, type PoolPaths, resumeHoldCommand } from "../controls.ts";
import { redactText } from "../redact.ts";
import { busyReason, checkBusy } from "./busy.ts";
import { canInstall } from "./config.ts";
import { checkExclusive } from "./exclusive.ts";
import {
  type AuditEntry,
  CANCELLABLE_STEPS,
  clampTail,
  clampText,
  type Clock,
  MAX_REASON_LEN,
  parseBootId,
  parseResultDoc,
  parseVerifyDoc,
  type PeersPort,
  type PoolsPort,
  type RebootPolicy,
  type RemotePort,
  type RemoteResult,
  type RemoteVerb,
  RUN_ID,
  type RunEvents,
  type RunHold,
  type RunOrigin,
  type RunOutcome,
  type RunRecord,
  type RunStep,
  type StatusPort,
  type StepLog,
  type TelemetryPort,
  type UpdateMode,
  type UpdatesConfig,
  type UpdatesMachine,
  type UpdatesStore,
  type VerifyDoc,
} from "./model.ts";

const MIN = 60_000;
/** Drain, install and boot polls this often. */
export const POLL_MS = 15_000;
/** An install may run this long. */
export const INSTALL_CAP_MS = 60 * MIN;
/** Waiting for the host after a reboot. */
export const BOOT_WAIT_MS = 15 * MIN;
export const BOOT_WAIT_WINDOWS_MS = 45 * MIN;
/** A hold lasts the drain cap plus this. */
export const HOLD_EXTRA_MS = 120 * MIN;
/** A hold kept after a failure is renewed to this. */
export const RENEW_MS = 24 * 60 * MIN;
/** A gate verb's time limit (the install verb only starts the detached install). */
export const VERB_TIMEOUT_MS = 60_000;
/** A `result` document may predate the install request by this much (clock skew). */
export const RESULT_SKEW_MS = 5 * MIN;
/** After step 3 the pause must still cover the install, the boot wait and a verify margin. */
export const VERIFY_MARGIN_MS = 15 * MIN;

/** What the orchestrator runs over. */
export interface OrchestratorDeps {
  readonly config: UpdatesConfig;
  /** The pool commands' programs (`null`: no runner scheduler; machines with pools are refused). */
  readonly paths: PoolPaths | null;
  readonly pools: PoolsPort;
  readonly remote: RemotePort;
  readonly clock: Clock;
  readonly store: UpdatesStore;
  readonly status: StatusPort;
  readonly peers: PeersPort;
  readonly telemetry: TelemetryPort | null;
  readonly events: RunEvents;
  /** A fresh run id (tests pass a fixed one). */
  readonly newRunId?: (machine: string, now: number) => string;
}

/** A request for a run (Update now, a schedule, or an approved agent request). */
export interface RunRequest {
  readonly machine: string;
  readonly origin: RunOrigin;
  /** Defaults to the machine's `install`. */
  readonly mode?: UpdateMode;
  /** Defaults to the machine's `reboot`. */
  readonly reboot?: RebootPolicy;
  /** Defaults to the machine's `drainCapMinutes`. */
  readonly drainCapMinutes?: number;
  /** The maintenance window's end (ms); `null` / absent for Update now. */
  readonly windowEnd?: number | null;
}

/** `start`'s answer. */
export type StartResult =
  | { readonly ok: true; readonly runId: string; readonly done: Promise<RunRecord> }
  | { readonly ok: false; readonly reason: string };

/** `cancel`'s answer. */
export type CancelResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const defaultRunId = (machine: string, now: number) =>
  `${machine.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 40)}-${now.toString(36)}-${
    Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, "0")
  }`;

/** The boot wait for a machine. */
export const bootWaitMs = (m: UpdatesMachine) =>
  m.os === "windows" ? BOOT_WAIT_WINDOWS_MS : BOOT_WAIT_MS;

/** The update orchestrator: at most one run at a time. */
export class UpdateOrchestrator {
  #deps: OrchestratorDeps;
  #run: Run | null = null;

  constructor(deps: OrchestratorDeps) {
    this.#deps = deps;
  }

  /** The run in flight in this process, if any. */
  current(): RunRecord | null {
    return this.#run?.rec ?? null;
  }

  /** Start a run (refused when the machine can't update, the lock is taken or a peer forbids). */
  async start(req: RunRequest): Promise<StartResult> {
    const d = this.#deps;
    const machine = d.config.machines.find((m) => m.id === req.machine);
    if (!machine) return { ok: false, reason: `"${clampText(req.machine, 64)}" isn't configured.` };
    if (!canInstall(machine)) {
      return {
        ok: false,
        reason: machine.self
          ? `${machine.id} is the machine Fleet runs on: notify only, no install.`
          : `${machine.id} installs nothing (install: none).`,
      };
    }
    if (machine.pools.length > 0 && !d.paths) {
      return { ok: false, reason: "Holding pools needs the runner scheduler's pool commands." };
    }
    if (this.#run) return { ok: false, reason: "An update is already running." };
    const active = await d.store.readRun();
    const verdict = checkExclusive(machine, d.config, await d.peers.facts(), active);
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
    const now = d.clock.now();
    const id = (d.newRunId ?? defaultRunId)(machine.id, now);
    if (!RUN_ID.test(id)) return { ok: false, reason: "bad run id" };
    const mode = req.mode ?? (machine.install === "all" ? "all" : "security");
    const rec: RunRecord = {
      v: 1,
      id,
      machine: machine.id,
      origin: req.origin,
      mode,
      reboot: req.reboot ?? machine.reboot,
      drainCapMinutes: req.drainCapMinutes ?? machine.drainCapMinutes,
      windowEnd: req.windowEnd ?? null,
      startedAt: now,
      step: "preflight",
      stepAt: now,
      holds: [],
      bootId: null,
      baseline: null,
      installAt: null,
      installOk: null,
      rebootNeeded: false,
      rebooted: false,
      steps: [],
      outcome: null,
      keptHolds: [],
    };
    if (!await d.store.claimRun(rec)) {
      return { ok: false, reason: "Another update is in flight; one runs at a time." };
    }
    const run = new Run(d, machine, rec);
    this.#run = run;
    const done = run.go("preflight").finally(() => {
      if (this.#run === run) this.#run = null;
    });
    return { ok: true, runId: id, done };
  }

  /**
   * After a Fleet restart: pick up update-run.json's run. Before the install nothing was
   * installed, so this run's holds are resumed and it ends `aborted`; from the install on it
   * continues where it was (the install is polled, never started twice; no second reboot).
   */
  async reattach(): Promise<Promise<RunRecord> | null> {
    const d = this.#deps;
    if (this.#run) return null;
    const rec = await d.store.readRun();
    if (!rec) return null;
    const machine = d.config.machines.find((m) => m.id === rec.machine);
    const run = new Run(d, machine ?? null, rec);
    this.#run = run;
    const from: RunStep | "restart-early" = CANCELLABLE_STEPS.includes(rec.step)
      ? "restart-early"
      : rec.step;
    return run.go(from).finally(() => {
      if (this.#run === run) this.#run = null;
    });
  }

  /** Cancel the run in flight: accepted through step 3 (final check), refused after it. */
  cancel(runId: string): CancelResult {
    const run = this.#run;
    if (!run || run.rec.id !== runId) return { ok: false, reason: "That run isn't in flight." };
    if (!CANCELLABLE_STEPS.includes(run.rec.step)) {
      return {
        ok: false,
        reason: "The install has started; a run can't be cancelled after the final check.",
      };
    }
    run.requestCancel();
    return { ok: true };
  }
}

type Next = RunStep | null;

/** One run's state machine. */
class Run {
  rec: RunRecord;
  #d: OrchestratorDeps;
  #m: UpdatesMachine | null;
  #cancel = new AbortController();
  #stepStart = 0;
  /** The outcome so far (install-failed / reboot-pending carry through verify). */
  #outcome: RunOutcome = "succeeded";

  constructor(d: OrchestratorDeps, m: UpdatesMachine | null, rec: RunRecord) {
    this.#d = d;
    this.#m = m;
    this.rec = rec;
    if (rec.installOk === false) this.#outcome = "install-failed";
  }

  requestCancel(): void {
    this.#cancel.abort();
  }

  get #cancelled(): boolean {
    return this.#cancel.signal.aborted;
  }

  get #now(): number {
    return this.#d.clock.now();
  }

  get #machine(): UpdatesMachine {
    if (!this.#m) throw new Error("machine not configured");
    return this.#m;
  }

  // ---- bookkeeping ----

  async #enter(step: RunStep, patch: Partial<RunRecord> = {}): Promise<void> {
    this.#stepStart = this.#now;
    this.rec = { ...this.rec, ...patch, step, stepAt: this.#stepStart };
    await this.#d.store.saveRun(this.rec);
  }

  async #log(
    ok: boolean,
    detail: string,
    extra: { code?: number; tail?: string } = {},
  ): Promise<void> {
    const entry: StepLog = {
      step: this.rec.step,
      startedAt: this.#stepStart,
      endedAt: this.#now,
      ok,
      detail: clampText(detail, MAX_REASON_LEN),
      ...(extra.code !== undefined ? { code: extra.code } : {}),
      ...(extra.tail ? { tail: clampTail(redactText(extra.tail)) } : {}),
    };
    this.rec = { ...this.rec, steps: [...this.rec.steps, entry] };
    await this.#d.store.saveRun(this.rec);
    this.#d.events({ kind: "step", run: this.rec, step: this.rec.step, text: entry.detail });
  }

  #alert(text: string): void {
    this.#d.events({ kind: "alert", run: this.rec, text: clampText(text, MAX_REASON_LEN) });
  }

  async #save(patch: Partial<RunRecord>): Promise<void> {
    this.rec = { ...this.rec, ...patch };
    await this.#d.store.saveRun(this.rec);
  }

  #verb(verb: RemoteVerb, m: UpdatesMachine = this.#machine): Promise<RemoteResult> {
    return this.#d.remote.run(m, verb, { timeoutMs: VERB_TIMEOUT_MS });
  }

  /** Sleep one poll, but no further than `until`; a cancel wakes it early. */
  #poll(until: number, signal?: AbortSignal): Promise<void> {
    const ms = Math.max(0, Math.min(POLL_MS, until - this.#now));
    return this.#d.clock.sleep(ms, signal);
  }

  #ownHolds(): RunHold[] {
    return this.rec.holds.filter((h) => !h.pausedBefore);
  }

  /** Resume this run's own holds; the commands that failed. */
  async #resumeOwn(): Promise<string[]> {
    const failed: string[] = [];
    for (const h of this.#ownHolds()) {
      const built = this.#d.paths ? resumeHoldCommand(h.pool, this.#d.paths) : null;
      if (!built || !built.ok) {
        failed.push(h.pool);
        continue;
      }
      const r = await this.#d.pools.run(built.command).catch(() => ({ code: -1, output: "" }));
      if (r.code !== 0) {
        failed.push(h.pool);
        this.#alert(
          `Couldn't resume pool ${h.pool}; run: ${built.command.program} ${
            built.command.args.join(" ")
          }`,
        );
      }
    }
    return failed;
  }

  /** Renew this run's holds to 24 h and keep them (host down, verify failed). */
  async #keepHolds(): Promise<void> {
    const kept: string[] = [];
    for (const h of this.#ownHolds()) {
      kept.push(h.pool);
      const built = this.#d.paths
        ? holdPoolCommand(h.pool, RENEW_MS / 1000, this.rec.id, this.#d.paths)
        : null;
      const r = built?.ok
        ? await this.#d.pools.run(built.command).catch(() => ({ code: -1, output: "" }))
        : { code: -1, output: "" };
      if (r.code !== 0) this.#alert(`Couldn't renew the hold on ${h.pool}; it expires on its own.`);
    }
    await this.#save({ keptHolds: kept });
  }

  // ---- the loop ----

  async go(from: RunStep | "restart-early"): Promise<RunRecord> {
    let next: Next;
    try {
      next = from === "restart-early" ? await this.#restartEarly() : from;
      while (next) next = await this.#step(next);
    } catch (err) {
      // A port threw: nothing more is attempted; holds expire on their own if not resumed.
      const msg = err instanceof Error ? err.message : String(err);
      this.#alert(`The update stopped: ${msg}`);
      if (CANCELLABLE_STEPS.includes(this.rec.step)) await this.#resumeOwn().catch(() => {});
      this.#outcome = CANCELLABLE_STEPS.includes(this.rec.step) ? "aborted" : "verify-failed";
      await this.#report().catch(() => {});
    }
    return this.rec;
  }

  #step(step: RunStep): Promise<Next> {
    switch (step) {
      case "preflight":
        return this.#preflight();
      case "hold":
        return this.#hold();
      case "drain":
        return this.#drain();
      case "final-check":
        return this.#finalCheck();
      case "install":
        return this.#install();
      case "reboot":
        return this.#reboot();
      case "wait-boot":
        return this.#waitBoot();
      case "verify":
        return this.#verify();
      case "resume":
        return this.#resume();
      case "report":
        return this.#report().then(() => null);
    }
  }

  /** End before the install: resume this run's holds, then report `outcome`. */
  async #endEarly(outcome: RunOutcome, detail: string): Promise<Next> {
    await this.#log(outcome === "nothing-to-do", detail);
    const failed = await this.#resumeOwn();
    this.#outcome = outcome;
    if (failed.length) this.#alert(`Pools left paused: ${failed.join(", ")}`);
    return "report";
  }

  async #restartEarly(): Promise<Next> {
    await this.#log(false, "Fleet restarted before the install; nothing was installed");
    await this.#resumeOwn();
    this.#outcome = "aborted";
    return "report";
  }

  async #preflight(): Promise<Next> {
    await this.#enter("preflight");
    const m = this.#machine;
    const st = await this.#d.status.refresh(m);
    if (st.error || !st.host) {
      return this.#endEarly("aborted", `status check failed: ${st.error ?? "no status"}`);
    }
    const h = st.host;
    const due = h.reboot.required || this.rec.reboot === "always" ||
      (this.rec.mode === "all" ? h.pending.total > 0 : h.pending.security > 0);
    if (!due) return this.#endEarly("nothing-to-do", "nothing pending and no reboot due");
    const boot = await this.#verb("boot-id");
    const bootId = boot.code === 0 ? parseBootId(boot.stdout) : null;
    if (!bootId) {
      return this.#endEarly(
        "aborted",
        boot.unreachable ? "ssh didn't connect (or the host key didn't match)" : "no boot id",
      );
    }
    const v = await this.#verb("verify");
    const baseline = v.code === 0 ? parseVerifyDoc(v.stdout) : null;
    if (!baseline) return this.#endEarly("aborted", "no baseline from the host's verify");
    if (baseline.freeDiskMb !== null && baseline.freeDiskMb < this.#d.config.minFreeDiskMb) {
      return this.#endEarly(
        "aborted",
        `only ${baseline.freeDiskMb} MB free (needs ${this.#d.config.minFreeDiskMb})`,
      );
    }
    await this.#save({ bootId, baseline });
    if (this.#cancelled) return this.#endEarly("cancelled", "cancelled");
    await this.#log(
      true,
      `${h.pending.total} pending (${h.pending.security} security)${
        h.reboot.required ? ", reboot required" : ""
      }`,
    );
    return m.pools.length > 0 ? "hold" : m.busy.length > 0 ? "drain" : "install";
  }

  async #hold(): Promise<Next> {
    await this.#enter("hold");
    const m = this.#machine;
    const seconds = this.rec.drainCapMinutes * 60 + HOLD_EXTRA_MS / 1000;
    const holdEnd = this.#now + seconds * 1000;
    for (const pool of m.pools) {
      const s = await this.#d.pools.state(pool);
      const covers = s.pause && (s.pause.until === null || s.pause.until >= holdEnd);
      if (s.pause && covers) {
        await this.#save({
          holds: [...this.rec.holds, { pool, until: s.pause.until, pausedBefore: true }],
        });
        continue;
      }
      const built = holdPoolCommand(pool, seconds, this.rec.id, this.#d.paths!);
      const r = built.ok
        ? await this.#d.pools.run(built.command)
        : { code: -1, output: built.message };
      if (r.code !== 0) {
        return this.#endEarly("aborted", `couldn't hold ${pool}`);
      }
      // A pool paused before (but not long enough) is held too, and still never resumed.
      await this.#save({
        holds: [...this.rec.holds, { pool, until: holdEnd, pausedBefore: s.pause !== null }],
      });
    }
    if (this.#cancelled) return this.#endEarly("cancelled", "cancelled");
    const before = this.rec.holds.filter((x) => x.pausedBefore).map((x) => x.pool);
    await this.#log(
      true,
      `held ${m.pools.join(", ")}${before.length ? ` (already paused: ${before.join(", ")})` : ""}`,
    );
    return "drain";
  }

  #busyNow(): Promise<string | null> {
    return checkBusy({
      machine: this.#machine,
      config: this.#d.config,
      pools: this.#d.pools,
      remote: this.#d.remote,
      telemetry: this.#d.telemetry,
      activeRun: this.rec,
    }).then(busyReason);
  }

  async #drain(): Promise<Next> {
    await this.#enter("drain");
    const cap = this.#stepStart + this.rec.drainCapMinutes * MIN;
    const deadline = Math.min(cap, this.rec.windowEnd ?? Infinity);
    for (;;) {
      if (this.#cancelled) return this.#endEarly("cancelled", "cancelled while draining");
      const reason = await this.#busyNow();
      if (reason === null) break;
      if (this.#now >= deadline) {
        return this.#endEarly("deferred-busy", `still busy at the drain cap: ${reason}`);
      }
      await this.#poll(deadline, this.#cancel.signal);
    }
    await this.#log(true, "idle");
    return "final-check";
  }

  /** Step 3's checks; the reason they fail, or `null`. */
  async #stillClear(): Promise<string | null> {
    const busy = await this.#busyNow();
    if (busy) return busy;
    const needed = INSTALL_CAP_MS + bootWaitMs(this.#machine) + VERIFY_MARGIN_MS;
    for (const h of this.rec.holds) {
      const s = await this.#d.pools.state(h.pool);
      if (!s.pause) return `${h.pool} is no longer paused`;
      if (s.pause.until !== null && s.pause.until - this.#now < needed) {
        return `${h.pool}'s pause ends too soon`;
      }
    }
    return null;
  }

  async #finalCheck(): Promise<Next> {
    await this.#enter("final-check");
    const reason = await this.#stillClear();
    if (reason) return this.#endEarly("aborted", `final check: ${reason}`);
    if (this.#cancelled) return this.#endEarly("cancelled", "cancelled");
    await this.#log(true, "clear");
    return "install";
  }

  async #install(): Promise<Next> {
    const resuming = this.rec.step === "install" && this.rec.installAt !== null;
    if (!resuming) {
      // From here on a cancel is refused (#enter moves the step past the cancellable ones).
      // One write: a restart sees the step and when the install was asked for together.
      await this.#enter("install", { installAt: this.#now });
      const verb = this.rec.mode === "all" ? "install-all" : "install-security";
      const kick = await this.#verb(verb);
      if (!kick.unreachable && !kick.timedOut && kick.code !== 0) {
        await this.#save({ installOk: false });
        await this.#log(false, `the host refused the install (exit ${kick.code})`, {
          code: kick.code,
          tail: kick.stdout,
        });
        this.#outcome = "install-failed";
        return "verify";
      }
    } else {
      this.#stepStart = this.rec.stepAt;
    }
    const installAt = this.rec.installAt!;
    const end = installAt + INSTALL_CAP_MS;
    for (;;) {
      const r = await this.#verb("result");
      const doc = r.code === 0 ? parseResultDoc(r.stdout) : null;
      const ours = doc && doc.startedAt !== null && doc.startedAt >= installAt - RESULT_SKEW_MS;
      if (doc && ours && (doc.state === "succeeded" || doc.state === "failed")) {
        const ok = doc.state === "succeeded";
        await this.#save({ installOk: ok, rebootNeeded: doc.rebootRequired });
        await this.#log(ok, ok ? "installed" : "the install failed", {
          ...(doc.exitCode !== null ? { code: doc.exitCode } : {}),
          tail: doc.tail,
        });
        if (!ok) {
          this.#outcome = "install-failed";
          return "verify";
        }
        return "reboot";
      }
      if (this.#now >= end) {
        await this.#save({ installOk: false });
        await this.#log(false, "the install didn't finish within 60 min");
        this.#outcome = "install-failed";
        return "verify";
      }
      await this.#poll(end);
    }
  }

  async #reboot(): Promise<Next> {
    const resumingSent = this.rec.step === "reboot" && this.rec.rebooted;
    if (resumingSent) return "wait-boot";
    await this.#enter("reboot");
    const policy = this.rec.reboot;
    const want = policy === "always" || (policy === "if-needed" && this.rec.rebootNeeded);
    if (!want) {
      if (this.rec.rebootNeeded) {
        this.#outcome = "reboot-pending";
        await this.#log(false, "a reboot is required; the policy is never");
      } else await this.#log(true, "no reboot needed");
      return "verify";
    }
    const reason = await this.#stillClear();
    if (reason) {
      this.#outcome = "reboot-pending";
      await this.#log(false, `reboot skipped: ${reason}`);
      return "verify";
    }
    // Recorded before it is sent: a restart never sends a second reboot.
    await this.#save({ rebooted: true });
    const r = await this.#verb("reboot");
    if (!r.unreachable && r.code !== 0) {
      await this.#save({ rebooted: false });
      this.#outcome = "reboot-pending";
      await this.#log(false, `the host refused the reboot (exit ${r.code})`, { code: r.code });
      return "verify";
    }
    await this.#log(true, "reboot asked");
    return "wait-boot";
  }

  async #waitBoot(): Promise<Next> {
    if (this.rec.step !== "wait-boot") await this.#enter("wait-boot");
    else this.#stepStart = this.rec.stepAt;
    const end = this.#stepStart + bootWaitMs(this.#machine);
    for (;;) {
      const r = await this.#verb("boot-id");
      const id = r.code === 0 ? parseBootId(r.stdout) : null;
      if (id && id !== this.rec.bootId) {
        await this.#log(true, "back up");
        return "verify";
      }
      if (this.#now >= end) {
        await this.#log(false, "the host didn't come back");
        await this.#keepHolds();
        this.#alert(`${this.#machine.id} didn't come back after the reboot; its pools stay held.`);
        this.#outcome = "host-down";
        return "report";
      }
      await this.#poll(end);
    }
  }

  /** Why the host fails verify, or `[]`. */
  async #verifyProblems(): Promise<string[]> {
    const m = this.#machine;
    const r = await this.#verb("verify");
    const v = r.code === 0 ? parseVerifyDoc(r.stdout) : null;
    if (!v) return [r.unreachable ? "the host didn't answer verify" : "no verify document"];
    const base: VerifyDoc | null = this.rec.baseline;
    const out: string[] = [];
    if (v.system && v.system !== "running" && v.system !== "degraded") {
      out.push(`system is ${v.system}`);
    }
    const before = new Set(base?.failedUnits ?? []);
    const fresh = v.failedUnits.filter((u) => !before.has(u));
    if (fresh.length) out.push(`new failed units: ${fresh.join(", ")}`);
    if (base?.docker === "active" && v.docker !== "active") out.push("docker isn't active");
    for (const mount of m.verify.mounts) {
      if (!v.mounts.includes(mount)) out.push(`${mount} isn't mounted`);
    }
    for (const c of v.checks) if (!c.ok) out.push(`verify.d/${c.name} failed`);
    const ios = (l: readonly string[] | null) => (l ?? []).some((p) => /\biOS\b/.test(p));
    if (m.os === "macos" && ios(base?.xcodePlatforms ?? null) && !ios(v.xcodePlatforms)) {
      out.push(
        "the Xcode iOS platform is gone (repair: xcodebuild -downloadPlatform iOS, as the login user)",
      );
    }
    for (const g of m.verify.reach) {
      const guest = this.#d.config.machines.find((x) => x.id === g);
      if (!guest) continue;
      const gr = await this.#verb("boot-id", guest);
      if (gr.code !== 0 || !parseBootId(gr.stdout)) out.push(`${g} doesn't answer`);
    }
    if (m.pools.length > 0) {
      const ready = await this.#d.pools.ready(m.pools);
      if (!ready.ok) out.push(`slots not ready: ${ready.reason}`);
    }
    return out;
  }

  async #verify(): Promise<Next> {
    if (this.rec.step !== "verify") await this.#enter("verify");
    else this.#stepStart = this.rec.stepAt;
    const problems = await this.#verifyProblems();
    if (problems.length) {
      await this.#log(false, problems.join("; "));
      await this.#keepHolds();
      this.#alert(`${this.#machine.id} failed verify: ${problems.join("; ")}`);
      this.#outcome = "verify-failed";
      return "report";
    }
    await this.#log(true, "verified");
    return this.#machine.pools.length > 0 ? "resume" : "report";
  }

  async #resume(): Promise<Next> {
    await this.#enter("resume");
    const failed = await this.#resumeOwn();
    if (failed.length) {
      await this.#log(false, `couldn't resume ${failed.join(", ")}`);
      if (this.#outcome === "succeeded") this.#outcome = "resume-failed";
    } else {
      const own = this.#ownHolds().map((h) => h.pool);
      await this.#log(true, own.length ? `resumed ${own.join(", ")}` : "nothing to resume");
    }
    return "report";
  }

  async #report(): Promise<void> {
    await this.#enter("report");
    const outcome = this.#outcome;
    this.rec = { ...this.rec, outcome };
    const entry: AuditEntry = {
      v: 1,
      id: this.rec.id,
      machine: this.rec.machine,
      origin: this.rec.origin,
      mode: this.rec.mode,
      reboot: this.rec.reboot,
      startedAt: this.rec.startedAt,
      endedAt: this.#now,
      outcome,
      steps: this.rec.steps,
      keptHolds: this.rec.keptHolds,
    };
    await this.#d.store.appendAudit(entry);
    this.#d.events({ kind: "done", run: this.rec, outcome });
    if (this.#m) await this.#d.status.refresh(this.#m).catch(() => null);
    await this.#d.store.clearRun(this.rec.id);
  }
}
