import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateTrials, validateEvaluationContract } from "../src/workflow-evals.js";

const contract = (overrides = {}) => ({ development: [{ id: "dev" }], held_out: [{ id: "held" }], trials: 2, max_retries: 1, min_pass_rate: 1, budget: { max_trials: 8, timeout_ms: 10000 }, grader: "deterministic", ...overrides });
const trial = (scenario, number = 1, outcome = "passed", retry = 0) => ({ scenario, trial: number, retry, outcome, duration_ms: 100 });
const complete = () => [trial("dev"), trial("dev", 2), trial("held"), trial("held", 2)];

test("evaluations separate held-out scores and preserve failed retry attempts", () => {
  const records = [trial("dev"), trial("dev", 2), trial("held", 1, "failed"), trial("held", 1, "passed", 1), trial("held", 2)];
  const result = evaluateTrials(contract(), records);
  assert.equal(result.outcome, "passed");
  assert.equal(result.sample_count, 5);
  assert.equal(result.failed, 1);
  assert.equal(result.first_attempt_success, 3);
  assert.equal(result.retry_assisted_success, 1);
  assert.equal(result.held_out.first_attempt_success_rate, 0.5);
  assert.equal(result.development.first_attempt_success_rate, 1);
  assert.equal(result.pass_rate, 1);
  assert.deepEqual(result.trials, records);
  const failures = evaluateTrials(contract(), [trial("dev"), trial("dev", 2), trial("held"), trial("held", 2, "failed")]);
  assert.equal(failures.outcome, "failed");
  assert.equal(failures.pass_rate, 0.5);
  assert.equal(failures.variability, 0.5);
});

test("missing, skipped, and inconclusive evidence cannot pass; infrastructure errors remain errors", () => {
  assert.equal(evaluateTrials(contract({ min_pass_rate: 0 }), []).outcome, "inconclusive");
  for (const outcome of ["skipped", "inconclusive"]) assert.equal(evaluateTrials(contract(), [...complete().slice(0, 3), trial("held", 2, outcome)]).outcome, "inconclusive");
  assert.equal(evaluateTrials(contract(), [...complete().slice(0, 3), trial("held", 2, "error")]).outcome, "error");
  const recovered = evaluateTrials(contract(), [...complete().slice(0, 3), trial("held", 2, "error"), trial("held", 2, "passed", 1)]);
  assert.equal(recovered.outcome, "passed"); assert.equal(recovered.errors, 1);
});

test("evaluation rejects retries that hide missing samples, successes, or budget violations", () => {
  for (const records of [[trial("held", 1, "passed", 1)], [trial("held"), trial("held", 1, "failed", 1)], [trial("held"), trial("held")], [trial("unknown")], [trial("held", 3)]]) assert.throws(() => evaluateTrials(contract(), records), { code: "INVALID_EVALUATION" });
  assert.throws(() => evaluateTrials(contract({ budget: { max_trials: 4, timeout_ms: 10000 } }), [...complete(), trial("held", 2, "failed", 1)]), /max_trials/);
  assert.throws(() => evaluateTrials(contract({ budget: { max_trials: 8, timeout_ms: 1 } }), complete()), /timeout_ms/);
  assert.throws(() => validateEvaluationContract(contract({ held_out: [{ id: "dev" }] })), /overlapping/);
  assert.throws(() => validateEvaluationContract(contract({ budget: { max_trials: 3, timeout_ms: 10000 } })), /cannot cover/);
  assert.throws(() => validateEvaluationContract(null), { code: "INVALID_EVALUATION" });
});

test("model graders require successful known-good and broken control calibration", () => {
  assert.throws(() => evaluateTrials(contract({ grader: "model" }), complete()), /known-good/);
  const protocol = contract({ grader: "model", calibration: [{ id: "good", expected: "passed" }, { id: "broken", expected: "failed" }] });
  assert.equal(evaluateTrials(protocol, complete()).outcome, "inconclusive");
  assert.equal(evaluateTrials(protocol, complete(), [{ id: "good", outcome: "passed" }, { id: "broken", outcome: "passed" }]).outcome, "failed");
  assert.equal(evaluateTrials(protocol, complete(), [{ id: "good", outcome: "passed" }, { id: "broken", outcome: "failed" }]).outcome, "passed");
  assert.equal(evaluateTrials(protocol, complete(), [{ id: "good", outcome: "error" }]).outcome, "error");
});
