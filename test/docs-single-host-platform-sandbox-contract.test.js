/**
 * Structural tests for docs/single-host-platform-sandbox-contract.md
 * (issue #916).
 *
 * The document is the authoritative contract for the supported single-host
 * platform set and the sandbox capabilities expected from each provider
 * CLI. Issue #916 is a pure specification: no production code changes with
 * it, so these tests pin the document's own claims — the closed platform
 * and support-level sets, the rejected non-goals (native Windows, WSL1,
 * ECS/EKS/Fargate, Lambda-style runtimes, multi-host), the
 * two-sandbox-domain rule that never credits an agent CLI sandbox with
 * containing runner-owned commands, the behavioral-attestation rule for
 * the #697 §7 runner sandbox, the fail-closed startup gates (including the
 * WSL2 placement and toolchain rules), the subtraction-free degraded-mode
 * policy, the unknown-evaluates-as-absent rule, the closed capability
 * check-id set and report schema, the Antigravity
 * containment-is-verification-work stance, the spike register, and the
 * reconciliation notes in docs/tool-request-grant-tiers-contract.md §18,
 * docs/preflight-execution-plan-contract.md §20, and docs/DOMAIN.md §5
 * that land alongside it — against drift. They are structural only,
 * mirroring the doc-only pin pattern used for
 * docs/preflight-execution-plan-contract.md (#915).
 */
import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Assertions run against a whitespace-normalized copy: the document is
// hard-wrapped prose, so a claim can straddle a line break today and be
// reflowed tomorrow. Normalizing means these tests pin what the document
// says, not how it happens to be wrapped.
function read(rel) {
  return readFileSync(resolve(ROOT, rel), 'utf8').replace(/\s+/g, ' ');
}

const DOC_PATH = 'docs/single-host-platform-sandbox-contract.md';
const doc = read(DOC_PATH);
const tiers = read('docs/tool-request-grant-tiers-contract.md');
const preflight = read('docs/preflight-execution-plan-contract.md');

// docs/DOMAIN.md is a PRIVATE_ONLY_PATH (copybara/copy.bara.sky): the public
// mirror never receives it, and a test that unconditionally loads it couples
// this file to material the exported tree lacks — a dangling ENOENT in the
// public repo's own CI (issue #811). The DOMAIN.md reconciliation pins below
// therefore run only where the document exists (the private source of truth)
// and skip cleanly in the exported tree.
const domain = existsSync(resolve(ROOT, 'docs/DOMAIN.md')) ? read('docs/DOMAIN.md') : null;
const domainTest = domain === null ? test.skip : test;

describe(`${DOC_PATH} — status and scope`, () => {
  test('is marked approved design, not yet implemented', () => {
    expect(doc).toMatch(/Status: \*\*approved design, not yet implemented\*\* \(issue #916\)/);
  });

  test('states its chain position as the successor of #915', () => {
    expect(doc).toMatch(/the successor of the preflight Execution Plan contract \(#915\) in the executable chain/);
    expect(doc).toMatch(
      /#777 → #780 → #781 → #782 → #783 → #784 → #785 → #697 → #915 → #916 → #917 → #918 → #919 → #722/,
    );
  });

  test('defers to the fixed predecessor contracts it consumes', () => {
    expect(doc).toMatch(/fixed by `docs\/tool-request-grant-tiers-contract\.md` \(#697\)/);
    expect(doc).toMatch(/fixed by `docs\/preflight-execution-plan-contract\.md` \(#915\)/);
    expect(doc).toMatch(/fixed by `docs\/guided-tool-request-flow\.md`/);
    expect(doc).toMatch(/fixed by `docs\/environment-prepare-contract\.md`/);
  });

  test('adds no runtime behavior and no #697 vocabulary', () => {
    expect(doc).toMatch(/It adds no runtime behavior/);
    expect(doc).toMatch(
      /adds no tier, no `TierRefusalReason` member, and no change to that registry's policy triple/,
    );
  });

  test('states the security posture: isolation earns automation', () => {
    expect(doc).toMatch(/Issue text reaches the loop only after the trusted human boundary/);
    expect(doc).toMatch(/Isolation earns automation; automation never earns isolation\./);
  });
});

describe(`${DOC_PATH} — the two sandbox domains (§3)`, () => {
  test('never credits an agent CLI sandbox with containing runner-owned commands', () => {
    expect(doc).toMatch(
      /\*\*No agent CLI sandbox is ever credited with containing runner-owned commands\.\*\*/,
    );
    expect(doc).toMatch(
      /has changed \*\*nothing\*\* about what `npm test` run by the runner can reach/,
    );
  });

  test('the runner sandbox is never delegated to a provider CLI', () => {
    expect(doc).toMatch(/The runner sandbox is never delegated to a provider CLI\./);
    expect(doc).toMatch(/attestable on the host itself, with no agent CLI in the loop/);
  });
});

describe(`${DOC_PATH} — the normative support matrix (§4)`, () => {
  test('the runtime platform set is closed to darwin and linux', () => {
    expect(doc).toMatch(/`process\.platform` `"darwin"` or `"linux"`/);
    expect(doc).toMatch(/\*\*The platform set is closed\.\*\*/);
  });

  test('the four targets are macos, linux, wsl2, and ec2', () => {
    expect(doc).toMatch(/`macos`, `linux` \(single-host\), `wsl2` \(Windows through WSL2\), `ec2` \(the reference Linux cloud deployment\)/);
  });

  test('native Windows is rejected at startup, never degraded', () => {
    expect(doc).toMatch(
      /\*\*Native Windows execution is rejected at startup, never degraded\*\*/,
    );
  });

  test('WSL1, ECS-family, multi-host, and Lambda-style runtimes are rejected', () => {
    expect(doc).toMatch(/\| WSL1 \| rejected \|/);
    expect(doc).toMatch(/\| ECS, EKS, Fargate, distributed runners \| rejected \|/);
    expect(doc).toMatch(/\| Multi-host coordination \/ horizontal scaling \| rejected \|/);
    expect(doc).toMatch(/\| Lambda-style short-lived execution \| rejected \|/);
  });

  test('support levels are a closed set and unknown evaluates as absent', () => {
    expect(doc).toMatch(/the closed set `"supported"` \| `"degraded"` \| `"rejected"`/);
    expect(doc).toMatch(/\*\*Unknown evaluates as absent\*\*/);
  });
});

describe(`${DOC_PATH} — WSL2 boundary rules (§5.3)`, () => {
  test('loop-owned state lives on a Linux-native filesystem', () => {
    expect(doc).toMatch(/\*\*Placement: loop-owned state lives on a Linux-native filesystem\.\*\*/);
    expect(doc).toMatch(/never on a Windows-drive interop mount/);
    expect(doc).toMatch(/by containing-mount filesystem type, not by path prefix/);
  });

  test('loop-owned commands resolve to Linux executables', () => {
    expect(doc).toMatch(/\*\*Executables: loop-owned commands resolve to Linux binaries\.\*\*/);
    expect(doc).toMatch(/resolving to a `\*\.exe` or to a path on an interop mount \*\*refuses at startup\*\*/);
  });
});

describe(`${DOC_PATH} — EC2 reference shape (§5.4)`, () => {
  test('the egress-only group pairs with SSM access; direct SSH is a recorded deviation', () => {
    expect(doc).toMatch(/no inbound rule at all — which rules out direct SSH by construction/);
    expect(doc).toMatch(
      /\*\*Operator access in the reference shape is SSM Session Manager\*\*/,
    );
    expect(doc).toMatch(
      /adds one narrowly scoped inbound rule \(SSH from a fixed operator source only\) — a recorded deviation from the reference shape/,
    );
  });
});

describe(`${DOC_PATH} — provider CLI capabilities (§6–§7)`, () => {
  test('P5 containment is graded, never load-bearing', () => {
    expect(doc).toMatch(/P5 is \*\*graded, not required\*\*/);
    expect(doc).toMatch(/its absence degrades defense in depth, never correctness/);
  });

  test('the shipped baseline pins the only explicit provider sandbox flag', () => {
    expect(doc).toMatch(/`codex exec --sandbox read-only --skip-git-repo-check/);
    expect(doc).toMatch(/the only explicit `--sandbox` pin in the tree/);
    expect(doc).toMatch(/No lane passes a permission-bypass or sandbox-disabling flag anywhere in the tree\./);
  });

  test('Antigravity containment is verification work, never assumed', () => {
    expect(doc).toMatch(
      /\*\*Antigravity\/Gemini sandbox guarantees are recorded as verification work, never assumed\*\*/,
    );
  });
});

describe(`${DOC_PATH} — runner sandbox and attestation (§8)`, () => {
  test('attestation is behavioral, on the live host', () => {
    expect(doc).toMatch(
      /\*\*A runner-sandbox capability is attested only by a canary that exercises the boundary on the live host\*\*/,
    );
    expect(doc).toMatch(/\*\*never sufficient to attest containment\*\*/);
  });

  test('a host without the capability routes to the human gate, never unconfined', () => {
    expect(doc).toMatch(/`"containment-unavailable"`/);
    expect(doc).toMatch(/never to unconfined execution/);
  });

  test('the EC2 canary must cover IMDS', () => {
    expect(doc).toMatch(/169\.254\.169\.254/);
    expect(doc).toMatch(/an attempted connection to the IMDS address/);
  });

  test('the minimum canary set covers the environment allowlist behaviorally', () => {
    expect(doc).toMatch(
      /a read — from inside the boundary — of a canary environment variable planted in the orchestrator's environment outside the fixed allowlist/,
    );
    expect(doc).toMatch(
      /The environment probe is what attests `"runner-sandbox\.env-allowlist"`/,
    );
  });
});

describe(`${DOC_PATH} — fail-closed checks and degraded mode (§9)`, () => {
  test('probes fail closed', () => {
    expect(doc).toMatch(/\*\*Probes fail closed\.\*\*/);
  });

  test('degradation subtracts nothing and is never silent', () => {
    expect(doc).toMatch(/\*\*Degradation subtracts nothing and is never silent\*\*/);
    expect(doc).toMatch(/falls through per #915 §9/);
  });

  test('provider gates are doctor errors, not process refusals', () => {
    expect(doc).toMatch(/\*\*Provider gates are doctor errors, not process refusals\.\*\*/);
  });
});

describe(`${DOC_PATH} — the capability report (§10)`, () => {
  test('defines the report schema with a derived support level', () => {
    expect(doc).toMatch(/interface PlatformCapabilityReport \{/);
    expect(doc).toMatch(/derived, never hand-assigned/);
  });

  test('the check-id set is closed', () => {
    expect(doc).toMatch(/`"runner-sandbox\.network-registry-metadata"`/);
    expect(doc).toMatch(/Adding a check id is a change to this document first\./);
  });

  test('an unknown cloud classification requires the IMDS guard, exactly as ec2', () => {
    expect(doc).toMatch(/`"platform\.imds-guarded"` applies whenever `platform\.cloud !== "none"`/);
    expect(doc).toMatch(
      /`"unknown"` is treated exactly as `"ec2"`, so an unclassified host must pass the §§5\.4\/8\.3 IMDS denial canary and can never derive `supported` without it/,
    );
    expect(doc).toMatch(
      /or an applicable `"platform\.imds-guarded"` — does not; `supported` otherwise/,
    );
  });

  test('a non-WSL Linux/EC2 host classifies present, never rejected for lacking a WSL2 identity', () => {
    expect(doc).toMatch(
      /positively classified either as WSL2 \(`platform\.wsl2 === true`\) or as non-WSL Linux/,
    );
    expect(doc).toMatch(/never `rejected` for lacking a WSL2 identity/);
  });

  test('the report is diagnostic, never an authorization input', () => {
    expect(doc).toMatch(/\*\*diagnostic surface, not an authorization input\*\*/);
    expect(doc).toMatch(/A stale report can misdescribe the host; it can never authorize on its behalf\./);
  });
});

describe(`${DOC_PATH} — guarantees, spikes, and validation (§11–§12)`, () => {
  test('Linux/EC2 and WSL2 each have a concrete prerequisites-and-validation path', () => {
    expect(doc).toMatch(/### 11\.2 `linux` \/ `ec2` prerequisites/);
    expect(doc).toMatch(/### 11\.3 `wsl2` prerequisites/);
    expect(doc).toMatch(/### 11\.4 The validation plan — how `designed` becomes `operational`/);
  });

  test('current guarantees are separated from spike assumptions', () => {
    expect(doc).toMatch(/### 12\.1 Current guarantees \(demonstrated\)/);
    expect(doc).toMatch(/### 12\.2 Spike register \(assumptions requiring verification\)/);
    expect(doc).toMatch(
      /\*\*nothing currently executing depends on the runner sandbox existing\*\*/,
    );
  });

  test('the spike register covers WSL2 kernel, Codex fallback, Antigravity, and registry egress', () => {
    expect(doc).toMatch(/\| S1 \| Does the stock WSL2 kernel enable Landlock/);
    expect(doc).toMatch(/\| S2 \| What does the Codex CLI do on a Linux host without Landlock/);
    expect(doc).toMatch(/\| S3 \| What containment, if any, do the `agy` builds/);
    expect(doc).toMatch(/\| S5 \| What mechanism restricts `"registry-metadata"` egress/);
    expect(doc).toMatch(/package-registry work fails closed until this lands/);
  });

  test('names its own docs pin', () => {
    expect(doc).toMatch(/test\/docs-single-host-platform-sandbox-contract\.test\.js/);
  });
});

describe(`${DOC_PATH} — reconciliation landed alongside`, () => {
  test('the grant-tiers contract §18 marks its #916 pointer delivered', () => {
    expect(tiers).toMatch(
      /\*\*Delivered \(#916\)\*\*: `docs\/single-host-platform-sandbox-contract\.md` — the single-host platform and CLI sandbox capability contract/,
    );
    expect(tiers).toMatch(
      /no agent CLI sandbox is ever credited with containing runner-owned commands/,
    );
  });

  test('the preflight contract §20 marks its #916 pointer delivered', () => {
    expect(preflight).toMatch(
      /\*\*Delivered \(#916\)\*\*: `docs\/single-host-platform-sandbox-contract\.md` — the supported single-host platform set/,
    );
    expect(preflight).toMatch(
      /remain with the chain's later issues \(#917 onward\)/,
    );
  });

  domainTest('DOMAIN.md §5 item 4 records the platform/sandbox contract as decided', () => {
    expect(domain).toMatch(/\*\*Platform\/sandbox contract decided \(#916\)\*\*/);
    expect(domain).toMatch(
      /`docs\/single-host-platform-sandbox-contract\.md`: the closed single-host platform set/,
    );
  });
});
