'use strict';
// utils/instancePaths.js — Spokbot instance path resolution (US-FW-001).
//
// The kernel never hardcodes where an operator's instance content
// lives. Resolution is computed from the environment at call time:
//
//   SPOKBOT_INSTANCE_DIR  Root of the operator's instance checkout.
//                         Default: the framework tree root — today's
//                         unsplit layout, where instance content sits
//                         beside the framework in one tree.
//   SPOKBOT_STATE_DIR     Runtime state directory.
//                         Default: <slack-agents>/.state (today's path).
//   SPOKBOT_CONFIG_<NAME> Explicit per-file config override
//                         (e.g. SPOKBOT_CONFIG_MODELS_YAML).
//
// Config precedence (configPath): env override -> instance config/
// -> framework default (slack-agents/config/). Persona content
// (personasPath) prefers the split layout (<instance>/personas/...)
// and falls back to the unsplit layout (<instance>/...) so the
// engine behaves identically before and after the split.

const fs = require('fs');
const path = require('path');

function frameworkRoot() {
  return path.resolve(__dirname, '..', '..');
}

function slackAgentsDir() {
  return path.resolve(__dirname, '..');
}

function instanceDir() {
  const env = process.env.SPOKBOT_INSTANCE_DIR;
  return env ? path.resolve(env) : frameworkRoot();
}

function stateDir() {
  const env = process.env.SPOKBOT_STATE_DIR;
  return env ? path.resolve(env) : path.join(slackAgentsDir(), '.state');
}

function instancePath(...parts) {
  return path.join(instanceDir(), ...parts);
}

// Persona content: split layout keeps it under personas/; the unsplit
// layout keeps it at the instance root. Prefer split when it exists.
function personasPath(...parts) {
  const split = instancePath('personas', ...parts);
  if (fs.existsSync(split) || fs.existsSync(path.dirname(split))) return split;
  return instancePath(...parts);
}

function statePath(...parts) {
  return path.join(stateDir(), ...parts);
}

function configPath(name) {
  const envKey = 'SPOKBOT_CONFIG_' + name.replace(/[^a-z0-9]+/gi, '_').toUpperCase();
  if (process.env[envKey]) return path.resolve(process.env[envKey]);
  const instanceCopy = instancePath('config', name);
  if (fs.existsSync(instanceCopy)) return instanceCopy;
  return path.join(slackAgentsDir(), 'config', name);
}

// Shared state-dir resolution (US-FW-002). Before this, five modules
// duplicated the same resolver with a hardcoded canonical machine path
// and a per-user HOME fallback — the split-brain source (Oct 12, 2026:
// root crons resolved a different HOME than the engine and read an
// empty decoy state). Precedence: the legacy deployment envs keep
// winning (production safety), then the Spokbot env, then the checkout
// default. The default is anchored to the checkout itself, so it is
// the same directory for every user of the same tree — there is no
// per-user fallback left to disagree about.
function resolvedStateDir() {
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) return process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (process.env.MACF_STATE_DIR) return process.env.MACF_STATE_DIR;
  return stateDir();
}

module.exports = {
  frameworkRoot,
  slackAgentsDir,
  instanceDir,
  stateDir,
  instancePath,
  personasPath,
  statePath,
  configPath,
  resolvedStateDir,
};
