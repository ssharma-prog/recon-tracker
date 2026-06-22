const { spawn } = require('child_process');
const os = require('os');

const TIMEOUT_MS = 480000; // 8 minutes

// Runs the `claude` CLI (uses the existing Claude Code login — no API key).
// Platform-agnostic: cwd is the OS temp dir, and on Windows the CLI is invoked
// via the shell so `claude.cmd` on PATH resolves.
function runClaude(prompt, { noTools = false } = {}) {
  return new Promise((resolve, reject) => {
    const args = noTools
      ? ['-p', '--output-format', 'text']
      : ['-p', '--output-format', 'text', '--allowedTools', 'WebSearch,WebFetch'];
    const proc = spawn('claude', args, {
      env: { ...process.env, ANTHROPIC_API_KEY: '' },
      cwd: os.tmpdir(),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('Claude timed out after 8 minutes'));
    }, TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`Claude exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

module.exports = { runClaude };
