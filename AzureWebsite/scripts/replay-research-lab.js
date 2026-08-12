'use strict';

const path = require('node:path');
const { readResearchLabDiagnosticCapture } = require('../services/research-lab-diagnostics');
const { replayResearchLabCapture } = require('../services/research-lab-replay');

async function main() {
  const requestedFile = process.argv[2];
  if (!requestedFile) {
    throw new Error('Usage: npm run research:replay -- <private-capture.json>');
  }
  const capture = await readResearchLabDiagnosticCapture(path.resolve(requestedFile));
  const result = await replayResearchLabCapture(capture);
  console.log(JSON.stringify({ event: 'research_lab_replay', ...result }));
}

main().catch((error) => {
  const code = error && typeof error.code === 'string' ? error.code : 'replay_failed';
  console.error(JSON.stringify({ event: 'research_lab_replay', status: 'failed', code }));
  process.exitCode = 1;
});
