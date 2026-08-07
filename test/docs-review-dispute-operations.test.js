/**
 * Structural pins for docs/review-dispute-operations.md (issue #849).
 *
 * The operations document is the one an operator reads before turning the
 * protocol on and again when they want it off. Its risk is not that it goes
 * out of date quietly — it is that it drifts into POLICY, or promises a
 * command or a guarantee the code does not have. So the assertions here fall
 * into three groups:
 *
 *  1. it defers to the contract rather than restating or extending it;
 *  2. every command, flag, session key and default it names is real — checked
 *     against the CLI's own command registry and the contract's own constants,
 *     not against a second copy of them written here;
 *  3. the two claims that are easy to get wrong stay right: the metrics proxy
 *     is described as observed rather than saved, and the escalated-lineage
 *     limitation is stated rather than papered over.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { COMMANDS } from '../dist/cli/admin.js';
import {
  DEFAULT_ARBITER_MIN_CONFIDENCE,
  REVIEW_DISPUTE_LIMIT_SPECS,
  TERMINAL_LINEAGE_STATES,
} from '../dist/core/review-dispute.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = readFileSync(resolve(ROOT, 'docs/review-dispute-operations.md'), 'utf8');
const doc = RAW.replace(/\s+/g, ' ');
const contract = readFileSync(resolve(ROOT, 'docs/review-dispute-contract.md'), 'utf8').replace(/\s+/g, ' ');
const adminContract = readFileSync(resolve(ROOT, 'docs/admin-cli-contract.md'), 'utf8');

describe('docs/review-dispute-operations.md — authority and scope', () => {
  test('names itself the operator document and defers to the contract', () => {
    expect(doc).toMatch(/This is the operator's document/);
    expect(doc).toMatch(/is the authority on \*what the protocol is\*/);
    expect(doc).toMatch(/nothing here redefines any of it/);
    expect(doc).toMatch(/review-dispute-contract\.md/);
  });

  test('the contract points back at it, and says it adds no policy', () => {
    expect(contract).toMatch(/review-dispute-operations\.md/);
    expect(contract).toMatch(/adds no policy of its own/);
  });

  test('records the copybara export decision', () => {
    expect(doc).toMatch(/\*\*publicly exportable\*\*, not private-only/);
    expect(doc).toMatch(/copybara\/copy\.bara\.sky/);
  });

  test('carries no absolute local path, secret, or live webhook', () => {
    expect(RAW).not.toMatch(/\/Users\//);
    expect(RAW).not.toMatch(/\/home\/[a-z]/);
    expect(RAW).not.toMatch(/hooks\.slack\.com/);
    expect(RAW).not.toMatch(/gh[pousr]_[A-Za-z0-9]{16,}/);
  });
});

describe('docs/review-dispute-operations.md — configuration', () => {
  test('states the single default-off flag and that there is no second switch', () => {
    expect(doc).toMatch(/gated by exactly one flag, `session\.reviewDispute\.enabled`, and it defaults to `false`/);
    expect(doc).toMatch(/There is no second switch, no migration, no per-task opt-in, and no cleanup step/);
  });

  test('an omitted block and an explicit false are documented as identical', () => {
    expect(doc).toMatch(/Default-off is genuinely legacy/);
    expect(doc).toMatch(/no `reviewDispute` key and a session with `"enabled": false` resolve to the same settings/);
  });

  test('every documented default matches the contract constants', () => {
    expect(doc).toContain(`\`arbiter.minConfidence\` | \`${DEFAULT_ARBITER_MIN_CONFIDENCE}\``);
    // The two limits a session may legitimately set to zero, and only those.
    const zeroable = Object.entries(REVIEW_DISPUTE_LIMIT_SPECS)
      .filter(([, spec]) => spec.min === 0)
      .map(([key]) => key);
    expect(zeroable.sort()).toEqual(['maxEvidenceRoundsPerLineage', 'maxReconsiderationsPerLineage']);
    for (const key of zeroable) expect(doc).toContain(key);
    expect(doc).toMatch(/four of the six limits reject `0`/);
    expect(doc).toMatch(/may only \*\*lower\*\* them/);
  });

  test('the counter table matches the contract caps', () => {
    const caps = REVIEW_DISPUTE_LIMIT_SPECS;
    expect(doc).toContain(`| \`rebuttals\` | ${caps.maxRebuttalsPerVersion.default} per version |`);
    expect(doc).toContain(`| \`reconsiderations\` | ${caps.maxReconsiderationsPerLineage.default} per lineage |`);
    expect(doc).toContain(`| \`arbitrationPasses\` | ${caps.maxArbitrationPassesPerLineage.default} per lineage |`);
    expect(doc).toContain(
      `| \`malformedArbiterAttempts\` | ${caps.maxMalformedArbiterAttemptsPerLineage.default} per lineage |`,
    );
    expect(doc).toContain(`| \`evidenceRoundsUsed\` | ${caps.maxEvidenceRoundsPerLineage.default} per lineage |`);
    expect(doc).toMatch(/none of them is ever clamped/);
  });
});

describe('docs/review-dispute-operations.md — arbiter selection and doctor', () => {
  test('explains independence and the allowSameProvider caveat', () => {
    expect(doc).toMatch(/shares a provider with the implementer or the reviewer is refused/);
    expect(doc).toMatch(/List candidates in preference order/);
    expect(doc).toMatch(/same-provider-model-unknown/);
    expect(doc).toMatch(/that is not a misconfiguration/);
  });

  test('names the three doctor checks and where the remediation is', () => {
    for (const check of ['arbiterConfig', 'arbiterCandidates', 'arbiterSelection']) {
      expect(doc).toContain(`\`${check}\``);
    }
    expect(doc).toMatch(/every arbitration would escalate to a human \(contract §8\.3, §7 row 19\)/);
    expect(doc).toMatch(/add a candidate whose provider differs from both parties/);
    expect(doc).toMatch(/`reviewDispute\.arbiter\.allowSameProvider` to `true`/);
  });

  test('states that the role checks report only failures, so absence is the pass', () => {
    expect(doc).toMatch(/`implementationAgentCli` and `reviewAgentCli` appear \*\*only when the role is unusable\*\*/);
    expect(doc).toMatch(/the two candidate checks are \*skipped\* rather than failed/);
  });
});

describe('docs/review-dispute-operations.md — commands it promises exist', () => {
  const registered = new Set(COMMANDS.map((c) => c.name));

  test('every dispute command it documents is in the admin command registry', () => {
    for (const name of ['dispute status', 'dispute reopen', 'dispute metrics']) {
      expect(registered.has(name)).toBe(true);
      expect(doc).toContain(name);
    }
  });

  test('every flag it shows for `dispute metrics` is a flag that command declares', () => {
    const metrics = COMMANDS.find((c) => c.name === 'dispute metrics');
    expect(metrics).toBeDefined();
    const flags = new Set(metrics.options.map((o) => o.flag.split(' ')[0]));
    for (const flag of ['--session-id', '--session-ref', '--issue-number', '--since', '--until']) {
      expect(flags.has(flag)).toBe(true);
      expect(doc).toContain(flag);
    }
  });

  test('the recovery command it recommends is the ordinary handoff one', () => {
    expect(registered.has('recover')).toBe(true);
    expect(doc).toMatch(/--from ready_for_human --phase/);
    expect(doc).toMatch(/Recovery is a \*task\* transition/);
  });

  test('the admin CLI contract lists the metrics command too', () => {
    expect(adminContract).toContain('`dispute metrics`');
    expect(adminContract).toContain('review-dispute-operations.md');
  });
});

describe('docs/review-dispute-operations.md — metrics claims', () => {
  test('the report is documented as event-derived, offline, and read-only', () => {
    expect(doc).toMatch(/derived from the persisted `review\.dispute\.transition` task events/);
    expect(doc).toMatch(/opens no §10\.2 artifact, reads no public comment, makes no GitHub or network call, and mutates nothing/);
  });

  test('the proxy is defined, and never sold as a saving', () => {
    expect(doc).toMatch(/\*\*`lineagesResolvedWithoutHuman` is an observable proxy, not a saving\.\*\*/);
    expect(doc).toMatch(/It says nothing about what would have happened without the protocol/);
    // The counterfactual phrasing the Issue forbids must not appear as a claim.
    expect(doc).toMatch(/does not report a "review loops prevented" figure/);
    expect(RAW).not.toMatch(/prevented \d+ review loops/i);
  });

  test('it explains why bounded counters are read from deltas, not literals', () => {
    expect(doc).toMatch(/read from the \*\*counter deltas\*\*, not from the audit-event literals/);
    expect(doc).toMatch(/Counting literals would undercount/);
  });

  test('it states the determinism property the report depends on', () => {
    expect(doc).toMatch(/counted once per transition key/);
    expect(doc).toMatch(/an entry the protocol already marked `replayed` is never counted/);
    expect(doc).toMatch(/transitionsDeduplicated/);
  });

  test('it states that metrics are not a quality gate', () => {
    expect(doc).toMatch(/not a quality gate and nothing in the runner reads them/);
  });
});

describe('docs/review-dispute-operations.md — visibility, escalation, rollback', () => {
  test('separates public comment content from local-only artifacts', () => {
    expect(doc).toMatch(/\*\*Never public\*\*/);
    expect(doc).toMatch(/\*\*Local only\*\*/);
    expect(doc).toMatch(/rebuttal or rationale prose, arbiter reasoning, evidence content/);
    expect(doc).toMatch(/`binding` is not a resolution and gets no comment of its own/);
  });

  test('every terminal outcome literal appears in the lifecycle description', () => {
    for (const state of TERMINAL_LINEAGE_STATES) expect(doc).toContain(state);
  });

  test('lists the expected human escalations as the protocol working', () => {
    expect(doc).toMatch(/These are the protocol working, not the protocol failing/);
    for (const situation of ['spec_ambiguous', 'minConfidence', 'No acceptable independent arbiter']) {
      expect(doc).toContain(situation);
    }
  });

  test('distinguishes the three rollback operations', () => {
    expect(doc).toMatch(/Disabling the feature \(safe, reversible, no cleanup\)/);
    expect(doc).toMatch(/Recovering an in-flight task/);
    expect(doc).toMatch(/`admin dispute reopen` is not rollback/);
    expect(doc).toMatch(/left exactly as it is\*\*: not deleted, not migrated, not summarized/);
    expect(doc).toMatch(/byte-identical across a disable\/re-enable round trip/);
  });

  test('states the escalated_human limitation instead of inventing a command', () => {
    expect(doc).toMatch(/G1 — an `escalated_human` lineage has no way back into automation/);
    expect(doc).toMatch(/there is no command that resolves an escalated lineage/);
    expect(doc).toMatch(/G2 — the reviewer, evidence, and runner turns have no dispatcher/);
    // The same two gaps, in the document that owns them.
    expect(contract).toMatch(/G1 — no human-resolution transition out of `escalated_human`/);
    expect(contract).toMatch(/G2 — no operator continuation for the undispatched-turn park/);
  });

  test('the n8n compatibility claim holds: no generated workflow knows the protocol', () => {
    expect(doc).toMatch(/\*\*No n8n change is required to run the protocol, and none was made\.\*\*/);
    expect(doc).toMatch(/Never hand-edit the generated JSON/);
    // The claim, checked rather than asserted: no generated workflow mentions
    // the protocol, its flag, its events, or its commands. If a future change
    // puts protocol logic in a node, this fails and the document is wrong.
    for (const file of [
      'docs/n8n-thin-parent-workflow.json',
      'docs/n8n-thin-child-workflow.json',
      'docs/n8n-thin-parent-workflow-private-node.json',
      'docs/n8n-thin-child-workflow-private-node.json',
    ]) {
      const json = readFileSync(resolve(ROOT, file), 'utf8');
      for (const token of ['reviewDispute', 'dispute', 'lineage', 'arbiter']) {
        expect(json).not.toContain(token);
      }
    }
  });

  test('the verification section names the suites that actually exist', () => {
    for (const suite of [
      'test/review-dispute-e2e.test.js',
      'test/review-dispute-rollout.test.js',
      'test/review-dispute-metrics.test.js',
      'test/admin-dispute-metrics.test.js',
      'test/docs-review-dispute-operations.test.js',
    ]) {
      expect(doc).toContain(suite);
      expect(() => readFileSync(resolve(ROOT, suite), 'utf8')).not.toThrow();
    }
    expect(doc).toMatch(/No test in that list runs a paid agent, calls GitHub or Slack, touches the network, or edits SQLite by hand/);
  });
});
