// Unit tests for the one-RPC snapshot + resource-telemetry extractors: the
// pure mappers behind sidebarSnapshot()/topSurfaceSamples() and the
// surface-health failure predicate. Shapes mirror live probes of cmux 0.64.12
// (2026-06-09). Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  portLabel,
  extractSidebarWorkspaces,
  extractTopSamples,
  surfaceHealthFailure,
} from "./cmux.js";

// ── extractSidebarWorkspaces ─────────────────────────────────────────────────

const SNAPSHOT_RAW = {
  seq: 247635,
  workspaces: [
    {
      id: "WS-UUID-1",
      ref: "workspace:90",
      listening_ports: [3000, "5173"],
      pull_request_urls: ["https://github.com/o/r/pull/12"],
      git_branches: ["fleet/agent-x"],
      latest_conversation_message: "All tests green.",
    },
    {
      // missing-fields entry: everything optional absent / null
      id: "WS-UUID-2",
      ref: "workspace:91",
      listening_ports: null,
      pull_request_urls: null,
      git_branches: null,
      latest_conversation_message: null,
    },
    { ref: "workspace:92" }, // no UUID → dropped (can't join to the registry)
  ],
};

test("extractSidebarWorkspaces: maps fields and tolerates missing ones", () => {
  const out = extractSidebarWorkspaces(SNAPSHOT_RAW);
  assert.equal(out.length, 2); // the UUID-less entry is dropped
  const [a, b] = out;
  assert.equal(a!.id, "WS-UUID-1");
  assert.deepEqual(a!.listeningPorts, [":3000", ":5173"]);
  assert.deepEqual(a!.pullRequestUrls, ["https://github.com/o/r/pull/12"]);
  assert.deepEqual(a!.gitBranches, ["fleet/agent-x"]);
  assert.equal(a!.latestConversationMessage, "All tests green.");
  assert.deepEqual(b!.listeningPorts, []);
  assert.deepEqual(b!.pullRequestUrls, []);
  assert.equal(b!.latestConversationMessage, undefined);
});

test("extractSidebarWorkspaces: garbage payloads yield an empty list, never throw", () => {
  for (const raw of [null, undefined, 42, "x", {}, { workspaces: "nope" }]) {
    assert.deepEqual(extractSidebarWorkspaces(raw), []);
  }
});

test("portLabel: numbers, strings, port-ish objects; garbage dropped", () => {
  assert.equal(portLabel(3000), ":3000");
  assert.equal(portLabel("5173"), ":5173");
  assert.equal(portLabel(":8080"), ":8080");
  assert.equal(portLabel({ port: 4000 }), ":4000");
  assert.equal(portLabel({ number: "9229" }), ":9229");
  assert.equal(portLabel({}), undefined);
  assert.equal(portLabel(null), undefined);
  assert.equal(portLabel(""), undefined);
});

// ── extractTopSamples ────────────────────────────────────────────────────────

const TOP_RAW = {
  windows: [
    {
      workspaces: [
        {
          ref: "workspace:90",
          panes: [
            {
              surfaces: [
                {
                  id: "SURF-UUID-1",
                  ref: "surface:144",
                  resources: { cpu_percent: 95.2, resident_bytes: 192_233_472 },
                },
                { ref: "surface:145" }, // no UUID → dropped
              ],
            },
          ],
        },
      ],
    },
  ],
};

test("extractTopSamples: walks windows→workspaces→panes→surfaces by UUID", () => {
  const out = extractTopSamples(TOP_RAW);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { surfaceId: "SURF-UUID-1", cpuPercent: 95.2, residentBytes: 192_233_472 });
});

test("extractTopSamples: missing resources default to zero; garbage never throws", () => {
  const out = extractTopSamples({
    windows: [{ workspaces: [{ panes: [{ surfaces: [{ id: "S" }] }] }] }],
  });
  assert.deepEqual(out, [{ surfaceId: "S", cpuPercent: 0, residentBytes: 0 }]);
  for (const raw of [null, {}, { windows: 7 }]) assert.deepEqual(extractTopSamples(raw), []);
});

// ── surfaceHealthFailure ─────────────────────────────────────────────────────

test("surfaceHealthFailure: healthy entry and no-data both read as 'no failure'", () => {
  const entries = [{ id: "S1", ref: "surface:1", type: "terminal", in_window: false }];
  assert.equal(surfaceHealthFailure(entries, "S1"), undefined);
  // Capability gate / failed call → undefined entries: NEVER a failure.
  assert.equal(surfaceHealthFailure(undefined, "S1"), undefined);
});

test("surfaceHealthFailure: missing surface and explicit negatives report reasons", () => {
  assert.match(surfaceHealthFailure([], "S1")!, /missing/);
  assert.match(surfaceHealthFailure([{ id: "S1", healthy: false }], "S1")!, /healthy=false/);
  assert.match(surfaceHealthFailure([{ id: "S1", alive: false }], "S1")!, /alive=false/);
  assert.match(surfaceHealthFailure([{ id: "S1", error: "pty gone" }], "S1")!, /pty gone/);
});
