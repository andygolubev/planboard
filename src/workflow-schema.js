import crypto from "node:crypto";

export const WORKFLOW_VERSION = 1;
export const LEASE_MS = 5 * 60 * 1000;
export const HEARTBEAT_MS = 30 * 1000;
export const OUTCOMES = ["passed", "failed", "error", "skipped", "inconclusive"];
export const HOSTS = ["codex", "claude", "cursor", "opencode"];
export const digest = (value) => crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
export const uid = (prefix) => `${prefix}_${crypto.randomUUID()}`;
export function fail(message, code = "INVALID", status = 400) {
  throw Object.assign(new Error(message), { code, status });
}
export function requireString(value, name) {
  if (typeof value !== "string" || !value.trim() || value.length > 10000) fail(`${name} must be a nonempty string`);
  return value;
}
export function initialWorkflow() {
  return { schema_version: WORKFLOW_VERSION, revision: 0, activated_at: null, config: null, config_revision: null,
    specs: { requirements: {}, decisions: {}, components: {}, changes: {}, documents: {}, mappings: {}, issues: [] },
    instructions: {}, workers: {}, coordinator: null, runs: {}, attempts: {}, artifacts: {}, jobs: {}, results: {}, evaluations: {}, accepted_changes: {}, revisions: {} };
}

/** @typedef {{id:string, task:string, run_id:string, attempt:number, objective:string, requirements:Object, criteria:Array, dependencies:string[], scope:string[], outputs:string[], checks:Object, input_revision:string, profile:string}} TaskPacket */
/** @typedef {{id:string, worker:string, run:string, task:string, number:number, token:string, expires_at:string, phase:string, packet:TaskPacket}} Claim */
/** @typedef {{hash:string, workspace:string, files:Array<{path:string,hash:string,bytes:number}>, git_revision:string|null, scope:string[]}} CandidateManifest */
/** @typedef {{id:string,job:string,artifact:string,check:string,outcome:'passed'|'failed'|'error'|'skipped'|'inconclusive',evidence:Array,criteria:Array,at:string}} ValidationResult */
/** @typedef {{scenario:string,trial:number,retry:number,outcome:string,evidence:Array}} EvaluationTrial */
/** @typedef {{schema_version:1,sequence:number,id:string,at:string,type:string,actor:string,task?:string,run?:string,requirement?:string,worker?:string,outcome?:string,detail:Object}} WorkflowEvent */
