import { fail, OUTCOMES } from "./workflow-schema.js";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = (message) => fail(message, "INVALID_EVALUATION");
const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value);
const integer = (value, min, max = 100000) => Number.isSafeInteger(value) && value >= min && value <= max;

export function validateEvaluationContract(contract) {
  if (!object(contract)) invalid("Evaluation contract must be an object");
  if (!Array.isArray(contract.development) || !Array.isArray(contract.held_out) || !contract.held_out.length) invalid("Evaluation requires development and nonempty held_out scenario arrays");
  const ids = new Set();
  for (const scenario of [...contract.development, ...contract.held_out]) {
    if (!object(scenario) || !identifier(scenario.id)) invalid("Evaluation scenarios require valid stable ids");
    if (ids.has(scenario.id)) invalid(`Duplicate or overlapping evaluation scenario: ${scenario.id}`);
    ids.add(scenario.id);
  }
  if (!integer(contract.trials, 1)) invalid("Evaluation trials must be a positive bounded integer");
  if (!integer(contract.max_retries, 0, 100)) invalid("Evaluation max_retries must be between 0 and 100");
  if (typeof contract.min_pass_rate !== "number" || !Number.isFinite(contract.min_pass_rate) || contract.min_pass_rate < 0 || contract.min_pass_rate > 1) invalid("Evaluation min_pass_rate must be between 0 and 1");
  if (!object(contract.budget) || !integer(contract.budget.max_trials, 1) || !integer(contract.budget.timeout_ms, 1, 86400000)) invalid("Evaluation requires bounded max_trials and timeout_ms budgets");
  if (ids.size * contract.trials > contract.budget.max_trials) invalid("Evaluation budget cannot cover all declared initial samples");
  if (!["model", "deterministic", "human"].includes(contract.grader)) invalid("Evaluation grader must be model, deterministic, or human");
  if (contract.calibration !== undefined && !Array.isArray(contract.calibration)) invalid("Evaluation calibration must be an array");
  const calibrationIds = new Set();
  for (const control of contract.calibration || []) {
    if (!object(control) || !identifier(control.id) || !["passed", "failed"].includes(control.expected)) invalid("Calibration controls require an id and expected passed or failed outcome");
    if (calibrationIds.has(control.id) || ids.has(control.id)) invalid(`Duplicate calibration control: ${control.id}`);
    calibrationIds.add(control.id);
  }
  if (contract.grader === "model" && !["passed", "failed"].every((outcome) => contract.calibration?.some((entry) => entry.expected === outcome))) {
    invalid("Model graders require known-good and intentionally broken calibration controls");
  }
  return contract;
}

function summarize(scenarios, contract, grouped) {
  const samples = [];
  for (const scenario of scenarios) {
    for (let trial = 1; trial <= contract.trials; trial++) samples.push({ scenario: scenario.id, trial, attempts: grouped.get(`${scenario.id}\0${trial}`) || [] });
  }
  const expected = samples.length;
  const observed = samples.filter((sample) => sample.attempts.length);
  const last = (sample) => sample.attempts.at(-1)?.outcome;
  const completed = observed.filter((sample) => ["passed", "failed", "error"].includes(last(sample)));
  const first = observed.filter((sample) => sample.attempts[0].outcome === "passed").length;
  const assisted = observed.filter((sample) => sample.attempts.length > 1 && last(sample) === "passed").length;
  const passed = observed.filter((sample) => last(sample) === "passed").length;
  const records = observed.flatMap((sample) => sample.attempts);
  const per_scenario = scenarios.map((scenario) => {
    const own = samples.filter((sample) => sample.scenario === scenario.id);
    const outcomes = own.map(last).filter(Boolean);
    return { id: scenario.id, passed: outcomes.filter((outcome) => outcome === "passed").length, expected_samples: contract.trials, observed_samples: outcomes.length,
      pass_rate: outcomes.filter((outcome) => outcome === "passed").length / contract.trials, variable: new Set(outcomes).size > 1 };
  });
  const pass_rate = expected ? passed / expected : 0;
  return { sample_count: records.length, expected_samples: expected, observed_samples: observed.length, completed_samples: completed.length,
    first_attempt_success: first, first_attempt_success_rate: expected ? first / expected : 0,
    retry_assisted_success: assisted, retry_assisted_success_rate: expected ? assisted / expected : 0,
    passed, failed: records.filter((entry) => entry.outcome === "failed").length,
    errors: records.filter((entry) => entry.outcome === "error").length,
    terminal_errors: observed.filter((sample) => last(sample) === "error").length,
    skipped: records.filter((entry) => entry.outcome === "skipped").length,
    inconclusive: records.filter((entry) => entry.outcome === "inconclusive").length,
    pass_rate, variability: Math.sqrt(pass_rate * (1 - pass_rate)), per_scenario,
    complete: completed.length === expected };
}

export function evaluateTrials(contract, trials, calibration = []) {
  validateEvaluationContract(contract);
  if (!Array.isArray(trials) || !Array.isArray(calibration)) invalid("Evaluation trials and calibration results must be arrays");
  if (trials.length > contract.budget.max_trials) invalid("Evaluation exceeded max_trials budget");
  const scenarios = new Set([...contract.development, ...contract.held_out].map((entry) => entry.id));
  const grouped = new Map();
  let duration = 0;
  for (const entry of trials) {
    if (!object(entry) || !scenarios.has(entry.scenario)) invalid("Trial references an unknown scenario");
    if (!integer(entry.trial, 1, contract.trials) || !integer(entry.retry, 0, contract.max_retries)) invalid("Trial or retry number is outside the declared protocol");
    if (!OUTCOMES.includes(entry.outcome)) invalid(`Invalid trial outcome: ${entry.outcome}`);
    if (entry.duration_ms !== undefined && (!Number.isFinite(entry.duration_ms) || entry.duration_ms < 0)) invalid("Trial duration_ms must be nonnegative");
    duration += entry.duration_ms || 0;
    const key = `${entry.scenario}\0${entry.trial}`;
    if (!grouped.has(key)) grouped.set(key, []);
    const attempts = grouped.get(key);
    if (attempts.some((attempt) => attempt.retry === entry.retry)) invalid("Duplicate scenario/trial/retry result");
    attempts.push(entry);
  }
  if (duration > contract.budget.timeout_ms) invalid("Evaluation exceeded timeout_ms budget");
  for (const attempts of grouped.values()) {
    attempts.sort((a, b) => a.retry - b.retry);
    for (let index = 0; index < attempts.length; index++) {
      if (attempts[index].retry !== index) invalid("Evaluation retries must start at zero with no gaps");
      if (index && attempts[index - 1].outcome === "passed") invalid("A successful trial cannot be retried");
    }
  }
  const controls = new Map((contract.calibration || []).map((entry) => [entry.id, entry]));
  const seenControls = new Set();
  for (const entry of calibration) {
    if (!object(entry) || !controls.has(entry.id) || !OUTCOMES.includes(entry.outcome) || seenControls.has(entry.id)) invalid("Unknown, duplicate, or invalid calibration result");
    seenControls.add(entry.id);
  }
  const calibrationComplete = calibration.length === controls.size;
  const calibrationErrors = calibration.filter((entry) => entry.outcome === "error").length;
  const calibrationMismatch = calibration.some((entry) => ["passed", "failed"].includes(entry.outcome) && entry.outcome !== controls.get(entry.id).expected);
  const calibrationPassed = calibrationComplete && calibration.every((entry) => entry.outcome === controls.get(entry.id).expected);
  const development = summarize(contract.development, contract, grouped);
  const held_out = summarize(contract.held_out, contract, grouped);
  const combined = summarize([...contract.development, ...contract.held_out], contract, grouped);
  let outcome = "inconclusive";
  if (combined.terminal_errors || calibrationErrors) outcome = "error";
  else if (calibrationMismatch) outcome = "failed";
  else if (combined.complete && calibrationPassed) outcome = held_out.pass_rate >= contract.min_pass_rate ? "passed" : "failed";
  return { ...combined, outcome, pass_rate: held_out.pass_rate, variability: held_out.variability, development, held_out,
    calibration: { complete: calibrationComplete, passed: calibrationPassed, mismatches: calibration.filter((entry) => entry.outcome !== controls.get(entry.id).expected).length, errors: calibrationErrors, results: structuredClone(calibration) },
    duration_ms: duration, remaining_trials: contract.budget.max_trials - trials.length, trials: structuredClone(trials) };
}
